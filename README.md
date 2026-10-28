# osu! danser render service

這是單機、FIFO、單 renderer 的 osu!standard `.osr` 渲染服務。服務只接受 replay，會由 osu! API 以 checksum 查圖，再從可配置 mirror 下載 `.osz`，安全解壓並驗證 `.osu` MD5，最後交給 danser-go 產生 720p 或 1080p、60 FPS 的 MP4。

## 目前狀態

核心 MVP 已實作：

- Fastify API：`POST /api/renders`、`GET /api/renders/:id`、`GET /api/renders/:id/video`、`DELETE /api/renders/:id`、`GET /health`
- SQLite 持久化 FIFO queue，固定一次一個 render
- OSR metadata parser、osu!standard mode check、5 MiB upload limit
- osu! OAuth client-credentials token cache
- 多 beatmap mirror fallback、同 mapset download lock
- `.osz` entry/path/symlink/size/entry-count 安全檢查與 replay checksum 驗證
- 15 GiB soft / 8 GiB hard storage guard，過期輸出清理與 beatmap LRU
- atomic `.part` 下載/輸出、crash recovery、HTTP Range video download
- 內建單頁 drag/drop UI、720p/1080p 解析度與每個任務獨立的安全視覺設定

解析度可在網頁的「輸出影片」選單選擇。API 也可在 multipart 的 `options` 欄位傳入 `{"resolution":"720p"}` 或 `{"resolution":"1080p"}`；未指定時使用 1080p。

## OAuth 回傳 URL

這個服務使用 osu! 的 **Client Credentials Grant**，只需要公開資料，不做使用者登入，也不走 authorization-code flow。因此官方文件允許 **Application Callback URL 留白**。如果 osu! 表單目前強制要求輸入，填入 `http://127.0.0.1:3030/` 即可；這個 URL 不會被本服務的 client-credentials 流程使用，也不需要建立 OAuth callback route。不要把 client secret 放進 frontend。

將 client id/secret 放進 shell environment 或 systemd `EnvironmentFile`：

```sh
cp .env.example .env
$EDITOR .env
npm install
npm run build
npm start
```

服務啟動時會自動從專案根目錄載入 `.env`；shell 已存在的同名環境變數優先，不會被 `.env` 覆蓋。

預設監聽 `127.0.0.1:3030`，開啟 `http://127.0.0.1:3030/`。

## danser release

服務預設使用：

```text
~/danser/danser-cli
```

release 解壓後要確認執行權限：

```sh
chmod u+x ~/danser/danser-cli
chmod u+x ~/danser/ffmpeg/ffmpeg
chmod u+x ~/danser/ffmpeg/ffprobe
```

服務以 `DANSER_BASE_SETTINGS` 指向的 JSON 作為基底，目前使用 `~/danser/settings/default.json`。服務會自動產生 `settings/service.json`，保留基底中的畫面設定，但強制覆蓋 Songs、Skins、Replay、60 FPS、AAC、QSV、輸出路徑與 motion blur；每個任務再以白名單 `-sPatch` 覆蓋 720p 或 1080p 解析度，並透過 `LD_LIBRARY_PATH` 找到 danser 內附的 FFmpeg shared libraries。

使用者可以調整是否跳過前奏、三組音量、背景暗度/模糊/視差/Bloom、遊戲區縮放、游標大小/軌跡/效果、Skin/圖譜顏色來源、HUD 元件及常見 hit object 顯示。這些選項會存進 SQLite，並由 backend 產生受控 CLI 參數與 `-sPatch`；browser 不能提交任意 danser JSON、FFmpeg 參數或檔案路徑。

### QSV preflight

啟動時不是只查 `ffmpeg -encoders`，而是實際編碼一個 frame。目前這台機器已通過 `h264_qsv` self-test，`/health` 會回傳 `"encoder":"h264_qsv"`。如果未來 driver/runtime 更新後失敗，health 會明確顯示 degraded 與實際選用的 encoder。

如果 systemd 在圖形桌面完全啟動前先啟動，第一次 preflight 可能暫時顯示 `display=false`。服務會在 `/health` 與新 render 前重新檢查；不需要手動改資料庫或重建 job。

## systemd --user

```sh
mkdir -p ~/.config/systemd/user
cp systemd/osu-render.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now osu-render.service
systemctl --user status osu-render.service
```

若使用 Hyprland，systemd user service 必須繼承 `DISPLAY`、`WAYLAND_DISPLAY`、`XDG_RUNTIME_DIR`。範例 unit 已設定 `PartOf=graphical-session.target`；實際 session target 依你的 Hyprland/systemd user setup 調整。

## 驗證

```sh
npm run build
npm test
curl http://127.0.0.1:3030/health
```

已使用本機不存在 beatmap 的 replay 完成自動下載、checksum 驗證、自訂設定、1080p60 H.264 QSV/AAC render 與 HTTP Range 下載驗證。
