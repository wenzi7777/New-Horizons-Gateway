// Ported from the Desktop's components/sdk/AiPromptDialog.tsx.
import { useEffect, useMemo, useState } from "react";
import { Copy, X } from "lucide-react";

import { copyText } from "../lib/clipboard";
import { useAppsT } from "../strings";
import { buildAiPrompt, type PromptDiagnostic } from "../lib/sdkPrompt";
import type { MatrixTarget, SdkKind } from "../lib/sdkProject";

type Props = {
  kind: SdkKind;
  target: MatrixTarget;
  source: string;
  diagnostics: readonly PromptDiagnostic[];
  author: string;
  request: string;
  onRequestChange: (request: string) => void;
  /** Off when the editor still holds the untouched template. */
  defaultIncludeCurrent: boolean;
  onClose: () => void;
};

// Builds a prompt for an external AI assistant and copies it. Nothing leaves
// the page except through the author's own clipboard.
export function AiPromptDialog({ kind, target, source, diagnostics, author, request, onRequestChange, defaultIncludeCurrent, onClose }: Props) {
  const t = useAppsT();
  const [includeCurrent, setIncludeCurrent] = useState(defaultIncludeCurrent);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const prompt = useMemo(
    () => buildAiPrompt({ kind, request, board: target, includeCurrent, source, diagnostics, author }),
    [kind, request, target, includeCurrent, source, diagnostics, author],
  );
  useEffect(() => { setCopyState("idle"); }, [prompt]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const copy = () => {
    copyText(prompt)
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("failed"));
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal-panel apps-dialog wide" role="dialog" aria-modal="true" aria-labelledby="sdk-ai-prompt-title">
        <header className="apps-dialog-head">
          <h3 id="sdk-ai-prompt-title">{t("sdkAiPrompt")}</h3>
          <button type="button" className="button ghost icon-button" onClick={onClose} aria-label={t("sdkClose")}>
            <X size={16} strokeWidth={2} />
          </button>
        </header>
        <p className="sdk-hint">{t("sdkAiPromptIntro")}</p>

        <dl className="sdk-facts">
          <div><dt>{t("sdkAiPromptKind")}</dt><dd>{kind === "flow" ? t("sdkAiPromptKindFlow") : kind === "panel" ? t("sdkAiPromptKindPanel") : t("sdkAiPromptKindReadout")}</dd></div>
          <div><dt>{t("sdkTarget")}</dt><dd>{target.label}</dd></div>
        </dl>

        <div className="field">
          <label htmlFor="sdk-ai-prompt-request">{t("sdkAiPromptRequest")}</label>
          <textarea
            id="sdk-ai-prompt-request"
            className="sdk-ai-prompt-request"
            value={request}
            placeholder={kind === "flow" ? t("sdkAiPromptPlaceholderFlow") : kind === "panel" ? t("sdkAiPromptPlaceholderPanel") : t("sdkAiPromptPlaceholderReadout")}
            onChange={(event) => onRequestChange(event.target.value)}
            autoFocus
          />
        </div>

        <label className="apps-check">
          <input type="checkbox" checked={includeCurrent} onChange={(event) => setIncludeCurrent(event.target.checked)} />
          <span>{t("sdkAiPromptIncludeCurrent")}</span>
        </label>

        <div className="sdk-ai-prompt-actions">
          <span className="sdk-hint">{t("sdkAiPromptChars", { count: prompt.length.toLocaleString() })}</span>
          {copyState === "copied" ? <span className="sdk-hint" role="status">{t("copied")}</span> : null}
          {copyState === "failed" ? <span className="notice error" role="alert">{t("copyFailed")}</span> : null}
          <button type="button" className="button primary" onClick={copy}>
            <Copy size={14} strokeWidth={2} />{t("sdkAiPromptCopy")}
          </button>
        </div>
        <p className="sdk-hint">{t("sdkAiPromptHint")}</p>
      </div>
    </div>
  );
}
