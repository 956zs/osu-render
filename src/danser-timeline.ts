/**
 * Which song time (beatmap ms, the replay's own clock) each frame of danser's video shows. Derived from the
 * settings osu-render runs danser with, so plugins can draw things in sync with the replay. See
 * docs/plugins.md "Timeline".
 */

/** danser (record mode) advances its clock in 1 ms steps and captures frame 0 after the first step. */
const DANSER_UPDATE_MS = 1;
/** danser record mode forces LeadInTime 0 and waits max(LeadInTime, 1 s) before the map starts. */
const DANSER_MIN_LEAD_IN_MS = 1000;

/** What danser's start time depends on in a .osu file. */
export interface OsuTiming {
  formatVersion: number;
  approachRate: number;
  /** Earliest hit object (ms). */
  firstObjectMs: number;
}

/** Reads the format version, approach rate (OD when the map has none, like danser) and first hit object. */
export function parseOsuTiming(text: string): OsuTiming {
  let formatVersion = 0;
  let ar: number | undefined;
  let od: number | undefined;
  let firstObjectMs = Number.POSITIVE_INFINITY;
  let section = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (formatVersion === 0) {
      const version = /^osu file format v(\d+)/.exec(line);
      if (version) { formatVersion = Number(version[1]); continue; }
    }
    if (line.startsWith('[') && line.endsWith(']')) { section = line.slice(1, -1); continue; }
    if (section === 'Difficulty') {
      const [key, value] = line.split(':', 2).map((part) => part.trim());
      const parsed = Number(value);
      if (key === 'ApproachRate' && Number.isFinite(parsed)) ar = clamp(parsed, 0, 10);
      if (key === 'OverallDifficulty' && Number.isFinite(parsed)) od = clamp(parsed, 0, 10);
    } else if (section === 'HitObjects' && line) {
      const time = Number(line.split(',')[2]);
      if (Number.isFinite(time)) firstObjectMs = Math.min(firstObjectMs, time);
    }
  }
  if (!Number.isFinite(firstObjectMs)) throw new Error('beatmap has no hit objects');
  return { formatVersion, approachRate: ar ?? od ?? 5, firstObjectMs };
}

/** Song speed of the replay's mods: DT/NC 1.5, HT 0.75. */
export function modsRate(mods: string): number {
  if (/DT|NC/.test(mods)) return 1.5;
  if (/HT/.test(mods)) return 0.75;
  return 1;
}

/** Approach preempt (ms) as danser computes it: AR with HR (×1.4, max 10) / EZ (÷2), float32 like danser. */
export function preemptMs(approachRate: number, mods: string): number {
  let ar = approachRate;
  if (mods.includes('HR')) ar = Math.min(ar * 1.4, 10);
  if (mods.includes('EZ')) ar /= 2;
  ar = Math.fround(ar);
  const value = ar > 5 ? 1200 + (450 - 1200) * (ar - 5) / 5 : ar < 5 ? 1200 - (1200 - 1800) * (5 - ar) / 5 : 1200;
  return Math.floor(value);
}

export interface DanserTimingInput {
  timing: OsuTiming;
  mods: string;
  /** -quickstart (osu-render's skipIntro): skip to the first object, lead-in hold 0. */
  quickstart: boolean;
  /** Playfield.LeadInHold (s) of the settings danser runs with. */
  leadInHoldS: number;
  /** Playfield.SeizureWarning of the settings danser runs with. */
  seizureWarning: { enabled: boolean; durationS: number };
}

/**
 * Song time shown on video frame 0, the real-time video ms before the song clock runs at the mod rate, and
 * that rate: video time v shows song time `startMs + v` while v < prerollMs, then
 * `startMs + prerollMs + (v - prerollMs) * rate`.
 */
export interface Timeline {
  startMs: number;
  prerollMs: number;
  rate: number;
}

/**
 * danser-go app/states/player.go, record mode: the clock starts at
 * startPointE − LeadInHold − seizure warning − max(LeadInTime, 1 s) (record mode forces LeadInTime 0),
 * runs at speed 1 until startPointE and at the mod rate after it; startPointE = first object − preempt
 * (preempt = min(1800, AR preempt)) when skipping and that is > 0, else −preempt. Song time = clock − 24 ms
 * for maps older than format v5. Frame 0 is captured after the first 1 ms step.
 */
export function danserTimeline(input: DanserTimingInput): Timeline {
  const rate = modsRate(input.mods);
  const preempt = Math.min(1800, preemptMs(input.timing.approachRate, input.mods));
  const skipTime = input.timing.firstObjectMs - preempt;
  const startPointE = input.quickstart && Math.max(0, skipTime) > 0.01 ? skipTime : -preempt;
  const holdMs = input.quickstart ? 0 : Math.max(0, input.leadInHoldS) * 1000;
  const seizureMs = input.seizureWarning.enabled ? Math.max(1000, input.seizureWarning.durationS * 1000) : 0;
  const clockStart = startPointE - holdMs - seizureMs - DANSER_MIN_LEAD_IN_MS;
  const oldOffset = input.timing.formatVersion < 5 ? 24 : 0;
  const frame0 = clockStart + DANSER_UPDATE_MS;
  return {
    startMs: frame0 - oldOffset,
    // the clock speeds up once song time (clock − oldOffset) reaches startPointE
    prerollMs: Math.max(0, startPointE + oldOffset - frame0),
    rate,
  };
}

/** Song time shown at video time `videoMs`. */
export function songTimeAt(timeline: Timeline, videoMs: number): number {
  return videoMs < timeline.prerollMs
    ? timeline.startMs + videoMs
    : timeline.startMs + timeline.prerollMs + (videoMs - timeline.prerollMs) * timeline.rate;
}

/** LeadInHold and SeizureWarning from a danser settings file (danser's defaults when missing). */
export function danserLeadIn(settings: unknown): Pick<DanserTimingInput, 'leadInHoldS' | 'seizureWarning'> {
  const playfield = isRecord(settings) && isRecord(settings.Playfield) ? settings.Playfield : {};
  const hold = typeof playfield.LeadInHold === 'number' && Number.isFinite(playfield.LeadInHold) ? playfield.LeadInHold : 2;
  const seizure = isRecord(playfield.SeizureWarning) ? playfield.SeizureWarning : {};
  return {
    leadInHoldS: hold,
    seizureWarning: {
      enabled: seizure.Enabled === true,
      durationS: typeof seizure.Duration === 'number' && Number.isFinite(seizure.Duration) ? seizure.Duration : 5,
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
