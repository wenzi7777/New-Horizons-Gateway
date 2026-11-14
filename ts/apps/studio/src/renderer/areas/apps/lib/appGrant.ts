// The operator's consent for an app's dangerous capabilities (firmware v2.1.0).
//
// A package declaring storage, device_config, device_stream, io_i2c or io_uart
// is installed only with those names in app_install's `grant`; the device
// refuses one that is missing (capability_not_granted) and, for I/O, one its
// board cannot offer (capability_unsupported). The install dialog asks before
// anything is written, and says up front when the board cannot take the app.

import { BOARD_CAPABILITIES, DANGEROUS_CAPABILITIES } from "../sdk/lib/index.mjs";

/** The dangerous capabilities among `capabilities`, in the library's order. */
export function dangerousCapabilities(capabilities: readonly string[] | undefined): string[] {
  const declared = new Set(capabilities ?? []);
  return DANGEROUS_CAPABILITIES.filter((name) => declared.has(name));
}

/** Capabilities in `capabilities` that the board named by `hardwareModel` cannot offer. */
export function unsupportedCapabilities(capabilities: readonly string[] | undefined, hardwareModel: string): string[] {
  const model = hardwareModel.toLowerCase();
  const boards = BOARD_CAPABILITIES as Readonly<Record<string, readonly string[]>>;
  return (capabilities ?? []).filter((name) => {
    const allowed = boards[name];
    return allowed !== undefined && !allowed.some((board) => model.includes(board.toLowerCase()));
  });
}
