// Ported from New-Horizons-Desktop/frontend/src/lib/valueFormat.ts (keep in step).
// CSV of any JSON-ish value as path,value rows.
function bytesToHex(data: Uint8Array): string {
  return Array.from(data)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join(' ');
}

export function valueToCsv(value: unknown): string {
  const rows = [['path', 'value']];
  function visit(item: unknown, path: string) {
    if (item && typeof item === 'object' && !(item instanceof Uint8Array)) {
      if (Array.isArray(item)) {
        item.forEach((child, index) => visit(child, `${path}[${index}]`));
        return;
      }
      for (const [key, child] of Object.entries(item as Record<string, unknown>)) {
        visit(child, path ? `${path}.${key}` : key);
      }
      return;
    }
    rows.push([path || '$', item instanceof Uint8Array ? bytesToHex(item) : String(item ?? '')]);
  }
  visit(value, '');
  return rows.map((row) => row.map((cell) => `"${cell.replace(/"/g, '""')}"`).join(',')).join('\n');
}
