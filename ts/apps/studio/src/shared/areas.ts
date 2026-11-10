// Feature areas: how NH Studio grows without every feature editing the same
// files. Each area owns
//   src/shared/areas/<area>.ts      its typed API (methods + events)
//   src/main/areas/<area>.ts        its main-process handlers
//   src/renderer/areas/<area>/      its page(s), typed client and strings
// and talks over two generic channels: a request (area, method, args) that
// the main process only accepts for methods the area registered, and a
// broadcast push (area, event, payload).

export const AREAS = ['app', 'sync', 'profiles', 'apps', 'tools', 'calibration'] as const;
export type AreaName = (typeof AREAS)[number];

export const AREA_CALL = 'nh-studio:area-call';
export const AREA_EVENT = 'nh-studio:area-event';

export function isAreaName(value: unknown): value is AreaName {
  return typeof value === 'string' && (AREAS as readonly string[]).includes(value);
}

/** Method names are plain identifiers, so they can never collide with object internals. */
export const AREA_METHOD_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;
