// Ported from New-Horizons-Desktop/frontend/src/lib/commandResult.ts; keep in step.
function recordValue(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function normalizeCommandResult(result: Record<string, unknown> | null): Record<string, unknown> | null {
  const source = recordValue(result);
  if (!source) return null;

  const nested = recordValue(source.data);
  const looksLikeEnvelope = Boolean(
    nested
      && (
        "cmd" in source
        || "ok" in source
        || "message" in source
        || "error" in source
      ),
  );
  if (!looksLikeEnvelope || !nested) {
    return source;
  }

  return {
    ...source,
    ...nested,
    command: typeof source.cmd === "string" ? source.cmd : source.command,
  };
}
