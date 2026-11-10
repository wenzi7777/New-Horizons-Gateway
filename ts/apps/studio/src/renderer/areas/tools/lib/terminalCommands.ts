// The Terminal page's command catalogue and the text <-> builder conversions
// around it. Kept free of runtime imports so node tests can load it directly.

export type CommandParam = {
  key: string;
  labelKey: string;
  type: "text" | "number" | "select";
  required?: boolean;
  placeholder?: string;
  defaultValue?: string;
  options?: { labelKey: string; value: string }[];
};

export type CommandBlock = {
  command: string;
  groupKey: string;
  params: CommandParam[];
  // A command known only from the device's own catalog: no form, just the
  // firmware's summary and a free `--key value` field passed through as is
  // (the backend's generic compile turns it into the payload).
  device?: { summary: string; maintenance: boolean };
};

// One row of the device's `commands` table (firmware v1.15.0+), as
// GET /api/devices/<uid>/commands returns it.
export type DeviceCommandSpec = {
  name: string;
  maintenance: boolean;
  heavy: boolean;
  quiet: boolean;
  internal: boolean;
  status_snapshot: boolean;
  summary: string;
};

export const DEVICE_COMMAND_GROUP = "commandGroupDevice";
export const RAW_ARGS_KEY = "args";

export const COMMAND_GROUP_ORDER = [
  "commandGroupCore",
  "commandGroupMaintenance",
  "commandGroupConfig",
  "commandGroupFiles",
  DEVICE_COMMAND_GROUP,
  "commandGroupDanger",
];

