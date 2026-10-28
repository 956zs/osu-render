import { AppError } from './errors.js';

export type RenderResolution = '720p' | '1080p';

export interface RenderDimensions {
  readonly width: number;
  readonly height: number;
}

export const RESOLUTION_DIMENSIONS: Readonly<Record<RenderResolution, RenderDimensions>> = Object.freeze({
  '720p': Object.freeze({ width: 1280, height: 720 }),
  '1080p': Object.freeze({ width: 1920, height: 1080 }),
});

export interface RenderOptions {
  readonly skipIntro: boolean;
  readonly masterVolume: number;
  readonly musicVolume: number;
  readonly sampleVolume: number;
  readonly backgroundDim: number;
  readonly backgroundBlur: number;
  readonly playfieldScale: number;
  readonly loadVideos: boolean;
  readonly loadStoryboards: boolean;
  readonly backgroundParallax: boolean;
  readonly bloom: boolean;
  readonly cursorSize: number;
  readonly cursorTrailStyle: number;
  readonly cursorRainbow: boolean;
  readonly cursorGlow: boolean;
  readonly cursorRipples: boolean;
  readonly cursorSmoke: boolean;
  readonly useSkinColors: boolean;
  readonly useBeatmapColors: boolean;
  readonly showScore: boolean;
  readonly showHpBar: boolean;
  readonly showComboCounter: boolean;
  readonly showHitErrorMeter: boolean;
  readonly showPpCounter: boolean;
  readonly showHitCounter: boolean;
  readonly showStrainGraph: boolean;
  readonly showKeyOverlay: boolean;
  readonly showScoreboard: boolean;
  readonly showMods: boolean;
  readonly showResultsScreen: boolean;
  readonly showApproachCircles: boolean;
  readonly showComboNumbers: boolean;
  readonly showSliderEndCircles: boolean;
  readonly showSliderFollowCircle: boolean;
  readonly showSliderScorePoints: boolean;
  readonly resolution: RenderResolution;
}

interface TogglePatch { readonly Show: boolean }

export interface DanserPatch {
  readonly Recording: {
    readonly FrameWidth: number;
    readonly FrameHeight: number;
  };
  readonly Audio: {
    readonly GeneralVolume: number;
    readonly MusicVolume: number;
    readonly SampleVolume: number;
  };
  readonly Skin: { readonly UseColorsFromSkin: boolean; readonly UseBeatmapColors: boolean };
  readonly Cursor: {
    readonly CursorSize: number;
    readonly TrailStyle: number;
    readonly Colors: { readonly EnableRainbow: boolean };
    readonly EnableTrailGlow: boolean;
    readonly CursorRipples: boolean;
    readonly SmokeEnabled: boolean;
  };
  readonly Playfield: {
    readonly Scale: number;
    readonly Bloom: { readonly Enabled: boolean };
    readonly Background: {
      readonly LoadStoryboards: boolean;
      readonly LoadVideos: boolean;
      readonly Dim: { readonly Normal: number };
      readonly Parallax: { readonly Enabled: boolean };
      readonly Blur: { readonly Enabled: boolean; readonly Values: { readonly Normal: number } };
    };
  };
  readonly Gameplay: {
    readonly Score: TogglePatch;
    readonly HpBar: TogglePatch;
    readonly ComboCounter: TogglePatch;
    readonly HitErrorMeter: TogglePatch;
    readonly PPCounter: TogglePatch;
    readonly HitCounter: TogglePatch;
    readonly StrainGraph: TogglePatch;
    readonly KeyOverlay: TogglePatch;
    readonly ScoreBoard: TogglePatch;
    readonly Mods: TogglePatch;
    readonly ShowResultsScreen: boolean;
  };
  readonly Objects: {
    readonly DrawApproachCircles: boolean;
    readonly DrawComboNumbers: boolean;
    readonly Sliders: {
      readonly DrawEndCircles: boolean;
      readonly DrawSliderFollowCircle: boolean;
      readonly DrawScorePoints: boolean;
    };
  };
}

export const DEFAULT_RENDER_OPTIONS: Readonly<RenderOptions> = Object.freeze({
  resolution: '1080p',
  skipIntro: true,
  masterVolume: 50,
  musicVolume: 50,
  sampleVolume: 50,
  backgroundDim: 30,
  backgroundBlur: 0,
  playfieldScale: 100,
  loadVideos: true,
  loadStoryboards: true,
  backgroundParallax: true,
  bloom: true,
  cursorSize: 12,
  cursorTrailStyle: 1,
  cursorRainbow: false,
  cursorGlow: true,
  cursorRipples: false,
  cursorSmoke: true,
  useSkinColors: true,
  useBeatmapColors: true,
  showScore: true,
  showHpBar: true,
  showComboCounter: true,
  showHitErrorMeter: true,
  showPpCounter: true,
  showHitCounter: true,
  showStrainGraph: true,
  showKeyOverlay: true,
  showScoreboard: true,
  showMods: true,
  showResultsScreen: true,
  showApproachCircles: true,
  showComboNumbers: true,
  showSliderEndCircles: true,
  showSliderFollowCircle: true,
  showSliderScorePoints: true,
});

