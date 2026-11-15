# studio-v2.9.1

**The heatmap names the pin behind every row and column; the GPIO45 leak compensation switch applies as soon as it is flipped.**

## Live view

- NH Studio: the 2D heatmap labels each row with its analog pin (A0…) on the left and each column with its select pin (D0…) on top, as printed on the board; mirroring flips the labels too. Nothing is shown until the device reports its pin layout.
- NH Pocket: tapping a heatmap cell shows "P number · A pin × D pin · value".

## Reference voltage (TIA-CTL v2.0.F)

- NH Studio: the "compensate GPIO45 pull-down leakage" switch only reached the device with "Apply" and snapped back to the device's value on the next refresh. It now applies at once like the other switches and changes only that setting; "Apply" sends just the reference Rfb. Leak compensation does not need conversion or smart Vref.

## Other

- Pairs with New Horizons OS v2.1.0 and New Horizons Desktop v1.13.1.
