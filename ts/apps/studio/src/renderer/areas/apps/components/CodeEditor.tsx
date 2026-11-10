import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { json } from "@codemirror/lang-json";
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { lintGutter, setDiagnostics } from "@codemirror/lint";
import { Compartment, EditorState, StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";

import { nhsCompletions, nhsLanguage, toCmDiagnostics } from "../lib/nhsLanguage";
import type { CompileReport, Diagnostic } from "../sdk/lib/index.mjs";

export type CodeEditorHandle = {
  /** Put the cursor on a 1-based line and scroll it into view. */
  revealLine: (line: number) => void;
  focus: () => void;
};

type Props = {
  /** Identifies the document; a new key starts a fresh editor state (and undo history). */
  docKey: string;
  value: string;
  language: "nhs" | "json";
  diagnostics: Diagnostic[];
  /** The last successful compile, for completing declared names. */
  symbols: CompileReport | null;
  /** 1-based lines to mark, e.g. the lines whose nodes just changed. */
  markedLines?: ReadonlySet<number>;
  onChange: (value: string) => void;
  ariaLabel: string;
};

// Ported from the Desktop's components/sdk/CodeEditor.tsx. Colours are the
// theme's CSS variables (apps.css defines the --apps-syntax-* ones from
// them), so a theme switch recolours the editor without rebuilding it.
const highlight = HighlightStyle.define([
  { tag: tags.comment, color: "var(--apps-syntax-comment)", fontStyle: "italic" },
  { tag: tags.keyword, color: "var(--apps-syntax-keyword)", fontWeight: "600" },
  { tag: tags.string, color: "var(--apps-syntax-string)" },
  { tag: tags.number, color: "var(--apps-syntax-number)" },
  { tag: tags.atom, color: "var(--apps-syntax-number)" },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: "var(--apps-syntax-function)" },
  { tag: tags.definition(tags.variableName), color: "var(--apps-syntax-definition)", fontWeight: "600" },
  { tag: tags.variableName, color: "var(--text)" },
  { tag: tags.operator, color: "var(--text-dim)" },
  { tag: tags.propertyName, color: "var(--apps-syntax-definition)" },
  { tag: [tags.bool, tags.null], color: "var(--apps-syntax-keyword)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--panel-solid)", color: "var(--text)" },
  ".cm-scroller": {
    fontFamily: "var(--mono)",
    lineHeight: "1.6",
  },
  ".cm-content": { padding: "10px 0" },
  ".cm-gutters": { backgroundColor: "var(--panel-soft)", color: "var(--text-muted)", border: "none" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)" },
  ".cm-activeLineGutter": { backgroundColor: "color-mix(in srgb, var(--accent) 10%, transparent)", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)",
  },
  ".cm-tooltip": { borderRadius: "8px", border: "1px solid var(--line-strong)", boxShadow: "var(--shadow-md)" },
  ".cm-tooltip-autocomplete ul li[aria-selected]": { backgroundColor: "var(--accent)", color: "var(--on-accent)" },
  ".cm-sdk-marked": { backgroundColor: "color-mix(in srgb, var(--warning) 18%, transparent)" },
});

const setMarked = StateEffect.define<ReadonlySet<number>>();

const markedField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    let next = value.map(transaction.changes);
    for (const effect of transaction.effects) {
      if (!effect.is(setMarked)) continue;
      const doc = transaction.state.doc;
      const marks = [...effect.value]
        .filter((line) => line >= 1 && line <= doc.lines)
        .sort((a, b) => a - b)
        .map((line) => Decoration.line({ class: "cm-sdk-marked" }).range(doc.line(line).from));
      next = Decoration.set(marks);
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field),
});

export const CodeEditor = forwardRef<CodeEditorHandle, Props>(function CodeEditor(
  { docKey, value, language, diagnostics, symbols, markedLines, onChange, ariaLabel },
  ref,
) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  const languageSlot = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  const symbolsRef = useRef(symbols);
  onChangeRef.current = onChange;
  symbolsRef.current = symbols;

  const languageExtension = (kind: "nhs" | "json"): Extension =>
    kind === "nhs"
      ? [nhsLanguage, autocompletion({ override: [nhsCompletions(() => symbolsRef.current)] })]
      : [json(), autocompletion()];

  const createState = (doc: string) =>
    EditorState.create({
      doc,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        lintGutter(),
        markedField,
        syntaxHighlighting(highlight),
        theme,
        languageSlot.current.of(languageExtension(language)),
        keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, ...completionKeymap, indentWithTab]),
        EditorView.contentAttributes.of({ "aria-label": ariaLabel, spellcheck: "false" }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChangeRef.current(update.state.doc.toString());
        }),
      ],
    });

  useEffect(() => {
    if (!host.current) return undefined;
    const editor = new EditorView({ parent: host.current, state: createState(value) });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // The view is created once; documents are swapped in below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switching documents replaces the whole state, so undo cannot reach back
  // into the previous project. setState() does not report a change, so the
  // new document is not echoed back as an edit.
  const shownKey = useRef(docKey);
  useEffect(() => {
    const editor = view.current;
    if (!editor || shownKey.current === docKey) return;
    shownKey.current = docKey;
    editor.setState(createState(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docKey]);

  // The same document changed from outside the editor (e.g. a reload).
  // Ordinary typing does not come back through here: the value already matches.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) {
      editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: languageSlot.current.reconfigure(languageExtension(language)) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    editor.dispatch(setDiagnostics(editor.state, toCmDiagnostics(editor.state.doc, diagnostics)));
  }, [diagnostics]);

  useEffect(() => {
    view.current?.dispatch({ effects: setMarked.of(markedLines ?? new Set()) });
  }, [markedLines]);

  useImperativeHandle(ref, () => ({
    revealLine(line: number) {
      const editor = view.current;
      if (!editor) return;
      const target = editor.state.doc.line(Math.min(Math.max(line, 1), editor.state.doc.lines));
      editor.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: "center" }) });
      editor.focus();
    },
    focus() {
      view.current?.focus();
    },
  }), []);

  return <div className="apps-editor-host" ref={host} />;
});
