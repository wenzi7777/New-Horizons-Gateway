# studio-v2.10.0

**TIA-CTL v2.0.F 的讀數改為 ADC mV、電導 µS、電導＋智慧 Vref 三選一，校正也能在電導模式下進行；錄製檔多記每幀的單位、Vref 與飽和列。**

## 讀數模式（TIA-CTL v2.0.F）

- NH Studio：基準電壓卡片的讀數改為一個選單（ADC mV、電導、電導＋智慧 Vref），按「套用」送出；「換算」與基準 Rfb 已移除，Rfb 表依每列狀態顯示。
- NH Pocket：讀數改為三段按鈕（原始、µS、µS 智慧），按「套用」送出。
- 電導需要先量測 Rfb；沒量到的列輸出 0。

## 錄製

- 設備送出每幀量程資訊時，CSV 多 `range_unit`、`vref_mv`、`saturated_rows` 三欄，和 Desktop 的錄製逐位元組一致。
- `.meta.json` 的 range 記讀數模式、輸出單位、智慧 Vref、Vref、Rfb、offset 與每列狀態；calibration 多記校正檔單位（`unit`）。

## 校正（NH Studio）

- 校正頁顯示校正檔單位：與目前輸出單位不同時提示「保留但不套用」；電導模式下提示校正不受 Vref 改變影響。
- 沒焊 Rfb 的感測器不算擬合失敗，進度只計算有 Rfb 的感測器。
- 新的錯誤訊息：校正中輸出單位改變、校正檔單位不符。

## 其他

- 搭配 New Horizons OS v2.2.0 與 New Horizons Desktop v1.14.0。
