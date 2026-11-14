// Where NH Studio remembers the Desktop account it signs in with: one file in
// userData, encrypted with Electron safeStorage (macOS Keychain, Windows
// DPAPI, Linux libsecret/kwallet). Without OS encryption nothing is stored:
// the app then signs in by hand each time rather than keep a password in clear.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { CredentialStore, Credentials } from '@nhgw/host';

/** The part of Electron's safeStorage used here (injected so tests need no Electron). */
export interface Cipher {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export const CREDENTIALS_FILE = join('config', 'account.bin');

export function fileCredentialStore(userDataDir: string, cipher: () => Promise<Cipher | null>): CredentialStore {
  const path = join(userDataDir, CREDENTIALS_FILE);
  return {
    async load(): Promise<Credentials | null> {
      const c = await cipher();
      if (!c || !c.isEncryptionAvailable()) return null;
      let raw: Buffer;
      try {
        raw = readFileSync(path);
      } catch {
        return null;
      }
      try {
        const parsed = JSON.parse(c.decryptString(raw)) as Partial<Credentials>;
        return typeof parsed.username === 'string' && typeof parsed.password === 'string' && parsed.username && parsed.password
          ? { username: parsed.username, password: parsed.password }
          : null;
      } catch {
        // Another user's or machine's keychain: unreadable, so forget it.
        return null;
      }
    },
    async save(credentials: Credentials | null): Promise<void> {
      if (credentials === null) {
        rmSync(path, { force: true });
        return;
      }
      const c = await cipher();
      if (!c || !c.isEncryptionAvailable()) return;
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, c.encryptString(JSON.stringify(credentials)), { mode: 0o600 });
      renameSync(tmp, path);
    },
  };
}

/** Electron's safeStorage, or null outside Electron (tests, tools). */
export async function electronCipher(): Promise<Cipher | null> {
  try {
    const electron = (await import('electron')) as unknown as { safeStorage?: Cipher; default?: { safeStorage?: Cipher } };
    return electron.safeStorage ?? electron.default?.safeStorage ?? null;
  } catch {
    return null;
  }
}
