// The panel permission table and limits App Studio's prompt quotes. The same
// table as the App Library's panelset.mjs and @nhgw/host's apps/validate.ts
// (test/renderer/appsLibs.test.ts keeps the three in step).
export const PANEL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  task_control: ["task_stop", "task_start", "task_set_period"],
  service_control: ["service_stop", "service_start", "service_restart"],
  app_control: ["app_stop", "app_start", "app_revive"],
};
export const MAX_PANEL_ACTIONS = 16;
export const MAX_PANEL_TABS = 8;
