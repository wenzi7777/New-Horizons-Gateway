// Ported from the Desktop's components/sdk/BuildPanel.tsx; export goes through a
// folder dialog in the main process, and a built package can be installed on a device.
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Cpu, Download, Info, XCircle } from "lucide-react";

import { useStudio } from "../../../state/studio";
import { appsApi, errorCode } from "../api";
import type { AppPackage } from "../lib/appLibrary";
import { useAppsT } from "../strings";
import { AppInstallDialog } from "./AppInstallDialog";
import { PermissionList as PanelPermissionList } from "./LibraryPage";
import {
  exportFiles,
  readManifestFields,
  runtimeShares,
  sha256Hex,
  writeManifestField,
  type EditableManifestField,
  type MatrixTarget,
  type SdkProject,
} from "../lib/sdkProject";
import {
  DEFAULT_BUDGET_US,
  LEGACY_MAX_NODES,
  MAX_NODES,
  MAX_PACKAGE_BYTES,
  WINDOW_POOL,
  compareVersions,
  type Analysis,
  type Diagnostic,
  type FlowNode,
} from "../sdk/lib/index.mjs";
import { TextInput } from '../../../components/ui';

type Props = {
  project: SdkProject;
  analysis: Analysis;
  target: MatrixTarget;
  onRevealLine: (line: number) => void;
  /** Writes an edited manifest field back into the project's source. */
  onSourceChange: (source: string) => void;
  go: (path: string[]) => void;
};

