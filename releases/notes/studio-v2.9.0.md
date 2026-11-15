# studio-v2.9.0

**NH Studio 與 NH Pocket 加入 IO 視覺化工具；基準電壓改成「手動 + 兩個開關」；錄製檔記下 v2.0.F 的讀取方式。**

## IO 視覺化工具

- NH Studio：設備設定的腳位卡片新增「開啟 IO 視覺化工具」，左邊是板子圖（v1.0.F、v1.5.F、v2.0.F、GCU v2.1 / v2.2.C / v2.3.D），右邊依矩陣順序點選類比與選擇腳位，可直接套用或複製成終端機指令，與 Desktop 相同。
- NH Pocket：設備頁新增「IO 視覺化工具」，上面是板子圖，下面依序點選腳位，確認後套用（`set_matrix_layout`）。
- 各板子的腳位資料移到 Studio 與 Pocket 共用的 `@nhgw/host`。

## 基準電壓 (TIA-CTL v2.0.F)

- Studio 與 Pocket 的 Raw / 仮想 Rfb / 自動 改成兩個開關：「換算到基準刻度」與其上的「智慧 Vref 調節」。兩個都關是手動，和 v1.5.F 以前的板子讀法相同；智慧調節需要換算開著。Studio 的基準 Rfb 與漏電補償移到「詳細設定」。
- 外部 LED 模式改成開關。

## 錄製

- `.meta.json` 新增 `range`（模式、Vref、基準 Rfb、漏電補償、各列 Rfb 與偏移；只有 v2.0.F 有），錄製中途的變更記在 `changes`。與 New Horizons Desktop v1.13.0 逐位元組相同。

## 其他

- FindMe 卡片不再在兩組值之間跳動：relay 的在線快照不再覆寫設備自己回報的 relay 位址與開機後毫秒，「最終成功」顯示為開機後秒數。
- App：執行中卡片顯示外部 LED 燈條，多個 App 都可能點燈時標示「共用」。
- 搭配 New Horizons OS v2.1.0 與 New Horizons Desktop v1.13.0。
