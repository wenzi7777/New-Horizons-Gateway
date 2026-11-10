# Gateway TS 重寫計劃（Mac / Windows / Linux / WebUI+TUI / Android）

## 背景
工廠的 Hub（ESP-NOW）模式無法配對，原因查不出來，現場也不方便配合除錯。所以改用 **Wi-Fi/UDP 模式 + Gateway**：寄一支裝好 Gateway App 的 Android 手機過去，手機和裝置都連工廠現有的 pocket Wi-Fi（手機只當 Wi-Fi 用戶端），資料經 pocket Wi-Fi 傳到 production Backend。手機開熱點、裝置直連手機的做法保留為備案（見「寄給工廠的手機」）。工廠電腦有保密限制，不能安裝軟體。

我們同時把 Gateway 從 Python 改寫成 **Node/TS**：一份純 TS 核心，桌面版是單一執行檔，Android 版用 React Native/Expo，兩邊共用核心。所有程式碼都放在這個 repo 裡。

## 架構
```
ts/                         npm workspaces（Python 版 newhorizons_gateway/ 在新版完全取代前保留不動）
  packages/core/            純 TS，不依賴 Node 或 RN；所有 I/O 都透過介面注入
    wire.ts                 由 gen_wire.py 產生（新增 TS 輸出，CI 用 --check 檢查是否一致）
    protocol/               封包辨識（v3/v4/v5、heartbeat、UID）、JSON 控制、result_chunk 重組
    time/                   TIME_REQ/RESP（32 B，int64 µs，小端序）
    state/                  裝置清單、FindMe、claim、過期判定（GatewayState 的規則全部照搬）
    udp/                    指令派送：session、0.5 s 重送、ack/result、到期
    discovery/              FindMe offer/decline/deny、claim 優先權
    upstream/               WSS client：hello、gateway_status、NHPKT1:base64、控制優先佇列、重連退避
    remote/                 gateway_command 共 10 種，錯誤碼與 1 s 回覆寬限
    update/                 manifest、版本比較（versions.json）、required_update、閒置自動更新
    ports.ts                UdpSocket / WebSocket / Http / Store / Clock / Log 介面
  packages/ui-tokens/       從 Desktop styles.css 產生 tokens.css / tokens.ts；主題模式和日出日落邏輯；i18n 字串
  packages/node/            桌面執行環境：dgram、ws、fs、http
    webui/                  沿用現有 webui/（vanilla JS），REST API 維持一樣的路徑和格式；token 改讀 tokens.css
    tui/                    Ink（React for CLI）：狀態面板 + log，用同一組 token 的顏色和主題模式
    build/                  esbuild 打包 → Node SEA → darwin-arm64/x64、win-x64、linux-x64/arm64
  apps/android/             Expo（dev build / prebuild）
    react-native-udp        UDP 13250 / 22346
    modules/fgservice/      自訂 Expo module（Kotlin）：foreground service + wakelock + 申請略過電池最佳化
    UI                      狀態、Wi-Fi 連線教學（含用戶端隔離檢查）、設定（gateway_id、target）、裝置清單、log
```

## UI 規範（三個介面都要遵守）
目前的規範以 Desktop 為準，Gateway WebUI（v1.1.x）已經對齊。新版的 WebUI、TUI、Android 都必須照同一套規範，不能各自設計。

**唯一來源（不另外複製一份）**
- 色彩、圓角、陰影、動態 token：`New-Horizons-Desktop/frontend/src/styles.css` 的 `:root`（淺色）和 `:root[data-theme="dark"]`（Graphite 深色）。例如 `--accent #1f6b54`、`--bg`、`--panel`、`--line`、`--radius-sm/md/lg/pill`、`--shadow-sm/md`、`--ease-out`、`--dur-fast/med`。
- 主題邏輯：`frontend/src/lib/theme.tsx` + `sunTimes.ts`（Gateway 的 `webui/theme.js` 是它的移植）。
- 文字：Desktop `i18n.tsx` 的 en / ja / zh-CN 三種語言，以及 Gateway `webui/i18n.js` 現有的字串。

**新增 `ts/packages/ui-tokens`**
- 建置時從 Desktop 的 `styles.css` 讀出兩組 token，產生：
  - 給 WebUI 用的 `tokens.css`（CSS 變數）。
  - 給 RN 和 Ink 用的 `tokens.ts`（`light` / `dark` 兩組物件）。