export const COMMAND_BLOCKS: CommandBlock[] = [
  { command: "status", groupKey: "commandGroupCore", params: [] },
  { command: "check-update", groupKey: "commandGroupCore", params: [{ key: "manifest-url", labelKey: "paramManifestUrl", type: "text", placeholder: "https://..." }] },
  { command: "apply-update", groupKey: "commandGroupDanger", params: [{ key: "manifest-url", labelKey: "paramManifestUrl", type: "text", placeholder: "https://..." }] },
  {
    command: "enter-maintenance",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "reason", labelKey: "paramReason", type: "text", placeholder: "calibration", defaultValue: "calibration" }],
  },
  { command: "exit-maintenance", groupKey: "commandGroupMaintenance", params: [] },
  { command: "scan-health", groupKey: "commandGroupCore", params: [] },
  { command: "sensor-sample", groupKey: "commandGroupCore", params: [] },
  { command: "task-list", groupKey: "commandGroupCore", params: [] },
  // Firmware v1.19.0 task manager: monitor snapshot and FreeRTOS threads.
  { command: "sysmon", groupKey: "commandGroupCore", params: [] },
  { command: "thread-list", groupKey: "commandGroupCore", params: [] },
  { command: "service-list", groupKey: "commandGroupCore", params: [] },
  { command: "capabilities", groupKey: "commandGroupCore", params: [] },
  { command: "app-list", groupKey: "commandGroupCore", params: [] },
  {
    command: "app-enable",
    groupKey: "commandGroupConfig",
    params: [{ key: "name", labelKey: "paramAppName", type: "text", required: true, placeholder: "flow" }],
  },
  {
    command: "app-disable",
    groupKey: "commandGroupConfig",
    params: [{ key: "name", labelKey: "paramAppName", type: "text", required: true, placeholder: "flow1" }],
  },
  // Stops last until reboot (firmware v1.19.0+): nothing is persisted.
  {
    command: "app-stop",
    groupKey: "commandGroupConfig",
    params: [{ key: "name", labelKey: "paramAppName", type: "text", required: true, placeholder: "flow" }],
  },
  {
    command: "app-start",
    groupKey: "commandGroupConfig",
    params: [{ key: "name", labelKey: "paramAppName", type: "text", required: true, placeholder: "flow" }],
  },
  {
    command: "app-revive",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "name", labelKey: "paramAppName", type: "text", required: true, placeholder: "flow" }],
  },
  {
    command: "app-events",
    groupKey: "commandGroupCore",
    params: [
      { key: "since-seq", labelKey: "paramSinceSeq", type: "number", placeholder: "0" },
      { key: "limit", labelKey: "paramLimit", type: "number", placeholder: "32" },
    ],
  },
  { command: "app-list-packages", groupKey: "commandGroupCore", params: [] },
  { command: "app-view", groupKey: "commandGroupCore", params: [] },
  {
    command: "app-install",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "path", labelKey: "paramPackagePath", type: "text", required: true, placeholder: "apps/heel_strike.nha" },
      { key: "sha256", labelKey: "paramSha256", type: "text" },
      {
        key: "replace",
        labelKey: "paramReplace",
        type: "select",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
    ],
  },
  {
    command: "app-uninstall",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "id", labelKey: "paramAppId", type: "text", required: true, placeholder: "heel_strike" },
      {
        key: "keep-file",
        labelKey: "paramKeepFile",
        type: "select",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
    ],
  },
  {
    command: "app-activate",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "id", labelKey: "paramAppId", type: "text", required: true, placeholder: "heel_strike" },
      { key: "slot", labelKey: "paramSlot", type: "number", placeholder: "1" },
    ],
  },
  {
    command: "app-deactivate",
    groupKey: "commandGroupMaintenance",
    // The backend wants --id or --slot (either one), so neither is required here.
    params: [
      { key: "id", labelKey: "paramAppId", type: "text", placeholder: "heel_strike" },
      { key: "slot", labelKey: "paramSlot", type: "number", placeholder: "1" },
    ],
  },
  {
    command: "app-verify",
    groupKey: "commandGroupCore",
    params: [{ key: "id", labelKey: "paramAppId", type: "text", required: true, placeholder: "heel_strike" }],
  },
  { command: "app-reindex", groupKey: "commandGroupMaintenance", params: [] },
  {
    command: "app-load-flow",
    groupKey: "commandGroupConfig",
    params: [{ key: "path", labelKey: "paramFlowPath", type: "text", placeholder: "apps/flow.json" }],
  },
  { command: "app-unload-flow", groupKey: "commandGroupConfig", params: [] },
  { command: "config-schema", groupKey: "commandGroupConfig", params: [] },
  {
    command: "config-get",
    groupKey: "commandGroupConfig",
    params: [{ key: "path", labelKey: "paramConfigPath", type: "text", placeholder: "scan.target_fps" }],
  },
  {
    command: "config-set",
    groupKey: "commandGroupConfig",
    params: [
      { key: "path", labelKey: "paramConfigPath", type: "text", required: true, placeholder: "scan.target_fps" },
      { key: "value", labelKey: "paramConfigValue", type: "text", required: true, placeholder: "60" },
    ],
  },
  {
    command: "set-power-profile",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "profile",
        labelKey: "paramProfile",
        type: "select",
        required: true,
        defaultValue: "performance",
        options: [
          { labelKey: "powerProfilePerformance", value: "performance" },
          { labelKey: "powerProfileBalanced", value: "balanced" },
          { labelKey: "powerProfilePowersave", value: "powersave" },
        ],
      },
    ],
  },
  {
    command: "service-restart",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "name", labelKey: "paramServiceName", type: "text", required: true, placeholder: "imu" }],
  },
  {
    command: "service-stop",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "name", labelKey: "paramServiceName", type: "text", required: true, placeholder: "imu" }],
  },
  {
    command: "service-start",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "name", labelKey: "paramServiceName", type: "text", required: true, placeholder: "imu" }],
  },
  {
    command: "task-stop",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "name", labelKey: "paramTaskName", type: "text", required: true, placeholder: "imu" }],
  },
  {
    command: "task-start",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "name", labelKey: "paramTaskName", type: "text", required: true, placeholder: "imu" }],
  },
  {
    command: "task-set-period",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "name", labelKey: "paramTaskName", type: "text", required: true, placeholder: "imu" },
      { key: "period-us", labelKey: "paramPeriodUs", type: "text", required: true, placeholder: "20000" },
    ],
  },
  { command: "dmesg", groupKey: "commandGroupFiles", params: [] },
  {
    command: "set-time",
    groupKey: "commandGroupConfig",
    params: [
      { key: "epoch-ms", labelKey: "paramEpochMs", type: "text", required: true, placeholder: "1780000000000" },
      {
        key: "force",
        labelKey: "paramForce",
        type: "select",
        defaultValue: "false",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
    ],
  },
  { command: "clock-sync", groupKey: "commandGroupConfig", params: [] },
  { command: "clock-status", groupKey: "commandGroupConfig", params: [] },
  {
    command: "set-stream-buffer",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "enabled",
        labelKey: "paramEnabled",
        type: "select",
        defaultValue: "true",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
      {
        key: "mode",
        labelKey: "logMode",
        type: "select",
        defaultValue: "standard",
        options: [
          { labelKey: "capacityDefault", value: "standard" },
          { labelKey: "capacityExtended", value: "extended" },
        ],
      },
    ],
  },
  { command: "calibration-status", groupKey: "commandGroupMaintenance", params: [] },
  { command: "calibration-enable", groupKey: "commandGroupMaintenance", params: [] },
  { command: "calibration-disable", groupKey: "commandGroupMaintenance", params: [] },
  { command: "calibration-clear-profile", groupKey: "commandGroupDanger", params: [] },
  { command: "calibration-session-begin", groupKey: "commandGroupMaintenance", params: [] },
  { command: "calibration-session-abort", groupKey: "commandGroupMaintenance", params: [] },
  {
    command: "calibration-session-commit",
    groupKey: "commandGroupMaintenance",
    // Defaults to true although the backend defaults to false: both calibration
    // UIs commit with auto_enable, and a committed profile is meant to be used.
    params: [
      {
        key: "auto-enable",
        labelKey: "paramAutoEnable",
        type: "select",
        defaultValue: "true",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
    ],
  },
  {
    command: "calibration-dump-tare",
    groupKey: "commandGroupMaintenance",
    params: [],
  },
  {
    command: "calibration-dump-level",
    groupKey: "commandGroupMaintenance",
    params: [{ key: "level", labelKey: "paramLevel", type: "number", required: true, defaultValue: "10" }],
  },
  { command: "calibration-dump-fit", groupKey: "commandGroupMaintenance", params: [] },
  {
    command: "calibration-set-fit",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "min-level", labelKey: "paramFitMinLevel", type: "number", defaultValue: "3" },
      { key: "adc1-c1", labelKey: "paramAdc1C1", type: "number", placeholder: "1" },
      { key: "adc1-c2", labelKey: "paramAdc1C2", type: "number", placeholder: "0" },
      { key: "adc2-c1", labelKey: "paramAdc2C1", type: "number", placeholder: "1" },
      { key: "adc2-c2", labelKey: "paramAdc2C2", type: "number", placeholder: "0" },
      { key: "adc1-clip-mv", labelKey: "paramAdc1ClipMv", type: "number", placeholder: "3150" },
      { key: "adc2-clip-mv", labelKey: "paramAdc2ClipMv", type: "number", placeholder: "3100" },
    ],
  },
  {
    command: "calibration-set-reference",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "level", labelKey: "paramLevel", type: "number", required: true, defaultValue: "10" },
      { key: "reference", labelKey: "paramReference", type: "number", required: true, defaultValue: "10" },
    ],
  },
  {
    command: "calibration-delete-level",
    groupKey: "commandGroupDanger",
    params: [{ key: "level", labelKey: "paramLevel", type: "number", required: true, defaultValue: "10" }],
  },
  {
    command: "calibration-capture-tare",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "duration-ms", labelKey: "paramDurationMs", type: "number", defaultValue: "3000" },
    ],
  },
  {
    command: "calibration-capture-cell",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "sensor-index", labelKey: "paramSensorIndex", type: "number", required: true, defaultValue: "0" },
      { key: "level", labelKey: "paramLevel", type: "number", defaultValue: "10" },
      { key: "reference", labelKey: "paramReference", type: "number" },
      { key: "duration-ms", labelKey: "paramDurationMs", type: "number", defaultValue: "3000" },
    ],
  },
  {
    command: "calibration-capture-all",
    groupKey: "commandGroupMaintenance",
    params: [
      { key: "level", labelKey: "paramLevel", type: "number", required: true, defaultValue: "10" },
      { key: "reference", labelKey: "paramReference", type: "number" },
      { key: "duration-ms", labelKey: "paramDurationMs", type: "number", defaultValue: "3000" },
    ],
  },
  { command: "findme-discover", groupKey: "commandGroupConfig", params: [] },
  {
    command: "findme-switch-gateway",
    groupKey: "commandGroupConfig",
    params: [
      { key: "preferred-gateway-id", labelKey: "paramGatewayId", type: "text", required: true },
      { key: "claim-id", labelKey: "paramClaimId", type: "text" },
      { key: "ttl-ms", labelKey: "paramTtlMs", type: "number", defaultValue: "30000" },
    ],
  },
  {
    command: "set-matrix-layout",
    groupKey: "commandGroupConfig",
    params: [
      { key: "analog-pins", labelKey: "analogPins", type: "text", required: true },
      { key: "select-pins", labelKey: "selectPins", type: "text", required: true },
    ],
  },
  {
    command: "set-scan-timing",
    groupKey: "commandGroupConfig",
    params: [
      { key: "target-fps", labelKey: "paramTargetFps", type: "number", defaultValue: "60" },
      { key: "settle-us", labelKey: "paramSettleUs", type: "number", defaultValue: "20" },
      { key: "send-every-n-frames", labelKey: "paramSendEveryNFrames", type: "number", defaultValue: "1" },
    ],
  },
  {
    command: "set-charge-profile",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "profile",
        labelKey: "paramProfile",
        type: "select",
        defaultValue: "balanced",
        options: [
          { labelKey: "ultraSlowChargingMode", value: "ultra_slow" },
          { labelKey: "slowChargingMode", value: "slow" },
          { labelKey: "balancedChargingMode", value: "balanced" },
          { labelKey: "fastChargingMode", value: "fast" },
          { labelKey: "extremeChargingMode", value: "extreme" },
        ],
      },
    ],
  },
  {
    command: "power-set-state",
    groupKey: "commandGroupDanger",
    params: [
      {
        key: "state",
        labelKey: "paramState",
        type: "select",
        defaultValue: "soft_off_auto",
        options: [
          { labelKey: "resumeNormalMode", value: "normal" },
          { labelKey: "softOffAuto", value: "soft_off_auto" },
          { labelKey: "softOffBattery", value: "soft_off_battery" },
          { labelKey: "softOffCharging", value: "soft_off_charging" },
        ],
      },
    ],
  },
  {
    command: "set-log",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "enabled",
        labelKey: "paramEnabled",
        type: "select",
        defaultValue: "true",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
      {
        key: "level",
        labelKey: "logLevel",
        type: "select",
        defaultValue: "error",
        options: [
          { labelKey: "error", value: "error" },
          { labelKey: "warn", value: "warn" },
          { labelKey: "info", value: "info" },
          { labelKey: "debug", value: "debug" },
        ],
      },
      {
        key: "mode",
        labelKey: "logMode",
        type: "select",
        defaultValue: "standard",
        options: [
          { labelKey: "capacityDefault", value: "standard" },
          { labelKey: "capacityExtended", value: "extended" },
        ],
      },
      { key: "max-bytes", labelKey: "paramMaxBytes", type: "number" },
    ],
  },
  {
    command: "set-ota-config",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "auto-apply-on-boot",
        labelKey: "autoOtaOnBoot",
        type: "select",
        defaultValue: "false",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
      { key: "channel", labelKey: "updateChannel", type: "text", placeholder: "stable / beta" },
      { key: "manifest-url", labelKey: "paramManifestUrl", type: "text", placeholder: "https://..." },
    ],
  },
  {
    command: "set-indicators",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "external-led-mode",
        labelKey: "paramExternalLedMode",
        type: "select",
        defaultValue: "off",
        options: [
          { labelKey: "indicatorMode_off", value: "off" },
          { labelKey: "indicatorMode_enabled", value: "enabled" },
        ],
      },
      {
        key: "preset",
        labelKey: "paramPreset",
        type: "select",
        options: [
          { labelKey: "indicatorPreset_system_status", value: "system_status" },
          { labelKey: "indicatorPreset_connectivity", value: "connectivity" },
          { labelKey: "indicatorPreset_pressure_meter", value: "pressure_meter" },
          { labelKey: "indicatorPreset_stream_heartbeat", value: "stream_heartbeat" },
          { labelKey: "indicatorPreset_calibration_auto", value: "calibration_auto" },
          { labelKey: "indicatorPreset_solid_marker", value: "solid_marker" },
          { labelKey: "indicatorPreset_identify", value: "identify" },
          { labelKey: "indicatorPreset_off", value: "off" },
        ],
      },
      {
        key: "external-led-color",
        labelKey: "externalLedColor",
        type: "select",
        options: [
          { labelKey: "indicatorColor_teal", value: "teal" },
          { labelKey: "indicatorColor_green", value: "green" },
          { labelKey: "indicatorColor_blue", value: "blue" },
          { labelKey: "indicatorColor_purple", value: "purple" },
          { labelKey: "indicatorColor_amber", value: "amber" },
          { labelKey: "indicatorColor_red", value: "red" },
          { labelKey: "indicatorColor_white", value: "white" },
        ],
      },
      { key: "brightness", labelKey: "paramBrightness", type: "number", defaultValue: "0.35", placeholder: "0.10, 0.20, 0.35, 0.50, 1.00" },
      {
        key: "oled-mode",
        labelKey: "paramOledMode",
        type: "select",
        defaultValue: "off",
        options: [
          { labelKey: "indicatorMode_off", value: "off" },
          { labelKey: "indicatorMode_auto", value: "auto" },
          { labelKey: "indicatorMode_enabled", value: "enabled" },
        ],
      },
      {
        key: "oled-page",
        labelKey: "paramOledPage",
        type: "select",
        options: [
          { labelKey: "oledPage_live_status", value: "live_status" },
          { labelKey: "oledPage_sensor_snapshot", value: "sensor_snapshot" },
          { labelKey: "oledPage_recording_status", value: "recording_status" },
          { labelKey: "oledPage_app", value: "app" },
        ],
      },
      { key: "oled-update-hz", labelKey: "paramOledUpdateHz", type: "number" },
      { key: "oled-contrast", labelKey: "paramOledContrast", type: "number" },
    ],
  },
  {
    command: "set-imu",
    groupKey: "commandGroupConfig",
    params: [
      {
        key: "enabled",
        labelKey: "paramEnabled",
        type: "select",
        defaultValue: "true",
        options: [
          { labelKey: "optionTrue", value: "true" },
          { labelKey: "optionFalse", value: "false" },
        ],
      },
    ],
  },
  { command: "io-config", groupKey: "commandGroupConfig", params: [] },
  {
    command: "file-list",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
          { labelKey: "fileScope_proc", value: "proc" },
        ],
      },
    ],
  },
  {
    command: "file-read-begin",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
          { labelKey: "fileScope_proc", value: "proc" },
        ],
      },
      { key: "path", labelKey: "paramPath", type: "text", required: true, placeholder: "device.log" },
    ],
  },
  {
    command: "file-read-chunk",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
          { labelKey: "fileScope_proc", value: "proc" },
        ],
      },
      { key: "path", labelKey: "paramPath", type: "text", required: true, placeholder: "device.log" },
      { key: "offset", labelKey: "paramOffset", type: "number", defaultValue: "0" },
      { key: "length", labelKey: "paramLength", type: "number", defaultValue: "1024" },
    ],
  },
  {
    command: "file-write-begin",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
        ],
      },
      { key: "path", labelKey: "paramPath", type: "text", required: true, placeholder: "configs/profile.json" },
      { key: "size", labelKey: "paramSize", type: "number", required: true, defaultValue: "2" },
      { key: "sha256", labelKey: "paramSha256", type: "text", placeholder: "optional" },
    ],
  },
  {
    command: "file-write-chunk",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
        ],
      },
      { key: "path", labelKey: "paramPath", type: "text", required: true, placeholder: "configs/profile.json" },
      { key: "offset", labelKey: "paramOffset", type: "number", defaultValue: "0" },
      { key: "data", labelKey: "paramDataHex", type: "text", required: true, placeholder: "7b7d" },
    ],
  },
  {
    command: "file-write-finish",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
        ],
      },
      { key: "path", labelKey: "paramPath", type: "text", required: true, placeholder: "configs/profile.json" },
      { key: "sha256", labelKey: "paramSha256", type: "text", placeholder: "optional" },
    ],
  },
  {
    command: "file-delete",
    groupKey: "commandGroupFiles",
    params: [
      {
        key: "scope",
        labelKey: "paramScope",
        type: "select",
        defaultValue: "user",
        options: [
          { labelKey: "fileScope_user", value: "user" },
          { labelKey: "fileScope_logs", value: "logs" },
          { labelKey: "fileScope_calibration", value: "calibration" },
        ],
      },
      { key: "path", labelKey: "paramPath", type: "text", required: true, placeholder: "tmp/sample.csv" },
    ],
  },
  {
    command: "log-tail",
    groupKey: "commandGroupFiles",
    params: [{ key: "lines", labelKey: "paramLines", type: "number", defaultValue: "50" }],
  },
  { command: "log-clear", groupKey: "commandGroupFiles", params: [] },
  { command: "crash-log", groupKey: "commandGroupFiles", params: [] },
  { command: "health", groupKey: "commandGroupFiles", params: [] },
  { command: "crash-clear", groupKey: "commandGroupFiles", params: [] },
  { command: "reboot", groupKey: "commandGroupDanger", params: [] },
  { command: "reboot-wifi-setup", groupKey: "commandGroupDanger", params: [] },
];

