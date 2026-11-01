# Plugins (API version 1)

A plugin adds a step after danser has rendered a replay: it gets danser's video (and everything about the job)
and may return a new video, which then replaces it. Use it for overlays, watermarks, extra HUD elements and the
like. Plugins are optional; without any, osu-render works exactly as before.

## Trust model: plugins are code

**A plugin is a JavaScript module that runs inside the osu-render process, with the same permissions as the
service** (it can read and write your files, start programs, use the network). Only install plugins you trust,
exactly like any other program. That is why plugins are installed from the command line on the server only: the
web page can turn installed plugins on for a render and set their options, but it can never upload or install
one.

osu-render keeps a broken plugin from breaking renders: a plugin that fails to load is listed as broken and never
runs; a plugin that throws, times out, returns something wrong or writes no output is skipped for that render, the
job log says why, and the render finishes with danser's video. This protects against bugs, not against a
malicious plugin.

## Installing (server owner)

```sh
npm run plugin -- list                         # installed plugins (and broken ones, with the reason)
npm run plugin -- install path/to/plugin       # a plugin folder ...
npm run plugin -- install path/to/plugin.zip   # ... or a zip of it (plugin.json at the top or in one folder)
npm run plugin -- install path/to/plugin.zip --force   # replace an installed version
npm run plugin -- remove <id>
```

On the Windows portable zip, run the same from the osu-render folder as `node dist\src\plugin-cli.js list` (and
so on). Plugins live in `PLUGINS_DIR` (default `<DATA_DIR>/plugins`, one folder per plugin id). **Restart
osu-render after installing or removing a plugin.** The startup log line `plugins_loaded` lists what loaded.

In the web page, installed plugins appear under **All settings → Plugins**: a "Use for this render" switch plus
the plugin's own options. A plugin that is not available on this server (for example a tool it needs is missing,
or it is for another platform) is shown greyed out with the reason.

## Writing a plugin

A plugin is a folder with `plugin.json` and an ES module. The smallest complete example is
[`examples/plugins/border`](../examples/plugins/border) (a coloured frame around the video):

```js
// index.mjs
import path from 'node:path';

export function available() {
  return true; // or { available: false, reason: 'ffmpeg filter missing' }
}

export async function videoStage(ctx) {
  const output = path.join(ctx.workDir, 'border.mp4');
  await ctx.utils.encodeVideo({
    filter: `[0:v]drawbox=x=0:y=0:w=iw:h=ih:color=0xff66aa:t=${ctx.options.thickness}[v]`,
    output,
  });
  return { status: 'applied', output, note: 'frame drawn' };
}
```

Plain JavaScript (ESM, Node 22+), no build step. Dependencies, if any, must be inside the plugin folder.

### plugin.json

| field | | |
|---|---|---|
| `id` | required | `^[a-z0-9][a-z0-9-]{1,47}$`; also the folder name once installed |
| `name`, `version` | required | shown in the UI and `plugin list` |
| `apiVersion` | required | `1` (this document). Other versions are refused with a message. |
| `description` | optional | |
| `entry` | optional | `.js` / `.mjs` module inside the folder, default `index.js` |
| `platforms` | optional | any of `linux`, `win32`, `darwin`; default: all. Elsewhere the plugin is listed but not loaded. |
| `options` | optional | per-render options for the UI (below), at most 20 |
| `i18n` | optional | UI text per language (`en`, `zh-TW`, `es`, ...): `name`, `description`, `options.<key>.label`, `options.<key>.values.<value>` |

Option types (`key`: `^[A-Za-z][A-Za-z0-9]{0,31}$`, not `enabled`):

```json
{ "key": "labels", "type": "toggle", "default": true }
{ "key": "corner", "type": "select", "values": ["top-left", "bottom-right"], "default": "bottom-right" }
{ "key": "size", "type": "number", "min": 20, "max": 80, "step": 5, "default": 40, "unit": "%" }
```

Every plugin also gets an `enabled` switch (default off). The values are checked against the manifest when a
render is submitted (wrong values → HTTP 400); missing ones take the defaults. They are stored with the render as
`options.plugins.<id>` (also in the HTTP API: `POST /api/renders` options `{"plugins": {"<id>": {"enabled":
true, ...}}}`; `GET /api/plugins` lists the installed plugins with their options and availability).

### `available(ctx)` (optional)

Called at startup and again when the page lists plugins (cached for a minute, 10 s time limit). Return `true` /
`false` or `{ available, reason }`. `ctx`: `{ apiVersion: 1, platform, env, pluginDir }`. Throwing or not
answering means unavailable. An unavailable plugin is skipped even when a render asks for it.