- 加一個 `--check`，Desktop 改了 token 但沒有重新產生時，讓 CI 失敗（跟 gen_wire 同樣的做法）。
- 主題邏輯也放在這裡，三個介面共用：
  - `ThemeMode = "auto" | "light" | "dark"`，預設 auto。
  - auto 依研究室位置（37.5236, 139.9381）的日出日落切換，並在下一次切換的時間點自動更新。
  - 選擇會記住：WebUI 存 `nh-theme-mode`，跟現在一樣；手機和 TUI 存在設定檔。

**WebUI（桌面版，5052）**
- 沿用目前已經符合規範的 `webui/`：總覽卡片、側欄 4 個分區（overview / connection / update / devices）、Graphite 深色主題、日出日落自動主題、lucide 的 SunMoon / Sun / Moon 主題按鈕（17px，stroke 1.8）、移植自 Desktop 的 Select、confirmDialog、toast、可摺疊的技術細節、Markdown 的 release note、三語言。
- 唯一的改動：token 改從 `ui-tokens` 產生的 `tokens.css` 讀取，不再手寫一份。

**Android（RN）**
- 畫面結構對照 WebUI 和 Desktop 的 GatewayManageModal：
  - 上方是總覽卡片：狀態、版本、網路（SSID、手機 IP）、服務中的裝置數。
  - 下方用 segmented control 切換 4 個分區：總覽、連線、更新、裝置。
  - 設定頁可以選語言和主題（自動 / 淺色 / 深色）。
- 元件依 Desktop 的視覺規則實作：卡片（`--panel` + `--radius-lg` + `--shadow-sm`）、segmented（凹槽感，選取項目用 `--control-selected`）、按鈕（主要按鈕用 `--accent`、危險操作用 `--danger`）、清單列、狀態點、toast、確認對話框、可摺疊的技術細節。
- 圖示用 lucide-react-native，跟 Desktop 同一套。
- 字型用系統字型（Android 是 Roboto / Noto Sans CJK），對應 Desktop 的 `-apple-system` 系統字型堆疊。
- 無障礙：系統開啟「減少動態效果」時，關掉動畫和陰影過渡（對應 Desktop 的 `prefers-reduced-motion`）。
- StatusBar 和導航列的顏色跟著主題切換。

**TUI（Ink）**
- 使用同一組 token 的 accent、成功、警告、危險等顏色，並提供淺色和深色兩組調色盤。
- auto 模式依同樣的日出日落規則切換；也可以用設定或 `--theme` 參數固定。
- 文字依系統語言（en / ja / zh），用的是跟 WebUI 同一份字串。
- 版面：狀態面板（跟 WebUI 總覽卡片相同的欄位）+ log 窗格，按 Ctrl+C 結束。這跟現在的 Textual 版一樣。

**驗收**
- 每完成一個介面，提供淺色、深色兩組截圖給使用者確認；auto 模式要附上「跨過日出日落時間點自動切換」的檢查。
- UI 由使用者自己實際操作測試；我只負責跑既有測試和 build。

### 決定事項
- **一個執行檔 = Mac / Windows / Linux / WebUI / TUI**：啟動後在 5052 提供 WebUI；在終端機啟動時同時顯示 TUI。Linux 版就是這個執行檔，不另外做。
- **打包用 Node SEA**（官方功能，dgram 完整支援），在 GitHub Actions 的 macOS、Windows、Ubuntu 三種環境各自建置。Bun `--compile` 雖然能交叉編譯，但它的 dgram 相容性還有疑慮，所以不採用。
  - macOS 先用 ad-hoc 簽章；要不要公證（需要 Apple Developer 帳號）之後再決定。
- **上游協定不變**：`client_type:"gateway"`，hello 多加一個 `platform`（`darwin`/`win32`/`linux`/`android`）。Backend 會忽略不認識的欄位，所以第一版不用改 Backend；Desktop 要顯示平台的話，之後再小改。
- **行為差異：保留或修正**
  - 保留：沒有 FindMe 的串流照樣轉送；heartbeat 不轉送；新版一律視為必須更新。
  - 修正：FindMe probe 加上 `SO_BROADCAST`（Python 版沒設，所以「discover」其實從來沒送出去）；已 ack、但沒有 result 也沒有 expires 的指令，加上逾時清除（Python 版會洩漏）。
  - 移除：沒用到的 CONTROL_PORT 22345，以及 web.py 的 dead code。
