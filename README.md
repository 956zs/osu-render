# osu-render

**English** · [繁體中文](README.zh-TW.md) · [Español](README.es.md)

Self-hosted osu! replay (`.osr`) to MP4 render service powered by [danser-go](https://github.com/Wieku/danser-go).
Drop a replay into the web page: the service looks the beatmap up through the osu! API, downloads it from a
mirror, renders it with danser and gives you a 720p or 1080p, 60 FPS MP4. Video encoding runs on your GPU
(NVIDIA NVENC, AMD AMF or Intel Quick Sync) when it can and falls back to the CPU (x264) when it cannot.

> **Windows and NVIDIA/AMD support is new and needs testers.** If you have one of those setups, running
> `npm run doctor` and sending the report helps a lot. See [Diagnostics & reporting](#diagnostics--reporting).

## Contents

- [Features](#features)
- [Platform & GPU support](#platform--gpu-support)
- [Requirements](#requirements)
- [osu! OAuth application](#osu-oauth-application)
- [Quick start: Windows](#quick-start-windows)
- [Quick start: Linux](#quick-start-linux)
- [Configuration](#configuration)
- [How encoder selection works](#how-encoder-selection-works)
- [Diagnostics & reporting](#diagnostics--reporting)
- [HTTP API](#http-api)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License & credits](#license--credits)

## Features

- Drag-and-drop web UI in English, 繁體中文 and Español.
- Upload only the replay. The beatmap is found by its checksum through the osu! API, downloaded from
  configurable mirrors (with fallback) and checked against the replay's MD5 before rendering.
- 720p or 1080p at 60 FPS, H.264 video with AAC audio.
- Per-render visual options: skip intro, volumes, background dim/blur/parallax, bloom, playfield scale,
  cursor size/trail/effects, skin or beatmap colours, HUD elements and hit object details.
- GPU encoder auto-detection with a real one-frame self-test, x264 fallback.
- Persistent FIFO queue (SQLite), one render at a time, recovery after a crash or restart.
- Disk guard: renders are refused when free space is low; old videos and replays expire after 24 hours and
  cached beatmaps are evicted least-recently-used first.
- Small HTTP API with Range downloads and an optional bearer token.
- Built-in diagnostics report (`npm run doctor` or the web UI) for bug reports.

## Platform & GPU support

| Platform | Encoder | Status |
| --- | --- | --- |
| Linux | Intel Quick Sync (`h264_qsv`) | Verified |
| Linux | NVIDIA NVENC (`h264_nvenc`) | Implemented, needs testers |
| Linux | AMD AMF (`h264_amf`) | Experimental: needs AMD's proprietary AMF runtime, most setups fall back to x264 |
| Windows 10 / 11 | NVIDIA NVENC (`h264_nvenc`) | Implemented, needs testers |
| Windows 10 / 11 | AMD AMF (`h264_amf`) | Implemented, needs testers |
| Windows 10 / 11 | Intel Quick Sync (`h264_qsv`) | Implemented, needs testers |
| Any | CPU x264 (`libx264`) | Fallback, always available (slower) |
| macOS | — | Not supported |

HEVC variants (`hevc_nvenc`, `hevc_amf`, `hevc_qsv`) can be forced with `RENDER_ENCODER`.

## Requirements

- **Node.js 22.12 or newer** (the current LTS is recommended). On Windows use the 64-bit build.
- **danser-go 0.11 or newer, 0.12.1 recommended.** Download the zip for your OS from the
  [danser-go releases](https://github.com/Wieku/danser-go/releases). It already contains the FFmpeg build
  danser uses, so you do not need to install FFmpeg yourself.
- **An osu! OAuth application** (client ID and secret), see [below](#osu-oauth-application).
- **A GPU driver** if you want hardware encoding:
  - NVIDIA: a recent GeForce/Studio driver. Old drivers fail the NVENC self-test with
    `Driver does not support the required nvenc API version`.
  - AMD: on Windows, the Adrenalin driver (it ships the AMF runtime). On Linux AMF needs AMD's proprietary
    runtime, which most distributions do not ship.
  - Intel: the Intel graphics driver, and the integrated GPU must be enabled. On desktops with a dedicated
    graphics card the iGPU is often disabled in the BIOS/UEFI (look for "iGPU Multi-Monitor" or similar).
    On Linux, Quick Sync also needs `intel-media-driver` and the oneVPL GPU runtime (`vpl-gpu-rt`, called
    `libmfx-gen1` / `onevpl-intel-gpu` on some distributions).
- **Disk space:** keep at least 15 GiB free. New renders are refused below 8 GiB.

## osu! OAuth application

The service uses the osu! API v2 **client credentials** grant: it only reads public beatmap data and never
logs anyone in.

1. Open <https://osu.ppy.sh/home/account/edit>, scroll to **OAuth** and click **New OAuth Application**.
2. Pick any name. The **Application Callback URL** can stay empty. If the form insists on one, use
   `http://127.0.0.1:3030/` (it is never called).
3. Copy the **Client ID** and **Client Secret** into `.env` as `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET`.
   The secret stays on the server and is never sent to the browser. Do not share it.

## Quick start: Windows

> [!IMPORTANT]
> Run the service **inside your logged-in Windows desktop session** (a normal terminal window, or a Task
> Scheduler task that runs only when you are logged on). It **cannot** run as a Windows Service, from
> "Run whether user is logged on or not", or over SSH: those run in session 0 / a non-interactive session where
> only the GDI Generic OpenGL 1.1 driver exists, and danser needs OpenGL 3.3 from your GPU driver.

1. Install [Node.js LTS](https://nodejs.org/) and [Git](https://git-scm.com/) (or use **Code → Download ZIP**
   on GitHub instead of `git clone`). In PowerShell:

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```

   Open a new PowerShell window afterwards so `node` and `npm` are on `PATH`.

2. Download `danser-0.12.1-win.zip` from the [danser-go releases](https://github.com/Wieku/danser-go/releases)
   and extract it, for example to `C:\danser` (so that `C:\danser\danser-cli.exe` exists).
   SmartScreen or Defender may warn about the unsigned exe, see [Troubleshooting](#troubleshooting).

3. Get the code and create your config:

   ```powershell
   git clone https://github.com/956zs/osu-render.git
   cd osu-render
   Copy-Item .env.example .env
   notepad .env
   ```

   Set at least:

   ```ini
   DANSER_DIR=C:/danser
   OSU_CLIENT_ID=12345
   OSU_CLIENT_SECRET=your-secret
   ```

   Forward slashes (`C:/danser`) or plain backslashes (`C:\danser`) both work. Do not add quotes.

4. Install, build, check and start:

   ```powershell
   npm ci
   npm run build
   npm run doctor
   npm start
   ```

   `npm run doctor` prints what it found (danser, FFmpeg, GPUs, which encoders pass the self-test) and saves a
   report, see [Diagnostics & reporting](#diagnostics--reporting).

5. Open <http://127.0.0.1:3030/> and drop a replay. Keep the terminal open while the service runs.

**Optional: start automatically when you log in.** Task Scheduler can run `npm start` at log on. In PowerShell,
from the repository folder:

```powershell
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm start" -WorkingDirectory (Get-Location).Path
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "osu-render" -Action $action -Trigger $trigger -Settings $settings
```

This registers a task that runs only while you are logged on, which is what danser needs. Do not switch it to
"Run whether user is logged on or not". Remove it with `Unregister-ScheduledTask -TaskName osu-render`.

## Quick start: Linux

```sh
# 1. danser (the zip has no execute bits, so set them)
mkdir -p ~/danser
unzip danser-0.12.1-linux.zip -d ~/danser
chmod +x ~/danser/danser ~/danser/danser-cli ~/danser/ffmpeg/bin/ffmpeg ~/danser/ffmpeg/bin/ffprobe
# danser 0.11 uses a flat layout instead: chmod +x ~/danser/danser-cli ~/danser/ffmpeg/ffmpeg ~/danser/ffmpeg/ffprobe

# 2. the service
git clone https://github.com/956zs/osu-render.git ~/osu-render
cd ~/osu-render
cp .env.example .env
$EDITOR .env        # DANSER_DIR=<output of: echo ~/danser>, OSU_CLIENT_ID, OSU_CLIENT_SECRET
npm ci
npm run build
npm run doctor
npm start           # then open http://127.0.0.1:3030/
```

The service finds danser's bundled FFmpeg libraries by itself (`ffmpeg/lib` for 0.12, `ffmpeg/` for 0.11); you
do not need to set `LD_LIBRARY_PATH`.

**Display:** danser 0.12+ renders offscreen on Linux and needs no display, so it also works on a headless box.
danser 0.11 opens a hidden window and needs `DISPLAY` or `WAYLAND_DISPLAY` from a running graphical session.

**systemd --user:** [`systemd/osu-render.service`](systemd/osu-render.service) is an example unit that expects
the repository in `~/osu-render` and danser in `~/danser`. Edit the paths (and the `node` path) first, then:

```sh
mkdir -p ~/.config/systemd/user
cp systemd/osu-render.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now osu-render.service
journalctl --user -u osu-render.service -f
```

To keep it running after you log out, enable lingering: `loginctl enable-linger "$USER"` (fine with danser
0.12+; danser 0.11 needs the desktop session anyway).

## Configuration

Settings are read from `.env` in the repository root. Variables already set in the real environment win over
`.env`. Paths may be absolute or relative to the repository root.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to listen on. Read [Security notes](#security-notes) before changing it. |
| `PORT` | `3030` | HTTP port. |
| `DATA_DIR` | `./data` | Database, replays, videos, beatmaps, logs and diagnostics reports. |
| `DANSER_DIR` | `./danser` | Folder where danser is extracted. |
| `DANSER_BIN` | `<DANSER_DIR>/danser-cli` (`.exe` on Windows) | danser CLI binary, if it lives elsewhere. |
| `DANSER_BASE_SETTINGS` | `<DANSER_DIR>/settings/default.json` | danser settings used as the base for renders (see below). |
| `DANSER_SKINS_DIR` | `<DATA_DIR>/skins` | Skins folder passed to danser. |
| `DANSER_SETTINGS_NAME` | `service` | Name of the settings file the service writes: `<DANSER_DIR>/settings/<name>.json`. Letters, digits, `-` and `_` only. |
| `RENDER_ENCODER` | `auto` | `auto`, `h264_nvenc`, `hevc_nvenc`, `h264_amf`, `hevc_amf`, `h264_qsv`, `hevc_qsv` or `libx264`. Any other value stops startup with an error. |
| `OSU_CLIENT_ID` | empty | osu! OAuth client ID. Required. |
| `OSU_CLIENT_SECRET` | empty | osu! OAuth client secret. Required. |
| `BEATMAP_MIRRORS` | `https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}` | Comma-separated `.osz` download URLs, tried in order. `{id}` is the beatmapset ID. |
| `AUTH_TOKEN` | empty | If set, every `/api/*` request needs `Authorization: Bearer <token>`. |
| `MAX_QUEUE` | `20` | Maximum number of unfinished jobs. |

**danser base settings.** The service copies `DANSER_BASE_SETTINGS`, overrides what it must (folders, 60 FPS,
encoder, output) and writes the result to `<DANSER_DIR>/settings/<DANSER_SETTINGS_NAME>.json`. If the base file
does not exist, danser's built-in defaults are used. To get a base file you can tweak (skin, cursor and so on),
run `danser-cli -noupdatecheck` once from the danser folder: it creates `settings/default.json`, prints
`No beatmap specified, closing...` and exits.

Tunables that are not secrets live in [`config/defaults.json`](config/defaults.json): the encoder auto order
per platform, self-test size and timeout, diagnostics sizes and the issue link. To change them, create
`config/local.json` with only the keys you want to override; it is merged over the defaults and ignored by
git. Example:

```json
{ "encoders": { "autoOrder": { "win32": ["h264_qsv", "libx264"] } } }
```

## How encoder selection works

danser only checks that an encoder name exists in FFmpeg; if the GPU or driver cannot actually use it, the
render fails halfway. So at startup the service **encodes one black 240×144 frame** with danser's FFmpeg for
each candidate and keeps the first one that works:

| `RENDER_ENCODER` | Candidates, in order |
| --- | --- |
| `auto` on Windows | `h264_nvenc` → `h264_amf` → `h264_qsv` → `libx264` |
| `auto` on Linux | `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264` |
| a specific encoder | that encoder → `libx264` |

If it ends up on `libx264`, renders still work but `/health` reports `"status": "degraded"` with
`"reason": "hardware_encoder_unavailable"` (auto mode) or `"encoder_unavailable"` (the encoder you forced
failed). While degraded, the check is repeated from time to time (on `/health` requests and new renders), so a
GPU that becomes available later is picked up without a restart.

## Diagnostics & reporting

If something does not work, or you simply want to help with testing, send a diagnostics report:

1. **`npm run doctor`** prints a summary and writes `data/diagnostics/doctor-<timestamp>.json`.
   `npm run doctor -- --json` prints the JSON itself instead of the summary. The doctor self-tests **every** supported
   encoder, not just the first that works, so one report shows the whole NVENC / AMF / QSV / x264 picture.
2. **In the web UI**, the **Diagnostics** card has **Download report** (the same JSON), **Copy summary** (short
   text for chat) and **Open GitHub issue** (a pre-filled issue form). `GET /api/diagnostics` returns the JSON too.
3. **Open an issue** with the [GPU / platform report](https://github.com/956zs/osu-render/issues/new?template=gpu-report.yml)
   template and paste the JSON. Sending the file to the maintainer directly works just as well.

### Privacy

- **Included:** OS name/version/architecture, CPU model, core count, RAM size, GPU names, vendors and driver
  versions, danser and FFmpeg versions and FFmpeg's encoder list, encoder self-test results (with the end of
  FFmpeg's error output), the startup check result, a config summary (host, port, encoder setting, mirror
  host names, and only *whether* OAuth credentials and `AUTH_TOKEN` are set), free disk space, and metadata of
  the last 20 renders (status, encoder, resolution, timings, error code and a short tail of danser's log, which
  can mention beatmap titles), and a summary of danser's `danser.log` (versions, GPU used for OpenGL).
- **Excluded:** the OAuth client ID and secret, `AUTH_TOKEN`, IP addresses, player names, replay and beatmap
  files. Your home folder is replaced with `~` and your user name with `<user>`.
- **Nothing is sent automatically.** The service never uploads anything. You choose whether to share the
  file. The **Open GitHub issue** button only opens a pre-filled page in your browser (that text travels to
  github.com in the page address); nothing is published until you press **Submit**. GitHub issues are public,
  so read the report before posting it.

## HTTP API

If `AUTH_TOKEN` is set, add `-H "Authorization: Bearer $AUTH_TOKEN"` to every `/api/*` call.

| Method & path | Description |
| --- | --- |
| `POST /api/renders` | Multipart upload: `replay` (the `.osr`, max 5 MiB) and optional `options` (JSON string). Returns `{ "id", "status" }`. |
| `GET /api/renders/:id` | Job status, progress, queue position, beatmap, output format and error. |
| `GET /api/renders/:id/video` | The finished MP4. Supports HTTP `Range`. |
| `DELETE /api/renders/:id` | Cancel a job. |
| `GET /api/diagnostics` | Diagnostics report (same JSON as `npm run doctor`). |
| `GET /health` | Service health (no auth): `status`, `renderer`, `display`, `encoder`, `encoderKind`, `platform`, `queue`, `freeDiskBytes`, `reason`. |

```sh
curl -F replay=@my-play.osr -F 'options={"resolution":"720p","skipIntro":true}' http://127.0.0.1:3030/api/renders
curl http://127.0.0.1:3030/api/renders/<id>
curl -o my-play.mp4 http://127.0.0.1:3030/api/renders/<id>/video
```

Job statuses: `uploaded` → `resolving` → `downloading` → `queued` → `rendering` → `finalizing` →
`completed`, or `failed` / `cancelled`. Limits: osu!standard replays only, beatmaps up to 15 minutes, 30 minutes
per render, 5 uploads per minute and 3 unfinished jobs per client.

## Security notes

- The service listens on `127.0.0.1` by default, so only your own machine can reach it.
- **Set `AUTH_TOKEN` before exposing it** (`HOST=0.0.0.0`, port forwarding or a reverse proxy). The token
  protects `/api/*`; the web page has a field for it. Use HTTPS (a reverse proxy) if the token crosses a network
  you do not trust.
- The browser cannot pass arbitrary danser or FFmpeg arguments or file paths. Render options are checked
  against a whitelist and turned into a fixed set of danser flags and settings patches.
- Downloaded `.osz` archives are extracted defensively: limits on entry count and total size, no absolute
  paths, `..`, symlinks or other special files, no Windows-reserved names (`CON`, `NUL`, `COM1`…) or
  case-insensitive duplicates, and the `.osu` file must match the replay's beatmap MD5.
- The OAuth secret and `AUTH_TOKEN` stay in `.env` (ignored by git) and are never sent to the browser or put in
  diagnostics reports.

## Troubleshooting

**`/health` is degraded.** The `reason` field says why:

| Reason | Meaning / what to do |
| --- | --- |
| `renderer_unavailable` | danser-cli was not found. Check `DANSER_DIR` / `DANSER_BIN`; on Linux run `chmod +x`. |
| `display_unavailable` | Linux with danser 0.11 and no `DISPLAY` / `WAYLAND_DISPLAY`. Start it from your desktop session or use danser 0.12+. |
| `hardware_encoder_unavailable` | No GPU encoder passed the self-test; rendering on the CPU (slower). See below. |
| `encoder_unavailable` | The encoder set in `RENDER_ENCODER` failed (x264 is used if it works), or no encoder works at all. |
| `storage_low` | Less than 8 GiB free in `DATA_DIR`. |

**A GPU encoder fails the self-test.** Run `npm run doctor` and look at `encoderProbes[].error`:

- NVIDIA: `Driver does not support the required nvenc API version` or `No capable devices found` means the
  driver is too old or the NVIDIA GPU is not active (laptops: plug in power and check the GPU is not disabled).
  Update the driver.
- AMD: `amfrt64.dll` / AMF errors mean the Adrenalin driver is missing or outdated.
- Intel: QSV / MFX session errors usually mean the iGPU is disabled in the BIOS/UEFI or the driver is outdated.
  On Linux install `intel-media-driver` and `vpl-gpu-rt`.

**Laptop with two GPUs (NVIDIA Optimus / AMD switchable graphics).** danser's OpenGL may run on the integrated
GPU. Open Windows **Settings → System → Display → Graphics**, add `danser-cli.exe`, choose **Options → High
performance** and save. The per-program setting in the NVIDIA Control Panel works too.

**Check what danser actually used.** danser writes `danser.log` in its own folder on every run. It contains the
`danser-go version`, the OpenGL vendor/renderer/version that was really used (so you can see which GPU drew the
frames), and the FFmpeg path and arguments.

**`RENDER_TIMEOUT`.** A render took longer than 30 minutes and was stopped. This mostly happens with the CPU
fallback on a slow machine; try 720p, fix the GPU encoder, or check the render log in `data/logs/`.

**Windows SmartScreen / Defender blocks danser.** danser's executables are not signed. Download danser only
from its [GitHub releases](https://github.com/Wieku/danser-go/releases). Before extracting, you can right-click
the zip → **Properties** → tick **Unblock**. If SmartScreen still appears, choose **More info → Run anyway**.
If Defender quarantines a file, restore it and add an exclusion for the danser folder.

**PowerShell says "running scripts is disabled on this system" for `npm`.** Run `npm.cmd` instead of `npm`, or
allow local scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**`npm ci` tries to compile `better-sqlite3`.** Use a 64-bit Node.js 22 or 24 (prebuilt binaries exist for
those); other versions need Visual Studio Build Tools.

**Port already in use (`EADDRINUSE`).** Another program uses port 3030. Set another `PORT` in `.env`, or find the
process: `Get-NetTCPConnection -LocalPort 3030` (Windows) / `ss -ltnp 'sport = :3030'` (Linux).

**Renders fail on Windows only when started in the background.** The service must run in your desktop session,
see the [Windows quick start](#quick-start-windows).

## Development

```sh
npm ci
npm run dev     # run from TypeScript with tsx
npm test        # build, then run the node:test suite
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the tests on Ubuntu and Windows (Node 24, plus
Node 22 on Ubuntu) and a smoke job that downloads danser 0.12.1 on both and checks that `npm run doctor` finds
danser and FFmpeg and that the x264 self-test passes. CI runners have no GPU, so hardware encoders are only
tested by people running the doctor on real machines.

## License & credits

[MIT](LICENSE) © 2026 956zs.

- Rendering by [danser-go](https://github.com/Wieku/danser-go) by Wieku (not bundled; download it separately).
- osu! is a trademark of ppy Pty Ltd. This project is not affiliated with or endorsed by ppy.
