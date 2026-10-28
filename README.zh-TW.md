# osu-render

[English](README.md) · **繁體中文** · [Español](README.es.md)

自架的 osu! replay（`.osr`）轉 MP4 渲染服務，底層使用 [danser-go](https://github.com/Wieku/danser-go)。
把 replay 拖進網頁後，服務會透過 osu! API 找到對應圖譜、從 mirror 下載、交給 danser 渲染，最後產生
720p 或 1080p、60 FPS 的 MP4。影片編碼會盡量使用 GPU（NVIDIA NVENC、AMD AMF 或 Intel Quick Sync），
不能用時改用 CPU（x264）。

> **Windows 與 NVIDIA/AMD 支援是新功能，需要測試者。** 如果你有這類環境，執行 `npm run doctor` 並把報告傳回來
> 會很有幫助。詳見 [診斷與回報](#診斷與回報)。

## 目錄

- [功能](#功能)
- [平台與 GPU 支援](#平台與-gpu-支援)
- [需求](#需求)
- [osu! OAuth 應用程式](#osu-oauth-應用程式)
- [Windows 快速開始](#windows-快速開始)
- [Linux 快速開始](#linux-快速開始)
- [設定](#設定)
- [編碼器如何選擇](#編碼器如何選擇)
- [診斷與回報](#診斷與回報)
- [HTTP API](#http-api)
- [安全性說明](#安全性說明)
- [疑難排解](#疑難排解)
- [開發](#開發)
- [授權與致謝](#授權與致謝)

## 功能

- 拖放式網頁介面，支援 English、繁體中文、Español。
- 只需上傳 replay。服務會用 checksum 透過 osu! API 找圖譜，從可設定的 mirror 下載（失敗會換下一個），
  渲染前再比對 replay 的 MD5。
- 720p 或 1080p、60 FPS，H.264 影像搭配 AAC 音訊。
- 每個任務可單獨調整畫面：跳過前奏、音量、背景暗度／模糊／視差、Bloom、遊戲區縮放、游標大小／軌跡／特效、
  Skin 或圖譜配色、HUD 元件與 hit object 細節。
- 自動偵測 GPU 編碼器，並實際編碼一個 frame 做自我測試；失敗時改用 x264。
- SQLite 持久化 FIFO 佇列，一次只渲染一個任務，當機或重啟後可自動恢復。
- 磁碟保護：剩餘空間不足時拒絕新任務；影片與 replay 24 小時後過期，快取圖譜依最久未使用（LRU）清除。
- 精簡的 HTTP API，影片下載支援 Range，可選用 bearer token。
- 內建診斷報告（`npm run doctor` 或網頁介面），方便回報問題。

## 平台與 GPU 支援

| 平台 | 編碼器 | 狀態 |
| --- | --- | --- |
| Linux | Intel Quick Sync（`h264_qsv`） | 已驗證 |
| Linux | NVIDIA NVENC（`h264_nvenc`） | 已實作，需要測試者 |
| Linux | AMD AMF（`h264_amf`） | 實驗性：需要 AMD 專有的 AMF runtime，多數環境會退回 x264 |
| Windows 10 / 11 | NVIDIA NVENC（`h264_nvenc`） | 已實作，需要測試者 |
| Windows 10 / 11 | AMD AMF（`h264_amf`） | 已實作，需要測試者 |
| Windows 10 / 11 | Intel Quick Sync（`h264_qsv`） | 已實作，需要測試者 |
| 全部 | CPU x264（`libx264`） | 備援，一定可用（較慢） |
| macOS | — | 不支援 |

HEVC 版本（`hevc_nvenc`、`hevc_amf`、`hevc_qsv`）可用 `RENDER_ENCODER` 強制指定。

## 需求

- **Node.js 22.12 以上**（建議使用目前的 LTS）。Windows 請用 64 位元版本。
- **danser-go 0.11 以上，建議 0.12.1。** 從 [danser-go releases](https://github.com/Wieku/danser-go/releases)
  下載對應作業系統的 zip。裡面已附 danser 使用的 FFmpeg，不需要另外安裝 FFmpeg。
- **osu! OAuth 應用程式**（client ID 與 secret），見[下方](#osu-oauth-應用程式)。
- **GPU 驅動程式**（想用硬體編碼時）：
  - NVIDIA：較新的 GeForce/Studio 驅動。太舊的驅動在 NVENC 自我測試會出現
    `Driver does not support the required nvenc API version`。
  - AMD：Windows 上安裝 Adrenalin 驅動（內含 AMF runtime）。Linux 上 AMF 需要 AMD 專有 runtime，
    多數發行版沒有提供。
  - Intel：Intel 顯示驅動，而且內顯必須啟用。有獨立顯卡的桌機常在 BIOS/UEFI 把內顯關掉
    （找「iGPU Multi-Monitor」之類的選項）。Linux 上 Quick Sync 另外需要 `intel-media-driver` 與 oneVPL GPU
    runtime（`vpl-gpu-rt`，部分發行版叫 `libmfx-gen1` / `onevpl-intel-gpu`）。
- **磁碟空間：** 建議保留至少 15 GiB。低於 8 GiB 時會拒絕新任務。

## osu! OAuth 應用程式

服務使用 osu! API v2 的 **client credentials** 授權：只讀取公開的圖譜資料，不做任何使用者登入。

1. 開啟 <https://osu.ppy.sh/home/account/edit>，捲到 **OAuth**，按 **New OAuth Application**。
2. 名稱隨意。**Application Callback URL** 可以留白；如果表單強制要求，填 `http://127.0.0.1:3030/`
   （服務不會用到它）。
3. 把 **Client ID** 與 **Client Secret** 填進 `.env` 的 `OSU_CLIENT_ID` 與 `OSU_CLIENT_SECRET`。
   secret 只留在伺服器端，不會送到瀏覽器。不要分享給別人。

## Windows 快速開始

> [!IMPORTANT]
> 服務必須在**你已登入的 Windows 桌面工作階段**中執行（一般的終端機視窗，或「只在使用者登入時執行」的工作排程器
> 工作）。它**無法**以 Windows 服務、「不論使用者登入與否均執行」或透過 SSH 執行：這些情況跑在 session 0 或
> 非互動式工作階段，只有 GDI Generic OpenGL 1.1，而 danser 需要 GPU 驅動提供的 OpenGL 3.3。

1. 安裝 [Node.js LTS](https://nodejs.org/) 與 [Git](https://git-scm.com/)（也可以在 GitHub 用
   **Code → Download ZIP** 代替 `git clone`）。在 PowerShell：

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install Git.Git
   ```

   裝完後開一個新的 PowerShell 視窗，讓 `node` 與 `npm` 出現在 `PATH`。

2. 從 [danser-go releases](https://github.com/Wieku/danser-go/releases) 下載 `danser-0.12.1-win.zip`，
   解壓縮到例如 `C:\danser`（確認 `C:\danser\danser-cli.exe` 存在）。
   SmartScreen 或 Defender 可能會對未簽章的 exe 發出警告，見[疑難排解](#疑難排解)。

3. 取得程式碼並建立設定檔：

   ```powershell
   git clone https://github.com/956zs/osu-render.git
   cd osu-render
   Copy-Item .env.example .env
   notepad .env
   ```

   至少設定：

   ```ini
   DANSER_DIR=C:/danser
   OSU_CLIENT_ID=12345
   OSU_CLIENT_SECRET=your-secret
   ```

   正斜線（`C:/danser`）或一般反斜線（`C:\danser`）都可以，不要加引號。

4. 安裝、建置、檢查、啟動：

   ```powershell
   npm ci
   npm run build
   npm run doctor
   npm start
   ```

   `npm run doctor` 會列出找到的東西（danser、FFmpeg、GPU、哪些編碼器通過自我測試）並儲存報告，
   見[診斷與回報](#診斷與回報)。

5. 開啟 <http://127.0.0.1:3030/>，拖入 replay。服務執行期間請保持終端機開著。

**選用：登入時自動啟動。** 可以用工作排程器在登入時執行 `npm start`。在專案資料夾的 PowerShell 中：

```powershell
$action   = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm start" -WorkingDirectory (Get-Location).Path
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "osu-render" -Action $action -Trigger $trigger -Settings $settings
```

這會建立一個只在你登入時執行的工作，正是 danser 需要的。不要改成「不論使用者登入與否均執行」。
要移除時執行 `Unregister-ScheduledTask -TaskName osu-render`。

## Linux 快速開始

```sh
# 1. danser（zip 內沒有執行權限，要自己加）
mkdir -p ~/danser
unzip danser-0.12.1-linux.zip -d ~/danser
chmod +x ~/danser/danser ~/danser/danser-cli ~/danser/ffmpeg/bin/ffmpeg ~/danser/ffmpeg/bin/ffprobe
# danser 0.11 是扁平結構：chmod +x ~/danser/danser-cli ~/danser/ffmpeg/ffmpeg ~/danser/ffmpeg/ffprobe

# 2. 服務本體
git clone https://github.com/956zs/osu-render.git ~/osu-render
cd ~/osu-render
cp .env.example .env
$EDITOR .env        # DANSER_DIR=<echo ~/danser 的輸出>、OSU_CLIENT_ID、OSU_CLIENT_SECRET
npm ci
npm run build
npm run doctor
npm start           # 然後開啟 http://127.0.0.1:3030/
```

服務會自己找到 danser 附帶的 FFmpeg 函式庫（0.12 在 `ffmpeg/lib`，0.11 在 `ffmpeg/`），不需要設定
`LD_LIBRARY_PATH`。

**顯示環境：** danser 0.12 以上在 Linux 會離屏（offscreen）渲染，不需要螢幕，無頭主機也能用。
danser 0.11 會開一個隱藏視窗，需要執行中圖形工作階段的 `DISPLAY` 或 `WAYLAND_DISPLAY`。

**systemd --user：** [`systemd/osu-render.service`](systemd/osu-render.service) 是範例 unit，預設專案在
`~/osu-render`、danser 在 `~/danser`。先改好路徑（以及 `node` 的路徑），再執行：

```sh
mkdir -p ~/.config/systemd/user
cp systemd/osu-render.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now osu-render.service
journalctl --user -u osu-render.service -f
```

想在登出後繼續執行，可啟用 lingering：`loginctl enable-linger "$USER"`（danser 0.12 以上適用；danser 0.11
本來就需要桌面工作階段）。

## 設定

設定從專案根目錄的 `.env` 讀取。真實環境變數中已存在的值優先於 `.env`。路徑可以是絕對路徑，或相對於專案根目錄。

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | 監聽位址。修改前請先讀[安全性說明](#安全性說明)。 |
| `PORT` | `3030` | HTTP 連接埠。 |
| `DATA_DIR` | `./data` | 資料庫、replay、影片、圖譜、日誌與診斷報告。 |
| `DANSER_DIR` | `./danser` | danser 解壓縮的資料夾。 |
| `DANSER_BIN` | `<DANSER_DIR>/danser-cli`（Windows 為 `.exe`） | danser CLI 執行檔，放在別處時才需要設定。 |
| `DANSER_BASE_SETTINGS` | `<DANSER_DIR>/settings/default.json` | 渲染時作為基底的 danser 設定（見下方）。 |
| `DANSER_SKINS_DIR` | `<DATA_DIR>/skins` | 傳給 danser 的 Skin 資料夾。 |
| `DANSER_SETTINGS_NAME` | `service` | 服務寫出的設定檔名稱：`<DANSER_DIR>/settings/<name>.json`。只能用英數字、`-` 與 `_`。 |
| `RENDER_ENCODER` | `auto` | `auto`、`h264_nvenc`、`hevc_nvenc`、`h264_amf`、`hevc_amf`、`h264_qsv`、`hevc_qsv` 或 `libx264`。其他值會讓服務啟動失敗並顯示錯誤。 |
| `OSU_CLIENT_ID` | 空 | osu! OAuth client ID。必填。 |
| `OSU_CLIENT_SECRET` | 空 | osu! OAuth client secret。必填。 |
| `BEATMAP_MIRRORS` | `https://mirror.hinamizawa.ai/api/v1/hinai/d/{id}` | 以逗號分隔的 `.osz` 下載網址，依序嘗試。`{id}` 是 beatmapset ID。 |
| `AUTH_TOKEN` | 空 | 設定後，所有 `/api/*` 請求都需要 `Authorization: Bearer <token>`。 |
| `MAX_QUEUE` | `20` | 未完成任務的上限。 |

**danser 基底設定。** 服務會複製 `DANSER_BASE_SETTINGS`，覆蓋必要的項目（資料夾、60 FPS、編碼器、輸出），
再寫到 `<DANSER_DIR>/settings/<DANSER_SETTINGS_NAME>.json`。基底檔不存在時使用 danser 內建預設值。
想要一份可以自己調整（Skin、游標等）的基底檔，在 danser 資料夾執行一次 `danser-cli -noupdatecheck`：
它會建立 `settings/default.json`，印出 `No beatmap specified, closing...` 後結束。

不屬於機密的可調參數放在 [`config/defaults.json`](config/defaults.json)：各平台的編碼器自動順序、自我測試的
尺寸與逾時、診斷報告大小與 issue 連結。要修改時，建立 `config/local.json` 並只寫要覆蓋的鍵；它會合併到預設值
之上，且已被 git 忽略。例如：

```json
{ "encoders": { "autoOrder": { "win32": ["h264_qsv", "libx264"] } } }
```

## 編碼器如何選擇

danser 只檢查 FFmpeg 裡有沒有這個編碼器名稱；如果 GPU 或驅動其實不能用，渲染會做到一半才失敗。所以服務啟動時會用
danser 的 FFmpeg 為每個候選者**實際編碼一個 240×144 的黑色 frame**，採用第一個成功的：

| `RENDER_ENCODER` | 候選順序 |
| --- | --- |
| Windows 上的 `auto` | `h264_nvenc` → `h264_amf` → `h264_qsv` → `libx264` |
| Linux 上的 `auto` | `h264_nvenc` → `h264_qsv` → `h264_amf` → `libx264` |
| 指定某個編碼器 | 該編碼器 → `libx264` |

如果最後用的是 `libx264`，仍然可以渲染，但 `/health` 會回報 `"status": "degraded"`，`reason` 為
`"hardware_encoder_unavailable"`（auto 模式）或 `"encoder_unavailable"`（你指定的編碼器失敗）。
degraded 期間會不定時重新檢查（在 `/health` 請求與新任務時），之後才可用的 GPU 不需要重啟就會被採用。

## 診斷與回報

遇到問題，或只是想幫忙測試，請傳一份診斷報告：

1. **`npm run doctor`** 會印出摘要，並寫入 `data/diagnostics/doctor-<timestamp>.json`。
   `npm run doctor -- --json` 則直接印出 JSON，而不是摘要。doctor 會對**所有**支援的編碼器做自我測試，而不只是第一個
   成功的，所以一份報告就能看到 NVENC / AMF / QSV / x264 的完整狀況。
2. **在網頁介面**，「**診斷報告**」卡片有「**下載報告**」（同一份 JSON）、「**複製摘要**」（適合貼到聊天的短文字）
   與「**開啟 GitHub issue**」（預先填好的 issue 表單）。`GET /api/diagnostics` 也會回傳這份 JSON。
3. **開 issue**：使用 [GPU / platform report](https://github.com/956zs/osu-render/issues/new?template=gpu-report.yml)
   範本並貼上 JSON。直接把檔案傳給維護者也可以。

### 隱私

- **包含：** 作業系統名稱／版本／架構、CPU 型號、核心數、記憶體大小、GPU 名稱、廠商與驅動版本、danser 與 FFmpeg
  版本及 FFmpeg 編碼器清單、編碼器自我測試結果（含 FFmpeg 錯誤輸出的結尾）、啟動檢查結果、設定摘要（host、port、
  編碼器設定、mirror 主機名稱，以及 OAuth 憑證與 `AUTH_TOKEN` *是否*有設定）、剩餘磁碟空間，以及最近 20 個任務的
  中繼資料（狀態、編碼器、解析度、耗時、錯誤代碼，以及一小段 danser 日誌結尾，其中可能出現圖譜名稱），以及 danser `danser.log` 的摘要（版本、OpenGL 使用的 GPU）。
- **不包含：** OAuth client ID 與 secret、`AUTH_TOKEN`、IP 位址、玩家名稱、replay 與圖譜檔案。
  家目錄會被替換成 `~`，使用者名稱替換成 `<user>`。
- **不會自動傳送任何東西。** 服務從不上傳資料，要不要分享由你決定。「**開啟 GitHub issue**」按鈕只是在瀏覽器開啟
  預先填好的頁面（內容會放在網址中送到 github.com），在你按下 **Submit** 之前不會發佈。GitHub issue 是公開的，
  貼出前請先看過報告內容。

## HTTP API

如果設定了 `AUTH_TOKEN`，每個 `/api/*` 呼叫都要加上 `-H "Authorization: Bearer $AUTH_TOKEN"`。

| 方法與路徑 | 說明 |
| --- | --- |
| `POST /api/renders` | Multipart 上傳：`replay`（`.osr`，最大 5 MiB）與選用的 `options`（JSON 字串）。回傳 `{ "id", "status" }`。 |
| `GET /api/renders/:id` | 任務狀態、進度、佇列位置、圖譜、輸出格式與錯誤。 |
| `GET /api/renders/:id/video` | 完成的 MP4，支援 HTTP `Range`。 |
| `DELETE /api/renders/:id` | 取消任務。 |
| `GET /api/diagnostics` | 診斷報告（與 `npm run doctor` 相同的 JSON）。 |
| `GET /health` | 服務健康狀態（不需驗證）：`status`、`renderer`、`display`、`encoder`、`encoderKind`、`platform`、`queue`、`freeDiskBytes`、`reason`。 |

```sh
curl -F replay=@my-play.osr -F 'options={"resolution":"720p","skipIntro":true}' http://127.0.0.1:3030/api/renders
curl http://127.0.0.1:3030/api/renders/<id>
curl -o my-play.mp4 http://127.0.0.1:3030/api/renders/<id>/video
```

任務狀態：`uploaded` → `resolving` → `downloading` → `queued` → `rendering` → `finalizing` → `completed`，
或 `failed` / `cancelled`。限制：只支援 osu!standard replay、圖譜最長 15 分鐘、每個任務最多渲染 30 分鐘、
每個 client 每分鐘 5 次上傳且最多 3 個未完成任務。

## 安全性說明

- 預設只監聽 `127.0.0.1`，只有本機能連線。
- **對外開放前先設定 `AUTH_TOKEN`**（`HOST=0.0.0.0`、port forwarding 或 reverse proxy）。token 保護 `/api/*`；
  網頁上有欄位可以填。token 若要經過不信任的網路，請用 HTTPS（reverse proxy）。
- 瀏覽器無法傳入任意 danser 或 FFmpeg 參數或檔案路徑。渲染選項會依白名單檢查，再轉成固定的 danser 參數與設定 patch。
- 下載的 `.osz` 以防禦性方式解壓縮：限制項目數量與總大小，拒絕絕對路徑、`..`、symlink 與其他特殊檔案、
  Windows 保留名稱（`CON`、`NUL`、`COM1`…）與大小寫不同的重複名稱，且 `.osu` 必須符合 replay 的圖譜 MD5。
- OAuth secret 與 `AUTH_TOKEN` 只放在 `.env`（已被 git 忽略），不會送到瀏覽器，也不會出現在診斷報告中。

## 疑難排解

**`/health` 顯示 degraded。** 看 `reason` 欄位：

| reason | 意義／處理方式 |
| --- | --- |
| `renderer_unavailable` | 找不到 danser-cli。檢查 `DANSER_DIR` / `DANSER_BIN`；Linux 上執行 `chmod +x`。 |
| `display_unavailable` | Linux 使用 danser 0.11 且沒有 `DISPLAY` / `WAYLAND_DISPLAY`。從桌面工作階段啟動，或改用 danser 0.12 以上。 |
| `hardware_encoder_unavailable` | 沒有 GPU 編碼器通過自我測試，改用 CPU 渲染（較慢）。見下方。 |
| `encoder_unavailable` | `RENDER_ENCODER` 指定的編碼器失敗（可用時改用 x264），或完全沒有可用的編碼器。 |
| `storage_low` | `DATA_DIR` 剩餘空間低於 8 GiB。 |

**GPU 編碼器自我測試失敗。** 執行 `npm run doctor`，查看 `encoderProbes[].error`：

- NVIDIA：`Driver does not support the required nvenc API version` 或 `No capable devices found` 表示驅動太舊，
  或 NVIDIA GPU 沒有啟用（筆電：接上電源並確認獨顯沒有被停用）。請更新驅動。
- AMD：`amfrt64.dll` 或 AMF 相關錯誤表示沒有安裝 Adrenalin 驅動或版本太舊。
- Intel：QSV / MFX session 錯誤通常是內顯在 BIOS/UEFI 被關閉或驅動太舊。Linux 上請安裝 `intel-media-driver`
  與 `vpl-gpu-rt`。

**雙顯示卡筆電（NVIDIA Optimus／AMD 切換式顯示卡）。** danser 的 OpenGL 可能跑在內顯上。開啟 Windows
**設定 → 系統 → 顯示器 → 圖形**，新增 `danser-cli.exe`，在 **選項** 選擇 **高效能** 並儲存。也可以在 NVIDIA 控制面板
的個別程式設定中指定。

**查看 danser 實際用了什麼。** danser 每次執行都會在自己的資料夾寫入 `danser.log`，內容包括 `danser-go version`、
實際使用的 OpenGL vendor／renderer／version（可看出是哪張 GPU 在繪圖），以及 FFmpeg 的路徑與參數。

**`RENDER_TIMEOUT`。** 渲染超過 30 分鐘而被中止。多半發生在較慢的機器使用 CPU 備援時；可改用 720p、修好 GPU
編碼器，或查看 `data/logs/` 中的渲染日誌。

**Windows SmartScreen / Defender 擋住 danser。** danser 的執行檔沒有簽章。只從 danser 的
[GitHub releases](https://github.com/Wieku/danser-go/releases) 下載。解壓縮前可以在 zip 上按右鍵 →
**內容** → 勾選**解除封鎖**。如果仍出現 SmartScreen，選 **其他資訊 → 仍要執行**。若 Defender 隔離了檔案，
請還原並把 danser 資料夾加入排除項目。

**PowerShell 對 `npm` 顯示「因為這個系統上已停用指令碼執行」。** 改用 `npm.cmd`，或允許本機指令碼：
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`。

**`npm ci` 試圖編譯 `better-sqlite3`。** 請用 64 位元的 Node.js 22 或 24（有預先編譯好的版本）；其他版本需要
Visual Studio Build Tools。

**連接埠已被占用（`EADDRINUSE`）。** 有其他程式在用 3030。在 `.env` 改 `PORT`，或找出該程式：
`Get-NetTCPConnection -LocalPort 3030`（Windows）/ `ss -ltnp 'sport = :3030'`（Linux）。

**Windows 上只有在背景啟動時渲染失敗。** 服務必須在你的桌面工作階段中執行，見 [Windows 快速開始](#windows-快速開始)。

## 開發

```sh
npm ci
npm run dev     # 用 tsx 直接執行 TypeScript
npm test        # 建置後執行 node:test 測試
```

CI（[`.github/workflows/ci.yml`](.github/workflows/ci.yml)）會在 Ubuntu 與 Windows 上跑測試（Node 24，Ubuntu 另跑
Node 22），並有一個 smoke job 在兩個平台下載 danser 0.12.1，檢查 `npm run doctor` 能找到 danser 與 FFmpeg，且 x264
自我測試通過。CI runner 沒有 GPU，硬體編碼器只能靠大家在實機執行 doctor 來測試。

## 授權與致謝

[MIT](LICENSE) © 2026 956zs。

- 渲染使用 Wieku 的 [danser-go](https://github.com/Wieku/danser-go)（未隨附，請另外下載）。
- osu! 是 ppy Pty Ltd 的商標。本專案與 ppy 無關，也未獲其背書。
