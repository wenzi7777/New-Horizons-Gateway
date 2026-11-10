# NH Studio（電腦）與 NH Pocket（手機）計劃

## Context
使用者希望仿照 Bambu Studio / Bambu Handy 的組合，把產品整理成兩個 App，並和現有的 Desktop 伺服器同步：
- **NH Studio**（完整名稱 New Horizons Studio）：安裝在 Mac / Windows 上的 App，**UI 全部重新設計**。可以在本機直接管理裝置；連上 Desktop 伺服器後，**取代現在的軟體 Gateway**，負責把裝置轉送到伺服器。NH Gateway 不再是獨立產品，伺服器 Relays 頁上的「Gateway」全部改成 Studio。
- **NH Pocket**（完整名稱 New Horizons Studio Pocket）：Android App，只保留核心功能，**一定要能離線錄製**。錄製結果存在手機上，可以匯出，也可以設定自動同步。
- **同步**：連上伺服器後，兩邊都看得到裝置。錄製在哪裡做，資料就存在哪裡：在 Studio 上錄，資料就在 Studio；啟用同步時才自動上傳。**裝置設定在 Studio、Pocket、伺服器任何一邊都能改。**
- **只讓部分裝置給 App 管理**：每個 App 都可以只管理指定的裝置。
- 下載頁要顯示完整名稱；App 圖示下方的名稱用短名（NH Studio / NH Pocket）。

調查結論（三份探索報告）：
- **Desktop Backend**：約 1.17 萬行，只用 Python 標準函式庫加 Flask，沒有重量級運算。校正在韌體上做，分析在瀏覽器裡做。44 個 REST、3 個 WebSocket；裝置狀態只存在記憶體；錄製格式為 `<UID>/<YYYYMMDD>/<HHMMSS>/{.data.csv,.events.csv,.meta.json}`；登入只支援 cookie。→ 引擎改寫成 TS 是可行的。
- **Desktop 前端**：Studio 會重新設計，所以不搬頁面。能沿用的是 `src/lib` 的純邏輯（命令結果、校正流程、錄製分析、終端機指令解析、版本等，大多有測試）、App SDK（`src/sdk`，零依賴）、三語字典的內容（1,886 個 key，可挑用）、App Studio 的編輯器做法（CodeMirror + nhs 語言）。
- **裝置歸屬**：完全由裝置自己決定接受哪個 FindMe offer（看優先權、claim、偏好的 Gateway），沒有任何驗證；一台裝置只會往一個目的地串流。伺服器的 FindMe 回應器對所有裝置一律接受，也忽略 `current_gateway_id`。
- **指令路徑已經支援「從任何一邊設定」**：伺服器的 `publish_command` 能經由轉送連線送指令（目前用的是 Gateway 的 WSS，換成 Studio 一樣可行），結果也會回傳。

## 架構
```
              Desktop 伺服器（現有 Flask；production / 研究室）
              ├ Relays 頁：Studio / Pocket / Hub（舊的 Python Gateway 顯示為「舊版，請改用 Studio」）
              └ 同步 API：token、錄製上傳/下載、標籤與 profile
                    ▲  上游 WSS（現有的轉送協定，client_type = studio / pocket）
          ┌─────────┴──────────────────┐
   apps/studio（NH Studio，Electron）       apps/pocket（NH Pocket，Expo/RN，Android）
   ├ 全新 UI（React + ui-tokens）            ├ 核心畫面（RN + ui-tokens），只用 HostStore 的子集
   ├ main process：Node 版 HostNative        ├ 原生模組 = HostNative：UDP、foreground service、.nhraw
   └ 本機資料夾：錄製、profile、App 專案      └ App 私有資料夾：錄製
          │                                   │
          └──────────► packages/host ◄────────┘
                       （@nhgw/host：AppHost / HostStore，完整功能以 Studio 為準；
                         平台只透過 HostNative 介面注入：UDP、檔案、.nhraw）
                               │
                       packages/engine（Desktop Backend 的 TS 改寫）→ packages/core
```
- **NH Studio 是完整產品，NH Pocket 是它的子集。** 兩者共用 `packages/host`；Studio 不依賴 Pocket（`apps/studio` 不 import `apps/pocket`），Pocket 只取 `HostStore` 中它需要的部分（`PocketStore = Pick<HostStore, …>`）。
- 一份引擎，Studio 和 Pocket 共用。目前的 `packages/node`（主程式、Web API、TUI、SEA）改成 Studio 的 **headless 模式**（`nh-studio --headless`），給研究室那兩台沒有螢幕、目前跑 Python Gateway 的機器（.90、.99）用；有螢幕的電腦則用 Electron 版。兩種模式是同一個引擎、同一份設定。
- Desktop 伺服器先維持 Python，只補上同步需要的部分。

