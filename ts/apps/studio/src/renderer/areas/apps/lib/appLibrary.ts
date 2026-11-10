// Catalog helpers (the Desktop's lib/appLibrary.ts). The catalog itself, the
// package bytes and their checking live in the main process (@nhgw/host apps).
import type { Locale } from "@nhgw/ui-tokens";

import type { AppCatalogEntry, Localised } from "../../../../shared/areas/apps";
import { compareVersionCores } from "./versioning";

export type { AppCatalog, AppCatalogEntry, AppPackage, AppSource, Localised } from "../../../../shared/areas/apps";
export { compareVersions, compareVersionCores } from "./versioning";

/** Resolve a localised catalog string, falling back to English. */
export function localised(value: Localised | string | undefined, locale: Locale): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value[locale] || value.en || "";
}

/** True when a device running `firmwareVersion` can run this app. */
export function satisfiesMinOs(entry: Pick<AppCatalogEntry, "min_os">, firmwareVersion: string | undefined): boolean {
  if (!firmwareVersion) return true; // unknown firmware: let the device decide
  // Cores only, like the firmware's own check: a beta of min_os qualifies.
  return compareVersionCores(firmwareVersion, entry.min_os) >= 0;
}

export function categoriesOf(items: readonly Pick<AppCatalogEntry, "category">[]): string[] {
  const seen = new Set<string>();
  items.forEach((item) => seen.add(item.category || "other"));
  return Array.from(seen).sort();
}

/** The app registry exists from firmware v1.1.0 on. */
export const REGISTRY_MIN_FIRMWARE = "v1.1.0";

/** The firmware an install needs: the app's min_os, or the registry's when that is older. */
export function installMinFirmware(entry: Pick<AppCatalogEntry, "min_os">): string {
  return compareVersionCores(entry.min_os || "v0.0.0", REGISTRY_MIN_FIRMWARE) > 0 ? entry.min_os : REGISTRY_MIN_FIRMWARE;
}

/** Why a device cannot take this app ("offline" / "firmware"), or "" when it can. */
export function installBlocker(entry: Pick<AppCatalogEntry, "min_os">, device: { online: boolean; firmwareVersion: string }): "" | "offline" | "firmware" {
  if (!device.online) return "offline";
  const firmware = device.firmwareVersion;
  if (!firmware || firmware === "unknown" || compareVersionCores(firmware, installMinFirmware(entry)) < 0) return "firmware";
  return "";
}
