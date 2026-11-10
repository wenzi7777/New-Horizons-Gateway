# studio-v2.0.1

**修正：NH Studio 與 NH Pocket 同時管理同一台裝置時，裝置會在兩者之間來回跳。**

## 原因

- 裝置每 3 秒廣播一次 FindMe，並接受這一輪最先收到的 offer。兩台主機都管理同一台裝置時，誰的回覆先到，裝置就切到誰，所以每隔幾秒就換一次主機。

## 修正

- 裝置目前串流到哪一台，那一台立刻回覆；其他主機晚 250 ms 才回覆。裝置因此留在原本的主機。
- 原主機關機或斷線時，其他主機的回覆仍然有效，裝置會自動換過去。
- 在另一台按「收編」會立刻生效（收編帶 claim，一律立即回覆）。
- NH Studio、NH Studio headless 與 NH Pocket 都已修正。Pocket v2.0.0 可以在 App 內更新（設定 → 軟體更新）。

## 注意

- 舊版 Python Gateway 收到就回，仍會和 Studio / Pocket 搶裝置；請改用 NH Studio headless。