## Studio 的 UI（全新設計，照 Desktop 的 UI 規範：token、自動/淺色/深色主題、三語）
| 分區 | 內容 |
|---|---|
| 裝置 | 清單（我管理的 / 附近可加入的 / 在別處的）、收編/釋放、狀態與電量、**裝置設定**（掃描、濾波、IMU、電源、時鐘、韌體更新、維護模式、裝置檔案、校正工作台） |
| 即時畫面 | 2D 熱圖、3D 表面、數值，多台裝置並排 |
| Profile | 感測器配置編輯器（沿用現有的 profile 格式，可同步） |
| 錄製 / CSV | 開始/停止、列表、時間軸預覽、匯出 CSV/zip、同步狀態（本機 / 上傳中 / 已同步） |
| App | App Library 瀏覽與安裝、App Studio（撰寫、模擬器、建置、安裝到裝置） |
| 工具 | 錄製分析、時間戳轉換、氣壓控制等（沿用 `lib` 的邏輯，重做畫面） |
| 設定 | 伺服器連線與同步策略、我管理的裝置、主題、語言、更新 |

Pocket 的範圍：裝置清單、收編/釋放、即時 2D 熱圖、基本設定與指令、離線錄製、錄製列表、匯出（分享選單）、自動同步、伺服器連線。

## 裝置歸屬與「從任何一邊設定」
- 每個 Studio / Pocket 都有一份「我管理的裝置」清單，offer 政策設為 `managed`：只對清單內的裝置提出 offer，並加上優先權。
- **收編**：送出帶 claim 的 `findme_switch_gateway`（沿用 core 的 claim 流程）。**釋放**：移出清單後送 `findme_discover`，之後對它一律回 `accept:false`（`device_released`）。
- 裝置**由管理它的那一台 App 負責轉送**。連上伺服器時，伺服器的指令經轉送連線送到裝置，所以伺服器端也能修改設定。
- 伺服器的 FindMe 回應器要修正：遵守 `current_gateway_id`，不搶已有歸屬的裝置；也要支援 offer 政策和拒絕清單（改 `discovery.py`、`service.py`）。
- 之後再做：韌體把「指定的管理者」存進設定（pin），重開機後不必重新搶；指令驗證和 HMAC 列為長期項目。

## 同步
- **伺服器**：
  - REST 支援 Bearer token（改 `auth.py`、`api.py`）；每台 Studio 或 Pocket 各自一個 token，不使用共用的 admin 帳號當身分。
  - 新增錄製上傳 API（分塊、可續傳，存進現有的資料夾結構並記錄來源）和清單/下載 API。
  - 標籤（暱稱、群組）和 profile 雙向同步，以最後修改時間為準。
- **即時**：連上伺服器後，Studio / Pocket 用轉送協定上報自己管理的裝置，兩邊都看得到。
- **錄製**：資料存在錄製發起的那一端。Studio / Pocket 上的錄製標記 `sync_state`；同步策略可選手動、自動、只在 Wi-Fi 下。伺服器自己發起的錄製照現在的做法，存在伺服器上。

