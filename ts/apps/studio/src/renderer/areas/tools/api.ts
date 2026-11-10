// Typed client for the "tools" area (see ../../../shared/areas/tools.ts).
import type { StudioApi } from '../../../shared/contract';
import type { ToolsAreaApi } from '../../../shared/areas/tools';

export function toolsApi(api: StudioApi): ToolsAreaApi {
  const call =
    <M extends keyof ToolsAreaApi>(method: M) =>
    (...args: Parameters<ToolsAreaApi[M]>) =>
      api.call('tools', method, ...args) as ReturnType<ToolsAreaApi[M]>;
  return {
    terminalHelp: call('terminalHelp'),
    terminalCompile: call('terminalCompile'),
    terminalHistory: call('terminalHistory'),
    terminalHistoryAdd: call('terminalHistoryAdd'),
    terminalHistoryClear: call('terminalHistoryClear'),
    recordingFiles: call('recordingFiles'),
    openAnalysisFile: call('openAnalysisFile'),
    readChunk: call('readChunk'),
    saveFile: call('saveFile'),
    openUploadFile: call('openUploadFile'),
    pressureSettings: call('pressureSettings'),
    pressureSaveSettings: call('pressureSaveSettings'),
    pressureHealth: call('pressureHealth'),
    pressureReadings: call('pressureReadings'),
    pressureSetTarget: call('pressureSetTarget'),
    pressureStop: call('pressureStop'),
  };
}

/** A device command runner for lib/deviceFileTransfer (CommandRunner) over api.sendCommand. */
export function deviceRunner(api: StudioApi, uid: string) {
  return async (payload: Record<string, unknown>): Promise<{ result: Record<string, unknown> | null }> => {
    const outcome = await api.sendCommand(uid, payload);
    if (!outcome.ok) {
      if (outcome.message === 'command_timeout') return { result: null };
      const data = outcome.data && typeof outcome.data === 'object' && !Array.isArray(outcome.data) ? (outcome.data as Record<string, unknown>) : {};
      return { result: { ...data, status: 'error', error: outcome.message } };
    }
    const data = outcome.data && typeof outcome.data === 'object' && !Array.isArray(outcome.data) ? (outcome.data as Record<string, unknown>) : {};
    return { result: data };
  };
}
