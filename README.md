# osu-render

**English** · [繁體中文](README.zh-TW.md) · [Español](README.es.md)

Self-hosted osu! replay (`.osr`) to MP4 render service powered by [danser-go](https://github.com/Wieku/danser-go).
Drop a replay into the web page: the service looks the beatmap up through the osu! API, downloads it from a
mirror, renders it with danser and gives you a 720p or 1080p, 60 FPS MP4. Video encoding runs on your GPU
(NVIDIA NVENC, AMD AMF or Intel Quick Sync) when it can and falls back to the CPU (x264) when it cannot.

<p>
  <img src="docs/screenshot-en.png" alt="osu-render web UI on desktop: the Render tab with the hit-circle drop zone, presets and quick settings, and the side rail" width="600">
  <img src="docs/screenshot-mobile-es.png" alt="osu-render Render tab on a phone, in Spanish, with the update notice and the floating tab bar" width="190">
</p>

> **Windows and NVIDIA/AMD support is new and needs testers.** If you have one of those setups, the
> [Windows portable zip](#windows-quick-start-portable-zip-recommended) is the easiest way to try it, and
> [sending a report](#reporting-results-for-testers) helps a lot.

## Contents

- [Features](#features)
- [Platform & GPU support](#platform--gpu-support)
- [Windows quick start: portable zip (recommended)](#windows-quick-start-portable-zip-recommended)
- [Custom skins](#custom-skins)
- [Render history and retention](#render-history-and-retention)
- [Local osu! Songs folder](#local-osu-songs-folder)
- [Updating](#updating)
- [Reporting results (for testers)](#reporting-results-for-testers)
- [FAQ](#faq)
- [Install from source](#install-from-source)
  - [Requirements](#requirements)
  - [osu! OAuth application](#osu-oauth-application)
  - [Windows from source](#windows-from-source)
  - [Linux](#linux)
- [Configuration](#configuration)
- [How encoder selection works](#how-encoder-selection-works)
- [HTTP API](#http-api)
- [Security notes](#security-notes)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [License & credits](#license--credits)

## Features

- Drag-and-drop web UI in English, 繁體中文 and Español with **Render**, **History**, **Skins** and **Diagnostics**
  tabs in a dark theme built from osu! shapes: a hit-circle drop zone and an approach-ring progress meter (on
  phones the tabs become a floating bottom bar).
- Quick settings next to the drop zone, every other option in a searchable **All settings** panel, named
  presets saved in your browser and **Reset to defaults**.
- Step-by-step job view (uploaded → finding beatmap → downloading → queued → rendering → done) with an approach-ring percentage,
  render speed, time left and map length, and an inline video preview when it finishes. A render in progress is picked up again
  after a page reload.
- Upload only the replay. The beatmap is found by its checksum through the osu! API, downloaded from
  configurable mirrors (with fallback) and checked against the replay's MD5 before rendering.
- 720p or 1080p at 60 FPS, H.264 video with AAC audio.
- Per-render visual options: skip intro, volumes, background dim/blur/parallax, bloom, playfield scale,
  cursor size/trail/effects, skin or beatmap colours, HUD elements and hit object details.
- Custom skins: upload an `.osk` on the **Skins** tab (or drop it into `data/skins`) and pick it per render.
- GPU encoder auto-detection with a real one-frame self-test, x264 fallback.
- Persistent FIFO queue (SQLite), one render at a time, recovery after a crash or restart.
- Disk guard: renders are refused when free space is low; old videos and replays expire after 24 hours
  (`VIDEO_RETENTION_HOURS`) and cached beatmaps are evicted least-recently-used first.
- Render history per client, with preview, download and delete buttons.
- Uses maps from a local osu!stable `Songs` folder before downloading, so unsubmitted maps work too.
- Small HTTP API with Range downloads and an optional bearer token.
- Built-in diagnostics report (`doctor.bat`, `npm run doctor` or the web UI) for bug reports.
- Windows portable zip: Node.js and danser-go included, nothing to install.

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

## Windows quick start: portable zip (recommended)

The portable zip contains everything: the app, a Node.js runtime and danser-go with its FFmpeg. You do not
need to install Node.js, Git or danser. Windows 10 or 11, 64-bit.

1. **Download** `osu-render-<version>-win-x64.zip` from the
   [latest release](https://github.com/956zs/osu-render/releases/latest).
2. **Unzip it anywhere you can write to**, for example `C:\osu-render` or a folder in `Documents`. Not inside
   `C:\Program Files` (the service writes its data next to itself) and not inside a cloud-synced folder.
   Optional: before unzipping, right-click the zip → **Properties** → tick **Unblock**, so Windows asks fewer
   questions later.
3. **Create an osu! OAuth application** (one-time, takes a minute):
   1. Open <https://osu.ppy.sh/home/account/edit>, scroll to **OAuth** and click **New OAuth Application**.
   2. Pick any name. For **Application Callback URL** use `http://127.0.0.1:3030/` (it is never called, the
      field may also stay empty).
   3. Keep the page open: you need the **Client ID** (a number) and the **Client Secret**.
4. **Double-click `start.bat`.** On the first run it asks for the client ID and the client secret (typing is hidden;
   paste it and press Enter) and saves them to `.env` in the same folder. The secret stays on your PC; do not share it.
5. **Your browser opens <http://127.0.0.1:3030/>** as soon as the service is ready. Drop a `.osr` replay on the page.
   The chip at the top right shows which encoder is in use (for example *GPU · NVIDIA NVENC*).

**Keep the console window open.** It is the service: closing it stops the service and any render in progress.
Run `start.bat` again to start it next time (the setup questions are only asked once).

> [!IMPORTANT]
> danser needs OpenGL 3.3 from your GPU driver, which only exists in your **logged-in desktop session**. Run
> `start.bat` from your desktop as your normal user. It does not work as a Windows Service, from a scheduled
> task set to "Run whether user is logged on or not", or over SSH/remote shells.

**SmartScreen and Defender.** The batch files and danser's executables are not code-signed. If SmartScreen
shows "Windows protected your PC", click **More info → Run anyway**. Defender may scan `danser-cli.exe` and
FFmpeg the first time, which can make the first start or render slow; if it quarantines a file, restore it and
add an exclusion for the `danser` folder. Only download the zip from this repository's
[Releases](https://github.com/956zs/osu-render/releases) page.

**Changing settings.** Edit `.env` in the unzipped folder with Notepad (see [Configuration](#configuration)), then
close the console window and run `start.bat` again. To redo the first-run questions, delete `.env`.

**Updating to a new version.** From 0.4.0 on, click **Update now** in the banner at the top of the page; see
[Updating](#updating).

**What is inside the zip** (top folder `osu-render\`):

| Path | What it is |
| --- | --- |
| `start.bat` | Starts the service (asks for the osu! credentials on the first run) and opens the browser. |
| `set-webhook.bat` | Sets the developer report webhook in `.env`, see [Reporting results](#reporting-results-for-testers). |
| `doctor.bat` | Runs the diagnostics check and opens the folder with the report, see [Reporting results](#reporting-results-for-testers). |
| `runtime\node.exe` | Node.js 24 LTS (official Windows x64 build, checksum-verified when the zip is built). |
| `danser\` | danser-go 0.12.1 for Windows, unmodified, including its FFmpeg build. |
| `dist\`, `public\`, `config\`, `node_modules\`, `package.json` | The app itself (compiled, production dependencies only). |
| `scripts\windows\setup.ps1` | The first-run setup used by `start.bat`. |
| `scripts\windows\apply-update.ps1` | Installs a downloaded update when `start.bat` restarts the service, see [Updating](#updating). |
| `VERSION.json` | The versions of osu-render, Node.js and danser in this zip (read by the updater). |
| `.env.example` | Template for `.env`, with every setting explained. |
| `README*.md`, `LICENSE`, `THIRD_PARTY_NOTICES.txt` | Documentation, this project's license and the licenses of the bundled software. |

`data\` (database, replays, videos, beatmap cache, logs and reports) and `.env` are created next to these files
on the first run.

The bundled third-party software keeps its own license: Node.js (MIT and others), danser-go (GPL-3.0) and the
FFmpeg build shipped inside danser, plus the npm packages in `node_modules`. `THIRD_PARTY_NOTICES.txt` in the zip
lists them.

## Custom skins

Open the **Skins** tab and drop an `.osk` file on it (or click to choose one). The skin is installed on the
server and selected for your next render; it stays in the list for later renders. **Use for next render** picks
an installed skin, and the **Skin** list in **Quick settings** on the **Render** tab does the same. Turn on
**Use the skin's cursor** (under **All settings**) to draw the skin's cursor instead of danser's. Uploading a skin with the same name
replaces the old one.

You can also add skins by hand: copy a skin folder (the one that contains `skin.ini`) or an `.osk` file into
the skins folder: `data\skins` in the portable zip, `data/skins` otherwise (`DANSER_SKINS_DIR` changes it).
Loose `.osk` files are unpacked the next time the page loads the skin list. `default` is danser's built-in
skin. Limits (200 MiB per `.osk`, size once unpacked, file count) are in `config/defaults.json` under `skins`.

## Render history and retention

The **History** tab lists your recent renders on this server (newest first, up to 20): beatmap, player, mods,
resolution, encoder, how long the render took and when its files will be deleted. Finished videos have
**Preview** (plays the video on the page) and **Download** buttons. **Delete files** removes the video, replay and log right away; the entry stays in the list
marked as deleted. The list only shows renders uploaded from your own address (on the portable zip that is just
your PC) and refreshes while a render is running.

Videos, replays and logs of finished, failed and cancelled renders are kept for `VIDEO_RETENTION_HOURS` hours
(default 24, from 1 to 720) and then deleted automatically. Set it in `.env` and restart.

## Local osu! Songs folder

If osu!stable is installed on the same PC, maps you already have are copied from its `Songs` folder instead of
being looked up and downloaded, so unsubmitted and local-only maps render too and nothing is downloaded.

- Windows: `%LOCALAPPDATA%\osu!\Songs` is found automatically. Turn this off with
  `"localSongs": { "autoDetect": false }` in `config/local.json`.
- Other folders: set `OSU_SONGS_DIRS` in `.env`, several folders separated by `;` on Windows or `:` on Linux.
- At startup the folder is indexed in the background (only new or changed `.osu` files are read again), so the
  first start after installing can take a minute with a big Songs folder. Renders still work meanwhile and use
  the API and mirrors for maps not indexed yet. Progress is in the log, and the index status is in diagnostics.
- The beatmap set is copied into `data/songs`; your osu! folder is never changed. Linked folders are skipped.
- If the local copy fails for any reason, the service falls back to the osu! API and mirrors.
- osu!lazer is not supported (it stores files by hash, not in a Songs folder).

## Updating

**Portable zip, 0.4.0 and later: update from the web page.** When osu-render starts, and when you open the page
(then every 10 minutes, also while the page is open), it asks GitHub for the newest release. If there is one, a banner at the top of the page
says *osu-render X is available*. Click **Update now** and confirm:

1. The service downloads the new zip from this repository's
   [Releases](https://github.com/956zs/osu-render/releases), checks its SHA-256 checksum and unpacks it into
   `data\update\staging\`. If any of this fails, nothing is changed and the page says so.
2. osu-render stops, `start.bat` installs the new files in the same window and starts it again. The page reloads by
   itself and says *Updated to osu-render X*.

Kept as they are: `.env`, the `data` folder (renders, uploaded skins, beatmap cache, logs), `config\local.json`, and
danser's `settings` folder, `danser.db` and `skins` folder. danser itself is only replaced when the new release
ships a different danser version. The previous app files are moved to `data\update\backup-<old version>` (only the
newest backup is kept). If installing fails, they are put back automatically and the old version starts again;
the details are in `data\update\apply-update.log`.

The update is refused while a render is queued or running: wait for it to finish. It only works when the service
was started with `start.bat`. To turn off the update checks, create `config\local.json` with
`{ "update": { "enabled": false } }`.

**Portable zip, by hand** (needed once for versions before 0.4.0, which have no update button):

1. Close the console window.
2. Unzip the new version into a **new** folder.
3. Copy `.env` and the whole `data` folder from the old folder into the new one. If you created or edited
   `danser\settings\default.json`, copy it too.
4. Run `start.bat` from the new folder. Delete the old folder once everything works.

**Source installs** (`git clone`): the banner only shows a hint, because the service cannot replace its own git
checkout. Update with:

```sh
git pull
npm ci
npm run build
```

then restart the service (`sudo systemctl restart osu-render` with the systemd unit, or stop and run `npm start`
again).

## Reporting results (for testers)

Whether it works or not, a report tells us which GPU, driver and encoder you have and how each encoder
self-test went.

### Easiest: send reports to the developer automatically

If the maintainer gave you a **report webhook URL** (privately, e.g. in a direct message):

1. Run `start.bat` once if you have not yet (the first run creates `.env`; it also asks for this URL, and you can
   paste it there and skip the next step).
2. Double-click **`set-webhook.bat`** in the osu-render folder, paste the URL and press Enter. The input stays
   hidden; an invalid URL is refused and asked again. Your other settings in `.env` are kept.
3. Close the `start.bat` window and run `start.bat` again. The black window shows a warning if the URL in `.env`
   is not valid.

Fallback, by hand: right-click `.env` → **Open with** → **Notepad**, find the line `REPORT_WEBHOOK_URL=` near the
end and paste the URL right after the `=`, with no quotes or spaces (a `.env` from an older version has no such
line: add it at the end). Save and restart. Windows hides file extensions by default, so make sure the file is
really named `.env` and not `.env.txt`: Notepad sometimes adds `.txt` when saving, and osu-render ignores
`.env.txt` (`start.bat` warns when it finds one). In File Explorer, **View → Show → File name extensions**
shows the real name.

From then on, every finished render (successful, failed or timed out; not cancelled) sends a redacted report
to the maintainer's Discord channel, and the **Diagnostics** tab gets a **Send to developer** button for
sending one by hand (for example after a startup problem). Automatic reports reuse the startup encoder
self-test instead of running a new one, so they never interrupt rendering. If the URL is wrong, the service
prints a warning at startup (and logs `report_webhook_invalid`) and keeps running without reporting; with a valid
URL it logs `report_webhook_enabled`.

Keep the URL to yourself: anyone who has it can post messages to that channel.

### Other ways to send a report

Any of these produces the same report:

- **Windows zip:** double-click **`doctor.bat`**. It prints a summary, saves
  `data\diagnostics\doctor-<timestamp>.json` and opens that folder in Explorer. You can run it while the
  service is running or stopped.
- **Web UI:** the **Diagnostics** tab has **Download report** (the JSON file), **Copy summary** (short text for
  chat) and **Open GitHub issue** (opens a pre-filled issue form in a new tab). Collecting the report can take
  a few seconds because it self-tests every encoder. The same tab shows the renderer status (encoder, display,
  free disk space) and, once a report has been collected, the result of each encoder self-test.
- **From source:** `npm run doctor` (summary) or `npm run doctor -- --json` (prints the JSON). Both also write
  the file to `data/diagnostics/`. `GET /api/diagnostics` returns the JSON too.

The doctor self-tests **every** supported encoder, not just the first that works, so one report shows the whole
NVENC / AMF / QSV / x264 picture. Then either open an issue with the
[GPU / platform report](https://github.com/956zs/osu-render/issues/new?template=gpu-report.yml) template
(attach or paste the JSON), or send the file to the maintainer directly. If a render failed, mention roughly
when, and what the page showed.

### Privacy

- **Included:** OS name/version/architecture, CPU model, core count, RAM size, GPU names, vendors and driver
  versions, danser and FFmpeg versions and FFmpeg's encoder list, encoder self-test results (with the end of
  FFmpeg's error output), the startup check result, a config summary (host, port, encoder setting, mirror host
  names, and only *whether* OAuth credentials, `AUTH_TOKEN` and `REPORT_WEBHOOK_URL` are set), free disk space,
  metadata of the last 20 renders (status, encoder, resolution, timings, error code and a short tail of danser's
  log, which can mention beatmap titles), and a summary of danser's `danser.log` (versions, GPU used for OpenGL).
- **Excluded:** the OAuth client ID and secret, `AUTH_TOKEN`, the webhook URL, IP addresses, player names, replay and beatmap
  files. Your home folder is replaced with `~` and your user name with `<user>`.
- **Nothing is sent automatically unless you set `REPORT_WEBHOOK_URL`.** Without it, the service never uploads
  anything and you choose whether to share the file. With it, the report described above (plus a short summary
  message) goes to the Discord channel behind that URL after each finished render and when you press **Send to
  developer**. The webhook URL itself is never logged or put in a report. The **Open GitHub issue** button only
  opens a pre-filled page in your browser (that text travels to github.com in the page address); nothing is
  published until you press **Submit**. GitHub issues are public, so read the report before posting it.

## FAQ

**Does it upload anything?**
No telemetry. The service only talks to the osu! API (to get a token and look up the beatmap by its checksum)
and to the beatmap mirrors in `BEATMAP_MIRRORS` (to download the `.osz`). Replays and videos stay on your
machine and are deleted after 24 hours (`VIDEO_RETENTION_HOURS`). Diagnostics reports are only shared if you share them, or if you set
`REPORT_WEBHOOK_URL` (then a redacted report goes to that Discord webhook after each render), see
[Privacy](#privacy).

**Can I run it as a Windows service?**
No. danser needs the OpenGL driver of a logged-in desktop session; Windows services run in session 0, where
only a basic OpenGL 1.1 driver exists, and every render fails. To start it automatically, use a Task Scheduler
task that runs **at log on, only when the user is logged on**, see [Windows from source](#windows-from-source)
(for the zip, point the task at `start.bat`).

**Which GPU is used?**
For video encoding, the first encoder that passes the startup self-test, in the order NVIDIA → AMD → Intel on
Windows (NVIDIA → Intel → AMD on Linux), else the CPU. The chip at the top right of the page shows the result,
and `RENDER_ENCODER` forces a specific one, see [How encoder selection works](#how-encoder-selection-works).
danser's OpenGL drawing is chosen by Windows/the driver and can be a different GPU on laptops, see
[Troubleshooting](#troubleshooting) (dual-GPU laptops and `danser.log`).

**Can friends on my LAN use it?**
Yes. In `.env` set `HOST=0.0.0.0` and a long random `AUTH_TOKEN`, then restart. Allow Node.js through the
Windows Firewall on **private** networks when Windows asks (or add an inbound rule for TCP port 3030). Friends
open `http://<your-PC's-LAN-IP>:3030/` and enter the token under **Service token** at the bottom of **Quick settings** (it opens by itself when the server asks for a token). Renders run one at a
time and each client can have at most 3 unfinished jobs. Do not expose it to the internet without HTTPS, see
[Security notes](#security-notes).

## Install from source

Use this on Linux, or on Windows if you want to run from a Git checkout instead of the zip.

### Requirements

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

### osu! OAuth application

The service uses the osu! API v2 **client credentials** grant: it only reads public beatmap data and never
logs anyone in.

1. Open <https://osu.ppy.sh/home/account/edit>, scroll to **OAuth** and click **New OAuth Application**.
2. Pick any name. The **Application Callback URL** can stay empty. If the form insists on one, use
   `http://127.0.0.1:3030/` (it is never called).
3. Copy the **Client ID** and **Client Secret** into `.env` as `OSU_CLIENT_ID` and `OSU_CLIENT_SECRET`
   (the portable zip's `start.bat` does this for you). The secret stays on the server and is never sent to the
   browser. Do not share it.

### Windows from source

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
   report, see [Reporting results](#reporting-results-for-testers).

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
For the portable zip, run the same commands from the unzipped folder with `-Argument "/c start.bat"` (after
the first run, so `.env` already exists).

### Linux

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

Settings are read from `.env` in the service folder (the repository root, or the unzipped folder for the
portable zip). Variables already set in the real environment win over `.env`. Paths may be absolute or
relative to that folder. Empty values count as unset. Restart the service after editing.

| Variable | Default | Description |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Address to listen on. Read [Security notes](#security-notes) before changing it. |
| `PORT` | `3030` | HTTP port. |
| `DATA_DIR` | `./data` | Database, replays, videos, beatmaps, logs and diagnostics reports. |
| `DANSER_DIR` | `./danser` | Folder where danser is extracted. |
| `DANSER_BIN` | `<DANSER_DIR>/danser-cli` (`.exe` on Windows) | danser CLI binary, if it lives elsewhere. |
| `DANSER_BASE_SETTINGS` | `<DANSER_DIR>/settings/default.json` | danser settings used as the base for renders (see below). |
| `DANSER_SKINS_DIR` | `<DATA_DIR>/skins` | Skins folder passed to danser. |
| `OSU_SONGS_DIRS` | Windows: `%LOCALAPPDATA%\osu!\Songs` if it exists | osu!stable `Songs` folders to use before downloading, separated by `;` (Windows) or `:` (Linux). See [Local osu! Songs folder](#local-osu-songs-folder). |
| `VIDEO_RETENTION_HOURS` | `24` | Hours to keep videos, replays and logs of finished renders, 1 to 720. |
| `DANSER_SETTINGS_NAME` | `service` | Name of the settings file the service writes: `<DANSER_DIR>/settings/<name>.json`. Letters, digits, `-` and `_` only. |
| `RENDER_ENCODER` | `auto` | `auto`, `h264_nvenc`, `hevc_nvenc`, `h264_amf`, `hevc_amf`, `h264_qsv`, `hevc_qsv` or `libx264`. Any other value stops startup with an error. |
| `OSU_CLIENT_ID` | empty | osu! OAuth client ID. Required. |
| `OSU_CLIENT_SECRET` | empty | osu! OAuth client secret. Required. |
| `BEATMAP_MIRRORS` | `https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}` | Comma-separated `.osz` download URLs, tried in order. `{id}` is the beatmapset ID. |
| `AUTH_TOKEN` | empty | If set, every `/api/*` request needs `Authorization: Bearer <token>`. |
| `MAX_QUEUE` | `20` | Maximum number of unfinished jobs. |
| `REPORT_WEBHOOK_URL` | empty | Discord webhook (`https://discord.com/api/webhooks/<id>/<token>`, also `discordapp.com`, `ptb.` and `canary.`) that receives a redacted diagnostics report after every finished render and from the **Send to developer** button. Other URLs are rejected with a startup warning. A secret: never logged or put in reports. See [Reporting results](#reporting-results-for-testers). |

**danser base settings.** The service copies `DANSER_BASE_SETTINGS`, overrides what it must (folders, 60 FPS,
encoder, output) and writes the result to `<DANSER_DIR>/settings/<DANSER_SETTINGS_NAME>.json`. If the base file
does not exist, danser's built-in defaults are used. To get a base file you can tweak (skin, cursor and so on),
run `danser-cli -noupdatecheck` once from the danser folder: it creates `settings/default.json`, prints
`No beatmap specified, closing...` and exits.

Tunables that are not secrets live in [`config/defaults.json`](config/defaults.json): the encoder auto order
per platform, self-test size and timeout, diagnostics sizes, the issue link, and the report webhook's
timeout, 429 retry cap, spacing between messages and log tail sizes (`reportWebhook`), and the update checks
(`update`: on/off, GitHub repository, check interval, download size limits and allowed download hosts), and how
long signed video preview links stay valid (`preview.ttlSeconds`, default 3600). To change them, create
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

## HTTP API

If `AUTH_TOKEN` is set, add `-H "Authorization: Bearer $AUTH_TOKEN"` to every `/api/*` call.

| Method & path | Description |
| --- | --- |
| `POST /api/renders` | Multipart upload: `replay` (the `.osr`, max 5 MiB) and optional `options` (JSON string). Returns `{ "id", "status" }`. |
| `GET /api/renders/:id` | Job status, progress, queue position, beatmap (`id`, `beatmapsetId`, `checksum`, `title`, `artist`, `version`), output format, `startedAt`, `renderMs` and error. While rendering, `speed` (a number such as `1.42`) and `eta` (text as printed by danser); once completed, `previewUrl` (a signed video link, see below). |
| `GET /api/renders/:id/video` | The finished MP4, named `Artist - Title [Version].mp4`. Supports HTTP `Range`. Also accepts the signed `previewUrl` (`?exp=<unix seconds>&sig=<hex>`) instead of the Bearer header, so a `<video>` element can play it. Signed links expire after `preview.ttlSeconds` (default 1 hour) and stop working when the service restarts (the key is random per process); an invalid or expired link returns `UNAUTHORIZED` (403). |
| `DELETE /api/renders/:id` | Cancel a job. |
| `GET /api/renders?limit=N` | Your recent renders (same client address only, default 20, max 100): `{ "renders": [{ "id", "status", "createdAt", "completedAt", "expiresAt", "beatmap": { "id", "beatmapsetId", "title", "artist", "version" }, "player", "mods", "resolution", "encoder", "renderMs", "videoAvailable", "filesDeleted", "error", "previewUrl" }] }`. |
| `DELETE /api/renders/:id/files` | Deletes the video, replay and log of your own finished render now; the history entry stays. Error `RENDER_ACTIVE` (409) while it is still running. A deleted video returns `RENDER_EXPIRED` (410). |
| `GET /api/skins` | Installed skins: `{ "skins": [{ "name" }] }`, built-in `default` first. |
| `POST /api/skins` | Multipart upload: `skin` (an `.osk`). Installs it and returns `{ "name" }`, or error `SKIN_INVALID` (422) / `SKIN_TOO_LARGE` (413). |
| `GET /api/update` | Update status: `{ "current", "latest", "available", "portable", "enabled", "notesUrl", "checkedAt" }`, plus `error` when the last GitHub check failed. GitHub is asked at most every `update.checkIntervalMs`. |
| `POST /api/update/apply` | Portable zip started by `start.bat` only: downloads, verifies and stages the newest release, answers `{ "applying": true, "version" }`, then restarts through `start.bat` to install it. Errors: `UPDATE_NOT_PORTABLE` (409), `UPDATE_BUSY` (409, a render is unfinished or an update is running), `UPDATE_FAILED` (502, nothing was changed). |
| `GET /api/diagnostics` | Diagnostics report (same JSON as `npm run doctor`). |
| `POST /api/diagnostics/send` | Sends the diagnostics report to `REPORT_WEBHOOK_URL`. Returns `{ "sent": true }`, or error `REPORT_WEBHOOK_DISABLED` (409, not configured) / `REPORT_SEND_FAILED` (502). |
| `GET /health` | Service health (no auth): `status`, `renderer`, `display`, `encoder`, `encoderKind`, `platform`, `queue`, `freeDiskBytes`, `reason`, `reportWebhook`. |

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
  you do not trust. The signed, short-lived `previewUrl` video links are the only way to reach an `/api` route
  without the token.
- The page is served with a strict Content-Security-Policy: scripts, styles and requests are same-origin only,
  no inline scripts or styles, and the page cannot be framed (`frame-ancestors 'none'`).
- The browser cannot pass arbitrary danser or FFmpeg arguments or file paths. Render options are checked
  against a whitelist and turned into a fixed set of danser flags and settings patches.
- Downloaded `.osz` archives are extracted defensively: limits on entry count and total size, no absolute
  paths, `..`, symlinks or other special files, no Windows-reserved names (`CON`, `NUL`, `COM1`…) or
  case-insensitive duplicates, and the `.osu` file must match the replay's beatmap MD5.
- The OAuth secret, `AUTH_TOKEN` and `REPORT_WEBHOOK_URL` stay in `.env` (ignored by git) and are never sent to
  the browser or put in diagnostics reports or logs. Reports only go to Discord when `REPORT_WEBHOOK_URL` is set,
  and only to `discord.com` / `discordapp.com`.

## Troubleshooting

**`/health` is degraded.** The `reason` field (also shown in the status chip on the page) says why:

| Reason | Meaning / what to do |
| --- | --- |
| `renderer_unavailable` | danser-cli was not found. Check `DANSER_DIR` / `DANSER_BIN`; on Linux run `chmod +x`. With the zip, check that `danser\danser-cli.exe` exists (Defender may have quarantined it). |
| `display_unavailable` | Linux with danser 0.11 and no `DISPLAY` / `WAYLAND_DISPLAY`. Start it from your desktop session or use danser 0.12+. |
| `hardware_encoder_unavailable` | No GPU encoder passed the self-test; rendering on the CPU (slower). See below. |
| `encoder_unavailable` | The encoder set in `RENDER_ENCODER` failed (x264 is used if it works), or no encoder works at all. |
| `storage_low` | Less than 8 GiB free in `DATA_DIR`. |

**A GPU encoder fails the self-test.** Run `doctor.bat` / `npm run doctor` and look at `encoderProbes[].error`
in the report:

- NVIDIA: `Driver does not support the required nvenc API version` or `No capable devices found` means the
  driver is too old or the NVIDIA GPU is not active (laptops: plug in power and check the GPU is not disabled).
  Update the driver.
- AMD: `amfrt64.dll` / AMF errors mean the Adrenalin driver is missing or outdated.
- Intel: QSV / MFX session errors usually mean the iGPU is disabled in the BIOS/UEFI or the driver is outdated.
  On Linux install `intel-media-driver` and `vpl-gpu-rt`.

**Laptop with two GPUs (NVIDIA Optimus / AMD switchable graphics).** danser's OpenGL may run on the integrated
GPU. Open Windows **Settings → System → Display → Graphics**, add `danser-cli.exe` (in the zip: the `danser`
folder), choose **Options → High performance** and save. The per-program setting in the NVIDIA Control Panel
works too.

**Check what danser actually used.** danser writes `danser.log` in its own folder on every run. It contains the
`danser-go version`, the OpenGL vendor/renderer/version that was really used (so you can see which GPU drew the
frames), and the FFmpeg path and arguments. Per-render logs are kept in `data/logs/`.

**`RENDER_TIMEOUT`.** A render took longer than 30 minutes and was stopped. This mostly happens with the CPU
fallback on a slow machine; try 720p, fix the GPU encoder, or check the render log in `data/logs/`.

**`start.bat` or `doctor.bat` says "osu-render files are missing".** The zip was opened in Explorer's zip view or
only partly extracted. Right-click the zip → **Extract All**, then run the `.bat` from the extracted folder.

**`start.bat` says the port is already in use.** osu-render is probably already running in another window, so it
opens the page and stops. If the page shows something else, set another `PORT` in `.env`.

**`start.bat` says "osu-render stopped with an error".** Read the text above that line, then run `doctor.bat`
and send the report. Do not unzip into `C:\Program Files` (the folder must be writable).

**Windows SmartScreen / Defender blocks danser.** danser's executables are not signed. Download danser only
from its [GitHub releases](https://github.com/Wieku/danser-go/releases) (or use the zip from this project's
releases). Before extracting, you can right-click the zip → **Properties** → tick **Unblock**. If SmartScreen
still appears, choose **More info → Run anyway**. If Defender quarantines a file, restore it and add an
exclusion for the danser folder.

**PowerShell says "running scripts is disabled on this system" for `npm`.** Run `npm.cmd` instead of `npm`, or
allow local scripts once: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

**`npm ci` tries to compile `better-sqlite3`.** Use a 64-bit Node.js 22 or 24 (prebuilt binaries exist for
those); other versions need Visual Studio Build Tools.

**Port already in use (`EADDRINUSE`).** Another program (or a second copy of the service) uses port 3030. Set
another `PORT` in `.env`, or find the process: `Get-NetTCPConnection -LocalPort 3030` (Windows) /
`ss -ltnp 'sport = :3030'` (Linux).

**Renders fail on Windows only when started in the background.** The service must run in your desktop session,
see [Can I run it as a Windows service?](#faq).

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

Releases are automatic: **bump the version in `package.json`, push to main, and the release is published
automatically.** (`npm version 0.5.0 --no-git-tag-version` updates `package.json` and `package-lock.json`
together.) On every push to main, `.github/workflows/release.yml` checks whether the tag `v<version>` exists. If it
does not, it assembles the Windows portable zip from the files in `packaging/` on a Windows runner, smoke-tests the
extracted copy (including an in-app update with danser kept and replaced, a rollback, and the `start.bat` restart on
exit code 75), then creates the tag and the GitHub Release with the zip and its SHA-256 checksum. Pushes that leave
the version alone publish nothing. Pushing a `v*` tag by hand still works; the release is only created once.

## License & credits

[MIT](LICENSE) © 2026 956zs.

- Rendering by [danser-go](https://github.com/Wieku/danser-go) by Wieku (GPL-3.0). Not part of this repository;
  the Windows portable zip bundles an unmodified copy.
- The portable zip also bundles [Node.js](https://nodejs.org/). See `THIRD_PARTY_NOTICES.txt` in the zip.
- osu! is a trademark of ppy Pty Ltd. This project is not affiliated with or endorsed by ppy.