## 錄製格式
- 輸出檔案跟 Desktop 完全相同（`.data.csv`、`.events.csv`、`.meta.json` format 1，`transport` 標示 `studio` / `pocket`），既有和新的分析工具都能讀。
- Pocket：在原生端寫 `.nhraw`（length-prefixed 的原始封包加接收時間），所以 JS 被系統降速也不會掉資料；錄製結束後，用 TS 的 `packetParser`（以 `spec/fixtures/packets.json` 驗證）轉成 CSV。Studio 直接在 Node 端寫 CSV。約 200 MB/小時（112 個感測器、60 fps），要顯示剩餘空間。

## 分階段
| 階段 | 內容 | 完成條件 |
|---|---|---|
| 0 | Android 實機驗證（進行中：平板 + v1.5.F + 家裡 Wi-Fi） | UDP、背景、對時都通過 |
| 1 | **engine**：改寫 `packet_parser`、裝置表與狀態合併（`service.py`）、`command_gating`、`device_commands`、`recording_session` / `recording_meta`、`recording_timeline`、`device_labels`、profiles、`result_chunks`、`app_library`、`terminal`；加上 managed 政策與收編/釋放；轉送角色沿用 core 的 runtime/upstream | 同樣的輸入封包，錄製輸出跟 Python 版逐位元組一致；移植 Desktop 後端的測試 |
| 2 | **NH Pocket v1**（工廠交付）：核心畫面、收編/釋放、離線錄製、匯出、轉送與伺服器顯示 | 實機關螢幕錄 1 小時，資料完整；伺服器看得到裝置，從伺服器改設定也能生效 |
| 3 | **NH Studio v1**：Electron 外殼 + 全新 UI 的裝置、即時畫面、錄製/CSV、設定；headless 模式取代 `packages/node` 的 Gateway | 在研究室取代 Python Gateway 和 start_local.sh 實測 |
| 4 | **同步**：伺服器加 token、上傳 API、FindMe 回應器修正，Relays 頁改成 Studio / Pocket；Studio 和 Pocket 實作自動同步 | 錄製自動上傳後，伺服器的 Files 頁看得到；標籤和 profile 雙向同步 |
| 5 | **Studio v2**：Profile 編輯器、App Library 與 App Studio、工具 | 能在 Studio 上寫 App、建置並安裝到裝置 |
| 6 | **改名與發布**：Python Gateway 最後一版提示改用 Studio（設定可匯入，gateway_id 沿用）；下載頁改成 New Horizons Studio / New Horizons Studio Pocket；Studio 和 Pocket 的自動更新 | 研究室兩台舊 Gateway 換成 Studio headless 後，伺服器上仍是同一台，裝置正常 |

工廠交付的優先順序：0 → 1（只做 Pocket 需要的解析、錄製、FindMe 政策）→ 2。Studio 排在之後。

## 主要檔案
- 新增：`ts/packages/engine/`、`ts/packages/host/`（Studio 與 Pocket 共用的 App host）、`ts/apps/pocket/`（由 `ts/spikes/android-gateway` 擴充）、`ts/apps/studio/`（Electron + 全新 UI）。
- 沿用：`ts/packages/core`、`ts/packages/ui-tokens`、`ts/packages/node`（改成 Studio headless）、Desktop 前端的 `src/lib` 純邏輯與 `src/sdk`。
- Desktop 伺服器要改：`backend/newhorizons_backend/{auth.py,api.py,discovery.py,service.py,gateway_registry.py,recording_meta.py}`；前端 Relays 頁（Gateway → Studio / Pocket）。

## 驗證
- 引擎：同一組封包同時餵給 Python 版和 TS 版，比對 CSV 和 meta；fixtures 和移植過來的測試都要通過。
- 共存：Studio、Pocket、伺服器同時在同一個網路時，確認裝置歸屬正確、不會互搶；收編/釋放能正確轉移。
- 從任何一邊設定：分別從伺服器、Studio、Pocket 修改同一台裝置的設定，其他兩邊都看得到更新後的狀態。
- Pocket：收編 → 離線錄製 → 關螢幕 → 匯出 → 回到網路環境自動同步，完整走一遍。
- UI 依 Desktop 規範製作，畫面由使用者自己測試。
