## Windows portable package

`osu-render-@VERSION@-win-x64.zip` is a ready-to-run package for Windows 10/11 (64-bit). Nothing else needs to be installed.

**What's inside**

- osu-render @VERSION@ (web UI + render queue), with production dependencies only
- Node.js @NODE_VERSION@ (`runtime\node.exe`)
- danser-go @DANSER_VERSION@ for Windows (`danser\`), including its FFmpeg build
- `start.bat` (start osu-render), `doctor.bat` (diagnostics report), `scripts\windows\setup.ps1` (first-run setup)

**Quick start**

1. Download the zip. Optional but recommended: right-click it, **Properties**, tick **Unblock**, **OK**.
2. Right-click the zip, **Extract All...**, and pick a folder with a few GB free (renders and beatmaps are stored in `data\` next to `start.bat`).
3. Open the extracted `osu-render` folder and double-click `start.bat`.
4. On the first run it asks for your osu! API **Client ID** and **Client Secret**. Create them at <https://osu.ppy.sh/home/account/edit> in the **OAuth** section (**New OAuth Application**, any name, leave the callback URL empty or use `http://127.0.0.1:3030/`). The secret is typed hidden and saved only in the `.env` file in that folder.
5. Your browser opens <http://127.0.0.1:3030/> when the service is ready. Keep the black window open while you use it; close it to stop osu-render.

Notes:

- osu-render must run in a normal, logged-in desktop session (danser needs a desktop to render). It does not work as a Windows service.
- Windows SmartScreen may say "Windows protected your PC" because the scripts are not signed: click **More info** and **Run anyway**. Unblocking the zip before extracting (step 1) avoids most of these prompts.
- The GPU encoder (NVIDIA NVENC, AMD AMF, Intel Quick Sync) is detected automatically and falls back to the CPU (libx264). To force one, edit `RENDER_ENCODER` in `.env`.
- If start.bat says the port is in use, osu-render is probably already running in another window. Change `PORT` in `.env` to use another port.

**Sending diagnostics**

If something does not work, or to report how your GPU performs:

- double-click `doctor.bat`, then attach the newest `data\diagnostics\doctor-*.json` file, or
- open the **Diagnostics** card in the web UI and use download / copy summary, or
- open a [GPU report issue](https://github.com/956zs/osu-render/issues/new?template=gpu-report.yml) with the summary.

Reports stay on your PC until you send them. Your osu! client secret is never included and your Windows user name is masked.

**Third-party software**

This package bundles [danser-go](https://github.com/Wieku/danser-go) by Wieku (GPL-3.0, unmodified official release [@DANSER_VERSION@](https://github.com/Wieku/danser-go/releases/tag/@DANSER_VERSION@)), the FFmpeg build that ships with it (GPL-3.0-or-later, <https://ffmpeg.org/>) and [Node.js](https://nodejs.org/) (MIT). They are separate projects by their own authors; see `THIRD_PARTY_NOTICES.txt` in the zip. osu-render itself is MIT-licensed.

**Checksum (SHA-256)**

```
@SHA256@  osu-render-@VERSION@-win-x64.zip
```
