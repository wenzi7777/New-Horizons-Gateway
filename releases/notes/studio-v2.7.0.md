# studio-v2.7.0

**支援 New Horizons OS v2.0.0 的 App 虛擬機：舊 App 顯示「需要更新」，App Studio 編譯出 bytecode。**

## App

- NH Studio 設備 App 頁新增「需要更新」狀態：v2.0.0 韌體不再執行 v2.0.0 之前建置的 App 套件，這類 App 會標示「需要更新」並提示從 App Store 重新安裝 2.0.0 版。
- 新增錯誤訊息 `needs_update`（套件需要重新建置）與 `app_pool_exhausted`（App 記憶池放不下這個 App）。
- App Studio 改用 SDK 2：編譯時同時產生 bytecode 映像檔，`min_os` 至少為 v2.0.0。
- 搭配 New Horizons OS v2.0.0 與 New Horizons Desktop v1.11.0。NH Pocket 沒有變更，維持 v2.6.0。
