// Tools > Recording analysis: the Desktop's RecordingAnalysisTool for a
// Studio recording (picked from the snapshot, or #/tools/analysis/<id>) or a
// CSV the user opens. The CSV streams from the main process in ~1 MB chunks
// into a module worker that parses as it goes; the page keeps only the typed
// arrays. Range / statistics CSV and chart PNG go out through save dialogs.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, FolderOpen, Image, RotateCcw } from 'lucide-react';

import { TOOLS_CHUNK_BYTES, type ToolsFileSource } from '../../../../shared/areas/tools';
import { Card, Facts, Notice, Segmented, Checkbox, Select } from '../../../components/ui';
import { formatBytes, formatDateTime } from '../../../lib/format';
import type { Route } from '../../../lib/navigation';
import { useStudio } from '../../../state/studio';
import { useAreaT } from '../../i18n';
import { toolsApi } from '../api';
import {
  IMU_GROUPS,
  defaultGridColumns,
  formatDuration,
  formatInstant,
  intervalHistogram,
  metaGridColumns,
  parseEventsCsv,
  parseRecordingMeta,
  placeEvents,
  sensorFrame,
  sensorStats,
  summarizeRecording,
  type ImuGroup,
  type PlacedEvent,
  type Recording,
  type RecordingIssue,
  type RecordingMeta,
} from '@nhgw/analysis';
import { toolsStrings } from '../toolsStrings';
import type { WorkerReply, WorkerRequest } from './recordingWorker';
import { SensorHeatmap } from './SensorHeatmap';
import { TimelineChart, type ChartMarker, type ChartSeries, type TimelineChartHandle } from './TimelineChart';
import { TimestampConverter } from './TimestampConverter';
import '../tools-analysis.css';

type Metric = 'total' | 'peak' | 'contact' | 'sensors';
type HeatmapMode = 'frame' | 'mean' | 'peak';
type Loaded = { name: string; source: ToolsFileSource; eventsSource: ToolsFileSource | null; recording: Recording; meta: RecordingMeta | null; events: PlacedEvent[] };

// Trace colours are data colours (TimelineChart lifts them on dark), as on the Desktop.
const METRIC_COLORS: Record<Exclude<Metric, 'sensors'>, string> = { total: '#1f6b54', peak: '#d9480f', contact: '#2f6fdb' };
const SENSOR_COLORS = ['#1f6b54', '#2f6fdb', '#d9480f', '#9c36b5', '#c2255c', '#0c8599', '#e67700', '#5c7cfa'];
const AXIS_COLORS = ['#d9480f', '#2b8a3e', '#2f6fdb'];
const EVENT_COLOR = '#7048e8';
const FOCUS_SPAN_MS = 4000;
const IMU_KEYS = { acc: 'analysisImuAcc', gyro: 'analysisImuGyro', mag: 'analysisImuMag' } as const;

function formatNumber(value: number) {
  if (!Number.isFinite(value)) return '—';
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return value.toFixed(0);
  if (magnitude >= 100) return value.toFixed(1);
  if (magnitude >= 1) return value.toFixed(2);
  return value === 0 ? '0' : value.toFixed(3);
}

function csvCell(value: unknown) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Streams a source chunk by chunk (the main process caps each read). */
async function streamSource(tools: ReturnType<typeof toolsApi>, source: ToolsFileSource, onChunk: (data: Uint8Array, offset: number, total: number) => void, cancelled: () => boolean) {
  let offset = 0;
  for (;;) {
    if (cancelled()) throw new Error('cancelled');
    const chunk = await tools.readChunk(source, offset, TOOLS_CHUNK_BYTES);
    if (chunk.data.length) onChunk(chunk.data, chunk.nextOffset, chunk.totalBytes);
    offset = chunk.nextOffset;
    if (chunk.done || chunk.data.length === 0) return chunk.totalBytes;
  }
}

async function readAllText(tools: ReturnType<typeof toolsApi>, source: ToolsFileSource): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  let text = '';
  await streamSource(tools, source, (data) => (text += decoder.decode(data, { stream: true })), () => false);
  return text + decoder.decode();
}

