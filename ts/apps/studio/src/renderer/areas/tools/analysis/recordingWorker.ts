// Parses a recording off the main thread as it streams in: the page pulls
// ~1 MB chunks from the main process (tools.readChunk) and posts them here,
// so neither the page nor this worker ever holds the whole CSV as text.
// Bundled by Vite as a module worker (new URL(..., import.meta.url)).
import { RecordingCsvBuilder, recordingBuffers, type Recording } from '../lib/recordingAnalysis';

export type WorkerRequest =
  | { id: number; type: 'start'; name: string }
  | { id: number; type: 'chunk'; data: Uint8Array }
  | { id: number; type: 'end' }
  | { id: number; type: 'cancel' };

export type WorkerReply = { id: number; rows: number } | { id: number; recording: Recording } | { id: number; error: string };

type WorkerScope = {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

const scope = self as unknown as WorkerScope;
let current: { id: number; builder: RecordingCsvBuilder; decoder: TextDecoder } | null = null;

scope.onmessage = (event) => {
  const message = event.data;
  try {
    if (message.type === 'start') {
      current = { id: message.id, builder: new RecordingCsvBuilder(message.name), decoder: new TextDecoder('utf-8') };
      return;
    }
    if (!current || current.id !== message.id) return;
    if (message.type === 'cancel') {
      current = null;
    } else if (message.type === 'chunk') {
      current.builder.feed(current.decoder.decode(message.data, { stream: true }));
      scope.postMessage({ id: message.id, rows: current.builder.rowCount });
    } else {
      current.builder.feed(current.decoder.decode());
      const recording = current.builder.finish();
      current = null;
      scope.postMessage({ id: message.id, recording }, recordingBuffers(recording));
    }
  } catch (error) {
    current = null;
    scope.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) });
  }
};
