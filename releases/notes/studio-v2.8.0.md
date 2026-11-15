# studio-v2.8.0

**支援 New Horizons OS v2.1.0：App Studio 改用 TypeScript 風格的語言，安裝時列出危險權限並要求同意。**

## App

- 設備的 App 移到設定頁（設定 → App），版面與 Desktop 相同：資源長條、每個執行中 App 一張卡片（負載與一分鐘走勢）、每個已安裝 App 一個開關，以及詳細面板（暫停 / 繼續、復活、移到最前、解除安裝、該 App 的事件）。開關 App 時自動處理維護模式，錄製中會先確認。拿掉「設備上」分頁，舊連結會開啟設備設定。
- 終端機：新增 `app-reorder`；移除 `app-enable`、`app-disable`、`app-load-flow`、`app-unload-flow`（韌體 v2.1.0 已沒有）。
- App Studio 原始碼改為 `app.ts`（TypeScript 子集），舊 `.nhs` 語法不再支援；編輯器、參考面板（由 `nhos.d.ts` 產生，標示需要同意的 API）、範本、AI 提示、建置面板與模擬器都改為新語言，與 New Horizons Desktop v1.12.0 相同。
- 安裝對話框：App 宣告危險權限（儲存、裝置設定、串流、外接 I2C / UART）時列出說明，勾選同意後才安裝並以 `grant` 送給裝置；板子沒有需要的外接 I/O（只有 v1.5.F、v2.0.F 有）時在寫入前提示。
- 新增錯誤訊息 `capability_not_granted`、`capability_unsupported`；App 套件改以 `vm` 驗證。
- 設備檔案工具新增「App 資料」範圍（App 以 `store.append` 寫出的 CSV）。
- 搭配 New Horizons OS v2.1.0 與 New Horizons Desktop v1.12.0。NH Pocket 沒有變更，維持 v2.6.0。
