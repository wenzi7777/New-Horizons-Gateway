// The desktop Node adapters of @nhgw/node (packages/node/src/adapters) that
// Studio's main process reuses: clock, UDP socket with port-conflict errors,
// WebSocket, atomic JSON files, logger. Imported by path, not through
// @nhgw/node's index, which also pulls in the Gateway's web server and SEA
// assets; esbuild bundles these into main.cjs.
export { NodeClock } from '../../../../packages/node/src/adapters/clock';
export { NodeUdpSocket, PortInUseError } from '../../../../packages/node/src/adapters/udp';
export { NodeWsConnector } from '../../../../packages/node/src/adapters/ws';
export { HostLogger, formatLogLine } from '../../../../packages/node/src/adapters/logger';
