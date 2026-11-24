// Device health from the firmware's `health` command (v1.9.0+), ported from
// New-Horizons-Desktop src/components/DeviceHealthCard.tsx + HealthParts.tsx.
// The device keeps it out of `status`, so the card fetches and holds its own
// copy. Studio only relays over Wi-Fi, so the Hub (ESP-NOW) link counters are
// shown only once they have ever moved.

import { useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";

import type { DeviceView } from "../../../shared/contract";
import { Card } from "../../components/ui";
import type { Payload } from "../../lib/commands";
import { isFaultReset } from "../../lib/scanHealth";
import { useStudio } from "../../state/studio";
import { useDeviceSettingsT } from "./DeviceHardware";

type Send = (
  label: string,
  payload: Payload,
  options?: { success?: string | false },
) => Promise<{ ok: boolean; data: unknown }>;
type Snapshot = Record<string, unknown>;
type Tone = "neutral" | "good" | "warn" | "bad";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function count(value: unknown): string {
  const n = num(value);
  return n === null ? "-" : n.toLocaleString();
}

function durationLabel(value: unknown): string {
  const seconds = num(value);
  if (seconds === null) return "-";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours === 0
    ? `${minutes} m`
    : `${hours.toLocaleString()} h ${minutes} m`;
}

function tempLabel(value: unknown): string {
  const celsius = num(value);
  return celsius === null ? "-" : `${celsius.toFixed(1)} °C`;
}

function bytesLabel(value: unknown): string {
  const bytes = num(value);
  return bytes === null || bytes === 0
    ? "-"
    : `${(bytes / 1024).toFixed(1)} KB`;
}

/** The reply's health block, whether or not the firmware envelope's `data` was hoisted. */
function healthSnapshot(data: unknown): Snapshot | null {
  const outer = record(data);
  if (record(outer.time).power_on_s !== undefined) return outer;
  const inner = record(outer.data);
  return record(inner.time).power_on_s !== undefined ? inner : null;
}

function unknownCommand(data: unknown): boolean {
  const outer = record(data);
  return [outer.error, outer.message, record(outer.data).error].some(
    (v) => String(v ?? "") === "unknown_command",
  );
}

const VERDICT_PILL: Record<string, string> = {
  ok: "live",
  warn: "waiting",
  fail: "danger",
};

function Stat({
  label,
  value,
  sub,
  tone = "neutral",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <div className={`health-stat tone-${tone}`}>
      <div className="health-stat-label">{label}</div>
      <div className="health-stat-value">{value}</div>
      {sub ? <div className="health-stat-sub">{sub}</div> : null}
    </div>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="health-group">
      <h5 className="health-group-heading">{title}</h5>
      <div className="health-rows">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className={`health-row tone-${tone}`}>
      <div className="health-row-label">
        <span>{label}</span>
        {hint ? <small>{hint}</small> : null}
      </div>
      <div className="health-row-value">{value}</div>
    </div>
  );
}

export function DeviceHealthCard({
  device,
  disabled,
  busy,
  send,
}: {
  device: DeviceView;
  disabled: boolean;
  busy: string;
  send: Send;
}) {
  const ds = useDeviceSettingsT();
  const { t } = useStudio();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [updatedAt, setUpdatedAt] = useState("");
  const [fetched, setFetched] = useState(false);

  const load = async () => {
    const outcome = await send(
      ds("deviceHealth"),
      { command: "health" },
      { success: false },
    );
    if (!outcome.ok) {
      if (unknownCommand(outcome.data)) setUnsupported(true);
      return;
    }
    const data = healthSnapshot(outcome.data);
    if (!data) return;
    setUnsupported(false);
    setSnapshot(data);
    setUpdatedAt(new Date().toLocaleTimeString());
  };

  useEffect(() => {
    setSnapshot(null);
    setUnsupported(false);
    setUpdatedAt("");
    setFetched(false);
  }, [device.uid]);

  // Only the first fetch per device is automatic; later ones are a click.
  useEffect(() => {
    if (fetched || disabled) return;
    setFetched(true);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetched, disabled]);

  const health = record(snapshot?.health);
  const verdict = String(health.verdict ?? "");
  const reasons = Array.isArray(health.reasons)
    ? health.reasons.map(String)
    : [];
  const time = record(snapshot?.time);
  const boot = record(snapshot?.boot);
  const resetCounts = Object.entries(record(boot.reset_counts)).sort(
    (a, b) => Number(b[1]) - Number(a[1]),
  );
  const firmware = record(snapshot?.firmware);
  const environment = record(snapshot?.environment);
  const connectivity = record(snapshot?.connectivity);
  const input = snapshot && "input" in snapshot ? record(snapshot.input) : null;
  const firstSeenUnix = num(time.first_seen_unix) ?? 0;
  const crashTotal = num(boot.crash_total) ?? 0;
  const running = busy === "health";
  // Firmware reports esp_reset_reason_t names ("poweron", "panic", ...).
  const resetLabel = (reason: string) => {
    const key = `healthResetReason_${reason}`;
    const label = ds(key);
    return label === key ? reason : label;
  };
  const espNowMoved = [
    "espnow_hub_losses",
    "espnow_reply_failures",
    "espnow_send_failures",
  ].some((key) => Number(connectivity[key]) > 0);

  return (
    <Card
      title={ds("deviceHealth")}
      copy={ds("deviceHealthCopy")}
      actions={
        <>
          {verdict ? (
            <span className={`status-pill ${VERDICT_PILL[verdict] ?? "muted"}`}>
              {ds(`healthVerdict_${verdict}`)}
            </span>
          ) : null}
          <button
            className="button tiny"
            type="button"
            disabled={disabled}
            onClick={() => void load()}
          >
            <RefreshCw size={13} aria-hidden="true" />
            {running ? t("running") : t("actionStatus")}
          </button>
        </>
      }
    >
      {unsupported ? (
        <p className="field-note">{ds("deviceHealthUnsupported")}</p>
      ) : !snapshot ? (
        <p className="field-note">
          {running ? t("running") : ds("deviceHealthEmpty")}
        </p>
      ) : (
        <div className="stack">
          {reasons.length > 0 ? (
            <div
              className={`health-callout tone-${verdict === "fail" ? "bad" : "warn"}`}
              role="status"
            >
              <strong>{ds("healthReasons")}</strong>
              <ul>
                {reasons.map((reason) => (
                  <li key={reason}>{ds(`healthReason_${reason}`)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="health-summary">
            <Stat
              label={ds("healthPowerOn")}
              value={durationLabel(time.power_on_s)}
              sub={`${ds("healthScan")} ${durationLabel(time.scan_s)}`}
            />
            <Stat
              label={ds("healthBootCount")}
              value={count(boot.boot_count)}
              sub={
                boot.last_reset_reason
                  ? `${ds("healthLastReset")}: ${resetLabel(String(boot.last_reset_reason))}`
                  : undefined
              }
            />
            <Stat
              label={ds("healthCrashTotal")}
              value={count(boot.crash_total)}
              sub={`${ds("healthOtaRollback")} ${count(firmware.ota_rollback)}`}
              tone={crashTotal > 0 ? "bad" : "neutral"}
            />
            <Stat
              label={ds("healthChipTemp")}
              value={tempLabel(environment.chip_temp_c)}
              sub={`${ds("healthTempRange")} ${tempLabel(environment.chip_temp_min_c)} – ${tempLabel(environment.chip_temp_max_c)}`}
              tone={reasons.includes("high_temperature") ? "warn" : "neutral"}
            />
          </div>
          <div className="health-groups">
            <Group title={ds("healthGroupTime")}>
              <Row
                label={ds("healthPowerOn")}
                value={durationLabel(time.power_on_s)}
              />
              <Row
                label={ds("healthAwake")}
                value={durationLabel(time.awake_s)}
              />
              <Row
                label={ds("healthSoftOff")}
                value={durationLabel(time.soft_off_s)}
              />
              <Row
                label={ds("healthScan")}
                value={durationLabel(time.scan_s)}
              />
              <Row
                label={ds("healthSession")}
                value={durationLabel(time.session_s)}
              />
              <Row
                label={ds("healthLongestSession")}
                value={durationLabel(time.longest_session_s)}
              />
            </Group>
            <Group title={ds("healthGroupBoot")}>
              <Row
                label={ds("healthBootCount")}
                value={count(boot.boot_count)}
              />
              <Row
                label={ds("healthCrashTotal")}
                value={count(boot.crash_total)}
                tone={crashTotal > 0 ? "bad" : "neutral"}
              />
              <Row
                label={ds("healthLastReset")}
                value={
                  boot.last_reset_reason
                    ? resetLabel(String(boot.last_reset_reason))
                    : "-"
                }
                tone={
                  isFaultReset(String(boot.last_reset_reason ?? ""))
                    ? "bad"
                    : "neutral"
                }
              />
              {resetCounts.map(([reason, n]) => (
                <Row
                  key={reason}
                  label={resetLabel(reason)}
                  hint={ds("healthResetCountHint")}
                  value={count(n)}
                  tone={
                    isFaultReset(reason) && Number(n) > 0 ? "bad" : "neutral"
                  }
                />
              ))}
            </Group>
            <Group title={ds("healthGroupFirmware")}>
              <Row
                label={ds("healthFirmwareFirst")}
                value={String(firmware.first || "-")}
              />
              <Row
                label={ds("healthFirmwareChanges")}
                value={count(firmware.changes)}
              />
              <Row
                label={ds("healthOtaSuccess")}
                value={count(firmware.ota_success)}
              />
              <Row
                label={ds("healthOtaRollback")}
                value={count(firmware.ota_rollback)}
                tone={Number(firmware.ota_rollback) > 0 ? "warn" : "neutral"}
              />
              {firmware.rolled_back_from ? (
                <Row
                  label={ds("healthRolledBackFrom")}
                  value={String(firmware.rolled_back_from)}
                  tone="warn"
                />
              ) : null}
            </Group>
            <Group title={ds("healthGroupEnvironment")}>
              <Row
                label={ds("healthChipTemp")}
                value={tempLabel(environment.chip_temp_c)}
              />
              <Row
                label={ds("healthChipTempMax")}
                value={tempLabel(environment.chip_temp_max_c)}
              />
              <Row
                label={ds("healthChipTempMin")}
                value={tempLabel(environment.chip_temp_min_c)}
              />
              <Row
                label={ds("healthMinFreeHeap")}
                value={bytesLabel(environment.min_free_heap)}
                tone={reasons.includes("low_heap") ? "warn" : "neutral"}
              />
              <Row
                label={ds("healthWifiDisconnects")}
                value={count(connectivity.wifi_disconnects)}
              />
              {"espnow_hub_losses" in connectivity && espNowMoved ? (
                <>
                  <Row
                    label={ds("healthEspNowHubLosses")}
                    value={count(connectivity.espnow_hub_losses)}
                  />
                  <Row
                    label={ds("healthEspNowReplyFailures")}
                    value={count(connectivity.espnow_reply_failures)}
                  />
                  <Row
                    label={ds("healthEspNowSendFailures")}
                    value={count(connectivity.espnow_send_failures)}
                  />
                </>
              ) : null}
              {input ? (
                <Row
                  label={ds("healthButtonPresses")}
                  value={count(input.button_presses)}
                />
              ) : null}
            </Group>
          </div>
          <p className="health-footnote">
            {ds("healthTrackedSince")
              .replace("{boot}", count(boot.tracked_since_boot))
              .replace("{firmware}", String(firmware.first || "-"))}
            {firstSeenUnix > 0
              ? ` · ${ds("healthFirstSeen")}: ${new Date(firstSeenUnix * 1000).toLocaleDateString()}`
              : ""}
            {` · ${ds("healthFlushNote").replace("{minutes}", String(Math.round((num(time.flush_interval_s) ?? 600) / 60)))}`}
            {updatedAt
              ? ` · ${ds("healthUpdatedAt").replace("{time}", updatedAt)}`
              : ""}
          </p>
        </div>
      )}
    </Card>
  );
}
