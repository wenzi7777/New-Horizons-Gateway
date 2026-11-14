/// <reference path="../../sdk/types/nhos.d.ts" />
export const manifest = {
  id: "steps",
  name: "Step Counter",
  version: "3.0.0",
  author: "wenzi7777",
  summary: "Counts heel strikes; kept across reboots, button resets.",
  category: "biomechanics",
  icon: "foot",
} as const;

// Step counter: heel strikes, kept across reboots; the button resets it.
const heel = new Region({ rows: [50, 100], cols: [0, 100], percent: true });
const loading = new Threshold(300, 100);
const strike = new Debounce(30);
const steps = new Counter({ persist: true });
const pace = new Interval();

on("frame", () => {
  const down = strike.update(loading.update(heel.sum()));
  event("strike", down);
  steps.update(down, button.pressed());
  const cadence = 60000 / pace.update(down);
  if (strike.rose) emit("step", steps.value);
  led.set(Color.Green, down);
  oled.text(0, "Steps", steps.value);
  oled.text(1, "Per min", cadence);
});
