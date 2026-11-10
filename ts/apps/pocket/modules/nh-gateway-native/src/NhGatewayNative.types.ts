export type DatagramEvent = {
  localPort: number;
  ip: string;
  srcPort: number;
  /** base64 of the raw UDP payload */
  data: string;
  /** wall clock (µs since epoch) the moment receive() returned */
  rxEpochUs: number;
};

export type TimeServedEvent = {
  seq: number;
  /** t3 - t2 of the reply, built natively */
  turnaroundUs: number;
};

export type NativeStats = {
  running: boolean;
  datagramsIn: number;
  datagramsOut: number;
  timeRequests: number;
  sendErrors: number;
  lastError: string;
};

export type NetworkInterfaceInfo = { name: string; address: string };

export type NhGatewayNativeEvents = {
  onDatagram: (event: DatagramEvent) => void;
  onTimeServed: (event: TimeServedEvent) => void;
};

/** A file or folder under the app's files root (stat / listDir). */
export type NativeFileInfo = {
  name: string;
  isDirectory: boolean;
  /** Bytes (0 for a folder). */
  size: number;
  mtimeMs: number;
};

export type RawCaptureStats = {
  uid: string;
  path: string;
  records: number;
  bytes: number;
  lastEpochUs: number;
  /** Set once a write failed; the capture stops growing. */
  error: string;
};

/** `.nhraw` record sources (NHRAW.md). */
export const RAW_SOURCE = { stream: 0, control: 1, event: 2 } as const;
