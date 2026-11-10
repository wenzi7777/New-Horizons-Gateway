// Ported from New-Horizons-Desktop frontend/src/lib/actionButton.ts.
export type ActionButtonGesture = "short" | "long";
export type ActionButtonAction = "none" | "identify" | "toggle_external_led" | "soft_off";

export type ActionButtonStatus = {
  supported: boolean;
  shortPress: ActionButtonAction | null;
  longPress: ActionButtonAction | null;
  bootWifiSetup: string | null;
  lastAction: string | null;
  lastResult: string | null;
};

const SHORT_ACTIONS: ActionButtonAction[] = ["none", "identify", "toggle_external_led"];
const LONG_ACTIONS: ActionButtonAction[] = [...SHORT_ACTIONS, "soft_off"];

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function actionOrNull(value: unknown, gesture: ActionButtonGesture): ActionButtonAction | null {
  const candidate = String(value ?? "");
  return actionButtonActionsForGesture(gesture).includes(candidate as ActionButtonAction)
    ? candidate as ActionButtonAction
    : null;
}

export function actionButtonActionsForGesture(gesture: ActionButtonGesture): ActionButtonAction[] {
  return gesture === "long" ? LONG_ACTIONS : SHORT_ACTIONS;
}

export function buildActionButtonCommand(shortPress: ActionButtonAction, longPress: ActionButtonAction) {
  if (!SHORT_ACTIONS.includes(shortPress) || !LONG_ACTIONS.includes(longPress)) {
    throw new Error("invalid_action_button_config");
  }
  return {
    command: "set_action_button",
    short_press: shortPress,
    long_press: longPress,
  };
}

export function normalizeActionButtonStatus(value: unknown): ActionButtonStatus {
  const status = record(value);
  const runtime = record(status.runtime);
  return {
    supported: status.supported === true,
    shortPress: actionOrNull(status.short_press, "short"),
    longPress: actionOrNull(status.long_press, "long"),
    bootWifiSetup: typeof status.boot_wifi_setup === "string" ? status.boot_wifi_setup : null,
    lastAction: typeof runtime.last_action === "string" ? runtime.last_action : null,
    lastResult: typeof runtime.last_result === "string" ? runtime.last_result : null,
  };
}