// Builder commands that never reach the device: the page handles them itself.
export const LOCAL_ONLY_COMMANDS = ["io-config", "visualize-io"];

// Spellings the backend accepts for a command that has no block of its own.
const COMMAND_ALIASES: Record<string, string> = {
  "visualize-io": "io-config",
};

// Option names the backend's compile_terminal_command also accepts, mapped to
// the builder's own key for that value.
const PARAM_ALIASES: Record<string, Record<string, string>> = {
  "log-tail": { "max-lines": "lines" },
  "set-time": { epoch: "epoch-ms" },
  "file-write-chunk": { "data-hex": "data" },
};

// set_indicators takes nested external_led/oled objects in JSON; the builder
// (like the CLI) spells them as flat keys.
const INDICATOR_FLAT_KEYS: Record<string, Record<string, string>> = {
  external_led: { mode: "external-led-mode", preset: "preset", color: "external-led-color", brightness: "brightness" },
  oled: { mode: "oled-mode", page: "oled-page", update_hz: "oled-update-hz", contrast: "oled-contrast" },
};

// JSON envelope fields that are not command parameters.
const JSON_ENVELOPE_KEYS = new Set(["command", "protocol", "request_id", "quiet"]);

// Same words the backend's _as_bool treats as true; anything else is false.
const TRUE_WORDS = new Set(["1", "true", "yes", "on", "enabled"]);
const FALSE_WORDS = new Set(["0", "false", "no", "off", "disabled"]);

