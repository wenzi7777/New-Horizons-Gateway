// Whether the first-run guide was finished or skipped: a key in the host
// config on Android (kept with the other settings), memory elsewhere.
import { createPocketStore } from '.';

const KEY = 'pocket_onboarding_done';
let memory = false;
const listeners = new Set<(done: boolean) => void>();

/** Settings → "Show the setup guide again" reaches the root through this. */
export function subscribeOnboarding(listener: (done: boolean) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

type ConfigHost = { appConfig?(): Promise<Record<string, unknown>>; saveAppConfig?(patch: Record<string, unknown>): Promise<void> };

function host(): ConfigHost | null {
  return createPocketStore() as unknown as ConfigHost | null;
}

export async function onboardingDone(): Promise<boolean> {
  const h = host();
  if (!h?.appConfig) return memory;
  try {
    return (await h.appConfig())[KEY] === true;
  } catch {
    return false;
  }
}

export async function setOnboardingDone(done: boolean): Promise<void> {
  memory = done;
  await host()?.saveAppConfig?.({ [KEY]: done });
  for (const listener of [...listeners]) listener(done);
}
