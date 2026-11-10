// Typed API of the "profiles" area (see ../areas.ts): sensor-layout profiles
// stored as <dataFolder>/profiles/<name>.json in the Desktop's format, and
// which profile each device uses (kept per computer).

import type { Profile, ProfileAssignments, ProfileListEntry } from '../../../../../packages/host/src/profiles';

export type { Profile, ProfileAssignments, ProfileListEntry, ProfileSensor } from '../../../../../packages/host/src/profiles';

export interface ProfilesAreaApi {
  list(): Promise<ProfileListEntry[]>;
  /** Whether profiles can be edited now: they are edited on the server only (false offline / signed out). */
  editable(): Promise<boolean>;
  /** Rejects "profile_not_found" / "invalid_profile". */
  get(name: string): Promise<Profile>;
  /** Writes (atomically); the name is sanitised to a file stem, which is returned. */
  save(name: string, profile: Profile): Promise<string>;
  /** A new empty profile under a free name based on `name`; returns the stored name. */
  create(name: string): Promise<string>;
  duplicate(name: string, newName?: string): Promise<string>;
  /** Rejects "profile_exists"; device assignments follow the rename. */
  rename(name: string, newName: string): Promise<string>;
  /** Also clears the devices that used it. */
  remove(name: string): Promise<void>;
  /** Open dialog → stores the chosen JSON (legacy layouts converted); the new name, or null if cancelled. */
  importFile(): Promise<string | null>;
  /** Save dialog → writes the profile JSON; the saved path, or null if cancelled. */
  exportFile(name: string): Promise<string | null>;
  /** Open dialog for an image → a data: URL (≤ 8 MB), or null if cancelled. */
  chooseImage(): Promise<string | null>;
  assignments(): Promise<ProfileAssignments>;
  /** name null clears the device's profile. */
  assign(uid: string, name: string | null): Promise<ProfileAssignments>;
}

export interface ProfilesAreaEvents {
  /** The profile files changed (here or on disk, e.g. by sync). */
  changed: { names: string[] };
  assignments: ProfileAssignments;
}