export function findCommandBlock(command: string, extraBlocks: CommandBlock[] = []) {
  return COMMAND_BLOCKS.find((block) => block.command === command) ?? extraBlocks.find((block) => block.command === command);
}

/**
 * Blocks for what the device lists but this Desktop has no block for -- a
 * command added to the firmware later. Internal commands (set_transport,
 * set_wifi) are not offered; the backend sends those itself.
 */
export function deviceCommandBlocks(catalog: DeviceCommandSpec[] | null | undefined): CommandBlock[] {
  if (!catalog) return [];
  const blocks: CommandBlock[] = [];
  for (const spec of catalog) {
    if (spec.internal) continue;
    const command = normalizeName(spec.name);
    if (findCommandBlock(command) || COMMAND_ALIASES[command] || LOCAL_ONLY_COMMANDS.includes(command)) continue;
    blocks.push({
      command,
      groupKey: DEVICE_COMMAND_GROUP,
      params: [{ key: RAW_ARGS_KEY, labelKey: "paramRawArgs", type: "text", placeholder: "--key value" }],
      device: { summary: spec.summary, maintenance: spec.maintenance },
    });
  }
  return blocks;
}

/** Commands the device itself flags as maintenance-only, in builder spelling. */
export function maintenanceOnlyCommands(catalog: DeviceCommandSpec[] | null | undefined): Set<string> {
  return new Set((catalog ?? []).filter((spec) => spec.maintenance).map((spec) => normalizeName(spec.name)));
}

