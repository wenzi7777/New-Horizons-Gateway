// recording_meta.py's file layout, and the UTC time formatting the files use.
//
//   <dataRoot>/<UID>/<YYYYMMDD>/<HHMMSS>[-n]/<HHMMSS>[-n].{data.csv,events.csv,meta.json}
//
// named after the moment the first frame arrived, in UTC. Wall times are
// epoch microseconds (what Python's datetime holds).
import { basename, dirname, joinPath, type RecordingFileSink } from './sink';

export const META_FORMAT = 1;
export const DATA_SUFFIX = '.data.csv';
export const EVENTS_SUFFIX = '.events.csv';
export const META_SUFFIX = '.meta.json';
/** Before Desktop v0.27.0 the samples were `<HHMMSS>.csv`. */
export const LEGACY_DATA_SUFFIX = '.csv';

export type RecordingPaths = {
  directory: string;
  data: string;
  events: string;
  meta: string;
};

/** `062756` for any of a recording's files, in either layout. */
export function recordingBase(path: string): string {
  const name = basename(path);
  const lowered = name.toLowerCase();
  for (const suffix of [DATA_SUFFIX, EVENTS_SUFFIX, META_SUFFIX, LEGACY_DATA_SUFFIX]) {
    if (lowered.endsWith(suffix)) return name.slice(0, name.length - suffix.length);
  }
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** The files that belong with `path` (any of them, either layout). */
export function siblingPaths(path: string, exists: (path: string) => boolean = () => false): RecordingPaths {
  const base = recordingBase(path);
  const directory = dirname(path);
  let data = joinPath(directory, `${base}${DATA_SUFFIX}`);
  const legacy = joinPath(directory, `${base}${LEGACY_DATA_SUFFIX}`);
  if (!exists(data) && (exists(legacy) || path === legacy)) data = legacy;
  return {
    directory,
    data,
    events: joinPath(directory, `${base}${EVENTS_SUFFIX}`),
    meta: joinPath(directory, `${base}${META_SUFFIX}`),
  };
}

/** Creates the folder for a recording whose first frame arrived at `nowUs`. */
export function newRecordingPaths(sink: RecordingFileSink, dataRoot: string, deviceUid: string, nowUs: number): RecordingPaths {
  const day = joinPath(dataRoot, deviceUid, strftimeUtc(nowUs, '%Y%m%d'));
  const stem = strftimeUtc(nowUs, '%H%M%S');
  let base = stem;
  let attempt = 2;
  while (sink.exists(joinPath(day, base)) || sink.exists(joinPath(day, `${base}${LEGACY_DATA_SUFFIX}`))) {
    base = `${stem}-${attempt}`;
    attempt += 1;
  }
  const directory = joinPath(day, base);
  sink.mkdirp(directory);
  return {
    directory,
    data: joinPath(directory, `${base}${DATA_SUFFIX}`),
    events: joinPath(directory, `${base}${EVENTS_SUFFIX}`),
    meta: joinPath(directory, `${base}${META_SUFFIX}`),
  };
}

// ── Time ───────────────────────────────────────────────────────────────────

const pad = (value: number, width = 2) => String(value).padStart(width, '0');

function utcDate(us: number): Date {
  return new Date(Math.floor(us / 1000));
}

/** datetime.strftime for %Y %m %d %H %M %S on a UTC time. */
export function strftimeUtc(us: number, format: string): string {
  const date = utcDate(us);
  return format.replace(/%([YmdHMS])/g, (_, code: string) => {
    switch (code) {
      case 'Y':
        return pad(date.getUTCFullYear(), 4);
      case 'm':
        return pad(date.getUTCMonth() + 1);
      case 'd':
        return pad(date.getUTCDate());
      case 'H':
        return pad(date.getUTCHours());
      case 'M':
        return pad(date.getUTCMinutes());
      default:
        return pad(date.getUTCSeconds());
    }
  });
}

/** recording_meta._iso: `2026-11-10T01:02:03.456Z` (milliseconds truncated). */
export function isoMs(us: number): string {
  const date = utcDate(us);
  return (
    `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}.${pad(date.getUTCMilliseconds(), 3)}Z`
  );
}

/** `int(datetime.timestamp() * 1000)`: the same float steps Python takes. */
export function epochMsFromUs(us: number): number {
  return Math.trunc((us / 1e6) * 1000);
}

/** recording_meta._server_time_zone(): the host's UTC offset at `us`, as "+09:00". */
export function localTimeZoneOffset(us: number): string {
  const minutes = -new Date(Math.floor(us / 1000)).getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
