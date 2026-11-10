// The version this build reports (hello, gateway_status, the web UI, update
// checks). Kept equal to package.json by test/version.test.ts; a release build
// may override it with an esbuild define of __NHGW_VERSION__.

declare const __NHGW_VERSION__: string | undefined;

export const PACKAGE_VERSION = '2.2.0';

/** "v" + package version, the form every Gateway version takes (v1.1.3, v2.0.0-beta.1). */
export const GATEWAY_VERSION: string =
  typeof __NHGW_VERSION__ === 'string' && __NHGW_VERSION__ ? __NHGW_VERSION__ : `v${PACKAGE_VERSION}`;