export function quoteCommandValue(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^[A-Za-z0-9_./:@,+-]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildCommandLine(block: CommandBlock, values: Record<string, string>) {
  const parts = [block.command];
  if (block.device) {
    const raw = values[RAW_ARGS_KEY]?.trim() ?? "";
    if (raw) parts.push(raw);
    return parts.join(" ");
  }
  for (const param of block.params) {
    const value = values[param.key]?.trim() ?? "";
    if (!value) continue;
    parts.push(`--${param.key}`, quoteCommandValue(value));
  }
  return parts.join(" ");
}

export function missingRequiredParams(block: CommandBlock, values: Record<string, string>) {
  return block.params.filter((param) => param.required && !(values[param.key] ?? "").trim());
}

/**
 * Splits a command line the way the backend's shlex.split (POSIX mode) does:
 * whitespace separates words, single quotes are literal, double quotes only
 * let \" and \\ through, and a bare backslash escapes the next character.
 * A backslash before a newline is a line continuation, so a command copied
 * from a multi-line shell snippet still reads as one line.
 */
export function tokenizeCommandLine(text: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (quote === '"') {
      const next = text[index + 1];
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (next === '"' || next === "\\")) {
        current += next;
        index += 1;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\\") {
      const next = text[index + 1];
      if (next === undefined) {
        current += char;
        inToken = true;
      } else if (next === "\n") {
        index += 1;
      } else if (next === "\r" && text[index + 2] === "\n") {
        index += 2;
      } else {
        current += next;
        inToken = true;
        index += 1;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (inToken) tokens.push(current);
      current = "";
      inToken = false;
      continue;
    }
    current += char;
    inToken = true;
  }
  if (quote) throw new Error("unterminated_quote");
  if (inToken) tokens.push(current);
  return tokens;
}

export type PasteErrorCode = "empty" | "invalid_json" | "missing_command" | "unknown_command" | "unterminated_quote";

export type PasteWarningCode =
  | "unknown_param"
  | "invalid_option"
  | "invalid_number"
  | "missing_value"
  | "ignored_argument"
  | "unsupported_value";

/** `key` is the parameter as the user wrote it; `value` the rejected value, if any. */
export type PasteWarning = { code: PasteWarningCode; key: string; value?: string };

export type ParsedPastedCommand =
  | { ok: true; command: string; values: Record<string, string>; unknownKeys: string[]; warnings: PasteWarning[] }
  | { ok: false; error: PasteErrorCode; detail?: string };

function normalizeName(value: string) {
  return value.trim().toLowerCase().replace(/_/g, "-");
}

function normalizeOptionValue(value: string) {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function isBooleanSelect(param: CommandParam) {
  const values = (param.options ?? []).map((option) => option.value).sort();
  return values.length === 2 && values[0] === "false" && values[1] === "true";
}

function matchSelectOption(param: CommandParam, raw: string): string | undefined {
  const wanted = normalizeOptionValue(raw);
  const match = (param.options ?? []).find((option) => normalizeOptionValue(option.value) === wanted);
  if (match) return match.value;
  if (isBooleanSelect(param)) {
    const word = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return "true";
    if (FALSE_WORDS.has(word)) return "false";
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// JSON scalar/array -> the builder's text form; undefined for nested objects.
function jsonValueToText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.some((item) => item !== null && typeof item === "object")) return undefined;
    return value.map((item) => String(item ?? "")).join(",");
  }
  return undefined;
}

type ParseState = { values: Record<string, string>; unknownKeys: string[]; warnings: PasteWarning[] };

function resolveParam(block: CommandBlock, rawKey: string) {
  const key = normalizeName(rawKey);
  const resolved = PARAM_ALIASES[block.command]?.[key] ?? key;
  return block.params.find((param) => param.key === resolved);
}

function addUnknownKey(state: ParseState, key: string) {
  if (!state.unknownKeys.includes(key)) state.unknownKeys.push(key);
  state.warnings.push({ code: "unknown_param", key });
}

// Puts one pasted value into the builder. A value the form cannot hold (an
// option the select lacks, text in a number field) is left out, with a warning,
// rather than silently turned into something else.
function assignParam(state: ParseState, block: CommandBlock, rawKey: string, value: string) {
  const param = resolveParam(block, rawKey);
  if (!param) {
    addUnknownKey(state, rawKey);
    return;
  }
  if (param.type === "select") {
    const option = matchSelectOption(param, value);
    if (option === undefined) {
      delete state.values[param.key];
      state.warnings.push({ code: "invalid_option", key: rawKey, value });
      return;
    }
    state.values[param.key] = option;
    return;
  }
  if (param.type === "number" && value.trim() && !Number.isFinite(Number(value))) {
    delete state.values[param.key];
    state.warnings.push({ code: "invalid_number", key: rawKey, value });
    return;
  }
  state.values[param.key] = value;
}

function lookupBlock(rawCommand: string, extraBlocks: CommandBlock[]) {
  const name = normalizeName(rawCommand);
  return findCommandBlock(COMMAND_ALIASES[name] ?? name, extraBlocks);
}

// A device-catalog block has no form to fill: its arguments go into the one
// free field, re-quoted as the CLI would take them.
function rawArgsResult(block: CommandBlock, pairs: [string, string][]): ParsedPastedCommand {
  const raw = pairs.map(([key, value]) => `--${key} ${quoteCommandValue(value) || '""'}`).join(" ");
  return { ok: true, command: block.command, values: raw ? { [RAW_ARGS_KEY]: raw } : {}, unknownKeys: [], warnings: [] };
}

function parseJsonCommand(text: string, extraBlocks: CommandBlock[]): ParsedPastedCommand {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json" };
  }
  if (!isPlainObject(data)) return { ok: false, error: "invalid_json" };
  const rawCommand = typeof data.command === "string" ? data.command.trim() : "";
  if (!rawCommand) return { ok: false, error: "missing_command" };
  const block = lookupBlock(rawCommand, extraBlocks);
  if (!block) return { ok: false, error: "unknown_command", detail: rawCommand };
  if (block.device) {
    const pairs: [string, string][] = [];
    for (const [key, value] of Object.entries(data)) {
      if (JSON_ENVELOPE_KEYS.has(key) || value === null || value === undefined) continue;
      const text = jsonValueToText(value);
      if (text !== undefined) pairs.push([normalizeName(key), text]);
    }
    return rawArgsResult(block, pairs);
  }

  const state: ParseState = { values: {}, unknownKeys: [], warnings: [] };
  for (const [key, value] of Object.entries(data)) {
    if (JSON_ENVELOPE_KEYS.has(key) || value === null || value === undefined) continue;
    const flatKeys = block.command === "set-indicators" ? INDICATOR_FLAT_KEYS[key] : undefined;
    if (flatKeys && isPlainObject(value)) {
      for (const [nestedKey, nestedValue] of Object.entries(value)) {
        if (nestedValue === null || nestedValue === undefined) continue;
        const label = `${key}.${nestedKey}`;
        const text = jsonValueToText(nestedValue);
        if (!flatKeys[nestedKey]) addUnknownKey(state, label);
        else if (text === undefined) state.warnings.push({ code: "unsupported_value", key: label });
        else assignParam(state, block, flatKeys[nestedKey], text);
      }
      continue;
    }
    const text = jsonValueToText(value);
    if (text === undefined) {
      if (resolveParam(block, key)) state.warnings.push({ code: "unsupported_value", key });
      else addUnknownKey(state, key);
      continue;
    }
    assignParam(state, block, key, text);
  }
  return { ok: true, command: block.command, ...state };
}