/** The header plus original lines [firstLine, lastLine] (file line numbers), streamed. */
async function sliceLines(tools: ReturnType<typeof toolsApi>, source: ToolsFileSource, firstLine: number, lastLine: number): Promise<string> {
  const decoder = new TextDecoder('utf-8');
  const out: string[] = [];
  let pending = '';
  let line = 0;
  const take = (raw: string) => {
    const clean = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === 0 || (line >= firstLine && line <= lastLine)) out.push(clean);
    line += 1;
  };
  let done = false;
  await streamSource(
    tools,
    source,
    (data) => {
      if (done) return;
      const joined = pending + decoder.decode(data, { stream: true });
      const parts = joined.split('\n');
      pending = parts.pop() ?? '';
      for (const part of parts) take(part);
      if (line > lastLine) done = true;
    },
    () => done,
  ).catch((error: unknown) => {
    if (!(error instanceof Error && error.message === 'cancelled')) throw error;
  });
  if (!done && pending) take(pending);
  return `${out.map((item, index) => (index === 0 ? item.replace(/^﻿/, '') : item)).join('\n')}\n`;
}

export function RecordingAnalysisTool({ recordingId, navigate }: { recordingId: string | null; navigate: (route: Route) => void }) {
  const t = useAreaT(toolsStrings);
  const { api, snapshot, locale, toast } = useStudio();
  const tools = useMemo(() => toolsApi(api), [api]);
  const recordings = snapshot?.recordings ?? [];

  const workerRef = useRef<Worker | null>(null);
  const loadId = useRef(0);
  const [progress, setProgress] = useState<{ done: number; total: number; rows: number } | null>(null);
  const [error, setError] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  const [view, setView] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const [cursor, setCursor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [metric, setMetric] = useState<Metric>('total');
  const [selected, setSelected] = useState<number[]>([]);
  const [imuGroup, setImuGroup] = useState<ImuGroup | null>(null);
  const [heatMode, setHeatMode] = useState<HeatmapMode>('frame');
  const [showEvents, setShowEvents] = useState(true);
  const chartRef = useRef<TimelineChartHandle | null>(null);

  useEffect(() => () => workerRef.current?.terminate(), []);

  const worker = useCallback(() => {
    if (!workerRef.current) workerRef.current = new Worker(new URL('./recordingWorker.ts', import.meta.url), { type: 'module' });
    return workerRef.current;
  }, []);

  const load = useCallback(
    async (name: string, source: ToolsFileSource, eventsSource: ToolsFileSource | null, metaRaw: Record<string, unknown> | null) => {
      const id = ++loadId.current;
      setError('');
      setLoaded(null);
      setProgress({ done: 0, total: 0, rows: 0 });
      const w = worker();
      const post = (message: WorkerRequest, transfer?: Transferable[]) => w.postMessage(message, transfer ?? []);
      const result = new Promise<Recording>((resolve, reject) => {
        const onMessage = (event: MessageEvent<WorkerReply>) => {
          const reply = event.data;
          if (reply.id !== id) return;
          if ('rows' in reply) setProgress((p) => (p ? { ...p, rows: reply.rows } : p));
          else {
            w.removeEventListener('message', onMessage);
            if ('error' in reply) reject(new Error(reply.error));
            else resolve(reply.recording);
          }
        };
        w.addEventListener('message', onMessage);
      });
      try {
        post({ id, type: 'start', name });
        await streamSource(
          tools,
          source,
          (data, done, total) => {
            setProgress((p) => ({ done, total, rows: p?.rows ?? 0 }));
            post({ id, type: 'chunk', data }, [data.buffer as ArrayBuffer]);
          },
          () => id !== loadId.current,
        );
        post({ id, type: 'end' });
        const recording = await result;
        if (id !== loadId.current) return;
        let events: PlacedEvent[] = [];
        if (eventsSource) {
          try {
            events = placeEvents(recording, parseEventsCsv(await readAllText(tools, eventsSource)));
          } catch {
            events = [];
          }
        }
        if (id !== loadId.current) return;
        setLoaded({ name, source, eventsSource, recording, meta: metaRaw ? parseRecordingMeta(metaRaw) : null, events });
        setView({ start: 0, end: recording.rowCount });
        setCursor(null);
        setSelected([]);
        setImuGroup(null);
      } catch (cause) {
        if (id !== loadId.current) return;
        post({ id, type: 'cancel' });
        if (!(cause instanceof Error && cause.message === 'cancelled')) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (id === loadId.current) setProgress(null);
      }
    },
    [tools, worker],
  );

  useEffect(() => {
    if (!recordingId) return;
    let stop = false;
    void tools
      .recordingFiles(recordingId)
      .then((files) => {
        if (stop) return;
        void load(
          files.dataName,
          { kind: 'recording', recordingId, file: 'data' },
          files.eventsBytes > 0 ? { kind: 'recording', recordingId, file: 'events' } : null,
          files.meta,
        );
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => {
      stop = true;
    };
  }, [recordingId, tools, load]);

  async function openLocal() {
    try {
      const file = await tools.openAnalysisFile();
      if (!file) return;
      navigate({ area: 'tools', path: ['analysis'] });
      void load(file.name, { kind: 'opened', token: file.token }, file.eventsToken ? { kind: 'opened', token: file.eventsToken } : null, file.meta ?? null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const rec = loaded?.recording ?? null;
  const summary = useMemo(() => (rec ? summarizeRecording(rec) : null), [rec]);
  const histogram = useMemo(() => (rec && summary ? intervalHistogram(rec, summary) : null), [rec, summary]);
  const columns = rec ? metaGridColumns(loaded?.meta ?? null, rec.sensorCount) ?? defaultGridColumns(rec.sensorCount) : 1;
  const start = view.start;
  const end = Math.max(view.start + 1, view.end);
  const stats = useMemo(() => (rec ? sensorStats(rec, start, end) : []), [rec, start, end]);
  const heat = useMemo(() => {
    if (!rec) return new Float32Array(0);
    if (heatMode === 'frame') {
      const row = cursor ?? hover ?? start;
      return sensorFrame(rec, 'frame', row, row + 1);
    }
    return sensorFrame(rec, heatMode, start, end);
  }, [rec, heatMode, cursor, hover, start, end]);

  const series: ChartSeries[] = useMemo(() => {
    if (!rec) return [];
    if (metric === 'sensors') {
      return selected.map((sensor, index) => ({
        key: `s${sensor}`,
        label: rec.sensorNames[sensor] ?? `P${sensor + 1}`,
        color: SENSOR_COLORS[index % SENSOR_COLORS.length]!,
        value: (row: number) => rec.pressure[row * rec.sensorCount + sensor] ?? 0,
      }));
    }
    const array = metric === 'total' ? rec.total : metric === 'peak' ? rec.peak : rec.active;
    const label = t(metric === 'total' ? 'analysisMetricTotal' : metric === 'peak' ? 'analysisMetricPeak' : 'analysisMetricContact');
    return [{ key: metric, label, color: METRIC_COLORS[metric], value: (row: number) => array[row] ?? 0 }];
  }, [rec, metric, selected, t]);

  const imuSeries: ChartSeries[] = useMemo(() => {
    if (!rec || !imuGroup) return [];
    return IMU_GROUPS[imuGroup]
      .flatMap((column, index) => {
        const values = rec.imu[column];
        return values ? [{ key: column, label: column, color: AXIS_COLORS[index]!, value: (row: number) => values[row] ?? 0 }] : [];
      });
  }, [rec, imuGroup]);

  const markers: ChartMarker[] = useMemo(
    () => (showEvents && loaded ? loaded.events.map((event) => ({ index: event.index, color: EVENT_COLOR, label: `${event.app} ${event.event}${event.edge ? ` ${event.edge}` : ''}` })) : []),
    [showEvents, loaded],
  );

  const availableImu = rec ? (Object.keys(IMU_GROUPS) as ImuGroup[]).filter((group) => IMU_GROUPS[group].some((column) => rec.imu[column])) : [];

  const focus = (index: number) => {
    if (!rec) return;
    const at = rec.time[index] ?? 0;
    let a = index;
    let b = index;
    while (a > 0 && at - (rec.time[a - 1] ?? 0) < FOCUS_SPAN_MS / 2) a -= 1;
    while (b < rec.rowCount - 1 && (rec.time[b + 1] ?? 0) - at < FOCUS_SPAN_MS / 2) b += 1;
    setView({ start: a, end: b + 1 });
    setCursor(index);
  };

  const toggleSensor = (sensor: number) => {
    setMetric('sensors');
    setSelected((list) => (list.includes(sensor) ? list.filter((s) => s !== sensor) : [...list, sensor].slice(-SENSOR_COLORS.length)));
  };

  async function save(defaultName: string, data: string | Uint8Array, ext: string) {
    try {
      const path = await tools.saveFile({ defaultName, data, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
      if (path) toast('success', t('saved', { path }));
    } catch (cause) {
      toast('error', cause instanceof Error ? cause.message : String(cause));
    }
  }

  const baseName = (loaded?.name ?? 'recording').replace(/(\.data)?\.csv$/i, '');

  async function exportRange() {
    if (!loaded || !rec) return;
    const first = rec.lineOfRow[start] ?? 1;
    const last = rec.lineOfRow[end - 1] ?? first;
    await save(`${baseName}_${start}-${end - 1}.csv`, await sliceLines(tools, loaded.source, first, last), 'csv');
  }

  async function exportStats() {
    const header = 'sensor,mean,peak,std,active_share';
    const lines = stats.map((s) => [s.name, s.mean, s.peak, s.std, s.activeShare].map(csvCell).join(','));
    await save(`${baseName}_stats.csv`, `${[header, ...lines].join('\n')}\n`, 'csv');
  }

  async function exportPng() {
    const canvas = chartRef.current?.canvas();
    if (!canvas) return;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) await save(`${baseName}_${metric}.png`, new Uint8Array(await blob.arrayBuffer()), 'png');
  }

  const issueLabel = (issue: RecordingIssue) =>
    issue.kind === 'lost_frames'
      ? t('analysisIssueLost', { count: issue.amount, n: issue.amount })
      : issue.kind === 'time_gap'
        ? t('analysisIssueGap', { duration: formatDuration(issue.amount), ms: Math.round(issue.amount) })
        : issue.kind === 'restart'
          ? t('analysisIssueRestart')
          : t('analysisIssueBackwards', { ms: Math.round(-issue.amount) });

  const origin = rec?.time[0] ?? 0;

  return (
    <div className="stack">
      <Card title={t('source')} copy={t('analysisSourceHint')}>
        <div className="analysis-source">
          <label className="field">
            <span className="field-label">{t('pickRecording')}</span>
            <Select
              value={recordingId ?? ''}
              onChange={(event) => navigate({ area: 'tools', path: event.target.value ? ['analysis', ...event.target.value.split('/')] : ['analysis'] })}
            >
              <option value="">{recordings.length ? '—' : t('noRecordings')}</option>
              {recordings.map((r) => (
                <option key={r.id} value={r.id} disabled={r.inProgress}>
                  {r.deviceName || r.uid} · {formatDateTime(r.startedAtMs, locale)} · {formatBytes(r.bytes)}
                </option>
              ))}
            </Select>
          </label>
          <span className="muted">{t('analysisOr')}</span>
          <button className="button" type="button" onClick={() => void openLocal()}>
            <FolderOpen size={14} aria-hidden="true" />
            {t('openFile')}
          </button>
        </div>
        {progress ? (
          <div className="analysis-progress" role="status" aria-live="polite">
            <progress max={progress.total || 1} value={progress.done} />
            <span>{t('loadingBytes', { done: formatBytes(progress.done), total: formatBytes(progress.total) })}</span>
          </div>
        ) : null}
        {error ? <Notice kind="error">{error}</Notice> : null}
      </Card>

      {rec && summary && loaded ? (
        <>
          <Card title={loaded.name}>
            <Facts
              items={[
                [t('analysisDuration'), formatDuration(summary.durationMs)],
                [t('analysisStart'), formatInstant(summary.startMs, locale)],
                [t('analysisEnd'), formatInstant(summary.endMs, locale)],
                [t('analysisSamples'), summary.rowCount.toLocaleString(locale)],
                [t('analysisSensors'), rec.sensorCount],
                [t('analysisRate'), `${summary.rateHz.toFixed(1)} Hz`],
                [t('analysisMedianInterval'), `${summary.intervalMs.median.toFixed(1)} ms`],
                [t('analysisContinuity'), summary.lostFrames || summary.timeGaps || summary.restarts ? t('analysisHasGaps') : t('analysisContinuous')],
                [t('analysisLostFrames'), summary.lostFrames],
                [t('analysisGaps'), summary.timeGaps],
                [t('analysisRestarts'), summary.restarts],
                [t('analysisEvents'), loaded.events.length],
                [t('analysisMaxValue'), formatNumber(rec.maxValue)],
                [t('analysisDeviceInfo'), loaded.meta ? [loaded.meta.device.hardwareModel, loaded.meta.device.firmwareVersion].filter(Boolean).join(' · ') : t('analysisNoMeta')],
              ]}
            />
            {rec.skippedLines ? <Notice kind="warning">{t('analysisSkipped', { count: rec.skippedLines, n: rec.skippedLines })}</Notice> : null}
            {summary.backwardsSteps ? <Notice kind="warning">{t('analysisBackwards', { count: summary.backwardsSteps, n: summary.backwardsSteps })}</Notice> : null}
          </Card>

          <Card
            title={t('analysisTimeline')}
            copy={t('selectRangeHint')}
            actions={
              <div className="analysis-actions">
                <button className="button tiny" type="button" onClick={() => setView({ start: 0, end: rec.rowCount })} disabled={start === 0 && end === rec.rowCount}>
                  <RotateCcw size={13} aria-hidden="true" />
                  {t('resetZoom')}
                </button>
                <button className="button tiny" type="button" onClick={() => void exportRange()}>
                  <Download size={13} aria-hidden="true" />
                  {t('exportRangeCsv')}
                </button>
                <button className="button tiny" type="button" onClick={() => void exportPng()}>
                  <Image size={13} aria-hidden="true" />
                  {t('exportPng')}
                </button>
              </div>
            }
          >
            <div className="analysis-toolbar">
              <Segmented<Metric>
                value={metric}
                onChange={setMetric}
                label={t('analysisTimeline')}
                options={[
                  { value: 'total', label: t('analysisMetricTotal') },
                  { value: 'peak', label: t('analysisMetricPeak') },
                  { value: 'contact', label: t('analysisMetricContact') },
                  { value: 'sensors', label: t('analysisMetricSensors') },
                ]}
              />
              {loaded.events.length ? (
                <label className="analysis-check">
                  <Checkbox checked={showEvents} onChange={(event) => setShowEvents(event.target.checked)} />
                  {t('analysisShowEvents')}
                </label>
              ) : null}
              <span className="muted analysis-range" aria-live="polite">
                {t('analysisRange')}: {formatDuration((rec.time[start] ?? origin) - origin)} – {formatDuration((rec.time[end - 1] ?? origin) - origin)} · {t('analysisRows')}: {(end - start).toLocaleString(locale)}
                {cursor !== null ? ` · ${t('analysisCursor')}: ${formatDuration((rec.time[cursor] ?? origin) - origin)}` : ''}
              </span>
            </div>
            {metric === 'sensors' && !selected.length ? <p className="muted">{t('analysisPickSensorsHint')}</p> : null}
            <TimelineChart
              ref={chartRef}
              time={rec.time}
              start={start}
              end={end}
              series={series}
              markers={markers}
              cursor={cursor}
              hover={hover}
              height={240}
              zeroBased
              formatValue={formatNumber}
              ariaLabel={t('analysisTimeline')}
              onHover={setHover}
              onPick={setCursor}
              onSelect={(a, b) => setView({ start: a, end: b })}
              onReset={() => setView({ start: 0, end: rec.rowCount })}
            />
            {availableImu.length ? (
              <div className="analysis-imu">
                <Segmented<ImuGroup | 'none'>
                  value={imuGroup ?? 'none'}
                  onChange={(value) => setImuGroup(value === 'none' ? null : value)}
                  label={t('analysisImu')}
                  options={[{ value: 'none', label: t('analysisHide') }, ...availableImu.map((group) => ({ value: group, label: t(IMU_KEYS[group]) }))]}
                />
                {imuGroup ? (
                  <TimelineChart
                    time={rec.time}
                    start={start}
                    end={end}
                    series={imuSeries}
                    cursor={cursor}
                    hover={hover}
                    height={160}
                    formatValue={formatNumber}
                    ariaLabel={t('analysisImu')}
                    onHover={setHover}
                    onPick={setCursor}
                    onSelect={(a, b) => setView({ start: a, end: b })}
                    onReset={() => setView({ start: 0, end: rec.rowCount })}
                  />
                ) : null}
              </div>
            ) : null}
          </Card>

          <div className="analysis-two">
            <Card title={t('analysisHeatmap')}>
              <Segmented<HeatmapMode>
                value={heatMode}
                onChange={setHeatMode}
                label={t('analysisHeatmap')}
                options={[
                  { value: 'frame', label: t('analysisHeatFrame') },
                  { value: 'mean', label: t('analysisHeatMean') },
                  { value: 'peak', label: t('analysisHeatPeak') },
                ]}
              />
              {rec.sensorCount ? (
                <SensorHeatmap names={rec.sensorNames} values={heat} columns={columns} scaleMax={rec.maxValue} selected={selected} formatValue={formatNumber} onToggle={toggleSensor} />
              ) : (
                <p className="muted">{t('analysisNoSensors')}</p>
              )}
            </Card>

            <Card title={t('analysisQuality')}>
              <Facts
                items={[
                  [t('analysisMedianInterval'), `${summary.intervalMs.median.toFixed(1)} ms`],
                  ['p95', `${summary.intervalMs.p95.toFixed(1)} ms`],
                  ['p99', `${summary.intervalMs.p99.toFixed(1)} ms`],
                  [t('analysisLongestInterval'), `${summary.intervalMs.max.toFixed(1)} ms`],
                ]}
              />
              {!rec.frameSeq ? <p className="muted">{t('analysisNoFrameSeq')}</p> : null}
              {histogram ? (
                <div className="analysis-histogram" role="img" aria-label={t('analysisIntervalHistogram')}>
                  {histogram.counts.map((count, index) => {
                    const max = Math.max(1, ...histogram.counts);
                    return <i key={index} style={{ height: `${Math.max(2, (count / max) * 100)}%` }} title={`${(index * histogram.binWidthMs).toFixed(0)} ms: ${count}`} />;
                  })}
                </div>
              ) : null}
              {summary.issues.length ? (
                <ul className="analysis-issues">
                  {summary.issues.map((issue, index) => (
                    <li key={index}>
                      <button type="button" className="button ghost tiny" onClick={() => focus(issue.index)}>
                        {formatDuration((rec.time[issue.index] ?? origin) - origin)} · {issueLabel(issue)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">{t('analysisNoIssues')}</p>
              )}
            </Card>
          </div>

          <Card
            title={t('analysisSensorStats')}
            copy={t('analysisStatsScope')}
            actions={
              <button className="button tiny" type="button" onClick={() => void exportStats()}>
                <Download size={13} aria-hidden="true" />
                {t('exportStatsCsv')}
              </button>
            }
          >
            <div className="analysis-table-wrap">
              <table className="analysis-table">
                <thead>
                  <tr>
                    <th scope="col">{t('analysisSensor')}</th>
                    <th scope="col">{t('analysisMean')}</th>
                    <th scope="col">{t('analysisPeak')}</th>
                    <th scope="col">{t('analysisStd')}</th>
                    <th scope="col" title={t('analysisActiveHint', { value: formatNumber(rec.activeThreshold) })}>{t('analysisActive')}</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.map((s) => (
                    <tr key={s.sensor} className={selected.includes(s.sensor) ? 'selected' : ''}>
                      <td>
                        <button type="button" className="button ghost tiny" aria-pressed={selected.includes(s.sensor)} onClick={() => toggleSensor(s.sensor)}>
                          {s.name}
                        </button>
                      </td>
                      <td className="mono">{formatNumber(s.mean)}</td>
                      <td className="mono">{formatNumber(s.peak)}</td>
                      <td className="mono">{formatNumber(s.std)}</td>
                      <td className="mono">{(s.activeShare * 100).toFixed(1)} %</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          {loaded.events.length ? (
            <Card title={t('analysisEvents')}>
              <div className="analysis-table-wrap">
                <table className="analysis-table">
                  <thead>
                    <tr>
                      <th scope="col">{t('analysisTime')}</th>
                      <th scope="col">{t('analysisEventApp')}</th>
                      <th scope="col">{t('analysisEventName')}</th>
                      <th scope="col">{t('analysisEventEdge')}</th>
                      <th scope="col">{t('analysisEventValue')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loaded.events.slice(0, 2000).map((event) => (
                      <tr key={event.seq}>
                        <td>
                          <button type="button" className="button ghost tiny" onClick={() => focus(event.index)}>
                            {formatDuration(event.atMs)}
                          </button>
                        </td>
                        <td>{event.app}</td>
                        <td>{event.event}</td>
                        <td>{event.edge}</td>
                        <td className="mono">{event.value}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          ) : null}

          <Card title={t('analysisConverter')}>
            <TimestampConverter recordingRange={{ startMs: summary.startMs, endMs: summary.endMs }} />
          </Card>
        </>
      ) : null}
    </div>
  );
}
