// Where NH Pocket remembers the Desktop account it signs in with:
// expo-secure-store (Android Keystore-encrypted, this app only), so Pocket
// signs in again by itself on every start.
import * as SecureStore from 'expo-secure-store';
import type { CredentialStore, Credentials } from '@nhgw/host';

const KEY = 'nh_pocket_account';

export const secureCredentials: CredentialStore = {
  async load(): Promise<Credentials | null> {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Partial<Credentials>;
      return typeof parsed.username === 'string' && typeof parsed.password === 'string' && parsed.username && parsed.password
        ? { username: parsed.username, password: parsed.password }
        : null;
    } catch {
      return null;
    }
  },
  async save(credentials: Credentials | null): Promise<void> {
    if (credentials === null) await SecureStore.deleteItemAsync(KEY);
    else await SecureStore.setItemAsync(KEY, JSON.stringify(credentials));
  },
};