function parseCliCommand(text: string, extraBlocks: CommandBlock[]): ParsedPastedCommand {
  let tokens: string[];
  try {
    tokens = tokenizeCommandLine(text);
  } catch {
    return { ok: false, error: "unterminated_quote" };
  }
  if (!tokens.length) return { ok: false, error: "empty" };
  const block = lookupBlock(tokens[0]!, extraBlocks);
  if (!block) return { ok: false, error: "unknown_command", detail: tokens[0] };
  if (block.device) {
    const rest = tokens.slice(1).map((token) => quoteCommandValue(token) || '""').join(" ");
    return { ok: true, command: block.command, values: rest ? { [RAW_ARGS_KEY]: rest } : {}, unknownKeys: [], warnings: [] };
  }

  const state: ParseState = { values: {}, unknownKeys: [], warnings: [] };
  const args = tokens.slice(1);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--") || token === "--") {
      state.warnings.push({ code: "ignored_argument", key: "", value: token });
      continue;
    }
    const body = token.slice(2);
    const equals = body.indexOf("=");
    if (equals >= 0) {
      assignParam(state, block, body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      // A bare flag: fine for a true/false option, otherwise nothing to fill.
      const param = resolveParam(block, body);
      if (param && isBooleanSelect(param)) state.values[param.key] = "true";
      else if (!param) addUnknownKey(state, body);
      else state.warnings.push({ code: "missing_value", key: body });
      continue;
    }
    assignParam(state, block, body, next);
    index += 1;
  }
  return { ok: true, command: block.command, ...state };
}

/**
 * Reads a pasted command -- a CLI line (as shown in the help, the generated
 * command or a `$ ...` log line) or a raw JSON payload as in the wiki -- into
 * the builder's command and form values. Only what was pasted is filled: the
 * builder's defaults are not mixed in, so the result means exactly the input.
 */
export function parsePastedCommand(text: string, extraBlocks: CommandBlock[] = []): ParsedPastedCommand {
  const trimmed = text.trim().replace(/^\$\s+/, "");
  if (!trimmed) return { ok: false, error: "empty" };
  if (trimmed.startsWith("{")) return parseJsonCommand(trimmed, extraBlocks);
  return parseCliCommand(trimmed, extraBlocks);
}
