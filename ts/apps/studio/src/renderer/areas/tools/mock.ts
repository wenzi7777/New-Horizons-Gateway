// Browser-preview (mock) implementation of the "tools" area: the same
// methods as main/areas/tools.ts, with canned behaviour (a synthetic
// recording, an in-memory history, a simulated pressure chamber).
import type { AreaMock } from '../mockTypes';
import type { PressureSettingsInput, ToolsFileSource, ToolsSaveRequest } from '../../../shared/areas/tools';

const MAX_KPA = 28;

function syntheticCsv(): Uint8Array {
  const sensors = 16;
  const head = ['timestamp_ms', ...Array.from({ length: sensors }, (_, i) => `P${i + 1}`), 'Acc_x', 'Acc_y', 'Acc_z', 'frame_seq', 'time_ref'];
  const lines = [head.join(',')];
  const t0 = Date.UTC(2026, 10, 10, 6, 0, 0);
  for (let row = 0; row < 3600; row += 1) {
    const press = Math.max(0, Math.sin(row / 120) * 1800);
    const cells = Array.from({ length: sensors }, (_, i) => Math.round(press * Math.exp(-(((i % 4) - 1.5) ** 2) / 2)));
    lines.push([t0 + row * 16 + (row === 2000 ? 900 : 0), ...cells, 0.01, 0.02, 0.98, row === 1500 ? row + 3 : row + 1, 'device'].join(','));
  }
  return new TextEncoder().encode(`${lines.join('\n')}\n`);
}

export const toolsMock: AreaMock = () => {
  const history = new Map<string, string[]>();
  let csv: Uint8Array | null = null;
  const data = () => (csv ??= syntheticCsv());
  let settings = { preset: 'lab_pi', url: '', token: '' };
  let kpa = 0;
  let target = 0;
  return {
    terminalHelp: () => [{ command: 'status', description: 'Query device status.', example: 'status' }],
    terminalCompile: (line: string) => {
      const command = String(line ?? '').trim().split(/\s+/)[0] ?? '';
      if (!command) return { ok: false, error: 'empty_command' };
      const name = command.replace(/-/g, '_');
      return { ok: true, compiled: { command: name, payload: { command: name }, argv: [command] } };
    },
    terminalHistory: (uid: string) => history.get(uid.toUpperCase()) ?? [],
    terminalHistoryAdd: (uid: string, line: string) => {
      const list = (history.get(uid.toUpperCase()) ?? []).filter((item) => item !== line);
      list.push(line);
      history.set(uid.toUpperCase(), list.slice(-200));
      return history.get(uid.toUpperCase());
    },
    terminalHistoryClear: (uid: string) => void history.delete(uid.toUpperCase()),
    recordingFiles: (recordingId: string) => ({ recordingId, dataBytes: data().length, eventsBytes: 0, meta: null, dataName: 'mock.data.csv' }),
    openAnalysisFile: () => ({ token: 'mock', name: 'mock.csv', bytes: data().length }),
    readChunk: (_source: ToolsFileSource, offset: number, length = 1 << 20) => {
      const all = data();
      const slice = all.slice(offset, offset + length);
      const nextOffset = offset + slice.length;
      return { data: slice, nextOffset, done: nextOffset >= all.length, totalBytes: all.length };
    },
    saveFile: (request: ToolsSaveRequest) => `/mock/${request.defaultName}`,
    openUploadFile: () => ({ name: 'hello.txt', data: new TextEncoder().encode('hello from the preview\n') }),
    pressureSettings: () => ({
      preset: settings.preset,
      url: settings.url,
      tokenHint: settings.token ? `${settings.token.slice(0, 8)}...` : '',
      configured: Boolean(settings.token),
      presets: [{ id: 'lab_pi', label: 'Lab Pi Server', url: 'https://pressure-cal.example' }],
    }),
    pressureSaveSettings: (input: PressureSettingsInput) => {
      settings = { preset: input.preset, url: input.url ?? settings.url, token: input.token || settings.token || 'mock-token' };
      return { ok: true, data: { status: 'saved' } };
    },
    pressureHealth: () => ({ ok: true, data: { uno: true, imada: false } }),
    pressureReadings: () => {
      kpa += (target - kpa) * 0.3;
      return { ok: true, data: { uno: { pressure_kpa: kpa, safety_latched: false }, imada: null } };
    },
    pressureSetTarget: (value: number) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: 'target_kpa_required', status: 422 };
      if (value > MAX_KPA) return { ok: false, error: 'target_kpa_exceeds_safety_limit', status: 422 };
      if (value < 0) return { ok: false, error: 'target_kpa_must_be_non_negative', status: 422 };
      target = value;
      return { ok: true, data: { accepted: true } };
    },
    pressureStop: () => {
      target = 0;
      return { ok: true, data: { accepted: true } };
    },
  };
};
