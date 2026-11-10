// Tools > Terminal: the Desktop's TerminalPage (New-Horizons-Desktop
// frontend/src/pages/TerminalPage.tsx) for one device. A command line that
// fills a command builder from a pasted / typed command, the command block
// cards, and an output log of the device's replies. Commands are compiled by
// the tools area (terminalCompile, the Desktop's allowlist plus the device's
// own catalog) and sent with api.sendCommand, which waits for the reply, so
// the Desktop's result polling is not needed. Per-device history (↑ / ↓).

import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { History, Play, Trash2 } from 'lucide-react';

import type { DeviceView, StudioSnapshot } from '../../../shared/contract';
import type { TerminalHelpItem } from '../../../shared/areas/tools';
import { Card, Disclosure, Notice, StatusDot, Select, TextInput } from '../../components/ui';
import type { Route } from '../../lib/navigation';
import { useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { toolsApi } from './api';
import {
  COMMAND_BLOCKS,
  COMMAND_GROUP_ORDER,
  LOCAL_ONLY_COMMANDS,
  buildCommandLine,
  deviceCommandBlocks,
  findCommandBlock,
  maintenanceOnlyCommands,
  missingRequiredParams,
  parsePastedCommand,
  type CommandBlock,
  type DeviceCommandSpec,
  type PasteErrorCode,
  type PasteWarning,
} from './lib/terminalCommands';
import { terminalStrings, type TerminalStringsKey } from './terminalStrings';
import './tools-terminal-files.css';

export type ToolProps = { uid: string | null; navigate: (route: Route) => void };

type LogEntry = { id: number; type: 'line'; text: string } | { id: number; type: 'result'; result: Record<string, unknown> };

type PasteResult = { ok: true; command: string; warnings: PasteWarning[] } | { ok: false; error: PasteErrorCode; detail?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * The device's own command table (firmware v1.15.0+), when the engine keeps
 * it in the device record. Studio has no dedicated call for it; without one
 * the static blocks are all there is (as on the Desktop with old firmware).
 */
export function deviceCatalogOf(snapshot: StudioSnapshot | null, uid: string | null): DeviceCommandSpec[] | null {
  if (!snapshot || !uid) return null;
  const detail = snapshot.deviceDetails[uid];
  if (!detail) return null;
  for (const candidate of [detail.record.command_catalog, detail.record.catalog, detail.status.command_catalog]) {
    const list = Array.isArray(candidate) ? candidate : asRecord(candidate)?.commands;
    if (!Array.isArray(list)) continue;
    const specs = list
      .map(asRecord)
      .filter((item): item is Record<string, unknown> => item !== null && typeof item.name === 'string')
      .map((item) => ({
        name: String(item.name),
        maintenance: Boolean(item.maintenance),
        heavy: Boolean(item.heavy),
        quiet: Boolean(item.quiet),
        internal: Boolean(item.internal),
        summary: String(item.summary ?? ''),
      }));
    if (specs.length) return specs as DeviceCommandSpec[];
  }
  return null;
}

// ---- Device picker (shared with DeviceFilesTool) ------------------------------------

export function ToolDevicePicker({
  devices,
  title,
  copy,
  empty,
  offlineLabel,
  onPick,
}: {
  devices: readonly DeviceView[];
  title: string;
  copy: string;
  empty: string;
  offlineLabel: string;
  onPick: (uid: string) => void;
}) {
  return (
    <Card title={title} copy={copy}>
      {devices.length === 0 ? <p className="empty">{empty}</p> : null}
      <ul className="device-list tool-device-list" role="list">
        {devices.map((d) => (
          <li key={d.uid}>
            <button type="button" className={`device-row${d.online ? '' : ' is-offline'}`} onClick={() => onPick(d.uid)}>
              <StatusDot state={d.online ? (d.mode === 'maintenance' ? 'maintenance' : 'online') : 'offline'} label={d.online ? undefined : offlineLabel} />
              <span className="device-title">
                <strong>{d.displayName}</strong>
                <small className="muted">{d.uid}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** The selected device's header line with a "change device" button. */
export function ToolDeviceHeader({ device, uid, changeLabel, offlineLabel, onChange, children }: { device: DeviceView | null; uid: string; changeLabel: string; offlineLabel: string; onChange: () => void; children?: ReactNode }) {
  return (
    <div className="tool-device-head">
      <StatusDot state={device?.online ? (device.mode === 'maintenance' ? 'maintenance' : 'online') : 'offline'} label={device?.online ? undefined : offlineLabel} />
      <span className="tool-device-name">
        <strong>{device?.displayName ?? uid}</strong>
        {device && device.displayName !== uid ? <small className="muted">{uid}</small> : null}
      </span>
      <span className="spacer" />
      {children}
      <button type="button" className="button tiny" onClick={onChange}>
        {changeLabel}
      </button>
    </div>
  );
}

// ---- Result card ---------------------------------------------------------------------

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : String(v))).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function resultSummaryRows(result: Record<string, unknown>): [string, unknown][] {
  const state = asRecord(result.update_state) ?? {};
  const system = asRecord(result.system) ?? {};
  const command = String(result.command ?? '');
  const isReleaseCheck = command === 'check_update';
  const isWriteCommand = command === 'apply_update';
  const phase = String(state.phase ?? '');
  const showUpdateState = isReleaseCheck || isWriteCommand || phase === 'downloading' || phase === 'done' || phase === 'error';
  const rows: [string, unknown][] = [
    ['command', result.command],
    ['status', result.status],
    ['message', result.message],
    ['mode', result.mode ?? system.mode],
    ['system', system.name],
    ['firmware_version', result.firmware_version ?? system.firmware_version],
    ['protocol', result.protocol],
    ['latest_release', isReleaseCheck ? (result.latest_version ?? state.version) : ''],
    ['applied_release', isWriteCommand ? (result.version ?? state.version) : ''],
    ['phase', showUpdateState ? state.phase : ''],
    ['operation', showUpdateState ? state.operation : ''],
    ['current_file', showUpdateState ? state.current_file : ''],
    ['request_id', result.request_id],
  ];
  return rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
}

function ResultCard({ result, rawLabel }: { result: Record<string, unknown>; rawLabel: string }) {
  const status = String(result.status ?? '');
  return (
    <div className={`term-entry result${status === 'error' ? ' error' : ''}`}>
      <div className="term-result-head">
        <strong>{String(result.command ?? 'result')}</strong>
        {status ? <span className={`status-pill ${status === 'error' ? 'waiting' : 'live'}`}>{status}</span> : null}
        {result.message ? <em>{String(result.message)}</em> : null}
      </div>
      <dl className="term-result-grid">
        {resultSummaryRows(result).map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{valueText(value)}</dd>
          </div>
        ))}
      </dl>
      <Disclosure summary={rawLabel}>
        <pre className="json-view">{JSON.stringify(result, null, 2)}</pre>
      </Disclosure>
    </div>
  );
}

function lineKind(text: string) {
  if (text.startsWith('$ ')) return 'command';
  if (text.startsWith('> queued')) return 'queued';
  if (text.startsWith('> ')) return 'topic';
  if (text.startsWith('!') || text.startsWith('ERROR:')) return 'error';
  if (text.startsWith('< ')) return 'success';
  return 'event';
}

function lineText(text: string) {
  return text.replace(/^\$ /, '').replace(/^> /, '').replace(/^< /, '');
}

// The command line is one line: fold shell continuations and newlines (a
// pasted multi-line JSON payload) into spaces.
function singleLine(text: string) {
  return text.replace(/\\\r?\n/g, ' ').replace(/\r?\n/g, ' ');
}

function commandParamDefaults(block: CommandBlock): Record<string, string> {
  return block.params.reduce<Record<string, string>>((values, param) => {
    values[param.key] = param.defaultValue ?? '';
    return values;
  }, {});
}

const VISIBLE_BLOCKS = COMMAND_BLOCKS.filter((block) => !LOCAL_ONLY_COMMANDS.includes(block.command));
const FALLBACK_BLOCK = VISIBLE_BLOCKS.find((block) => block.command === 'status') ?? VISIBLE_BLOCKS[0]!;

// ---- Terminal ----------------------------------------------------------------------------

export function TerminalTool({ uid, navigate }: ToolProps) {
  const { api, snapshot } = useStudio();
  const t = useAreaT(terminalStrings);
  // Command labels / descriptions come from terminalCommands.ts as plain strings.
  const tx = useCallback((key: string) => (key in terminalStrings.en ? t(key as TerminalStringsKey) : key), [t]);
  const tools = useMemo(() => toolsApi(api), [api]);
  const devices = snapshot?.devices ?? [];
  const device = uid ? (devices.find((d) => d.uid === uid) ?? null) : null;

  const [helpItems, setHelpItems] = useState<TerminalHelpItem[]>([]);
  const [selectedCommand, setSelectedCommand] = useState(FALLBACK_BLOCK.command);
  const [paramValues, setParamValues] = useState<Record<string, string>>(() => commandParamDefaults(FALLBACK_BLOCK));
  const nextId = useRef(1);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [running, setRunning] = useState(false);
  const [lineText_, setLineText] = useState('');
  const [pasteResult, setPasteResult] = useState<PasteResult | null>(null);
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  const catalog = useMemo(() => deviceCatalogOf(snapshot, uid), [snapshot, uid]);
  const catalogKey = catalog ? catalog.map((c) => `${c.name}:${c.maintenance ? 1 : 0}`).join(',') : '';
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const extraBlocks = useMemo(() => deviceCommandBlocks(catalog), [catalogKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const maintenanceOnly = useMemo(() => maintenanceOnlyCommands(catalog), [catalogKey]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const deviceCommands = useMemo(() => (catalog ? catalog.filter((c) => !c.internal).map((c) => c.name) : undefined), [catalogKey]);

  useEffect(() => {
    let alive = true;
    void tools
      .terminalHelp()
      .then((items) => {
        if (alive) setHelpItems(items);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [tools]);

  // A new device: fresh log and its own history.
  useEffect(() => {
    setLogs([{ id: nextId.current++, type: 'line', text: t('terminalReady') }]);
    setErrorMessage('');
    setHistory([]);
    historyIndex.current = null;
    if (!uid) return undefined;
    let alive = true;
    void tools
      .terminalHistory(uid)
      .then((items) => {
        if (alive) setHistory(items);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // t only changes the greeting's language; not a reason to drop the log.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tools, uid]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const helpByCommand = useMemo(() => new Map(helpItems.map((item) => [item.command, item])), [helpItems]);
  const selectedBlock = findCommandBlock(selectedCommand, extraBlocks) ?? FALLBACK_BLOCK;
  const generatedCommand = useMemo(() => buildCommandLine(selectedBlock, paramValues), [paramValues, selectedBlock]);
  const missingParams = useMemo(() => missingRequiredParams(selectedBlock, paramValues), [paramValues, selectedBlock]);
  const groups = useMemo(
    () =>
      COMMAND_GROUP_ORDER.map((groupKey) => ({
        groupKey,
        items: [...VISIBLE_BLOCKS, ...extraBlocks].filter((block) => block.groupKey === groupKey),
      })).filter((group) => group.items.length > 0),
    [extraBlocks],
  );

  const describe = (block: CommandBlock) => {
    const text = block.device ? block.device.summary : tx(`terminalHelp${block.command.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase())}`);
    return maintenanceOnly.has(block.command) ? `${text} · ${t('terminalMaintenanceOnly')}` : text;
  };

  const appendLines = (lines: string[]) => setLogs((current) => [...current, ...lines.map((text) => ({ id: nextId.current++, type: 'line' as const, text }))]);
  const appendResult = (result: Record<string, unknown>) => setLogs((current) => [...current, { id: nextId.current++, type: 'result', result }]);

  function selectCommand(command: string) {
    const block = findCommandBlock(command, extraBlocks) ?? FALLBACK_BLOCK;
    setSelectedCommand(block.command);
    setParamValues(commandParamDefaults(block));
    setErrorMessage('');
  }

  function applyCommandLine(text: string) {
    const parsed = parsePastedCommand(text, extraBlocks);
    if (!parsed.ok) {
      setPasteResult({ ok: false, error: parsed.error, detail: parsed.detail });
      return;
    }
    // Only what was written is filled -- no builder defaults -- so Run sends
    // exactly that command; missing required params still gate Run.
    setSelectedCommand(parsed.command);
    setParamValues(parsed.values);
    setErrorMessage('');
    setPasteResult({ ok: true, command: parsed.command, warnings: parsed.warnings });
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text');
    if (!pasted) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    const next = singleLine(`${input.value.slice(0, start)}${pasted}${input.value.slice(end)}`);
    setLineText(next);
    historyIndex.current = null;
    applyCommandLine(next);
  }

  function recall(delta: -1 | 1) {
    if (!history.length) return;
    const current = historyIndex.current ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + delta));
    historyIndex.current = next === history.length ? null : next;
    const text = next === history.length ? '' : (history[next] ?? '');
    setLineText(text);
    if (text) applyCommandLine(text);
    else setPasteResult(null);
  }

  function onLineKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (lineText_.trim()) applyCommandLine(lineText_);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      recall(-1);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      recall(1);
    }
  }

  async function runCommand(commandLine: string) {
    const command = commandLine.trim();
    if (!command || running) return;
    setErrorMessage('');
    appendLines([`$ ${command}`]);
    if (LOCAL_ONLY_COMMANDS.includes(command.split(/\s+/)[0] ?? '')) {
      appendLines([`! ${t('localOnlyDropped')}`]);
      return;
    }
    if (!uid) {
      setErrorMessage('device_uid_required');
      appendLines(['ERROR: device_uid_required']);
      return;
    }
    setRunning(true);
    try {
      const compiled = await tools.terminalCompile(command, deviceCommands);
      if (!compiled.ok) {
        setErrorMessage(`${t('compileFailed')}: ${compiled.error}`);
        appendLines([`ERROR: ${compiled.error}`]);
        return;
      }
      void tools
        .terminalHistoryAdd(uid, command)
        .then(setHistory)
        .catch(() => undefined);
      historyIndex.current = null;
      appendLines([`> queued ${compiled.compiled.command}`]);
      const outcome = await api.sendCommand(uid, compiled.compiled.payload);
      const data = asRecord(outcome.data);
      if (outcome.ok) {
        appendResult(data ?? { command: compiled.compiled.command, status: 'ok', message: outcome.message });
      } else if (outcome.message === 'command_timeout') {
        appendLines([`! ${t('terminalNoResponse')}`]);
      } else {
        setErrorMessage(outcome.message);
        if (data && Object.keys(data).length) appendResult({ command: compiled.compiled.command, ...data, status: 'error' });
        else appendLines([`ERROR: ${outcome.message}`]);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'terminal_execute_failed';
      setErrorMessage(message);
      appendLines([`ERROR: ${message}`]);
    } finally {
      setRunning(false);
    }
  }

  async function handleRun() {
    if (missingParams.length > 0) {
      setErrorMessage(`${t('missingRequiredParams')}: ${missingParams.map((param) => tx(param.labelKey)).join(', ')}`);
      return;
    }
    await runCommand(generatedCommand);
  }

  async function clearHistory() {
    if (!uid) return;
    await tools.terminalHistoryClear(uid).catch(() => undefined);
    setHistory([]);
    historyIndex.current = null;
  }

  if (!uid) {
    return (
      <ToolDevicePicker
        devices={devices}
        title={t('pickDeviceTitle')}
        copy={t('pickDeviceCopy')}
        empty={t('noDevices')}
        offlineLabel={t('deviceOffline')}
        onPick={(next) => navigate({ area: 'tools', path: ['terminal', next] })}
      />
    );
  }

  const lineKindTitle = (text: string) => {
    const kind = lineKind(text);
    if (kind === 'command') return t('command');
    if (kind === 'queued') return t('queued');
    if (kind === 'topic') return t('transportTarget');
    if (kind === 'error') return t('error');
    return t('event');
  };

  return (
    <div className="tool-terminal stack">
      <ToolDeviceHeader device={device} uid={uid} changeLabel={t('changeDevice')} offlineLabel={t('deviceOffline')} onChange={() => navigate({ area: 'tools', path: ['terminal'] })} />
      <div className="tool-terminal-layout">
        <div className="stack tool-terminal-main">
          <Card>
            <div className="field">
              <label htmlFor="terminal-line">{t('terminalPlaceholder')}</label>
              <div className="term-line-row">
                <TextInput
                  id="terminal-line"
                  className="term-line"
                  type="text"
                  value={lineText_}
                  placeholder={t('terminalPlaceholder')}
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby="terminal-line-hint"
                  onPaste={handlePaste}
                  onChange={(event) => {
                    setLineText(event.target.value);
                    setPasteResult(null);
                    historyIndex.current = null;
                  }}
                  onKeyDown={onLineKey}
                />
                <button className="button" type="button" onClick={() => applyCommandLine(lineText_)} disabled={!lineText_.trim()}>
                  {t('terminalPasteFill')}
                </button>
              </div>
              <span className="field-note" id="terminal-line-hint">
                {t('terminalHints')} {t('historyHint')}
              </span>
            </div>
            <div aria-live="polite">
              {pasteResult ? (
                pasteResult.ok ? (
                  <Notice kind="success">{t('terminalPasteFilled').replace('{command}', pasteResult.command)}</Notice>
                ) : (
                  <Notice kind="error">{tx(`terminalPasteError_${pasteResult.error}`).replace('{command}', pasteResult.detail ?? '')}</Notice>
                )
              ) : null}
              {pasteResult?.ok && pasteResult.warnings.length ? (
                <Notice kind="warning">
                  {pasteResult.warnings.map((warning, index) => (
                    <span key={`${warning.code}-${warning.key}-${index}`} className="term-warning">
                      {tx(`terminalPasteWarn_${warning.code}`).replace('{key}', warning.key).replace('{value}', warning.value ?? '')}
                    </span>
                  ))}
                </Notice>
              ) : null}
            </div>
          </Card>

          <Card
            title={
              <>
                <span className="muted term-eyebrow">{t('commandBuilder')}</span> {selectedBlock.command}
              </>
            }
            copy={describe(selectedBlock)}
            actions={
              <button className="button primary" type="button" onClick={() => void handleRun()} disabled={!generatedCommand || missingParams.length > 0 || running}>
                <Play size={14} aria-hidden="true" />
                {running ? t('running') : t('run')}
              </button>
            }
          >
            {selectedBlock.params.length ? (
              <div className="field-grid term-params" aria-label={t('commandFlow')} role="group">
                {selectedBlock.params.map((param) => {
                  const id = `term-param-${param.key}`;
                  const label = `${tx(param.labelKey)} (${param.required ? t('required') : t('optional')})`;
                  return (
                    <div className="field" key={param.key}>
                      <label htmlFor={id}>{label}</label>
                      {param.type === 'select' ? (
                        <Select id={id} value={paramValues[param.key] ?? ''} onChange={(event) => setParamValues((v) => ({ ...v, [param.key]: event.target.value }))}>
                          <option value="">{t('skipParam')}</option>
                          {(param.options ?? []).map((option) => (
                            <option key={option.value} value={option.value}>
                              {tx(option.labelKey)}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <TextInput
                          id={id}
                          inputMode={param.type === 'number' ? 'decimal' : undefined}
                          value={paramValues[param.key] ?? ''}
                          placeholder={param.placeholder}
                          aria-required={param.required || undefined}
                          onChange={(event) => setParamValues((v) => ({ ...v, [param.key]: event.target.value }))}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              void handleRun();
                            }
                          }}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="muted">{t('noParameters')}</p>
            )}
            <div className="term-generated">
              <span className="muted">{t('generatedCommand')}</span>
              <code>{generatedCommand}</code>
            </div>
            {errorMessage ? <Notice kind="error">{errorMessage}</Notice> : null}
          </Card>

          <Card
            title={t('outputLog')}
            actions={
              <button className="button tiny ghost" type="button" onClick={() => setLogs([])} disabled={!logs.length}>
                {t('clearLog')}
              </button>
            }
          >
            <div className="term-log" ref={logRef} role="log" aria-live="polite" aria-relevant="additions" aria-label={t('outputLog')} tabIndex={0}>
              {logs.map((entry) =>
                entry.type === 'line' ? (
                  <div key={entry.id} className={`term-entry ${lineKind(entry.text)}`}>
                    <span className="term-entry-title">{lineKindTitle(entry.text)}</span>
                    <span className="term-entry-body">{lineText(entry.text)}</span>
                  </div>
                ) : (
                  <ResultCard key={entry.id} result={entry.result} rawLabel={t('rawJson')} />
                ),
              )}
            </div>
          </Card>

          <Card
            title={
              <>
                <History size={14} aria-hidden="true" /> {t('historyTitle')}
              </>
            }
            actions={
              <button className="button tiny ghost" type="button" onClick={() => void clearHistory()} disabled={!history.length}>
                <Trash2 size={13} aria-hidden="true" />
                {t('historyClear')}
              </button>
            }
          >
            {history.length === 0 ? <p className="muted">{t('historyEmpty')}</p> : null}
            <ul className="term-history" role="list">
              {[...history].reverse().slice(0, 20).map((line, index) => (
                <li key={`${index}-${line}`}>
                  <button
                    type="button"
                    className="term-history-item"
                    aria-label={t('historyUse', { command: line })}
                    onClick={() => {
                      setLineText(line);
                      applyCommandLine(line);
                    }}
                  >
                    <code>{line}</code>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>

        <aside className="tool-terminal-blocks" aria-labelledby="terminal-blocks-title">
          <h3 id="terminal-blocks-title" className="section-title">
            {t('commandBlocks')}
          </h3>
          {groups.map((group) => (
            <section key={group.groupKey} className={`term-block-group${group.groupKey === 'commandGroupDanger' ? ' danger-zone' : ''}`} aria-label={tx(group.groupKey)}>
              <h4>{tx(group.groupKey)}</h4>
              <div className="term-block-grid">
                {group.items.map((block) => (
                  <button
                    key={block.command}
                    type="button"
                    className={`term-block${selectedCommand === block.command ? ' active' : ''}`}
                    aria-pressed={selectedCommand === block.command}
                    onClick={() => selectCommand(block.command)}
                  >
                    <strong>{block.command}</strong>
                    <small>{describe(block)}</small>
                    <code>{helpByCommand.get(block.command)?.example ?? block.command}</code>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </aside>
      </div>
    </div>
  );
}
