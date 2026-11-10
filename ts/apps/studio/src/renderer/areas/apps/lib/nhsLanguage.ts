// Editor support for .nhs: highlighting, completion and diagnostics.
//
// Highlighting is a stream tokenizer rather than a grammar: the compiler in
// sdk/ is the only parser, and errors come from it (as diagnostics), so the
// editor never has an opinion of its own about what is valid.

import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { StreamLanguage, type StringStream } from "@codemirror/language";
import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";

import { LANGUAGE, OPS, type CompileReport, type Diagnostic } from "../sdk/lib/index.mjs";

const STATEMENTS = new Set(LANGUAGE.statements);
const KEYWORDS = new Set([...LANGUAGE.keywords, ...LANGUAGE.headerFields]);
const FUNCTIONS = new Set(LANGUAGE.functions);
const LITERAL_NAMES = new Set([...LANGUAGE.featureFields, ...LANGUAGE.colours]);

type State = { afterDeclarator: boolean };

export const nhsLanguage = StreamLanguage.define<State>({
  name: "nhs",
  startState: () => ({ afterDeclarator: false }),
  token(stream: StringStream, state: State) {
    if (stream.eatSpace()) return null;
    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^\d+\.\d+\.\d+/)) return "number";
    if (stream.match(/^\d+(?:\.\d+)?/)) return "number";
    if (stream.match("..")) return "operator";
    const word = stream.match(/^[A-Za-z_][A-Za-z0-9_.-]*/) as RegExpMatchArray | null;
    if (word) {
      const text = word[0];
      if (state.afterDeclarator) {
        state.afterDeclarator = false;
        return "variableName.definition";
      }
      if (STATEMENTS.has(text)) {
        // The word after `region`, `signal`, `event` and `emit` names
        // something; after `app` it names the app. `show`, `bar` and `pixel`
        // start with a number and `meter` with an expression, so their first
        // word is a value, not a name.
        state.afterDeclarator = !["led", "gate", "show", "bar", "pixel", "meter"].includes(text);
        return "keyword";
      }
      if (KEYWORDS.has(text)) return "keyword";
      if (FUNCTIONS.has(text) && stream.peek() === "(") return "variableName.function";
      if (LITERAL_NAMES.has(text)) return "atom";
      return "variableName";
    }
    if (stream.match(/^(<=|>=|[<>=+\-*/%])/)) return "operator";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "#" } },
});

const FUNCTION_DOCS: Record<string, { args: string; info: string }> = {
  sum: { args: "(region)", info: "Total load over a region." },
  total: { args: "()", info: OPS.total!.summary },
  peak: { args: "() or (region)", info: `${OPS.peak!.summary} With a region: ${OPS.region_peak!.summary}` },
  active: { args: "(level) or (region, level)", info: `${OPS.active_cells!.summary} With a region: ${OPS.region_active!.summary}` },
  feature: { args: "(field)", info: "One field of a single features sweep; every feature() shares it." },
  arg_max: { args: "()", info: OPS.arg_max!.summary },
  row_centroid: { args: "() or (region)", info: OPS.row_centroid!.summary },
  col_centroid: { args: "() or (region)", info: OPS.col_centroid!.summary },
  mean: { args: "(x, frames)", info: OPS.mean!.summary },
  max_hold: { args: "(x, frames)", info: OPS.max_hold!.summary },
  integrate: { args: "(x, frames)", info: OPS.integrate!.summary },
  delta: { args: "(x)", info: OPS.delta!.summary },
  abs: { args: "(x)", info: OPS.abs!.summary },
  counter: { args: "(event) or (event, reset)", info: `${OPS.counter!.summary} With a reset: ${OPS.counter_reset!.summary}` },
  min: { args: "(a, b)", info: OPS.min!.summary },
  max: { args: "(a, b)", info: OPS.max!.summary },
  clamp: { args: "(x, lo, hi)", info: OPS.clamp!.summary },
  budget_load: { args: "()", info: OPS.budget_load!.summary },
  grace_left: { args: "()", info: OPS.grace_left!.summary },
  button: { args: "()", info: OPS.button!.summary },
  not: { args: "(event)", info: OPS.not!.summary },
  select: { args: "(event, a, b)", info: OPS.select!.summary },
  duration: { args: "(event)", info: OPS.duration!.summary },
  interval: { args: "(event)", info: OPS.interval!.summary },
  peak_since: { args: "(x, event)", info: OPS.peak_since!.summary },
  sqrt: { args: "(x)", info: OPS.sqrt!.summary },
  atan2: { args: "(y, x)", info: OPS.atan2!.summary },
  imu: { args: "(field)", info: OPS.imu!.summary },
  mag: { args: "(field)", info: OPS.mag!.summary },
  battery: { args: "()", info: OPS.battery!.summary },
  linked: { args: "()", info: OPS.linked!.summary },
  uptime: { args: "()", info: OPS.uptime!.summary },
};

