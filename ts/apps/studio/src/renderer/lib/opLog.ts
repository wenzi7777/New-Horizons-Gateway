// The operation log: every command or action the user started, with its
// payload and outcome, newest first, capped.

export type OpStatus = 'running' | 'ok' | 'error';

export type OpEntry = {
  id: number;
  atMs: number;
  /** Device the operation is for ('' for app-wide ones). */
  uid: string;
  label: string;
  payload: Record<string, unknown> | null;
  status: OpStatus;
  message: string;
  durationMs: number | null;
};

export const OP_LOG_LIMIT = 200;

export function startOp(log: readonly OpEntry[], entry: Omit<OpEntry, 'status' | 'message' | 'durationMs'>): OpEntry[] {
  return [{ ...entry, status: 'running' as const, message: '', durationMs: null }, ...log].slice(0, OP_LOG_LIMIT);
}

export function finishOp(log: readonly OpEntry[], id: number, ok: boolean, message: string, nowMs: number): OpEntry[] {
  return log.map((e) => (e.id === id ? { ...e, status: ok ? 'ok' : 'error', message, durationMs: Math.max(0, nowMs - e.atMs) } : e));
}

/** The payload as one line for the log ("set_filter enabled=true median=3 alpha=0.25"). */
export function payloadSummary(payload: Record<string, unknown> | null): string {
  if (!payload) return '';
  const { command, ...rest } = payload;
  const args = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v)}`);
  return [String(command ?? ''), ...args].filter(Boolean).join(' ');
}
