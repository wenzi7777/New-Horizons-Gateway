// datetime.now(timezone.utc).isoformat(), byte for byte: the Backend and the
// WebUI already parse the Python Gateway's timestamps (connected_at,
// last_connected_at, checked_at), so the TS Gateway writes the same shape --
// "+00:00" rather than "Z", and microseconds that vanish when they are zero.

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

export function pyIsoUtcFromEpochUs(epochUs: number): string {
  const us = Math.floor(epochUs);
  const ms = Math.floor(us / 1000);
  const micro = ((us % 1_000_000) + 1_000_000) % 1_000_000;
  const d = new Date(ms);
  const base =
    `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${base}${micro ? `.${pad(micro, 6)}` : ''}+00:00`;
}
