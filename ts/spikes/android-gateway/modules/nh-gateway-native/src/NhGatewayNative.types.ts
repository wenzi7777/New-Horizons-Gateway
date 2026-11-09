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
