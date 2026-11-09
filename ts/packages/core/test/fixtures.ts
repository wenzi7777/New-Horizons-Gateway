// The shared fixtures from the NewHorizonsOS-OTA checkout beside this repo
// (spec/fixtures/*.json), which pin every parser and version comparator in
// the system together. Tests that need them skip when it is not checked
// out, the same as the Python Gateway's tests.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const OS_REPO = resolve(here, '../../../../../NewHorizonsOS-OTA');
export const FIXTURES = resolve(OS_REPO, 'spec/fixtures');
export const hasFixtures = existsSync(FIXTURES);

export function readFixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(resolve(FIXTURES, name), 'utf-8')) as T;
}
