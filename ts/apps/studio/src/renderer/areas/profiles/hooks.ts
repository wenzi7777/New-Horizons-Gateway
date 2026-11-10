// React hooks over the profiles area: the list, the device → profile
// mapping, and one device's profile for Live (cached, refreshed on change).
import { useEffect, useMemo, useState } from 'react';

import type { Profile, ProfileAssignments, ProfileListEntry } from '../../../shared/areas/profiles';
import { useStudio } from '../../state/studio';
import { profilesApi } from './api';

export function useProfilesClient() {
  const { api } = useStudio();
  return useMemo(() => profilesApi(api), [api]);
}

export function useProfileList(): { items: ProfileListEntry[]; loaded: boolean; error: string | null } {
  const client = useProfilesClient();
  const [state, setState] = useState<{ items: ProfileListEntry[]; loaded: boolean; error: string | null }>({ items: [], loaded: false, error: null });
  useEffect(() => {
    let alive = true;
    const load = () =>
      client.list().then(
        (items) => alive && setState({ items, loaded: true, error: null }),
        (e: unknown) => alive && setState((s) => ({ ...s, loaded: true, error: e instanceof Error ? e.message : String(e) })),
      );
    void load();
    const off = client.on('changed', () => void load());
    return () => {
      alive = false;
      off();
    };
  }, [client]);
  return state;
}

export function useAssignments(): ProfileAssignments {
  const client = useProfilesClient();
  const [map, setMap] = useState<ProfileAssignments>({});
  useEffect(() => {
    let alive = true;
    client.assignments().then((m) => alive && setMap(m), () => undefined);
    const off = client.on('assignments', (m) => setMap(m ?? {}));
    return () => {
      alive = false;
      off();
    };
  }, [client]);
  return map;
}

/** The profile a device is assigned (null when none or unreadable). */
export function useDeviceProfile(uid: string | null): Profile | null {
  const client = useProfilesClient();
  const assignments = useAssignments();
  const name = uid ? (assignments[uid.replace(/[^a-fA-F0-9]/g, '').toUpperCase()] ?? null) : null;
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    if (!name) {
      setProfile(null);
      return undefined;
    }
    let alive = true;
    const load = () => client.get(name).then((p) => alive && setProfile(p), () => alive && setProfile(null));
    void load();
    const off = client.on('changed', (e) => {
      if (!e?.names?.length || e.names.includes(name)) void load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [client, name]);
  return profile;
}