- **時間服務**：Node 用 `performance.timeOrigin + performance.now()` 換算成 µs；RN 的精度要實測（第 0 階段）。
- **自我更新**（取代 slot、venv 和 bootloader）：
  - 新增 manifest `gateway-bin-{latest,beta}.json`：`{version, notes_url, assets:{"darwin-arm64":{url,sha256,size},…}}`。
  - 下載後驗證 sha256，再替換執行檔：先把執行中的檔案改名為 `.old`，放上新檔，然後重新啟動。下次啟動時健康檢查通過才刪掉 `.old`，失敗就換回來。
  - Python 版繼續讀原本的 `gateway-{latest,beta}.json`，兩邊互不干擾。
  - Android：App 自己檢查 manifest 的 `android` 資產，下載 APK，交給系統安裝程式安裝（需要「安裝未知應用程式」權限）。
- **測試**：用 vitest 移植 Python 的行為測試（state、udp_control、discovery 實際 socket、time、result_chunks、upstream、remote、update），共用 `spec/fixtures/packets.json`、`versions.json`，並加上 gen_wire 的 drift 檢查。

## 舊版（Python）Gateway 的遷移提示
目標：所有還在跑 Python 版的 Gateway，都會被明確提示去下載新版；設定可以直接帶過去，不用重新設定。

**版本號**
- TS 版從 **v2.0.0** 開始，使用新的 `gateway-bin-{latest,beta}.json`。
- Python 版最後發一個 **v1.2.0**（「遷移版」），之後 `gateway-{latest,beta}.json` 就停在 v1.2.0。
- 這樣做的原因：Python 版會把 manifest 上任何較新的版本都當成「必須更新」，然後自動下載 zip。如果把 v2.0.0 寫進舊的 manifest，舊版會嘗試用 zip 安裝一個執行檔，結果會壞掉。

**三個提示的位置**
1. **Python v1.2.0 本身**（v1.0.0 以後的版本會在閒置時自動更新到這一版）：
   - 讀取 `gateway-bin-latest.json`，依作業系統（`sys.platform` / `platform.machine()`）挑出對應的下載連結。
   - **WebUI**：頂部固定一條提示，寫「Gateway 已改為獨立 App，請下載新版」，附當前平台的下載按鈕、其他平台的連結，以及三語言的說明。照 UI 規範製作，提示條可以收合，但重新整理後會再出現。
   - **TUI**：狀態面板最上面一行顯示同樣的提示和下載網址。
   - **gateway_status** 加上 `migration: {available, version, download_url}`，讓 Desktop 也看得到。
2. **Desktop（Relays 頁）**：只要 Gateway 的 hello 沒有帶 `platform` 欄位（也就是 Python 版，不管哪一版，連 v1.0.0 之前不會自動更新的舊版也算），Gateway 卡片和管理視窗就顯示「請下載新版 Gateway」，附下載頁連結。v1.0.0 之前的舊版只能靠這裡提示。
3. **GitHub Release 和 README**：v1.2.0 的 release note 跟 README 開頭都寫明遷移方式。

**設定帶過去**
- 新版第一次啟動時，如果在自己所在的資料夾或目前目錄找到舊版的 `.run/config/config.json`，就自動匯入這些設定：`gateway_id`、`gateway_name`、`target_mode`、`manual_url`、`update_channel`、`denied_devices`、`remote_management`、各個 port。匯入後在 WebUI 和 TUI 提示「已匯入舊版設定」。
- 因為 `gateway_id` 沿用舊的，Desktop 會把新版當成同一台 Gateway，裝置不用重新配對。
- 遷移步驟：把新版執行檔放進舊 Gateway 的資料夾 → 執行 `python3 scripts/stop.py` 停掉舊版 → 啟動新版。v1.2.0 的提示條會直接列出這三步。

**Backend 要配合的小改動**
- `gateway_hello_ack` 的 `latest_gateway_version` 要依 hello 有沒有 `platform` 來決定：有就讀 `gateway-bin-*.json`，沒有就讀舊的 manifest。這樣 TS 版的「必須更新」判斷才正確，Python 版也不會被 v2.0.0 觸發自動更新。
- Desktop 前端的 Relays 卡片要加遷移提示。這兩項跟 Desktop 一起發一個小版本。

