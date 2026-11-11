// Reads a recording's CSV through the host in slices and parses it as it arrives, so the whole
// file is never held as text (a phone recording can run to tens of MB). There is no worker on a
// phone: between slices the JS thread is handed back so the screen keeps responding.
import { parseEventsCsv, parseRecordingMeta, placeEvents, RecordingCsvBuilder, Utf8StreamDecoder, type PlacedEvent, type Recording, type RecordingMeta } from '@nhgw/analysis';

import type { PocketStore } from '../../host/contract';

export const ANALYSIS_CHUNK_BYTES = 512 * 1024;

export type LoadedRecording = { recording: Recording; meta: RecordingMeta | null; events: PlacedEvent[] };

type Source = Pick<PocketStore, 'recordingAnalysisInfo' | 'readRecordingChunk'>;

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

async function readAll(store: Source, id: string, file: 'data' | 'events', totalBytes: number, onSlice: (text: string, readBytes: number) => void, cancelled: () => boolean): Promise<void> {
  const decoder = new Utf8StreamDecoder();
  let offset = 0;
  for (;;) {
    if (cancelled()) return;
    const chunk = await store.readRecordingChunk(id, file, offset, ANALYSIS_CHUNK_BYTES);
    onSlice(decoder.push(chunk.data), chunk.nextOffset);
    offset = chunk.nextOffset;
    // A reply that moves nothing and is not done would loop forever.
    if (chunk.done || chunk.data.length === 0 || offset >= totalBytes) break;
    await yieldToUi();
  }
  const rest = decoder.flush();
  if (rest) onSlice(rest, offset);
}

export async function loadRecordingForAnalysis(store: Source, id: string, name: string, onProgress: (fraction: number) => void, cancelled: () => boolean = () => false): Promise<LoadedRecording | null> {
  const info = await store.recordingAnalysisInfo(id);
  if (info.dataBytes <= 0) throw new Error('recording_not_found');
  const builder = new RecordingCsvBuilder(name);
  await readAll(store, id, 'data', info.dataBytes, (text, bytes) => {
    builder.feed(text);
    onProgress(Math.min(1, bytes / info.dataBytes));
  }, cancelled);
  if (cancelled()) return null;
  const recording = builder.finish();
  let events: PlacedEvent[] = [];
  if (info.eventsBytes > 0) {
    let eventsText = '';
    await readAll(store, id, 'events', info.eventsBytes, (text) => {
      eventsText += text;
    }, cancelled);
    events = placeEvents(recording, parseEventsCsv(eventsText));
  }
  return { recording, meta: parseRecordingMeta(info.meta), events };
}
