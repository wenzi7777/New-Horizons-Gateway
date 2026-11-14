// Ported from the Desktop's components/sdk/ReferencePanel.tsx.
import { useMemo, useState } from "react";
import { Search } from "lucide-react";

import { useAppsT } from "../strings";
import { API_REFERENCE } from "../lib/appLanguage";
import { PANEL_FORMS, READOUT_SECTION_FORMS } from "../lib/sdkPrompt";
import type { SdkKind } from "../lib/sdkProject";
import {
  DEFAULT_BUDGET_US,
  LED_COLOURS,
  MAX_DEBOUNCE_MS,
  MAX_EVENT_NAME,
  MAX_EXT_LEDS,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_PACKAGE_BYTES,
  OLED_ROWS,
  VM_STORE_QUOTA_BYTES,
  panelset,
  readoutset,
} from "../sdk/lib/index.mjs";
import { TextInput } from '../../../components/ui';

// Everything here is read from the SDK itself -- an app's API from the
// nhos.d.ts an author's own editor checks against -- so the reference cannot
// describe a language the compiler does not accept.

export function ReferencePanel({ kind }: { kind: SdkKind }) {
  const t = useAppsT();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const match = (...texts: string[]) => !needle || texts.some((text) => text.toLowerCase().includes(needle));

  const sections = useMemo(
    () => API_REFERENCE.map((section) => ({
      ...section,
      entries: section.entries.filter((entry) => match(entry.name, entry.signature, entry.doc)),
    })).filter((section) => section.entries.length > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needle],
  );

  const limits: [string, string][] = [
    [t("sdkLimitBudget"), `${DEFAULT_BUDGET_US} µs`],
    [t("sdkLimitEvent"), `${MAX_EVENT_NAME}`],
    [t("sdkLimitDebounce"), `${MAX_DEBOUNCE_MS} ms`],
    [t("sdkLimitPackage"), `${MAX_PACKAGE_BYTES} B`],
    [t("sdkLimitStore"), `${VM_STORE_QUOTA_BYTES / 1024} KB`],
    [t("sdkLimitOledRows"), `0–${OLED_ROWS - 1}`],
    [t("sdkLimitOledLabel"), `${MAX_OLED_LABEL}`],
    [t("sdkLimitOledDigits"), `0–${MAX_OLED_DIGITS}`],
    [t("sdkLimitExtPixel"), `0–${MAX_EXT_LEDS - 1}`],
  ];

  return (
    <div className="sdk-panel-body">
      <label className="apps-search">
        <Search size={15} aria-hidden="true" />
        <TextInput type="search" value={query} placeholder={t("sdkReferenceSearch")} aria-label={t("sdkReferenceSearch")} onChange={(event) => setQuery(event.target.value)} />
      </label>

      {kind === "flow" ? (
        <>
          {sections.map((section) => (
            <section className="sdk-section" key={section.title}>
              <h3>{section.title}</h3>
              <table className="sdk-table">
                <tbody>
                  {section.entries.map((entry) => (
                    <tr key={entry.signature}>
                      <td className="sdk-mono sdk-ref-signature">{entry.signature}</td>
                      <td>
                        {entry.ask ? <span className="sdk-chip sdk-ref-ask" title={t("sdkRefAskHint")}>{t("sdkRefAsk")}</span> : null}
                        {entry.doc}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}

          <section className="sdk-section">
            <h3>{t("sdkRefColours")}</h3>
            <div className="sdk-chips">{Object.entries(LED_COLOURS).filter(([name]) => match(name)).map(([name, [r, g, b]]) => (
              <span key={name} className="sdk-chip"><i className="sdk-swatch" style={{ background: `rgb(${r}, ${g}, ${b})` }} />Color.{name.charAt(0).toUpperCase() + name.slice(1)}</span>
            ))}</div>
          </section>
        </>
      ) : (
        <>
          <section className="sdk-section">
            <h3>{t("sdkRefSources")}</h3>
            <p className="sdk-hint">{t("sdkRefSourcesHint")}</p>
            <div className="sdk-chips">{[...readoutset.ALLOWED_SOURCES].filter((s) => match(s)).map((s) => <span key={s} className="sdk-chip sdk-mono">{s}</span>)}</div>
          </section>
          <section className="sdk-section">
            <h3>{t("sdkRefFormats")}</h3>
            <div className="sdk-chips">{[...readoutset.FORMATS].map((f) => <span key={f} className="sdk-chip sdk-mono">{f}</span>)}</div>
          </section>
          <section className="sdk-section">
            <h3>{t("sdkRefSections")}</h3>
            <div className="sdk-ref-list">
              {READOUT_SECTION_FORMS.filter(([kind, form]) => match(kind, form)).map(([kind, form]) => (
                <code key={kind} className="sdk-ref-form">{form}</code>
              ))}
            </div>
          </section>
          {kind === "panel" ? (
            <>
              <section className="sdk-section">
                <h3>{t("sdkRefPanel")}</h3>
                <div className="sdk-ref-list">
                  {PANEL_FORMS.filter(([name, form]) => match(name, form)).map(([name, form]) => (
                    <code key={name} className="sdk-ref-form">{form}</code>
                  ))}
                </div>
                <p className="sdk-hint">{t("sdkRefConditionsHint")}</p>
              </section>
              <section className="sdk-section">
                <h3>{t("sdkRefPermissions")}</h3>
                <table className="sdk-table">
                  <tbody>
                    {Object.entries(panelset.PERMISSIONS).filter(([name, commands]) => match(name, ...commands)).map(([name, commands]) => (
                      <tr key={name}>
                        <td className="sdk-mono sdk-nowrap">{name}</td>
                        <td className="sdk-chips">{commands.map((command) => <span key={command} className="sdk-chip sdk-mono">{command}</span>)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="sdk-hint">{t("sdkRefPermissionsHint")}</p>
              </section>
            </>
          ) : null}
        </>
      )}

      <section className="sdk-section">
        <h3>{t("sdkLimits")}</h3>
        <dl className="sdk-facts">
          {limits.filter(([label]) => match(label)).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd className="sdk-mono">{value}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}
