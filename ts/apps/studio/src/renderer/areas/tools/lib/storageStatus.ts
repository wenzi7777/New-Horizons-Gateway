type RecordLike = Record<string, unknown>;

export type StorageCategory = {
  scope: string;
  bytes: number;
};

export type StorageSnapshot = {
  payload: RecordLike;
  categories: StorageCategory[];
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  hasPayload: boolean;
};

function recordValue(value: unknown): RecordLike {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordLike : {};
}

function numberValue(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function hasStorageFields(value: RecordLike) {
  return (
    "total_bytes" in value
    || "used_bytes" in value
    || "free_bytes" in value
    || Array.isArray(value.categories)
  );
}

function normalizedStoragePayload(value: unknown): RecordLike {
  const direct = recordValue(value);
  if (hasStorageFields(direct)) return direct;
  const nestedStorage = recordValue(direct.storage);
  if (hasStorageFields(nestedStorage)) return nestedStorage;
  const nestedData = recordValue(direct.data);
  if (hasStorageFields(nestedData)) return nestedData;
  const nestedStatus = recordValue(direct.storage_status);
  if (hasStorageFields(nestedStatus)) return nestedStatus;
  return {};
}

function storageCategories(value: unknown): StorageCategory[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is RecordLike => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    .map((item) => ({
      scope: String(item.scope ?? "other"),
      bytes: numberValue(item.bytes, 0),
    }))
    .filter((item) => item.bytes > 0);
}

export function storageSnapshotFromResult(result: unknown): StorageSnapshot {
  const payload = normalizedStoragePayload(result);
  return {
    payload,
    categories: storageCategories(payload.categories),
    totalBytes: numberValue(payload.total_bytes, 0),
    usedBytes: numberValue(payload.used_bytes, 0),
    freeBytes: numberValue(payload.free_bytes, 0),
    hasPayload: hasStorageFields(payload),
  };
}

export function storageSnapshotFromDevice(device: { last_status?: unknown; last_result?: unknown } | null | undefined): StorageSnapshot {
  const lastStatus = recordValue(device?.last_status);
  const lastResult = recordValue(device?.last_result);
  const candidates = [
    lastStatus.storage,
    lastResult.storage,
    String(lastResult.command ?? "") === "storage_status" ? lastResult : undefined,
  ];
  for (const candidate of candidates) {
    const snapshot = storageSnapshotFromResult(candidate);
    if (snapshot.hasPayload) {
      return snapshot;
    }
  }
  return storageSnapshotFromResult(undefined);
}
