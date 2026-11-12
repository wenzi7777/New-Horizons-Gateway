# studio-v2.5.0

**NH Studio、NH Pocket、NH Studio headless 可以互相接管設備；被接管時不再把設備從清單移除；伺服器 WebUI 的「接管」對 Studio 也有效。**

## 接管設備

- 三者地位相同：任何一方都能把連在別處的設備直接轉過來，不必先在那邊解除。
- NH Studio（設備頁與設定 > 設備）、NH Pocket：連在別處的設備顯示「接管」，按下前會先確認；設定頁與設備頁的規則一致（以前設定頁對「Elsewhere」的設備也顯示「Add」）。
- NH Studio headless：本機 WebUI 的「接管」在未連上伺服器時也能用，並會顯示設備目前連在哪個中繼。
- 伺服器 Relays 頁的「接管」現在對 NH Studio / Pocket 也有效（以前設備轉過來後收不到回應，claim 會逾時）。

## 被接管與自動接回

- 設備被其他 Studio / Pocket / headless 接管時，會留在「我的設備」並標示「已被 X 接管」，跳出一次通知、停止這裡的錄製，可隨時按「接回」。不會自動搶回。
- 主人暫時不在（例如 Studio 關閉）時，其他中繼只是代為接手；主人回來後會自動把設備接回。

## FindMe

- offer 改為第 2 版，附上目前服務的設備數；新版韌體會依優先順序、是否連上伺服器、延遲與負載挑選中繼。

搭配 New Horizons OS v1.23.0 與 Desktop v1.9.0。