const BOOLEAN_OPTIONS = [
  'skipIntro', 'loadVideos', 'loadStoryboards', 'backgroundParallax', 'bloom',
  'cursorRainbow', 'cursorGlow', 'cursorRipples', 'cursorSmoke',
  'useSkinColors', 'useBeatmapColors', 'showScore', 'showHpBar', 'showComboCounter',
  'showHitErrorMeter', 'showPpCounter', 'showHitCounter', 'showStrainGraph',
  'showKeyOverlay', 'showScoreboard', 'showMods', 'showResultsScreen',
  'showApproachCircles', 'showComboNumbers', 'showSliderEndCircles',
  'showSliderFollowCircle', 'showSliderScorePoints',
] as const;
const NUMERIC_OPTIONS = [
  'masterVolume', 'musicVolume', 'sampleVolume', 'backgroundDim',
  'backgroundBlur', 'playfieldScale', 'cursorSize', 'cursorTrailStyle',
] as const;
const RESOLUTION_OPTIONS = ['resolution'] as const;
const ALLOWED_OPTIONS = new Set<keyof RenderOptions>([
  ...NUMERIC_OPTIONS, ...BOOLEAN_OPTIONS, ...RESOLUTION_OPTIONS,
]);

export function parseRenderOptions(value: string | undefined): Readonly<RenderOptions> {
  if (value === undefined || value === '') return DEFAULT_RENDER_OPTIONS;
  let input: unknown;
  try { input = JSON.parse(value); } catch { throw invalidOptions('Render options must be valid JSON.'); }
  if (!isObject(input)) throw invalidOptions('Render options must be a JSON object.');
  assertAllowedOptions(input);
  const options: RenderOptions = {
    ...DEFAULT_RENDER_OPTIONS,
    resolution: resolutionOption(input),
    masterVolume: boundedInteger(input, 'masterVolume', { min: 0, max: 100 }),
    musicVolume: boundedInteger(input, 'musicVolume', { min: 0, max: 100 }),
    sampleVolume: boundedInteger(input, 'sampleVolume', { min: 0, max: 100 }),
    backgroundDim: boundedInteger(input, 'backgroundDim', { min: 0, max: 100 }),
    backgroundBlur: boundedInteger(input, 'backgroundBlur', { min: 0, max: 100 }),
    playfieldScale: boundedInteger(input, 'playfieldScale', { min: 80, max: 120 }),
    cursorSize: boundedInteger(input, 'cursorSize', { min: 6, max: 24 }),
    cursorTrailStyle: boundedInteger(input, 'cursorTrailStyle', { min: 1, max: 4 }),
    skipIntro: booleanOption(input, 'skipIntro'),
    loadVideos: booleanOption(input, 'loadVideos'),
    loadStoryboards: booleanOption(input, 'loadStoryboards'),
    backgroundParallax: booleanOption(input, 'backgroundParallax'),
    bloom: booleanOption(input, 'bloom'),
    cursorRainbow: booleanOption(input, 'cursorRainbow'),
    cursorGlow: booleanOption(input, 'cursorGlow'),
    cursorRipples: booleanOption(input, 'cursorRipples'),
    cursorSmoke: booleanOption(input, 'cursorSmoke'),
    useSkinColors: booleanOption(input, 'useSkinColors'),
    useBeatmapColors: booleanOption(input, 'useBeatmapColors'),
    showScore: booleanOption(input, 'showScore'),
    showHpBar: booleanOption(input, 'showHpBar'),
    showComboCounter: booleanOption(input, 'showComboCounter'),
    showHitErrorMeter: booleanOption(input, 'showHitErrorMeter'),
    showPpCounter: booleanOption(input, 'showPpCounter'),
    showHitCounter: booleanOption(input, 'showHitCounter'),
    showStrainGraph: booleanOption(input, 'showStrainGraph'),
    showKeyOverlay: booleanOption(input, 'showKeyOverlay'),
    showScoreboard: booleanOption(input, 'showScoreboard'),
    showMods: booleanOption(input, 'showMods'),
    showResultsScreen: booleanOption(input, 'showResultsScreen'),
    showApproachCircles: booleanOption(input, 'showApproachCircles'),
    showComboNumbers: booleanOption(input, 'showComboNumbers'),
    showSliderEndCircles: booleanOption(input, 'showSliderEndCircles'),
    showSliderFollowCircle: booleanOption(input, 'showSliderFollowCircle'),
    showSliderScorePoints: booleanOption(input, 'showSliderScorePoints'),
  };
  return Object.freeze(options);
}