export function functionDoc(name: string) {
  return FUNCTION_DOCS[name];
}

/**
 * The shape of every statement, as the compiler's grammar accepts it. Shown in
 * Studio's Reference tab and quoted in its AI prompt.
 */
export const STATEMENT_FORMS: readonly (readonly [statement: string, form: string])[] = [
  ["app", 'app <id> { name "…"  version 1.0.0  author you  summary "…"  [category <word>]  [icon <word>]  [background yes] }'],
  ["region", "region <name> = rows <a>..<b>, cols <c>..<d>"],
  ["region", "region <name> = rows <a>%..<b>%, cols <c>%..<d>%"],
  ["signal", "signal <name> = <expression> [persist]"],
  ["event", "event <name> when <expression> > <number> [hyst <n>] [for <n>ms]"],
  ["event", "event <name> when <event expression> [for <n>ms]"],
  ["emit", "emit <name> value <expression> on rise(<event>)"],
  ["emit", "emit <name> value <expression> on fall(<event>)"],
  ["led", "led <colour> when <event>"],
  ["show", 'show <row> "<label>" <expression> [digits <n>]'],
  ["bar", 'bar <row> "<label>" <expression> range <lo>..<hi>'],
  ["pixel", "pixel <index> <colour> when <event>"],
  ["meter", "meter <expression> range <lo>..<hi>"],
  ["gate", "gate (<expression> < <number>) { signal / event / emit / led / show / bar / pixel / meter … }"],
];

/**
 * Completion for .nhs. `symbols` is the last successful compile report, so
 * the names an author has declared are offered alongside the language's own.
 */
export function nhsCompletions(symbols: () => CompileReport | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const word = context.matchBefore(/[A-Za-z_][A-Za-z0-9_]*/);
    if (!word && !context.explicit) return null;
    const from = word ? word.from : context.pos;
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const report = symbols();

    const options: Completion[] = [];
    // At the start of a line, only a statement makes sense.
    if (/^\s*[A-Za-z_]*$/.test(before)) {
      for (const statement of LANGUAGE.statements) options.push({ label: statement, type: "keyword" });
    }
    if (/\bled\s+[A-Za-z_]*$/.test(before)) {
      return { from, options: LANGUAGE.colours.map((colour) => ({ label: colour, type: "constant" })) };
    }
    if (/\bfeature\(\s*[A-Za-z_]*$/.test(before)) {
      return { from, options: LANGUAGE.featureFields.map((field) => ({ label: field, type: "constant" })) };
    }
    if (/\bimu\(\s*[A-Za-z_]*$/.test(before)) {
      return { from, options: LANGUAGE.imuFields.map((field) => ({ label: field, type: "constant" })) };
    }
    if (/\bmag\(\s*[A-Za-z_]*$/.test(before)) {
      return { from, options: LANGUAGE.magFields.map((field) => ({ label: field, type: "constant" })) };
    }
    if (/\b(?:sum|peak|row_centroid|col_centroid)\(\s*[A-Za-z_]*$/.test(before)) {
      return { from, options: Object.keys(report?.regions ?? {}).map((name) => ({ label: name, type: "variable", detail: "region" })) };
    }
    if (/\b(?:rise\(|fall\(|when)\s*[A-Za-z_]*$/.test(before) && /\b(?:led|emit|pixel)\b/.test(before)) {
      return { from, options: Object.keys(report?.events ?? {}).map((name) => ({ label: name, type: "variable", detail: "event" })) };
    }
    for (const keyword of LANGUAGE.keywords) options.push({ label: keyword, type: "keyword" });
    for (const name of LANGUAGE.functions) {
      const doc = FUNCTION_DOCS[name];
      options.push({ label: name, type: "function", detail: doc?.args, info: doc?.info, apply: `${name}(` });
    }
    for (const name of Object.keys(report?.signals ?? {})) options.push({ label: name, type: "variable", detail: "signal" });
    for (const name of Object.keys(report?.regions ?? {})) options.push({ label: name, type: "variable", detail: "region" });
    return { from, options, validFor: /^[A-Za-z0-9_]*$/ };
  };
}

/** SDK diagnostics as CodeMirror ones: 1-based line/col to document offsets. */
export function toCmDiagnostics(doc: Text, diagnostics: Diagnostic[]): CmDiagnostic[] {
  return diagnostics.map((diagnostic) => {
    const lineNumber = Math.min(Math.max(diagnostic.line ?? 1, 1), doc.lines);
    const line = doc.line(lineNumber);
    let from = line.from;
    let to = line.to;
    if (diagnostic.line && diagnostic.col) {
      from = Math.min(line.from + diagnostic.col - 1, line.to);
      to = diagnostic.endCol ? Math.min(line.from + diagnostic.endCol - 1, line.to) : from;
      if (to <= from) to = Math.min(from + 1, line.to);
    }
    return {
      from,
      to: Math.max(to, from),
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.code ?? undefined,
    };
  });
}
