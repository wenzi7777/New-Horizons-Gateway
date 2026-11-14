/// <reference path="../../sdk/types/nhos.d.ts" />
export const manifest = {
  id: "mat_view",
  name: "Mat View",
  version: "3.0.0",
  author: "wenzi7777",
  summary: "Front/rear load on the OLED; press the button for page 2.",
  category: "display",
  icon: "screen",
} as const;

// Two OLED pages; the button flips between them.
const rear = new Region({ rows: [50, 100], cols: [0, 100], percent: true });
const front = new Region({ rows: [0, 50], cols: [0, 100], percent: true });
const presses = new Counter();

on("frame", () => {
  const rearLoad = rear.sum();
  const frontLoad = front.sum();
  const page = presses.update(button.pressed()) % 2;
  if (page < 0.5) {
    oled.text(0, "Front", frontLoad);
    oled.text(1, "Rear", rearLoad);
    oled.bar(2, "Rear %", rearLoad / (rearLoad + frontLoad), 0, 1);
  } else {
    oled.text(0, "Peak", matrix.peak());
    oled.text(1, "Cells", matrix.activeCells(50));
    oled.text(2, "CoP row", matrix.rowCentroid(), 1);
  }
});
