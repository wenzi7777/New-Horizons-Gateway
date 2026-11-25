# studio-v2.14.0

**即時畫面新增「轉置」；NH Pocket 的即時畫面補齊成 Desktop 視覺化卡片的功能（含 3D）；Gyro / Acc 改成圖形，並新增磁力計。**

## 轉置（NH Studio / NH Pocket）

- Row Mirror / Col Mirror 旁新增「轉置」：行列互換（6 × 8 顯示成 8 × 6），熱圖、3D 曲面、COP 與尺寸標示一起換。先轉置、再鏡像，三個勾選組合出全部 8 種方向。
- 只影響顯示：錄製不變，P 編號跟著感測器走，A.. / D.. 腳位標示隨軸互換。選了感測器配置 profile 時無法轉置。
- NH Studio：選了 profile 時，鏡像改為移動感測器位置（數值留在原感測器），與 Desktop 相同；以前會顯示到別的感測器的值。

## NH Pocket 即時畫面

- 3D 曲面（單指拖曳旋轉、雙指縮放；只在有新資料時重畫，離開畫面即停止）與 2D 熱圖切換；手機無法顯示 3D 時自動改用 2D。
- 感測器配置 profile（從伺服器同步下來，需在設定登入）：以圓點畫在 profile 背景上，可調點大小。
- Row Mirror / Col Mirror / 轉置、矩陣尺寸；統計：樣本數、Device FPS、Render FPS、Max P、平均、COP。
- 每台設備的檢視設定會記住。

## IMU 與磁力計（NH Studio / NH Pocket）

- Gyro / Acc 換成三個面板，每個是儀表 + 最近 10 秒 X / Y / Z 走勢線 + 同色數值：加速度計（水平儀、|a|、roll / pitch）、陀螺儀（置中橫條，30–2000 °/s 自動刻度）、磁力計（新；指南針顯示板子 +X 的航向，以加速度計做傾斜補償，µT 與 |B|；航向為原始值）。沒有磁力計的設備會顯示提示。

## 其他

- NH Pocket 2.14.0（新增原生模組 expo-gl）；NH Studio headless 只改版號。搭配 Desktop v1.17.0；韌體不需更新。
