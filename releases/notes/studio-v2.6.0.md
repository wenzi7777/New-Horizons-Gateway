# studio-v2.6.0

**「附近的設備」可以手動發現；登入改為記住帳號、每次啟動自動登入。**

## 發現設備

- NH Studio 設備頁與 NH Pocket 的「附近的設備」旁新增「探索」按鈕（和 Desktop 管理視窗裡的「探索」相同）。按下後網路上的每台設備會直接回覆這台電腦/手機，所以正由別的中繼（例如 NH Studio headless）服務的設備也會出現，可以直接按「接管」。適用於 Wi-Fi 基地台不轉送設備廣播的網路。不需要登入。
- NH Studio headless 的本機 WebUI 原本就有「探索」按鈕。

## 登入

- NH Studio / NH Pocket 會記住登入的帳號（Studio 用系統鑰匙圈加密，Pocket 用 Android 安全儲存），每次啟動、切換伺服器或 token 失效時自動重新登入；只有記住的密碼無法使用（改過密碼、帳號停用）時才會請你重新登入。
- 移除貼上 app token 的方式；搭配 New Horizons Desktop v1.10.0（Relays 頁不再有 token 管理）。
- 從舊版升級後請在設定裡重新登入一次，之後就會自動登入。

## 修正

- 伺服器拒絕 token 時，標籤與設定檔同步以前不會察覺，現在會正確處理。
