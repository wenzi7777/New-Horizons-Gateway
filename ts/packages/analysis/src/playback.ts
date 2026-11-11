// Playback of a recording: where the cursor is after `elapsedMs` of wall time at a speed.
// Pure, so the screens (Pocket now, Studio later) share one rule and tests pin it.

export const PLAYBACK_SPEEDS = [0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/** The recording time (epoch ms) reached `elapsedMs` of real time after starting at `fromMs`; stops at `endMs`. */
export function playbackTime(fromMs: number, endMs: number, elapsedMs: number, speed: number): { ms: number; finished: boolean } {
  const ms = fromMs + Math.max(0, elapsedMs) * speed;
  return ms >= endMs ? { ms: endMs, finished: true } : { ms, finished: false };
}

/** The next speed in the cycle 0.5, 1, 2, 4, 0.5 … */
export function nextSpeed(current: number): PlaybackSpeed {
  const index = PLAYBACK_SPEEDS.findIndex((s) => s === current);
  if (index < 0) return 1;
  return PLAYBACK_SPEEDS[(index + 1) % PLAYBACK_SPEEDS.length]!;
}
