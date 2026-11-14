// Editor support for app.ts: highlighting, completion, diagnostics and the
// API reference.
//
// Highlighting is a stream tokenizer rather than a grammar: the compiler in
// sdk/ is the only parser, and errors come from it (as diagnostics), so the
// editor never has an opinion of its own about what is valid. The API itself
// -- names, signatures, what each does -- is read from the SDK's nhos.d.ts,
// the same file an author's own editor type-checks against.

import type { CompletionContext, CompletionResult, Completion } from "@codemirror/autocomplete";
import { StreamLanguage, type StringStream } from "@codemirror/language";
import type { Diagnostic as CmDiagnostic } from "@codemirror/lint";
import type { Text } from "@codemirror/state";

import { LANGUAGE, type CompileReport, type Diagnostic } from "../sdk/lib/index.mjs";
import nhosTypes from "../sdk/types/nhos.d.ts?raw";

const KEYWORDS = new Set(LANGUAGE.keywords);
const GLOBALS = new Set(LANGUAGE.globals);
const CLASSES = new Set(LANGUAGE.classes);

type State = { inComment: boolean; afterDot: boolean; afterDeclarator: boolean };

export const appLanguage = StreamLanguage.define<State>({
  name: "nhos-ts",
  startState: () => ({ inComment: false, afterDot: false, afterDeclarator: false }),
  token(stream: StringStream, state: State) {
    if (state.inComment) {
      if (stream.skipTo("*/")) {
        stream.match("*/");
        state.inComment = false;
      } else {
        stream.skipToEnd();
      }
      return "comment";
    }
    if (stream.eatSpace()) return null;
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      state.inComment = true;
      return "comment";
    }
    const afterDot = state.afterDot;
    state.afterDot = false;
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/) || stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
    if (stream.match(/^0[xX][0-9a-fA-F]+/) || stream.match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/)) return "number";
    const word = stream.match(/^[A-Za-z_$][A-Za-z0-9_$]*/) as RegExpMatchArray | null;
    if (word) {
      const text = word[0];
      const call = stream.peek() === "(";
      if (afterDot) return call ? "propertyName.function" : "propertyName";
      if (state.afterDeclarator) {
        state.afterDeclarator = false;
        return call ? "variableName.function.definition" : "variableName.definition";
      }
      if (text === "true" || text === "false") return "bool";
      if (KEYWORDS.has(text)) {
        state.afterDeclarator = text === "const" || text === "let" || text === "function";
        return "keyword";
      }
      if (CLASSES.has(text)) return "typeName";
      if (GLOBALS.has(text)) return call ? "variableName.function" : "variableName.standard";
      return call ? "variableName.function" : "variableName";
    }
    if (stream.match(".")) {
      state.afterDot = true;
      return "punctuation";
    }
    if (stream.match(/^(===|!==|=>|<=|>=|&&|\|\||\+\+|--|[+\-*/%]=|[<>=!+\-*/%&|^~?:])/)) return "operator";
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "//", block: { open: "/*", close: "*/" } } },
});

// --- the API, read from nhos.d.ts ----------------------------------------------

export type ApiEntry = {
  /** what completion offers: `store.append`, `Threshold`, `on` */
  name: string;
  /** the declaration as an author writes the call */
  signature: string;
  doc: string;
  /** asks the operator's consent at install */
  ask: boolean;
};

export type ApiSection = { title: string; entries: ApiEntry[] };

