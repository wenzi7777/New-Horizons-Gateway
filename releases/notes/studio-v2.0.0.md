# studio-v2.0.0

**第一版 New Horizons Studio：電腦版 NH Studio、無螢幕的 NH Studio headless，以及手機版 New Horizons Studio Pocket。取代 NH Gateway。**

## NH Studio（macOS / Windows / Linux）

- 在這台電腦上直接管理裝置：清單與收編/釋放、裝置設定、即時畫面（2D/3D）、錄製與 CSV 匯出、Profile 編輯、App Library 與 App Studio、工具（錄製分析、終端機、裝置檔案、時間戳轉換、氣壓控制）、完整的校正工作台。
- 連上 Desktop 伺服器後取代軟體 Gateway，把裝置轉送到伺服器；伺服器的 Relays 頁顯示為 NH Studio。
- 用 Desktop 的帳號登入，錄製、裝置暱稱、群組與 profile 可自動同步。
- 啟動畫面會初始化並檢查更新；設定頁重新分組。

## NH Studio headless（`nh-studio`）

- 給沒有螢幕的電腦（原本跑 Python Gateway 的機器）。放進舊 Gateway 的資料夾執行就會接手設定，Gateway ID 不變。
- `nh-studio --login` 用 Desktop 帳號登入；WebUI 在 5052 埠。會自我更新，失敗會自動退回。

## New Horizons Studio Pocket（Android）

- 裝置管理、即時熱圖、離線錄製（存在手機上，可匯出），登入後自動上傳到伺服器。
- App 內更新：設定 → 軟體更新。

## 注意

- 這一版沒有程式碼簽章：macOS 第一次開啟要在「系統設定 → 隱私權與安全性」允許，Windows 會出現 SmartScreen 提示，Android 要允許安裝來自此來源的 App。
- 伺服器需要 New Horizons Desktop v1.4.0 以上。
