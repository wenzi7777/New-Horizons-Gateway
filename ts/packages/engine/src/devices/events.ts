// What the device service tells the UI. The event names and shapes are the
// Desktop's (service.py emits them, ws.py forwards them to the browser), so a
// UI written against the Desktop WebSocket reads the same messages.
import type { Dict } from './py';

export type DeviceEvent =
  /** One device's decorated entry changed (status, result, presence, label, staleness). */
  | { type: 'device_update'; item: Dict }
  /** The whole list (after short aliases were folded into a full UID). */
  | { type: 'device_snapshot'; items: Dict[] }
  /** A device's reply to a command (or one inferred from a later status). */
  | { type: 'command_result'; device_uid: string; request_id: string; result: Dict }
  /** A parsed sensor frame. */
  | { type: 'visualization_update'; device_uid: string; data: Dict }
  /** A device's recording switch or state changed (ws.py recording_update). */
  | { type: 'recording_update'; device_uid: string; enabled: boolean; finishing?: boolean; error?: string }
  /** New (not in the Desktop): the FindMe "nearby" list changed (a discover was answered or noted). */
  | { type: 'nearby_update'; items: Dict[] };

export type DeviceEventType = DeviceEvent['type'];
export type DeviceEventListener = (event: DeviceEvent) => void;

export class DeviceEventEmitter {
  private readonly listeners: DeviceEventListener[] = [];

  /** Subscribes; returns the unsubscribe function. */
  on(listener: DeviceEventListener): () => void {
    if (!this.listeners.includes(listener)) this.listeners.push(listener);
    return () => this.off(listener);
  }

  off(listener: DeviceEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index >= 0) this.listeners.splice(index, 1);
  }

  /** Each listener gets its own shallow copy; one that throws is skipped, as in Python. */
  emit(event: DeviceEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...event } as DeviceEvent);
      } catch {
        // A broken listener must not stop the others (service._emit_event).
      }
    }
  }
}