## 階段（工廠手機優先）
| 階段 | 內容 | 完成條件 |
|---|---|---|
| 0. Android 可行性驗證 | 最小的 Expo dev build：手機和 v1.5.F 連同一個 Wi-Fi（2026-11-10 起在家用 ALLDOCUBE iPlay 60 mini Pro / Helio G99 / Android 14 測）；確認收得到 22346 廣播和 13250 串流；用 WSS 連 production；foreground service 在背景、關螢幕 30 分鐘都不斷線；量測時間精度 | 全部通過才繼續；有一項失敗就先處理 |
| 1. core + ui-tokens | 上面列的 packages/core 全部模組 + 移植的測試 + wire.ts 產生器；ui-tokens（token 產生器 + --check、主題和日出日落邏輯、i18n 字串） | vitest 全部通過，fixtures 一致；token 跟 Desktop 一致 |
| 2. Android App | 依 UI 規範製作的正式 UI（三種主題、三種語言）、設定保存、開機自動啟動、APK 自我更新 | v1.5.F 與手機在同一個 Wi-Fi 下串流、指令、對時、OTA 透過 Backend 都正常；連續跑 8 小時 |
| 3. 桌面版 | packages/node + WebUI + TUI + 三平台 SEA 執行檔 | 在 Mac、Windows、Linux 上取代 Python 版跑同樣的情境 |
| 4. 發布與更新 | gateway-bin manifest、GitHub Actions 建置發布、三語 release note、執行檔替換和回滾 | 從舊版自動更新到新版並驗證成功；回滾驗證成功 |
| 5. 遷移與淘汰 Python 版 | Python v1.2.0（遷移提示 + gateway_status.migration）、Desktop 小版本（依 platform 選擇 manifest + Relays 遷移提示）、新版自動匯入舊設定；README 和 CLAUDE.md 一併更新 | 研究室的兩台舊 Gateway（.90、.99）自動更新到 v1.2.0 後顯示提示；照提示換成 v2.0.0 後，`gateway_id` 不變，Desktop 上仍是同一台，裝置正常串流 |

## 寄給工廠的手機
- **主要架構**：手機和裝置都連工廠現有的 pocket Wi-Fi，手機只當 Wi-Fi 用戶端，資料經 pocket Wi-Fi 上網。不需要 SIM 卡。
- **出貨前必須確認 pocket Wi-Fi 沒有開用戶端隔離**（NEC Aterm / Speed Wi-Fi 等稱為「プライバシーセパレーター」，有些機型預設開啟）。開著的話，裝置送給手機的 FindMe 和 UDP 全部收不到。請工廠提供型號或到管理頁確認；App 在一段時間收不到任何 FindMe 時要提示這一點。
- 背景運作：foreground service + partial wake lock + multicast lock + Wi-Fi 鎖（API 29+ low-latency）。螢幕關閉後 Android 仍可能讓 Wi-Fi 省電，延遲由第 0 階段的關螢幕測試確認。
- 裝置切到 Wi-Fi 模式：裝置設定頁（`NHOS-<MAC>`）選 Wi-Fi 模式，填 pocket Wi-Fi 的 SSID。App 內附圖文教學。
- **備案（pocket Wi-Fi 有隔離又不能關時）**：手機開 2.4 GHz 熱點、裝置直連手機，需要行動數據 SIM 卡；熱點要固定 SSID/密碼、關掉「無人連線時自動關閉」，Android 不允許 App 自己開熱點，要手動開一次。
- 出貨前在研究室把整套流程用 GCU 板子跑過一次（如果拿得到 GCU 2.1 最好），並用要寄出的那支手機跑。

## 風險
- RN 的 UDP 廣播接收、背景存活時間，各家廠商的 Android 差異很大 → 用第 0 階段驗證，並且只保證寄出去那一支手機。
- pocket Wi-Fi 的用戶端隔離會讓整個方案失效 → 出貨前確認；改走熱點備案。
- Node SEA 在 macOS 上沒公證時，Gatekeeper 會擋 → 先用 ad-hoc 簽章並寫明開啟步驟；之後再決定要不要買 Developer 帳號。
- 現有的靜態測試（grep README、webui）不適用於新版 → 改寫成新版的檢查。
- Desktop 的 token 有一部分依賴 CSS 本身的特性（`backdrop-filter`、`rgba` 疊色、`color-mix`），RN 和終端機無法完全重現 → 毛玻璃在 RN 改用實色的 `--panel-solid`，終端機只用前景色和強調色；在 ui-tokens 裡列出每個 token 在 RN 和 TUI 上的對應方式。
