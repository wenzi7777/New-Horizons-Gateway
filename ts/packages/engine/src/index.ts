// @nhgw/engine: the NH Studio / NH Pocket engine (the Desktop backend's
// device service in TS) on top of @nhgw/core.
//   parse/      NHO/Arduino/1 stream packets and Python-faithful JSON
//   recording/  .data.csv / .events.csv / .meta.json, timelines, .nhraw
//   devices/    device table, command gating and routing, labels, and the
//               DeviceService that ties them and recording to the runtime
export * from './parse';
export * from './recording';
export * from './devices';