// Name, author and summary, edited here instead of in the code. The source
// stays the only place they live: each change is written into it.
function ManifestDetails({
  project,
  onSourceChange,
}: {
  project: SdkProject;
  onSourceChange: (source: string) => void;
}) {
  const t = useAppsT();
  const stated = readManifestFields(project);
  const [drafts, setDrafts] = useState(stated);
  const statedKey = `${project.id}|${stated.name}|${stated.author}|${stated.summary}`;
  useEffect(() => {
    setDrafts(readManifestFields(project));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statedKey]);

  const commit = (field: EditableManifestField) => {
    if (drafts[field] === stated[field]) return;
    const next = writeManifestField(project, field, drafts[field]);
    if (next !== project.source) onSourceChange(next);
    else setDrafts(stated);
  };

  const field = (key: EditableManifestField, label: string, wide = false) => (
    <div className={`field${wide ? " sdk-details-wide" : ""}`} key={key}>
      <label htmlFor={`sdk-manifest-${key}`}>{label}</label>
      <TextInput
        id={`sdk-manifest-${key}`}
        value={drafts[key]}
        maxLength={key === "summary" ? 160 : 60}
        onChange={(event) => setDrafts((current) => ({ ...current, [key]: event.target.value }))}
        onBlur={() => commit(key)}
        onKeyDown={(event) => {
          if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );

  return (
    <section className="sdk-details" aria-label={t("sdkDetailsTitle")}>
      <h3>{t("sdkDetailsTitle")}</h3>
      <div className="sdk-details-grid">
        {field("name", t("sdkDetailsName"))}
        {field("author", t("sdkDetailsAuthor"))}
        {field("summary", t("sdkDetailsSummary"), true)}
      </div>
      <p className="field-hint">{t("sdkDetailsHint")}</p>
    </section>
  );
}

/** Everything on a node except its op and wiring, as `key=value`. */
function nodeParams(node: FlowNode): string {
  return Object.entries(node)
    .filter(([key]) => key !== "op" && key !== "in")
    .map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("  ");
}

function nodeInputs(node: FlowNode): string {
  if (node.in === undefined) return "";
  return (Array.isArray(node.in) ? node.in : [node.in]).map((index) => `#${index}`).join(", ");
}

function Meter({ label, value, limit, unit, warnAt }: {
  label: string;
  value: number;
  limit: number;
  unit?: string;
  warnAt?: number;
}) {
  const share = limit > 0 ? Math.min(value / limit, 1) : 0;
  const state = value > limit ? "over" : warnAt !== undefined && value > warnAt ? "warn" : "ok";
  return (
    <div className={`sdk-meter sdk-meter-${state}`}>
      <div className="sdk-meter-head">
        <span>{label}</span>
        <strong>
          {value.toLocaleString()}
          <small> / {limit.toLocaleString()}{unit ? ` ${unit}` : ""}</small>
        </strong>
      </div>
      <div className="sdk-meter-track" aria-hidden="true">
        <div className="sdk-meter-fill" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  );
}

function DiagnosticRow({ diagnostic, onRevealLine }: { diagnostic: Diagnostic; onRevealLine: (line: number) => void }) {
  const Icon = diagnostic.severity === "error" ? XCircle : diagnostic.severity === "warning" ? AlertTriangle : Info;
  const content = (
    <>
      <Icon size={14} strokeWidth={2} aria-hidden="true" />
      <span className="sdk-diagnostic-message">{diagnostic.message}</span>
      {diagnostic.line ? <span className="sdk-diagnostic-where">{diagnostic.line}{diagnostic.col ? `:${diagnostic.col}` : ""}</span> : null}
    </>
  );
  return diagnostic.line ? (
    <button type="button" className={`sdk-diagnostic sdk-diagnostic-${diagnostic.severity}`} onClick={() => onRevealLine(diagnostic.line ?? 1)}>
      {content}
    </button>
  ) : (
    <div className={`sdk-diagnostic sdk-diagnostic-${diagnostic.severity}`}>{content}</div>
  );
}

export function BuildPanel({ project, analysis, target, onRevealLine, onSourceChange, go }: Props) {
  const t = useAppsT();
  const { api, toast } = useStudio();
  const client = useMemo(() => appsApi(api), [api]);
  const [installPkg, setInstallPkg] = useState<AppPackage | null>(null);
  const [actionError, setActionError] = useState("");
  const appId = String(analysis.package?.manifest?.id ?? "");
  const exportAll = async () => {
    setActionError("");
    try {
      const folder = await client.exportFiles(appId, files.map(({ filename, content }) => ({ filename, content })));
      if (folder) toast("success", t("appsExported", { folder }));
    } catch (caught) {
      setActionError(errorCode(caught));
    }
  };
  const installOnDevice = async () => {
    setActionError("");
    try {
      if (!analysis.bytes) return;
      // Validated by the main process like any other package before it may reach a device.
      setInstallPkg(await client.validatePackageBytes(analysis.bytes));
    } catch (caught) {
      setActionError(errorCode(caught));
    }
  };
  const [digest, setDigest] = useState<string | null>(null);

  // The previous digest stays up while the next one is computed, and an
  // unchanged package (an edited comment, say) keeps the same string, so
  // nothing that depends on it flashes.
  useEffect(() => {
    let cancelled = false;
    if (!analysis.bytes) {
      setDigest(null);
      return undefined;
    }
    void sha256Hex(analysis.bytes).then((hex) => {
      if (!cancelled) setDigest((current) => (current === hex ? current : hex));
    });
    return () => {
      cancelled = true;
    };
  }, [analysis.bytes]);

  const files = useMemo(() => exportFiles(project, analysis), [project, analysis]);
  const errors = analysis.diagnostics.filter((d) => d.severity === "error");
  const validation = analysis.validation;
  const report = analysis.report;
  const nodes = (analysis.package?.nodes ?? []) as FlowNode[];
  const costByIndex = new Map(report?.breakdown.map((item) => [item.index, item.us]) ?? []);
  const manifestVersion = String(analysis.package?.manifest?.version ?? "");
  // Accepted by current firmware, but not by the device chosen as the board.
  const firmwareTooOld = Boolean(validation && target.firmware && compareVersions(target.firmware, validation.minOs) < 0);

  // A library app reopened here either still is the published package, or it
  // has been changed -- and a changed package must not reuse its version.
  let originNote: { tone: "success" | "warning" | "neutral"; text: string } | null = null;
  if (project.origin?.packageSha256 && digest) {
    if (digest === project.origin.packageSha256) {
      originNote = { tone: "success", text: t("sdkOriginIdentical").replace("{version}", project.origin.version) };
    } else if (manifestVersion === project.origin.version) {
      originNote = { tone: "warning", text: t("sdkOriginBumpVersion").replace("{version}", project.origin.version) };
    } else {
      originNote = { tone: "neutral", text: t("sdkOriginChanged").replace("{from}", project.origin.version).replace("{to}", manifestVersion) };
    }
  }

  return (
    <div className="sdk-panel-body">
      <ManifestDetails project={project} onSourceChange={onSourceChange} />
      <div className={`sdk-verdict ${analysis.ok ? (firmwareTooOld ? "warn" : "ok") : "fail"}`}>
        {analysis.ok ? (firmwareTooOld ? <AlertTriangle size={18} strokeWidth={2} /> : <CheckCircle2 size={18} strokeWidth={2} />) : <XCircle size={18} strokeWidth={2} />}
        <div>
          <strong>
            {analysis.ok
              ? firmwareTooOld && validation ? t("sdkVerdictOkNewer").replace("{minOs}", validation.minOs) : t("sdkVerdictOk")
              : t("sdkVerdictFail").replace("{count}", String(errors.length))}
          </strong>
          <p>{analysis.ok ? t("sdkVerdictOkDetail") : t("sdkVerdictFailDetail")}</p>
        </div>
      </div>

      {firmwareTooOld && analysis.validation && target.firmware ? (
        <p className="notice warning">
          {t("sdkFirmwareTooOld")
            .replace("{device}", target.label.split(" · ")[0] ?? "")
            .replace("{firmware}", target.firmware)
            .replace("{minOs}", analysis.validation.minOs)}
          {analysis.validation.nodes > LEGACY_MAX_NODES
            ? ` ${t("sdkFirmwareTooOldNodes").replace("{nodes}", String(analysis.validation.nodes))}`
            : ""}
        </p>
      ) : null}

      {originNote ? <p className={`notice ${originNote.tone === "neutral" ? "" : originNote.tone}`}>{originNote.text}</p> : null}

      {analysis.diagnostics.length ? (
        <section className="sdk-section">
          <h3>{t("sdkDiagnostics")}</h3>
          <div className="sdk-diagnostics">
            {analysis.diagnostics.map((diagnostic, index) => (
              <DiagnosticRow key={`${index}-${diagnostic.message}`} diagnostic={diagnostic} onRevealLine={onRevealLine} />
            ))}
          </div>
        </section>
      ) : null}

      {validation ? (
        <section className="sdk-section">
          <h3>{t("sdkLimits")}</h3>
          <div className="sdk-meters">
            {validation.kind === "flow" ? (
              <>
                <Meter label={t("sdkNodes")} value={validation.nodes} limit={MAX_NODES} warnAt={MAX_NODES - 2} />
                <Meter
                  label={t("sdkCost").replace("{cells}", String(validation.cellCount ?? ""))}
                  value={validation.estimatedUs}
                  limit={validation.budgetUs ?? DEFAULT_BUDGET_US}
                  unit="µs"
                />
                <Meter label={t("sdkWindowPool")} value={validation.windowFloats ?? 0} limit={WINDOW_POOL} unit={t("sdkFloats")} />
              </>
            ) : null}
            <Meter label={t("sdkPackageSize")} value={validation.size} limit={MAX_PACKAGE_BYTES} unit="B" warnAt={MAX_PACKAGE_BYTES * 0.85} />
          </div>
          {validation.kind === "flow" ? (
            <div className="sdk-shares">
              <span>{t("sdkShareTitle")}</span>
              {runtimeShares(60).map(({ apps, us }) => (
                <span key={apps} className={validation.estimatedUs > us ? "over" : undefined}>
                  {t("sdkShareApps").replace("{n}", String(apps))} <strong>{us} µs</strong>
                </span>
              ))}
            </div>
          ) : null}
          <details className="sdk-limits-help">
            <summary>{t("sdkLimitsHelp")}</summary>
            <dl>
              {(validation.kind === "flow"
                ? ["Nodes", "Cost", "Pool", "Size", "Share"]
                : ["Size"]
              ).map((name) => (
                <div key={name}>
                  <dt>{t(`sdkLimitsHelp${name}Title`)}</dt>
                  <dd>{t(`sdkLimitsHelp${name}`)}</dd>
                </div>
              ))}
            </dl>
          </details>
          {validation.kind === "panel" ? (
            <PanelPermissionList permissions={validation.permissions ?? []} />
          ) : null}
          <dl className="sdk-facts">
            <div><dt>{t("sdkMinOs")}</dt><dd>{validation.minOs}</dd></div>
            {validation.kind === "flow" && report ? (
              <div><dt>{t("sdkShared")}</dt><dd>{report.reused}</dd></div>
            ) : null}
            {validation.kind === "readout" || validation.kind === "panel" ? (
              <>
                <div><dt>{t("sdkSources")}</dt><dd>{validation.sources}</dd></div>
                <div><dt>{t("sdkRefresh")}</dt><dd>{validation.refreshMs} ms</dd></div>
              </>
            ) : null}
            {validation.kind === "panel" ? (
              <div><dt>{t("sdkPanelActions")}</dt><dd>{validation.actions ?? 0}</dd></div>
            ) : null}
            <div>
              <dt>{t("sdkCapabilities")}</dt>
              <dd className="sdk-chips">
                {((analysis.package?.manifest?.capabilities ?? []) as string[]).map((cap) => <span key={cap} className="sdk-chip">{cap}</span>)}
              </dd>
            </div>
            {digest ? <div><dt>sha256</dt><dd className="sdk-mono sdk-digest" title={digest}>{digest.slice(0, 16)}…</dd></div> : null}
          </dl>
        </section>
      ) : null}

      {nodes.length ? (
        <section className="sdk-section">
          <h3>{t("sdkGraph")}</h3>
          <table className="sdk-table">
            <thead>
              <tr>
                <th>#</th>
                <th>{t("sdkOp")}</th>
                <th>{t("sdkInputs")}</th>
                <th>{t("sdkParams")}</th>
                <th className="num">µs</th>
                <th className="num">{t("sdkLine")}</th>
              </tr>
            </thead>
            <tbody>
              {nodes.map((node, index) => {
                const line = report?.nodeLines[index];
                return (
                  <tr key={index}>
                    <td className="sdk-mono">{index}</td>
                    <td className="sdk-mono">{node.op}</td>
                    <td className="sdk-mono sdk-nowrap">{nodeInputs(node)}</td>
                    <td className="sdk-mono sdk-params">{nodeParams(node)}</td>
                    <td className="num sdk-mono">{costByIndex.get(index) ?? ""}</td>
                    <td className="num">
                      {line ? (
                        <button type="button" className="sdk-link" onClick={() => onRevealLine(line)}>{line}</button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="sdk-section">
        <h3>{t("sdkExport")}</h3>
        <p className="sdk-hint">{t("appsExportHint")}</p>
        {actionError ? <p className="notice error">{actionError}</p> : null}
        <div className="sdk-export">
          {files.length ? (
            <>
              <button type="button" className="button primary" onClick={() => void installOnDevice()}>
                <Cpu size={14} aria-hidden="true" />
                {t("appsInstallBuilt")}
              </button>
              <button type="button" className="button" onClick={() => void exportAll()}>
                <Download size={14} aria-hidden="true" />
                {t("appsExportFiles")}
              </button>
              <span className="sdk-hint">{files.map((file) => file.filename).join(", ")}</span>
            </>
          ) : (
            <span className="sdk-hint">{t("sdkExportBlocked")}</span>
          )}
        </div>
      </section>
      {installPkg ? <AppInstallDialog pkg={installPkg} onClose={() => setInstallPkg(null)} go={go} /> : null}
    </div>
  );
}
