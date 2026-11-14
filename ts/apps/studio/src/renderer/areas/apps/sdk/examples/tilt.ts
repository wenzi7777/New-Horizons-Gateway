/// <reference path="../../sdk/types/nhos.d.ts" />
export const manifest = {
  id: "tilt",
  name: "Tilt Alarm",
  version: "3.0.0",
  author: "wenzi7777",
  summary: "Pitch and roll from the IMU; alerts active a lasting lean.",
  category: "care",
  icon: "level",
} as const;

// Posture: pitch and roll from the IMU; a lean past 25 degrees held for 3 s
// is a slouch, counted and logged with its worst angle.
const leaning = new Threshold(25, 5);
const slouch = new Debounce(3000);
const slouches = new Counter();
const worst = new PeakSince();

function update(): void {
  const pitch = imu.pitch;
  const roll = imu.roll;
  const lean = Math.max(Math.abs(pitch), Math.abs(roll));
  const active = slouch.update(leaning.update(lean));
  event("slouch", active);
  slouches.update(active);
  worst.update(lean, active);
  if (slouch.fell) emit("slouch_deg", worst.value);
  led.set(Color.Red, active);
  strip.meter(lean, 0, 45);
  oled.text(0, "Pitch", pitch, 1);
  oled.text(1, "Roll", roll, 1);
  oled.text(2, "Slouches", slouches.value);
}

on("frame", update);
on("idle", update);
