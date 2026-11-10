import { useState } from "react";
import { useStudio } from "../../../state/studio";
import { useAreaT } from "../../i18n";
import { toolsStrings, type ToolsStringsKey } from "../toolsStrings";
import {
  detectTimestampUnit,
  formatDuration,
  formatInstant,
  timestampToEpochMs,
  type TimestampUnit,
} from "../lib/recordingAnalysis";
import { Select, TextInput } from '../../../components/ui';

const UNITS: TimestampUnit[] = ["s", "ms", "us", "ns"];
const UNIT_KEYS: Record<TimestampUnit, ToolsStringsKey> = {
  s: "analysisUnitS",
  ms: "analysisUnitMs",
  us: "analysisUnitUs",
  ns: "analysisUnitNs",
};

/** A number in the given unit, or a date string read as a point in time. */
function readInstant(text: string, unit: TimestampUnit | "auto"): { ms: number; unit: TimestampUnit | null } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(trimmed)) {
    const value = Number(trimmed);
    if (!Number.isFinite(value)) return null;
    const resolved = unit === "auto" ? detectTimestampUnit(value) : unit;
    return { ms: timestampToEpochMs(value, resolved), unit: resolved };
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? { ms: parsed, unit: null } : null;
}

type TimestampConverterProps = {
  /** The loaded recording's first and last timestamp_ms, offered as inputs. */
  recordingRange: { startMs: number; endMs: number } | null;
};

// timestamp_ms in a recording is Unix epoch *milliseconds*; reading it as
// seconds lands tens of thousands of years out, and the difference of two of
// them as seconds reads a 6-minute recording as about 100 hours. This shows
// every reading of a number side by side, the one its size implies first.
export function TimestampConverter({ recordingRange }: TimestampConverterProps) {
  const t = useAreaT(toolsStrings);
  const { locale } = useStudio();
  const [value, setValue] = useState("");
  const [unit, setUnit] = useState<TimestampUnit | "auto">("auto");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const instant = readInstant(value, unit);
  const numeric = value.trim() !== "" && Number.isFinite(Number(value.trim())) ? Number(value.trim()) : null;
  const a = readInstant(from, unit);
  const b = readInstant(to, unit);

  return (
    <div className="analysis-converter">
      <div className="analysis-converter-block">
        <div className="analysis-converter-inputs">
          <label className="analysis-field grow">
            <span>{t("analysisConvertInput")}</span>
            <TextInput
              type="text"
              inputMode="decimal"
              value={value}
              placeholder="1792135441343"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <label className="analysis-field">
            <span>{t("analysisConvertUnit")}</span>
            <Select value={unit} onChange={(event) => setUnit(event.target.value as TimestampUnit | "auto")}>
              <option value="auto">{t("analysisUnitAuto")}</option>
              {UNITS.map((item) => <option key={item} value={item}>{t(UNIT_KEYS[item])}</option>)}
            </Select>
          </label>
          <button type="button" className="button compact" onClick={() => setValue(String(Date.now()))}>
            {t("analysisConvertNow")}
          </button>
        </div>
        {instant ? (
          <dl className="analysis-converter-result" aria-live="polite">
            {instant.unit ? (
              <>
                <dt>{t("analysisConvertReadAs")}</dt>
                <dd>{t(UNIT_KEYS[instant.unit])}{unit === "auto" ? ` · ${t("analysisConvertDetected")}` : ""}</dd>
              </>
            ) : null}
            <dt>{t("analysisConvertLocal")}</dt>
            <dd>{formatInstant(instant.ms, locale)}</dd>
            <dt>UTC</dt>
            <dd>{formatInstant(instant.ms, locale, "UTC")}</dd>
            <dt>ISO 8601</dt>
            <dd className="mono">{Number.isFinite(new Date(instant.ms).getTime()) ? new Date(instant.ms).toISOString() : "—"}</dd>
            <dt>{t("analysisConvertEpochMs")}</dt>
            <dd className="mono">{Math.round(instant.ms)}</dd>
            <dt>{t("analysisConvertEpochS")}</dt>
            <dd className="mono">{(instant.ms / 1000).toFixed(3)}</dd>
          </dl>
        ) : value.trim() ? (
          <p className="notice error" role="alert">{t("analysisConvertInvalid")}</p>
        ) : null}
        {numeric !== null && instant?.unit ? (
          <table className="analysis-converter-table">
            <thead>
              <tr>
                <th>{t("analysisConvertIfUnit")}</th>
                <th>UTC</th>
              </tr>
            </thead>
            <tbody>
              {UNITS.map((item) => (
                <tr key={item} className={item === instant.unit ? "active" : ""}>
                  <td>{t(UNIT_KEYS[item])}</td>
                  <td className="mono">{formatInstant(timestampToEpochMs(numeric, item), locale, "UTC")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="analysis-converter-block">
        <h4>{t("analysisConvertDuration")}</h4>
        <div className="analysis-converter-inputs">
          <label className="analysis-field grow">
            <span>{t("analysisConvertFrom")}</span>
            <TextInput type="text" inputMode="decimal" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label className="analysis-field grow">
            <span>{t("analysisConvertTo")}</span>
            <TextInput type="text" inputMode="decimal" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          {recordingRange ? (
            <button
              type="button"
              className="button compact"
              onClick={() => {
                setFrom(String(recordingRange.startMs));
                setTo(String(recordingRange.endMs));
              }}
            >
              {t("analysisConvertUseRecording")}
            </button>
          ) : null}
        </div>
        {a && b ? (
          <dl className="analysis-converter-result">
            <dt>{t("analysisDuration")}</dt>
            <dd><strong>{formatDuration(b.ms - a.ms)}</strong> · {((b.ms - a.ms) / 1000).toFixed(3)} s</dd>
          </dl>
        ) : null}
        <p className="analysis-note">{t("analysisConvertHint")}</p>
      </div>
    </div>
  );
}
