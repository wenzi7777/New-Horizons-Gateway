// Tools > Device files: the Desktop's DeviceFilesPage (New-Horizons-Desktop
// frontend/src/pages/DeviceFilesPage.tsx). Files per scope (user / logs /
// calibration), preview, download (save dialog), upload to the user scope
// with progress + cancel, delete, and the flash usage bar. Upload and delete
// need maintenance mode, exactly as on the Desktop.

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Download, FileText, Gauge, RefreshCw, ScrollText, Trash2, Upload, UserRound, type LucideIcon } from 'lucide-react';

import { TOOLS_MAX_UPLOAD_BYTES, type ToolsUploadFile } from '../../../shared/areas/tools';
import { Card, Notice, Segmented, useConfirm } from '../../components/ui';
import { useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { deviceRunner, toolsApi } from './api';
import { MAX_USER_PATH, READ_CHUNK_BYTES, ensureReadAdvanced, ensureReadOk, hexToBytes, readFailure, writeDeviceFile, type TransferProgress } from './lib/deviceFileTransfer';
import { storageSnapshotFromResult, type StorageSnapshot } from './lib/storageStatus';
import { filesStrings, type FilesStringsKey } from './filesStrings';
import { ToolDeviceHeader, ToolDevicePicker, type ToolProps } from './TerminalTool';
import './tools-terminal-files.css';

const SCOPES = ['user', 'logs', 'calibration'] as const;
type FileScope = (typeof SCOPES)[number];
const SCOPE_ICONS: Record<FileScope, LucideIcon> = { user: UserRound, logs: ScrollText, calibration: Gauge };
const LOG_PREVIEW_BYTES = 32768;

type FileEntry = { scope: string; path: string; name: string; size: number };
const fileKey = (file: FileEntry) => `${file.scope}:${file.path}`;

function previewTextOf(bytes: Uint8Array) {
  let control = 0;
  for (const byte of bytes) if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  if (bytes.length === 0 || control / bytes.length < 0.02) return new TextDecoder().decode(bytes);
  const lines: string[] = [];
  for (let offset = 0; offset < Math.min(bytes.length, 4096); offset += 16) {
    const row = Array.from(bytes.subarray(offset, offset + 16));
    const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  |${ascii}|`);
  }
  return lines.join('\n');
}

function normalizeItems(result: Record<string, unknown> | null, scope: FileScope): FileEntry[] {
  const raw = Array.isArray(result?.items) ? result.items : Array.isArray(result?.data) ? result.data : [];
  return (raw as unknown[])
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .filter((item) => !item.is_dir)
    .map((item) => {
      const rawPath = String(item.path ?? '');
      const prefix = `/${scope}/`;
      const path = rawPath.startsWith(prefix) ? rawPath.slice(prefix.length) : rawPath;
      return { scope: String(item.scope ?? scope), path, name: String(item.name ?? path), size: Number(item.size ?? 0) };
    })
    .filter((item) => item.path);
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}
function formatSpeed(bps: number) {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  if (bps >= 1024 * 1024) return `${(bps / 1024 / 1024).toFixed(1)} MB/s`;
  if (bps >= 1024) return `${(bps / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bps)} B/s`;
}
function formatEta(remaining: number, bps: number) {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  const s = remaining / bps;
  if (s >= 3600) return `~${Math.round(s / 3600)}h`;
  if (s >= 60) return `~${Math.round(s / 60)}m`;
  return `~${Math.round(s)}s`;
}
function percent(used: number, total: number) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}
function chunkBytes(result: Record<string, unknown>) {
  const data = typeof result.data === 'string' ? result.data : '';
  return /^[0-9a-fA-F]*$/.test(data) ? hexToBytes(data) : new TextEncoder().encode(data);
}
function merge(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function DeviceFilesTool({ uid, navigate }: ToolProps) {
  const { api, snapshot } = useStudio();
  const t = useAreaT(filesStrings);
  const tools = useMemo(() => toolsApi(api), [api]);
  const [confirmElement, ask] = useConfirm();
  const devices = snapshot?.devices ?? [];
  const device = uid ? (devices.find((d) => d.uid === uid) ?? null) : null;
  const mode = device?.mode ?? '';
  const maintenanceMode = mode === 'maintenance' || mode === 'safe_maintenance' || mode === 'SafeMaintenance';

  const [busy, setBusy] = useState(0);
  const running = busy > 0;
  const [activeScope, setActiveScope] = useState<FileScope>('logs');
  const [itemsByScope, setItemsByScope] = useState<Record<FileScope, FileEntry[]>>({ user: [], logs: [], calibration: [] });
  const [statusMessage, setStatusMessage] = useState('');
  const [uploadFile, setUploadFile] = useState<ToolsUploadFile | null>(null);
  const [uploadPath, setUploadPath] = useState('');
  const [selectedFile, setSelectedFile] = useState<FileEntry | null>(null);
  const [previewFor, setPreviewFor] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewText, setPreviewText] = useState('');
  const [downloadProgress, setDownloadProgress] = useState<TransferProgress | null>(null);
  const [uploadProgress, setUploadProgress] = useState<TransferProgress | null>(null);
  const uploadAbortRef = useRef(false);
  const [storage, setStorage] = useState<StorageSnapshot>(() => storageSnapshotFromResult(undefined));
  const previewRef = useRef<HTMLPreElement | null>(null);

  // Every device command goes through here so the toolbar can show "busy".
  const queue = useMemo(() => {
    if (!uid) return null;
    const run = deviceRunner(api, uid);
    return async (payload: Record<string, unknown>) => {
      setBusy((n) => n + 1);
      try {
        return await run(payload);
      } finally {
        setBusy((n) => n - 1);
      }
    };
  }, [api, uid]);

  const items = itemsByScope[activeScope];
  const isUserScope = activeScope === 'user';

  const refreshStorage = useCallback(async () => {
    if (!queue) return;
    const response = await queue({ command: 'storage_status' });
    setStorage(storageSnapshotFromResult(response.result));
  }, [queue]);

  const refreshScope = useCallback(
    async (scope: FileScope) => {
      if (!queue) return;
      const response = await queue({ command: 'file_list', scope });
      const failure = readFailure(response.result);
      if (failure) {
        setStatusMessage(failure);
        return;
      }
      setItemsByScope((current) => ({ ...current, [scope]: normalizeItems(response.result, scope) }));
      setStatusMessage(`${t('fileListUpdated')}: ${scope}`);
    },
    [queue, t],
  );

  useEffect(() => {
    setItemsByScope({ user: [], logs: [], calibration: [] });
    setSelectedFile(null);
    setUploadFile(null);
    setStatusMessage('');
  }, [uid]);

  useEffect(() => {
    if (!uid) return;
    void refreshScope(activeScope);
    void refreshStorage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScope, uid]);

  // Logs open on the newest log; other scopes start with nothing selected.
  useEffect(() => {
    const kept = items.find((item) => item.path === (selectedFile?.path ?? '') && item.scope === activeScope) ?? null;
    const next = kept ?? (activeScope === 'logs' ? (items.find((i) => i.path === 'device.log') ?? items.find((i) => i.path === 'device.log.1') ?? items[0] ?? null) : null);
    if (next?.path !== selectedFile?.path) setSelectedFile(next);
  }, [activeScope, items, selectedFile?.path]);

  useEffect(() => {
    setPreviewFor(null);
    setPreviewText('');
    setPreviewError('');
  }, [selectedFile?.scope, selectedFile?.path]);

  useEffect(() => {
    if (!queue || !selectedFile || previewFor !== fileKey(selectedFile)) return undefined;
    let cancelled = false;
    const file = selectedFile;
    void (async () => {
      setPreviewLoading(true);
      setPreviewError('');
      try {
        const begin = await queue({ command: 'file_read_begin', scope: file.scope, path: file.path });
        ensureReadOk(begin.result);
        const size = Number(begin.result?.size ?? file.size ?? 0);
        const length = Math.min(size || LOG_PREVIEW_BYTES, LOG_PREVIEW_BYTES);
        let offset = file.scope === 'logs' ? Math.max(size - length, 0) : 0;
        const parts: Uint8Array[] = [];
        let loaded = 0;
        while (!cancelled && loaded < length) {
          const chunk = await queue({ command: 'file_read_chunk', scope: file.scope, path: file.path, offset, length: READ_CHUNK_BYTES });
          ensureReadOk(chunk.result);
          const result = chunk.result ?? {};
          const bytes = chunkBytes(result);
          parts.push(bytes);
          loaded += bytes.length;
          const nextOffset = Number(result.next_offset ?? offset + bytes.length);
          const hasMore = Boolean(result.has_more ?? nextOffset < size);
          if (!bytes.length || !hasMore) break;
          ensureReadAdvanced(offset, nextOffset, hasMore);
          offset = nextOffset;
        }
        if (!cancelled) setPreviewText(previewTextOf(merge(parts)));
      } catch (error) {
        if (!cancelled) {
          setPreviewText('');
          setPreviewError(error instanceof Error ? error.message : 'request_failed');
        }
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [queue, previewFor, selectedFile]);

  useEffect(() => {
    const el = previewRef.current;
    if (el) el.scrollTop = selectedFile?.scope === 'logs' ? el.scrollHeight : 0;
  }, [previewText, selectedFile?.scope]);

  // The Desktop's download loop: progress, and one retry after re-reading the
  // size (a device that rebooted mid-download may hold a different file).
  async function downloadFileBytes(file: FileEntry, onProgress: (loaded: number, total: number) => void) {
    if (!queue) throw new Error('device_uid_required');
    const begin = await queue({ command: 'file_read_begin', scope: file.scope, path: file.path });
    ensureReadOk(begin.result);
    const size = Number(begin.result?.size ?? file.size ?? 0);
    let offset = 0;
    let retried = false;
    const chunks: Uint8Array[] = [];
    onProgress(0, size);
    while (offset < size || chunks.length === 0) {
      const chunk = await queue({ command: 'file_read_chunk', scope: file.scope, path: file.path, offset, length: READ_CHUNK_BYTES });
      const failure = readFailure(chunk.result);
      if (failure) {
        if (retried) throw new Error(failure);
        retried = true;
        const again = await queue({ command: 'file_read_begin', scope: file.scope, path: file.path });
        ensureReadOk(again.result);
        if (Number(again.result?.size ?? -1) !== size) throw new Error('file_changed');
        continue;
      }
      retried = false;
      const result = chunk.result ?? {};
      const bytes = chunkBytes(result);
      chunks.push(bytes);
      const nextOffset = Number(result.next_offset ?? offset + bytes.length);
      const hasMore = Boolean(result.has_more ?? nextOffset < size);
      ensureReadAdvanced(offset, nextOffset, hasMore);
      offset = nextOffset;
      onProgress(Math.min(offset, size), size);
      if (!hasMore) break;
    }
    return merge(chunks);
  }

  async function downloadFile(file: FileEntry) {
    const startTime = Date.now();
    setDownloadProgress({ loaded: 0, total: file.size, startTime });
    let bytes: Uint8Array;
    try {
      bytes = await downloadFileBytes(file, (loaded, total) => setDownloadProgress({ loaded, total, startTime }));
    } catch (error) {
      setDownloadProgress(null);
      setStatusMessage(`${t('downloadFailed')}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    setDownloadProgress(null);
    try {
      const saved = await tools.saveFile({ defaultName: file.name || file.path.split('/').pop() || 'download.bin', data: bytes });
      if (saved) setStatusMessage(`${t('saved')}: ${saved}`);
    } catch (error) {
      setStatusMessage(`${t('downloadFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function deleteFile(file: FileEntry) {
    if (!queue) return;
    const response = await queue({ command: 'file_delete', scope: file.scope, path: file.path });
    const failure = readFailure(response.result);
    setStatusMessage(failure ? `${t('delete')}: ${failure}` : `${t('delete')}: ${file.path}`);
    await refreshScope(file.scope as FileScope);
    await refreshStorage();
  }

  async function chooseUpload() {
    try {
      const picked = await tools.openUploadFile(TOOLS_MAX_UPLOAD_BYTES);
      if (picked) {
        setUploadFile(picked);
        setUploadPath('');
      }
    } catch (error) {
      setStatusMessage(`${t('uploadFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function uploadSelectedFile() {
    if (!uploadFile || !queue) return;
    const targetPath = uploadPath.trim() || uploadFile.name;
    if (targetPath.length > MAX_USER_PATH) {
      setStatusMessage(`${t('uploadFailed')}: path_too_long (${targetPath.length}/${MAX_USER_PATH})`);
      return;
    }
    uploadAbortRef.current = false;
    try {
      await writeDeviceFile(queue, { path: targetPath, bytes: uploadFile.data, scope: 'user', onProgress: setUploadProgress, abortRef: uploadAbortRef });
      setStatusMessage(`${t('uploadComplete')}: ${targetPath}`);
      setUploadFile(null);
      setUploadPath('');
      await refreshScope('user');
      await refreshStorage();
    } catch (error) {
      setStatusMessage(`${t('uploadFailed')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      uploadAbortRef.current = false;
      setUploadProgress(null);
    }
  }

  async function toggleMaintenance(enable: boolean) {
    if (!queue || !uid) return;
    await queue(enable ? { command: 'enter_maintenance', reason: 'file_browser_upload' } : { command: 'exit_maintenance' });
    await api.run(uid, { kind: 'status' }).catch(() => undefined);
    await refreshStorage();
    await refreshScope(activeScope);
  }

  async function confirmDelete(file: FileEntry) {
    const ok = await ask({ title: t('deviceFilesDeleteTitle', { name: file.name || file.path }), message: t('deviceFilesDeleteMessage'), confirmLabel: t('delete'), danger: true });
    if (ok) await deleteFile(file).catch(() => undefined);
  }

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    if (!items.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const index = items.findIndex((item) => item.path === selectedFile?.path);
      const next = event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
      setSelectedFile(items[next] ?? null);
    } else if (event.key === 'Enter' && selectedFile) {
      event.preventDefault();
      setPreviewFor(fileKey(selectedFile));
    }
  }

  if (!uid) {
    return (
      <ToolDevicePicker
        devices={devices}
        title={t('pickDeviceTitle')}
        copy={t('pickDeviceCopy')}
        empty={t('noDevices')}
        offlineLabel={t('deviceOffline')}
        onPick={(next) => navigate({ area: 'tools', path: ['files', next] })}
      />
    );
  }

  const scopeLabel = (scope: string) => (SCOPES.includes(scope as FileScope) ? t(`fileScope_${scope}` as FilesStringsKey) : scope);
  const ScopeIcon = SCOPE_ICONS[activeScope];
  const transfer = downloadProgress ?? uploadProgress;
  const transferText = (() => {
    if (!transfer) return '';
    const elapsed = (Date.now() - transfer.startTime) / 1000;
    const speed = elapsed > 0.5 ? transfer.loaded / elapsed : 0;
    const s = formatSpeed(speed);
    const eta = formatEta(transfer.total - transfer.loaded, speed);
    return `${formatFileSize(transfer.loaded)} / ${formatFileSize(transfer.total)}${s ? ` · ${s}` : ''}${eta ? ` · ${eta}` : ''}`;
  })();
  const writeTitle = (label: string) => (maintenanceMode ? label : t('fileWriteRequiresMaintenance'));

  return (
    <div className="tool-files stack">
      <ToolDeviceHeader device={device} uid={uid} changeLabel={t('changeDevice')} offlineLabel={t('deviceOffline')} onChange={() => navigate({ area: 'tools', path: ['files'] })} />
      <Card
        title={t('deviceFiles')}
        actions={
          <>
            <button type="button" className="icon-button" title={t('refresh')} aria-label={t('refresh')} disabled={running} onClick={() => void refreshScope(activeScope).then(refreshStorage)}>
              <RefreshCw size={15} aria-hidden="true" className={running ? 'spin' : undefined} />
            </button>
            {isUserScope ? (
              <button type="button" className="icon-button" title={writeTitle(t('upload'))} aria-label={t('upload')} disabled={running || !maintenanceMode} onClick={() => void chooseUpload()}>
                <Upload size={16} aria-hidden="true" />
              </button>
            ) : null}
            <button type="button" className="icon-button" title={t('download')} aria-label={t('download')} disabled={running || !selectedFile} onClick={() => selectedFile && void downloadFile(selectedFile)}>
              <Download size={16} aria-hidden="true" />
            </button>
            <button type="button" className="icon-button files-danger" title={writeTitle(t('delete'))} aria-label={t('delete')} disabled={running || !selectedFile || !maintenanceMode} onClick={() => selectedFile && void confirmDelete(selectedFile)}>
              <Trash2 size={16} aria-hidden="true" />
            </button>
          </>
        }
      >
        <Segmented
          label={t('fileScopes')}
          value={activeScope}
          onChange={setActiveScope}
          options={SCOPES.map((scope) => ({ value: scope, label: `${scopeLabel(scope)} (${itemsByScope[scope].length})` }))}
        />

        {isUserScope ? (
          <div className={`files-banner${maintenanceMode ? ' on' : ''}`}>
            <span>
              <strong>{t('maintenanceModeLabel')}</strong> · {maintenanceMode ? t('enabledState') : t('fileWriteRequiresMaintenance')}
            </span>
            <button className="button tiny" type="button" disabled={running} onClick={() => void toggleMaintenance(!maintenanceMode)}>
              {maintenanceMode ? t('exitMaintenance') : t('enterMaintenance')}
            </button>
          </div>
        ) : null}

        {uploadFile ? (
          <div className="files-upload">
            <Upload size={14} aria-hidden="true" />
            <span className="files-upload-name">
              {uploadFile.name} · {formatFileSize(uploadFile.data.length)}
            </span>
            <label className="files-upload-path">
              {t('paramPath')}
              <input value={uploadPath} maxLength={64} onChange={(e) => setUploadPath(e.target.value)} placeholder={uploadFile.name} />
            </label>
            <button className="button tiny primary" type="button" disabled={running || !maintenanceMode || Boolean(uploadProgress)} onClick={() => void uploadSelectedFile()}>
              {t('upload')}
            </button>
            <button
              className="button tiny ghost"
              type="button"
              onClick={() => {
                if (uploadProgress) uploadAbortRef.current = true;
                else setUploadFile(null);
              }}
            >
              {t('cancel')}
            </button>
          </div>
        ) : null}

        <div className="files-body">
          <div className="files-list-pane">
            <div className="files-list-head" aria-hidden="true">
              <span>{t('filesColName')}</span>
              <span>{t('filesColSize')}</span>
            </div>
            <div
              className="files-list"
              role="listbox"
              aria-label={scopeLabel(activeScope)}
              aria-activedescendant={selectedFile ? `file-${encodeURIComponent(fileKey(selectedFile))}` : undefined}
              tabIndex={0}
              onKeyDown={onListKey}
            >
              {items.length === 0 ? <p className="empty">{running ? t('loading') : t('emptyFiles')}</p> : null}
              {items.map((file) => {
                const selected = selectedFile?.path === file.path;
                return (
                  <div
                    key={fileKey(file)}
                    id={`file-${encodeURIComponent(fileKey(file))}`}
                    role="option"
                    aria-selected={selected}
                    className={`files-row${selected ? ' selected' : ''}`}
                    onClick={() => setSelectedFile(file)}
                    onDoubleClick={() => {
                      setSelectedFile(file);
                      setPreviewFor(fileKey(file));
                    }}
                  >
                    <span className="files-name">
                      <FileText size={15} aria-hidden="true" />
                      <span>{file.name || file.path}</span>
                    </span>
                    <span className="muted">{formatFileSize(file.size)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <aside className="files-preview" aria-label={t('preview')}>
            {!selectedFile ? (
              <div className="files-preview-hero">
                <ScopeIcon size={36} aria-hidden="true" />
                <span>{items.length ? t('deviceFilesSelectHint') : t('emptyFiles')}</span>
              </div>
            ) : (
              <>
                <div className="files-preview-head">
                  <FileText size={26} aria-hidden="true" />
                  <div>
                    <strong>{selectedFile.name || selectedFile.path}</strong>
                    <span className="muted">
                      {scopeLabel(selectedFile.scope)} · {formatFileSize(selectedFile.size)}
                    </span>
                  </div>
                </div>
                <div className="actions">
                  {previewFor === fileKey(selectedFile) ? (
                    <button className="button tiny" type="button" onClick={() => setPreviewFor(null)}>
                      {t('hidePreview')}
                    </button>
                  ) : (
                    <button className="button tiny primary" type="button" disabled={running} onClick={() => setPreviewFor(fileKey(selectedFile))}>
                      {t('preview')}
                    </button>
                  )}
                  <button className="button tiny" type="button" disabled={running} onClick={() => void downloadFile(selectedFile)}>
                    <Download size={13} aria-hidden="true" />
                    {t('download')}
                  </button>
                </div>
                {previewFor === fileKey(selectedFile) ? (
                  <div aria-live="polite">
                    <p className="muted files-preview-note">{selectedFile.scope === 'logs' ? t('deviceFilesLogTail') : t('deviceFilesHead')}</p>
                    {previewLoading ? <p className="muted">{t('loadingPreview')}</p> : null}
                    {previewError ? <Notice kind="error">{previewError}</Notice> : null}
                    {!previewLoading && !previewError ? (
                      <pre ref={previewRef} className="json-view files-preview-text" tabIndex={0}>
                        {previewText}
                      </pre>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </aside>
        </div>

        <footer className="files-footer">
          <div className="files-storage" title={storage.categories.map((c) => `${c.scope}: ${formatFileSize(c.bytes)}`).join(' · ')}>
            <span>{t('deviceStorage')}</span>
            <div
              className="files-storage-track"
              role="meter"
              aria-label={t('deviceStorage')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent(storage.usedBytes, storage.totalBytes))}
            >
              {storage.categories.length > 0
                ? storage.categories.map((c) => <span key={c.scope} className={`files-storage-seg ${c.scope}`} style={{ width: `${percent(c.bytes, storage.totalBytes)}%` }} />)
                : storage.totalBytes > 0
                  ? <span className="files-storage-seg other" style={{ width: `${percent(storage.usedBytes, storage.totalBytes)}%` }} />
                  : null}
            </div>
            <span>
              {storage.hasPayload
                ? t('deviceFilesStorageUsed', { used: formatFileSize(storage.usedBytes), total: formatFileSize(storage.totalBytes), free: formatFileSize(storage.freeBytes) })
                : t('flashUnavailable')}
            </span>
            <button className="icon-button small" type="button" title={t('refreshFlashUsage')} aria-label={t('refreshFlashUsage')} disabled={running} onClick={() => void refreshStorage()}>
              <RefreshCw size={12} aria-hidden="true" />
            </button>
          </div>
          <div className="files-status" aria-live="polite">
            {transfer ? (
              <span className="files-transfer">
                <span className="progress-track" role="progressbar" aria-label={t('transferProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={transfer.total > 0 ? Math.round((transfer.loaded / transfer.total) * 100) : 0}>
                  <span className="progress-fill" style={{ width: `${transfer.total > 0 ? Math.round((transfer.loaded / transfer.total) * 100) : 0}%` }} />
                </span>
                {transferText}
              </span>
            ) : (
              statusMessage
            )}
          </div>
        </footer>
      </Card>
      {confirmElement}
    </div>
  );
}
