// The "Illustrated" interface's path diagrams: which way power and data are
// flowing right now, drawn as boxes on a small grid with the live path lit
// (the way a printer shows which filament path is in use). Pure data; Studio,
// Pocket and the Desktop (lib/flowPath.ts, a copy) each draw it.

export type FlowNode = { id: string; col: number; row: number; active: boolean };
export type FlowEdge = { from: string; to: string; active: boolean };
export type FlowGraph = { cols: number; rows: number; nodes: FlowNode[]; edges: FlowEdge[] };

export type PowerFlowInput = {
  /** status.power.charger_present (USB-C power seen); null when not reported. */
  chargerPresent: boolean | null;
  /** status.power.charge_state: charging / charge_done / not_charging. */
  chargeState: string;
};

/**
 * USB-C -> charger -> system, with the battery under the charger:
 *
 *   [USB-C] -> [Charger] -> [System]
 *                 |           ^
 *              [Battery] -----+
 *
 * USB present: USB -> charger -> system lit, plus charger -> battery while it
 * charges. No USB: battery -> system. Null when the device reports neither
 * field (no battery support).
 */
export function powerFlow({ chargerPresent, chargeState }: PowerFlowInput): FlowGraph | null {
  const state = chargeState.trim();
  const known = state && state !== '-' && state !== 'unknown';
  if (chargerPresent === null && !known) return null;
  const usb = chargerPresent ?? (state === 'charging' || state === 'charge_done');
  const charging = usb && state === 'charging';
  return {
    cols: 3,
    rows: 2,
    nodes: [
      { id: 'usb', col: 0, row: 0, active: usb },
      { id: 'charger', col: 1, row: 0, active: usb },
      { id: 'system', col: 2, row: 0, active: true },
      { id: 'battery', col: 1, row: 1, active: charging || !usb },
    ],
    edges: [
      { from: 'usb', to: 'charger', active: usb },
      { from: 'charger', to: 'system', active: usb },
      { from: 'charger', to: 'battery', active: charging },
      { from: 'battery', to: 'system', active: !usb },
    ],
  };
}

export type ConnectionFlowInput = {
  /** wifi: through a relay on the LAN (Studio, Pocket, headless); espnow: through a Hub. */
  link: 'wifi' | 'espnow';
  /** The device is reachable through its relay. */
  deviceOnline: boolean;
  /** The relay holds its connection to the server; null when this app can't tell. */
  upstreamOnline: boolean | null;
};

/** Device -> relay (or Hub) -> server, lit as far as the data gets. */
export function connectionFlow({ link, deviceOnline, upstreamOnline }: ConnectionFlowInput): FlowGraph {
  const relay = link === 'espnow' ? 'hub' : 'relay';
  const upstream = deviceOnline && upstreamOnline !== false;
  return {
    cols: 3,
    rows: 1,
    nodes: [
      { id: 'device', col: 0, row: 0, active: deviceOnline },
      { id: relay, col: 1, row: 0, active: deviceOnline },
      { id: 'server', col: 2, row: 0, active: upstream },
    ],
    edges: [
      { from: 'device', to: relay, active: deviceOnline },
      { from: relay, to: 'server', active: upstream },
    ],
  };
}

export type FlowBox = { id: string; x: number; y: number; w: number; h: number; active: boolean };
export type FlowWire = { from: string; to: string; active: boolean; points: [number, number][] };

/**
 * Pixel layout of a graph: boxes on the grid, wires between their edges
 * (straight in a row or column, otherwise one bend: out sideways, then up or
 * down into the target).
 */
export function flowLayout(graph: FlowGraph, { cellW = 112, cellH = 48, gapX = 36, gapY = 26 } = {}) {
  const boxes: FlowBox[] = graph.nodes.map((node) => ({ id: node.id, x: node.col * (cellW + gapX), y: node.row * (cellH + gapY), w: cellW, h: cellH, active: node.active }));
  const byId = new Map(boxes.map((box) => [box.id, box]));
  const wires: FlowWire[] = [];
  for (const edge of graph.edges) {
    const a = byId.get(edge.from);
    const b = byId.get(edge.to);
    if (!a || !b) continue;
    let points: [number, number][];
    if (a.y === b.y) {
      const forward = b.x > a.x;
      points = [[forward ? a.x + a.w : a.x, a.y + a.h / 2], [forward ? b.x : b.x + b.w, b.y + b.h / 2]];
    } else if (a.x === b.x) {
      const down = b.y > a.y;
      points = [[a.x + a.w / 2, down ? a.y + a.h : a.y], [b.x + b.w / 2, down ? b.y : b.y + b.h]];
    } else {
      const right = b.x > a.x;
      const up = b.y < a.y;
      points = [[right ? a.x + a.w : a.x, a.y + a.h / 2], [b.x + b.w / 2, a.y + a.h / 2], [b.x + b.w / 2, up ? b.y + b.h : b.y]];
    }
    wires.push({ from: edge.from, to: edge.to, active: edge.active, points });
  }
  return {
    width: graph.cols * cellW + (graph.cols - 1) * gapX,
    height: graph.rows * cellH + (graph.rows - 1) * gapY,
    boxes,
    wires,
  };
}

/** Rough rendered width (px) of `text` at `fontPx`: CJK a full em, the rest ~0.62 em. */
export function estimateTextWidth(text: string, fontPx: number): number {
  let em = 0;
  for (const ch of text) em += /[⺀-鿿가-힯＀-￯]/.test(ch) ? 1 : 0.62;
  return em * fontPx;
}

/** `text` cut in the middle (head…tail) to fit `maxPx` at `fontPx`; whole when it fits. */
export function fitMiddle(text: string, maxPx: number, fontPx: number): string {
  if (estimateTextWidth(text, fontPx) <= maxPx) return text;
  const chars = [...text];
  let keep = chars.length - 1;
  for (; keep > 2; keep--) {
    const head = Math.ceil(keep / 2);
    const out = chars.slice(0, head).join('') + '…' + chars.slice(chars.length - (keep - head)).join('');
    if (estimateTextWidth(out, fontPx) <= maxPx) return out;
  }
  return chars.slice(0, 2).join('') + '…';
}

export type FlowText = { title: string; value?: string };

/** Box width (px) that fits every label of the graph, between min and max. */
export function flowCellWidth(labels: readonly FlowText[], { titlePx = 11.5, valuePx = 13, padding = 24, min = 112, max = 200 } = {}): number {
  const widest = Math.max(0, ...labels.map((label) => Math.max(estimateTextWidth(label.title, titlePx) * 1.05, estimateTextWidth(label.value ?? '', valuePx) * 1.08)));
  return Math.round(Math.max(min, Math.min(max, widest + padding)));
}
