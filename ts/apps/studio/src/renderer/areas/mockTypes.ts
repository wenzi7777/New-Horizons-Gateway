// What each area's browser-preview mock provides: method handlers, given a
// way to emit that area's events.
export type AreaMockHandlers = Record<string, (...args: never[]) => unknown>;
export type AreaMock = (emit: (event: string, payload?: unknown) => void) => AreaMockHandlers;