function cleanDoc(lines: string[]): string {
  return lines
    .map((line) => line.replace(/^\s*\/\*\*?/, "").replace(/\*\/\s*$/, "").replace(/^\s*\*\s?/, "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function tidy(signature: string): string {
  return signature.replace(/^declare\s+(?:const\s+enum|function|const|class|var)\s+/, "").replace(/;\s*$/, "").replace(/\s+/g, " ").trim();
}

type Owner = { name: string; doc: string; isClass: boolean };

/** One line (or `;`-separated piece) of a declaration's body as entries. */
function members(section: ApiSection, owner: Owner, text: string, doc: string) {
  const ask = /\[ask\]/.test(owner.doc + doc);
  const constructor = /^constructor(\(.*\));?$/.exec(text);
  if (constructor) {
    section.entries.push({
      name: owner.name,
      signature: `new ${owner.name}${constructor[1]}`,
      doc: [owner.doc, doc].filter(Boolean).join(" "),
      ask,
    });
    return;
  }
  // `readonly ax: number; readonly ay: number;` declares several fields.
  const parts = text.includes("(") ? [text] : text.split(";").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    const member = /^(?:readonly\s+)?([A-Za-z_]\w*)/.exec(part);
    if (!member) continue;
    section.entries.push({
      name: `${owner.name}.${member[1]}`,
      signature: `${owner.name}.${tidy(part.replace(/^readonly\s+/, ""))}`,
      doc: doc.replace(/\[ask\]\s*/g, ""),
      ask,
    });
  }
}

/**
 * The declarations of nhos.d.ts, grouped by its `// --- section ---` headers.
 * The first section (the cut-down TypeScript library) is left out: it is
 * there for the type checker, not for authors.
 */
export function parseApiReference(text: string): ApiSection[] {
  const sections: ApiSection[] = [];
  let section: ApiSection | null = null;
  let skip = true;
  let doc: string[] = [];
  let inDoc = false;
  let container: Owner | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = (lines[i] ?? "").trim();
    const header = /^\/\/ --- (.+?) -+\s*$/.exec(trimmed);
    if (header) {
      const title = header[1] ?? "";
      skip = /typescript library/i.test(title);
      section = skip ? null : { title, entries: [] };
      if (section) sections.push(section);
      doc = [];
      continue;
    }
    if (skip || !section) continue;
    if (inDoc || trimmed.startsWith("/**")) {
      doc.push(trimmed);
      inDoc = !trimmed.endsWith("*/");
      continue;
    }
    if (!trimmed || trimmed.startsWith("//")) continue;
    const docText = cleanDoc(doc);
    doc = [];
    if (container) {
      if (/^}/.test(trimmed)) {
        container = null;
        continue;
      }
      members(section, container, trimmed, docText);
      continue;
    }
    // A declaration whose members sit on the same line.
    const inline = /^declare\s+(const(?!\s+enum)|class)\s+([A-Za-z_]\w*)[^{]*\{(.*)\}\s*;?\s*$/.exec(trimmed);
    if (inline) {
      const owner: Owner = { name: inline[2] ?? "", doc: docText, isClass: inline[1] === "class" };
      if (!owner.isClass && docText) section.entries.push({ name: owner.name, signature: owner.name, doc: docText.replace(/\[ask\]\s*/g, ""), ask: /\[ask\]/.test(docText) });
      for (const part of (inline[3] ?? "").split(";").map((item) => item.trim()).filter(Boolean)) members(section, owner, part, "");
      continue;
    }
    // A declaration whose members follow, one or more per line.
    const open = /^declare\s+(const(?!\s+enum)|class)\s+([A-Za-z_]\w*)[^{]*\{\s*$/.exec(trimmed);
    if (open) {
      const owner: Owner = { name: open[2] ?? "", doc: docText, isClass: open[1] === "class" };
      container = owner;
      if (!owner.isClass && docText) section.entries.push({ name: owner.name, signature: owner.name, doc: docText.replace(/\[ask\]\s*/g, ""), ask: /\[ask\]/.test(docText) });
      continue;
    }
    // A declaration that spans lines but has no member body (a long type).
    let declaration = trimmed;
    while (!/[;}]\s*$/.test(declaration) && i + 1 < lines.length) {
      i += 1;
      declaration += ` ${(lines[i] ?? "").trim()}`;
    }
    const name = /^(?:declare\s+(?:const\s+enum|function|const|class|var)|type)\s+([A-Za-z_]\w*)/.exec(declaration)?.[1];
    if (!name) continue;
    section.entries.push({
      name,
      signature: tidy(declaration),
      doc: docText.replace(/\[ask\]\s*/g, ""),
      ask: /\[ask\]/.test(docText),
    });
    // An enum's members complete after its name: Color.Red, ...
    const enumBody = /^declare\s+const\s+enum\s+\w+\s*\{(.*)\}/.exec(declaration)?.[1];
    for (const member of enumBody?.split(",") ?? []) {
      const memberName = /^\s*([A-Za-z_]\w*)/.exec(member)?.[1];
      if (memberName) section.entries.push({ name: `${name}.${memberName}`, signature: `${name}.${memberName}`, doc: "", ask: false });
    }
  }
  return sections.filter((entry) => entry.entries.length > 0);
}

export const API_REFERENCE: readonly ApiSection[] = parseApiReference(nhosTypes);

const API_BY_NAME = new Map<string, ApiEntry>();
for (const section of API_REFERENCE) {
  for (const entry of section.entries) if (!API_BY_NAME.has(entry.name)) API_BY_NAME.set(entry.name, entry);
}

export function apiEntry(name: string): ApiEntry | undefined {
  return API_BY_NAME.get(name);
}

// --- completion ------------------------------------------------------------------

function memberOptions(owner: string): Completion[] {
  return (LANGUAGE.members[owner] ?? []).map((member) => {
    const entry = apiEntry(`${owner}.${member}`);
    const call = entry ? /^[^:(]*\(/.test(entry.signature.slice(owner.length + 1)) : false;
    return {
      label: member,
      type: call ? "method" : owner === "Color" ? "constant" : "property",
      detail: entry ? entry.signature.slice(owner.length + 1 + member.length) : undefined,
      info: entry?.doc || undefined,
      apply: call ? `${member}(` : member,
    };
  });
}

/**
 * Completion for app.ts. `symbols` is the last successful compile report: the
 * stateful objects it names complete their class's members after a dot.
 */
export function appCompletions(symbols: () => CompileReport | null) {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const report = symbols();

    // Inside a string: an event name or a setting.
    const quoted = /(\bon|\bconfigGet|\bconfigSet)\(\s*["']([A-Za-z_.]*)$/.exec(before);
    if (quoted) {
      const from = context.pos - (quoted[2] ?? "").length;
      const values = quoted[1] === "on" ? LANGUAGE.events : LANGUAGE.deviceConfigKeys;
      return { from, options: values.map((value) => ({ label: value, type: "constant" })), validFor: /^[A-Za-z_.]*$/ };
    }

    const dotted = /([A-Za-z_]\w*)\.(\w*)$/.exec(before);
    if (dotted) {
      const from = context.pos - (dotted[2] ?? "").length;
      let owner = dotted[1] ?? "";
      if (!LANGUAGE.members[owner]) {
        const symbol = report?.symbols.find((entry) => entry.name === owner);
        if (!symbol) return null;
        owner = symbol.kind;
      }
      const options = memberOptions(owner);
      return options.length ? { from, options, validFor: /^\w*$/ } : null;
    }

    const word = context.matchBefore(/[A-Za-z_]\w*/);
    if (!word && !context.explicit) return null;
    const from = word ? word.from : context.pos;
    const options: Completion[] = [];
    for (const keyword of LANGUAGE.keywords) options.push({ label: keyword, type: "keyword" });
    for (const name of LANGUAGE.globals) {
      const entry = apiEntry(name);
      const call = entry ? /^\w+\s*\(/.test(entry.signature) : false;
      options.push({
        label: name,
        type: call ? "function" : "namespace",
        detail: call && entry ? entry.signature.slice(name.length) : undefined,
        info: entry?.doc || undefined,
        apply: call ? `${name}(` : name,
      });
    }
    for (const name of LANGUAGE.classes) {
      const entry = apiEntry(name);
      options.push({ label: name, type: "class", detail: entry?.signature, info: entry?.doc || undefined });
    }
    for (const symbol of report?.symbols ?? []) options.push({ label: symbol.name, type: "variable", detail: symbol.kind });
    return { from, options, validFor: /^\w*$/ };
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