### `videoStage(ctx)` → result

Called after danser finished (and after earlier plugins; enabled plugins run in id order), only for renders that
enabled the plugin. Return:

- `{ status: 'applied', output, note? }` — `output` is a new, non-empty file **inside `ctx.workDir`**; it replaces
  the video. Never write to `ctx.video.path` yourself.
- `{ status: 'skipped', reason }` — nothing to do (the job log shows the reason).

Throwing marks the plugin failed for that render (the video stays as it was). Time limit: 30 min
(`config/defaults.json` `plugins.stageTimeoutMs`); after it, or when the render is cancelled, `ctx.signal` aborts
and the result is ignored.

`ctx`:

| field | |
|---|---|
| `apiVersion` | `1` |
| `platform`, `pluginDir` | |
| `workDir` | an empty folder for this render's files; removed afterwards |
| `job` | `{ id, replayPath, mods, beatmap: { checksum, osuPath, title, artist, version, creator } }` — `replayPath` is the uploaded `.osr`, `osuPath` the `.osu` danser rendered (or null) |
| `video` | `{ path, width, height, fps, durationMs }` — the video so far |
| `timeline` | `{ startMs, prerollMs, rate }` or null (then `timelineError` says why): which song time each frame shows, see below |
| `options` | this plugin's options for the render (`enabled` + the manifest's options) |
| `encoder` | `{ name, speedProfile }` of the render |
| `tools` | `{ ffmpeg, ffprobe, env }` — danser's ffmpeg and the environment to run it with |
| `signal` | `AbortSignal`: stop when it aborts |
| `log(line)` | appends `[plugin <id>] line` to the job log |
| `utils` | helpers, below |

`utils`:

- `encodeVideo({ filter, inputs?, stdinFrom?, output })` → `{ encoder }`: re-encodes the video through an ffmpeg
  `filter_complex` (input 0 is the video, label the result `[v]`) with the render's encoder settings, falling back
  to libx264 when a GPU encoder fails, audio copied, `+faststart`. `inputs` are more ffmpeg input arguments,
  `stdinFrom: { command, args }` starts a process whose stdout feeds ffmpeg's stdin (`pipe:0`). Throws with
  ffmpeg's last line when every encoder failed, or when the stdin process failed (the result would be partial).
- `rawVideoInput({ width, height, fps })`: input arguments for raw RGBA frames on stdin.
- `overlayFilter({ input, corner, opacity, marginPercent? })`: a filter laying input `input` (e.g. `'1:v'`) over the
  video in a corner (`top-left`, `top-right`, `bottom-left`, `bottom-right`), opacity 0..100, result `[v]`.
- `runProcess(command, args, { env?, timeoutMs?, captureStdout?, pipeFrom? })` → `{ code, output, producer? }`:
  runs a program hidden, killed when the stage is aborted.
- `songTimeAt(videoMs)`: song time at a video time (null without a timeline).

Typical overlay plugin: draw frames with your own program, write them as raw RGBA to stdout, and let the host
encode them:

```js
const size = { width: 244, height: 432, fps: 60 };
await ctx.utils.encodeVideo({
  inputs: ctx.utils.rawVideoInput(size),
  stdinFrom: { command: myTool, args: ['--frames', '--start-ms', String(ctx.timeline.startMs)] },
  filter: ctx.utils.overlayFilter({ input: '1:v', corner: 'bottom-right', opacity: 90 }),
  output,
});
```

### Timeline: video time → song time

danser's video starts some time before the map: frame 0 shows song time (beatmap ms, the clock of `.osr` frames)
`startMs`; the first `prerollMs` of video run at speed 1, then the song clock runs at `rate` (1.5 with DT/NC, 0.75
with HT):

```
song(v) = startMs + v                                   for v < prerollMs
song(v) = startMs + prerollMs + (v − prerollMs) · rate  after
```

osu-render derives it from the settings it runs danser with (danser-go 0.12 record mode): the clock starts at
`startPointE − LeadInHold − seizure warning − 1 s` (record mode forces LeadInTime 0; "skip intro" = `-quickstart`
also sets LeadInHold 0), runs at speed 1 until `startPointE` (= first object − preempt when skipping and that is
> 0, else −preempt; preempt from AR with HR/EZ, rounded through float32 like danser), then at the mod rate; frame
0 is taken after the first 1 ms step; maps older than format v5 are 24 ms late. Checked on real renders against
danser's own key overlay: presses land on the predicted frame or the next one.

## Versioning

`apiVersion` changes only for incompatible changes to `plugin.json`, the hooks or `ctx`; new optional fields
can be added within a version. osu-render refuses plugins with a version it does not implement.
