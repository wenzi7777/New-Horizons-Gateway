// Ported from New-Horizons-Desktop/frontend/src/lib/sensorLabel.ts (keep in step).
// One numbering for every sensor label the Desktop shows: the CSV export's.
// Its P1..Pn columns follow the stream's order -- row-major (row * cols +
// col) -- and start at 1.
//
// The firmware's calibration addresses sensors column-major instead
// (col * rows + row, MatrixScanner's colMajorIdx), and its stored profiles
// are keyed by that index, so calibration commands keep it; only what is
// displayed is translated here.

export function streamSensorLabel(rowMajorIndex: number): string {
  return `P${rowMajorIndex + 1}`;
}

export function calibrationToStreamIndex(sensorIndex: number, rows: number, cols: number): number {
  if (rows <= 0 || cols <= 0) return sensorIndex;
  const row = sensorIndex % rows;
  const col = Math.floor(sensorIndex / rows);
  return row * cols + col;
}

export function calibrationSensorLabel(sensorIndex: number, rows: number, cols: number): string {
  return streamSensorLabel(calibrationToStreamIndex(sensorIndex, rows, cols));
}