export function buildDanserPatch(options: Readonly<RenderOptions>): DanserPatch {
  return {
    Recording: buildRecordingPatch(options),
    Audio: buildAudioPatch(options),
    Skin: { UseColorsFromSkin: options.useSkinColors, UseBeatmapColors: options.useBeatmapColors },
    Cursor: buildCursorPatch(options),
    Playfield: buildPlayfieldPatch(options),
    Gameplay: buildGameplayPatch(options),
    Objects: buildObjectsPatch(options),
  };
}

function buildRecordingPatch(options: Readonly<RenderOptions>): DanserPatch['Recording'] {
  const dimensions = RESOLUTION_DIMENSIONS[options.resolution];
  return { FrameWidth: dimensions.width, FrameHeight: dimensions.height };
}

function buildAudioPatch(options: Readonly<RenderOptions>): DanserPatch['Audio'] {
  return {
    GeneralVolume: options.masterVolume / 100,
    MusicVolume: options.musicVolume / 100,
    SampleVolume: options.sampleVolume / 100,
  };
}

function buildCursorPatch(options: Readonly<RenderOptions>): DanserPatch['Cursor'] {
  return {
    CursorSize: options.cursorSize,
    TrailStyle: options.cursorTrailStyle,
    Colors: { EnableRainbow: options.cursorRainbow },
    EnableTrailGlow: options.cursorGlow,
    CursorRipples: options.cursorRipples,
    SmokeEnabled: options.cursorSmoke,
  };
}

function buildPlayfieldPatch(options: Readonly<RenderOptions>): DanserPatch['Playfield'] {
  return {
    Scale: options.playfieldScale / 100,
    Bloom: { Enabled: options.bloom },
    Background: {
      LoadStoryboards: options.loadStoryboards,
      LoadVideos: options.loadVideos,
      Dim: { Normal: options.backgroundDim / 100 },
      Parallax: { Enabled: options.backgroundParallax },
      Blur: { Enabled: options.backgroundBlur > 0, Values: { Normal: options.backgroundBlur / 100 } },
    },
  };
}

function buildGameplayPatch(options: Readonly<RenderOptions>): DanserPatch['Gameplay'] {
  return {
    Score: { Show: options.showScore },
    HpBar: { Show: options.showHpBar },
    ComboCounter: { Show: options.showComboCounter },
    HitErrorMeter: { Show: options.showHitErrorMeter },
    PPCounter: { Show: options.showPpCounter },
    HitCounter: { Show: options.showHitCounter },
    StrainGraph: { Show: options.showStrainGraph },
    KeyOverlay: { Show: options.showKeyOverlay },
    ScoreBoard: { Show: options.showScoreboard },
    Mods: { Show: options.showMods },
    ShowResultsScreen: options.showResultsScreen,
  };
}

function buildObjectsPatch(options: Readonly<RenderOptions>): DanserPatch['Objects'] {
  return {
    DrawApproachCircles: options.showApproachCircles,
    DrawComboNumbers: options.showComboNumbers,
    Sliders: {
      DrawEndCircles: options.showSliderEndCircles,
      DrawSliderFollowCircle: options.showSliderFollowCircle,
      DrawScorePoints: options.showSliderScorePoints,
    },
  };
}

function assertAllowedOptions(input: Record<string, unknown>): void {
  for (const key of Object.keys(input)) {
    if (!ALLOWED_OPTIONS.has(key as keyof RenderOptions)) throw invalidOptions(`Unsupported render option: ${key}.`);
  }
}

function boundedInteger(
  input: Record<string, unknown>,
  key: typeof NUMERIC_OPTIONS[number],
  bounds: { readonly min: number; readonly max: number },
): number {
  const value = input[key] ?? DEFAULT_RENDER_OPTIONS[key];
  if (!Number.isInteger(value) || (value as number) < bounds.min || (value as number) > bounds.max) {
    throw invalidOptions(`${key} must be an integer from ${bounds.min} to ${bounds.max}.`);
  }
  return value as number;
}

function booleanOption(input: Record<string, unknown>, key: typeof BOOLEAN_OPTIONS[number]): boolean {
  const value = input[key] ?? DEFAULT_RENDER_OPTIONS[key];
  if (typeof value !== 'boolean') throw invalidOptions(`${key} must be true or false.`);
  return value;
}

function resolutionOption(input: Record<string, unknown>): RenderResolution {
  const value = input.resolution ?? DEFAULT_RENDER_OPTIONS.resolution;
  if (value !== '720p' && value !== '1080p') throw invalidOptions('resolution must be 720p or 1080p.');
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidOptions(message: string): AppError {
  return new AppError('INVALID_OPTIONS', message, 400);
}
