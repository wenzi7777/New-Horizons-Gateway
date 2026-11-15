// @ts-check
/**
 * Compile an app.ts source into a .nha package carrying an NHVM/1 image.
 *
 * The language is a subset of TypeScript: every app.ts is a valid TypeScript
 * file against sdk/types/nhos.d.ts, so an editor gives completion and type
 * errors for free, and this compiler only has to accept what the device can
 * run. What it accepts (docs/authoring.md):
 *
 *   - top level: `export const manifest = {...}`, `const`/`let` numbers and
 *     booleans, `const x = new Float32Array(n)`, stateful objects
 *     (`const press = new Debounce(20)`), regions, `function`s, and
 *     `on(event, handler)`;
 *   - in functions: `let`/`const`, `if`/`else`, `while`, `for (;;)`,
 *     `break`/`continue`/`return`, `? :`, `&&`/`||` (short-circuit),
 *     `=`, `+=` and friends, `++`/`--`, calls;
 *   - values are numbers (float32 on the device) and booleans (0/1); strings
 *     only as constant names and labels.
 *
 * Stateful objects are created at the top level only, so each owns a fixed
 * piece of the arena; a call such as `matrix.total()` or `oled.text(...)`
 * owns one per place in the source. Nothing is allocated while running.
 */

import {
  CAPABILITY_SINCE,
  DANGEROUS_CAPABILITIES,
  FEATURE_FIELDS,
  IMU_FIELDS,
  LED_COLOURS,
  MAG_FIELDS,
  MAX_DEBOUNCE_MS,
  MAX_EVENT_NAME,
  MAX_EXT_LEDS,
  MAX_OLED_DIGITS,
  MAX_OLED_LABEL,
  MAX_REGION_INDEX,
  MAX_REL_PERCENT,
  MAX_WINDOW,
  DEFAULT_CELL_COUNT,
  OLED_LABEL_RE,
  OLED_ROWS,
  OPS,
  REL_COLS,
  REL_ROWS,
  compareVersions,
  appMemoryBytes,
} from "./opset.mjs";
import { Assembler, I2C_DENIED, VmImageError, encodeImage, toBase64, verifyImage } from "./vm.mjs";
import {
  NATIVE_LAYOUT,
  VM_DEVICE_CONFIG_KEYS,
  VM_EVENTS,
  VM_MAX_ARENA,
  VM_MAX_CODE,
  VM_MAX_CONSTS,
  VM_MAX_FUNCTIONS,
  VM_MAX_NODES,
  VM_MAX_STACK,
  VM_MAX_STRING,
  VM_MAX_STRINGS,
  VM_STORE_FILE_RE,
  VM_STORE_MAX_KEYS,
  VM_SYSCALLS,
  VM_TS_MIN_OS,
  flowOpNumber,
} from "./vmset.mjs";

const f32 = Math.fround;

/** An error at a place in the source. `line`/`col` are 1-based; either may be null. */
export class CompileError extends Error {
  /**
   * @param {string} reason
   * @param {number|null} [line]
   * @param {number|null} [col]
   * @param {number|null} [endCol]
   */
  constructor(reason, line = null, col = null, endCol = null) {
    super(line ? `line ${line}: ${reason}` : reason);
    this.name = "CompileError";
    this.reason = reason;
    this.line = line;
    this.col = col;
    this.endCol = endCol;
  }
}

// --- the language, for editors -------------------------------------------------

/** Handler events `on()` accepts, and the VM entry each one is. */
const HANDLER_EVENTS = Object.freeze({
  start: "start",
  frame: "frame",
  tick: "tick",
  idle: "idle_tick",
  button: "button",
  message: "message",
  stop: "stop",
});

/** Capability a handler needs to be woken at all. */
const HANDLER_CAPS = Object.freeze({ frame: "read_matrix", tick: "tick", idle: "tick", button: "button", message: "app_ipc" });

/**
 * Classes an app may construct at the top level. `op` is the native operator
 * behind `update()`; `params` maps constructor arguments onto its parameters.
 */
const CLASSES = Object.freeze({
  Threshold: { op: "threshold", inputs: 1, boolean: true },
  Debounce: { op: "debounce", inputs: 1, boolean: true },
  Mean: { op: "mean", inputs: 1, boolean: false },
  MaxHold: { op: "max_hold", inputs: 1, boolean: false },
  Integrate: { op: "integrate", inputs: 1, boolean: false },
  Delta: { op: "delta", inputs: 1, boolean: false },
  Counter: { op: "counter", inputs: 1, boolean: false },
  Duration: { op: "duration", inputs: 1, boolean: false },
  Interval: { op: "interval", inputs: 1, boolean: false },
  PeakSince: { op: "peak_since", inputs: 2, boolean: false },
  Features: { op: "features", inputs: 0, boolean: false },
  Edge: { op: null, inputs: 1, boolean: true },
});

/** Features fields by property name. */
const FEATURE_PROPS = Object.freeze(Object.fromEntries(FEATURE_FIELDS.map((name, i) => [camelCase(name), i])));
const IMU_PROPS = Object.freeze(Object.fromEntries(IMU_FIELDS.map((name, i) => [camelCase(name), i])));
const MAG_PROPS = Object.freeze({ x: 0, y: 1, z: 2, strength: 3, heading: 4 });
const COLOURS = Object.freeze(Object.fromEntries(Object.keys(LED_COLOURS).map((name) => [name[0].toUpperCase() + name.slice(1), name])));

/** @param {string} name */
function camelCase(name) {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}

/** What editors complete and highlight. */
export const LANGUAGE = Object.freeze({
  name: "NHOS TypeScript",
  extension: ".ts",
  keywords: ["const", "let", "function", "if", "else", "while", "for", "break", "continue", "return", "new", "true", "false", "export", "as"],
  events: Object.keys(HANDLER_EVENTS),
  globals: ["on", "emit", "event", "log", "clamp", "atan2deg", "battery", "linked", "uptime", "now", "frameSeq",
    "matrix", "imu", "mag", "led", "strip", "oled", "button", "budget", "store", "app", "device", "i2c", "uart", "Math", "Color"],
  classes: [...Object.keys(CLASSES), "Region", "Float32Array"],
  members: {
    matrix: ["total", "peak", "activeCells", "argMax", "rowCentroid", "colCentroid", "cell", "rows", "cols"],
    imu: Object.keys(IMU_PROPS),
    mag: Object.keys(MAG_PROPS),
    led: ["set"],
    strip: ["pixel", "meter"],
    oled: ["text", "bar"],
    button: ["pressed"],
    budget: ["load", "graceLeft"],
    store: ["get", "set", "append", "clear"],
    app: ["publish"],
    device: ["configGet", "configSet", "stream"],
    i2c: ["read8", "read16", "write8", "read", "write"],
    uart: ["open", "close", "write", "writeBytes", "available", "read"],
    Math: ["abs", "sqrt", "floor", "ceil", "round", "min", "max", "PI"],
    Color: Object.keys(COLOURS),
    Region: ["sum", "peak", "active", "rowCentroid", "colCentroid"],
    Features: ["update", "value", ...Object.keys(FEATURE_PROPS)],
  },
  featureFields: Object.keys(FEATURE_PROPS),
  deviceConfigKeys: VM_DEVICE_CONFIG_KEYS,
});

/** Natives whose value depends only on the frame and sensors (see native()). */
const SHARED_READINGS = new Set([
  "total", "peak", "active_cells", "arg_max", "row_centroid", "col_centroid",
  "region_sum", "region_peak", "region_active", "region_row_centroid", "region_col_centroid",
  "imu", "mag", "battery", "linked", "uptime", "budget_load", "grace_left",
]);

// --- lexer -------------------------------------------------------------------

/**
 * @typedef {object} Token
 * @property {"name"|"number"|"string"|"punct"|"eof"} kind
 * @property {string} text
 * @property {number|string} [value] a number's or string's value
 * @property {number} line 1-based
 * @property {number} col 1-based column of the first character
 * @property {number} endCol 1-based column just past the last character
 */

const PUNCTUATORS = [
  ">>>=", "===", "!==", ">>>", "<<=", ">>=", "...", "**=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<", ">>", "**",
  "{", "}", "(", ")", "[", "]", ";", ",", ".", ":", "?", "<", ">", "+", "-", "*", "/", "%", "!", "~", "&", "|", "^", "=", "@", "#",
];
const NUMBER_RE = /^(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d+)?)/;
const NAME_RE = /^[A-Za-z_$][\w$]*/;

/**
 * @param {string} source
 * @returns {Token[]}
 */
export function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (/** @type {number} */ n) => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === "\n") {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      advance(1);
      continue;
    }
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      advance((end < 0 ? source.length : end) - i);
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new CompileError("unterminated comment", line, col);
      advance(end + 2 - i);
      continue;
    }
    const startLine = line;
    const startCol = col;
    /** @param {Token["kind"]} kind @param {string} text @param {number|string} [value] */
    const push = (kind, text, value) => {
      advance(text.length);
      /** @type {Token} */
      const token = { kind, text, line: startLine, col: startCol, endCol: startCol + text.length };
      if (value !== undefined) token.value = value;
      tokens.push(token);
    };
    if (ch === "\"" || ch === "'") {
      let j = i + 1;
      let value = "";
      for (;;) {
        if (j >= source.length || source[j] === "\n") throw new CompileError("unterminated string", startLine, startCol);
        const c = source[j];
        if (c === ch) break;
        if (c === "\\") {
          const e = source[j + 1];
          const map = { n: "\n", t: "\t", r: "\r", "\\": "\\", "\"": "\"", "'": "'", "0": "\0" };
          if (!(e in map)) throw new CompileError(`unsupported escape \\${e}`, startLine, startCol + (j - i));
          value += map[/** @type {keyof typeof map} */ (e)];
          j += 2;
        } else {
          value += c;
          j += 1;
        }
      }
      push("string", source.slice(i, j + 1), value);
      continue;
    }
    if (ch === "`") throw new CompileError("template strings are not supported; use a plain string", line, col);
    const rest = source.slice(i, i + 64);
    const number = NUMBER_RE.exec(rest);
    if (number && /[\d.]/.test(ch) && !(ch === "." && !/\d/.test(source[i + 1] ?? ""))) {
      const text = number[0];
      const clean = text.replace(/_/g, "");
      const value = /^0[bB]/.test(clean) ? Number.parseInt(clean.slice(2), 2) : Number(clean);
      if (!Number.isFinite(value)) throw new CompileError(`invalid number ${text}`, line, col);
      push("number", text, value);
      continue;
    }
    const name = NAME_RE.exec(rest);
    if (name) {
      push("name", name[0]);
      continue;
    }
    const punct = PUNCTUATORS.find((p) => source.startsWith(p, i));
    if (punct) {
      push("punct", punct);
      continue;
    }
    throw new CompileError(`unexpected character '${ch}'`, line, col);
  }
  tokens.push({ kind: "eof", text: "", line, col, endCol: col });
  return tokens;
}

// --- parser ------------------------------------------------------------------

/** @typedef {{type: string, line: number, col: number, endCol: number, [key: string]: any}} Node */

const RESERVED = new Set([
  "const", "let", "var", "function", "if", "else", "while", "for", "do", "break", "continue", "return", "new",
  "true", "false", "export", "import", "class", "switch", "case", "default", "try", "catch", "throw", "typeof",
  "void", "null", "undefined", "this", "delete", "in", "of", "instanceof", "yield", "await", "async", "enum",
]);

/** Binary operator precedence; higher binds tighter. */
const PRECEDENCE = Object.freeze({
  "??": 1, "||": 2, "&&": 3, "|": 4, "^": 5, "&": 6,
  "==": 7, "!=": 7, "===": 7, "!==": 7,
  "<": 8, ">": 8, "<=": 8, ">=": 8,
  "<<": 9, ">>": 9, ">>>": 9,
  "+": 10, "-": 10, "*": 11, "/": 11, "%": 11, "**": 12,
});
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>=", ">>>="]);

class Parser {
  /** @param {Token[]} tokens */
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  get tok() {
    return this.tokens[this.pos];
  }

  /** @param {number} n */
  peek(n = 1) {
    return this.tokens[Math.min(this.pos + n, this.tokens.length - 1)];
  }

  take() {
    const token = this.tok;
    if (token.kind !== "eof") this.pos += 1;
    return token;
  }

  /** @param {string} text @param {Token} [token] */
  is(text, token = this.tok) {
    return (token.kind === "punct" || token.kind === "name") && token.text === text;
  }

  /** @param {string} text */
  accept(text) {
    if (this.is(text)) return this.take();
    return null;
  }

  /** @param {string} text */
  expect(text) {
    if (!this.is(text)) throw this.fail(`expected '${text}', found ${describe(this.tok)}`);
    return this.take();
  }

  expectName() {
    const token = this.tok;
    if (token.kind !== "name" || RESERVED.has(token.text)) throw this.fail(`expected a name, found ${describe(token)}`);
    return this.take();
  }

  /** @param {string} reason @param {Token|Node} [at] */
  fail(reason, at = this.tok) {
    return new CompileError(reason, at.line, at.col, at.endCol);
  }

  /** @param {string} type @param {Token|Node} at @param {Record<string, any>} [fields] @returns {Node} */
  node(type, at, fields = {}) {
    return { type, line: at.line, col: at.col, endCol: at.endCol, ...fields };
  }

  semicolon() {
    this.accept(";");
  }

  // -- program --

  parseProgram() {
    /** @type {Node[]} */
    const body = [];
    while (this.tok.kind !== "eof") {
      const start = this.tok;
      if (this.accept(";")) continue;
      if (this.is("import")) throw this.fail("imports are not needed: nhos.d.ts declares the whole API");
      if (this.accept("export")) {
        if (!this.is("const")) throw this.fail("only `export const manifest = {...}` may be exported");
        const decl = this.parseVarDecl();
        if (decl.decls.length !== 1 || decl.decls[0].name !== "manifest") throw this.fail("only `export const manifest = {...}` may be exported", start);
        body.push(this.node("Manifest", start, { value: decl.decls[0].init }));
        continue;
      }
      if (this.is("const") || this.is("let")) {
        body.push(this.parseVarDecl());
        continue;
      }
      if (this.is("var")) throw this.fail("use `let` or `const`");
      if (this.is("function")) {
        body.push(this.parseFunction());
        continue;
      }
      const expr = this.parseExpr();
      this.semicolon();
      body.push(this.node("ExprStmt", start, { expr }));
    }
    return body;
  }

  parseVarDecl() {
    const kindToken = this.take();
    /** @type {{name: string, type: string|null, init: Node|null, at: Token}[]} */
    const decls = [];
    do {
      const nameToken = this.expectName();
      const type = this.accept(":") ? this.parseType() : null;
      const init = this.accept("=") ? this.parseExpr() : null;
      if (kindToken.text === "const" && !init) throw this.fail(`'${nameToken.text}' is const and needs a value`, nameToken);
      decls.push({ name: nameToken.text, type, init, at: nameToken });
    } while (this.accept(","));
    this.semicolon();
    return this.node("VarDecl", kindToken, { kind: kindToken.text, decls });
  }

  /** A type annotation, kept as text: number, boolean, void, Float32Array, unions. */
  parseType() {
    const parts = [];
    do {
      if (this.tok.kind === "string" || this.tok.kind === "number") {
        parts.push(this.take().text);
        continue;
      }
      const name = this.tok;
      if (name.kind !== "name") throw this.fail(`expected a type, found ${describe(name)}`);
      this.take();
      let text = name.text;
      while (this.is("[") && this.is("]", this.peek())) {
        this.take();
        this.take();
        text += "[]";
      }
      parts.push(text);
    } while (this.accept("|"));
    return parts.join("|");
  }

  parseFunction() {
    const start = this.expect("function");
    const nameToken = this.expectName();
    const params = this.parseParams();
    const returns = this.accept(":") ? this.parseType() : null;
    const body = this.parseBlock();
    return this.node("Function", start, { name: nameToken.text, params, returns, body, nameAt: nameToken });
  }

  parseParams() {
    this.expect("(");
    /** @type {{name: string, type: string|null, at: Token}[]} */
    const params = [];
    if (!this.accept(")")) {
      do {
        if (this.is("...")) throw this.fail("rest parameters are not supported");
        const nameToken = this.expectName();
        if (this.is("?")) throw this.fail("optional parameters are not supported");
        const type = this.accept(":") ? this.parseType() : null;
        if (this.is("=")) throw this.fail("default parameter values are not supported");
        params.push({ name: nameToken.text, type, at: nameToken });
      } while (this.accept(","));
      this.expect(")");
    }
    return params;
  }

  parseBlock() {
    const start = this.expect("{");
    /** @type {Node[]} */
    const body = [];
    while (!this.accept("}")) {
      if (this.tok.kind === "eof") throw this.fail("expected '}'");
      body.push(this.parseStatement());
    }
    return this.node("Block", start, { body });
  }

  /** @returns {Node} */
  parseStatement() {
    const start = this.tok;
    if (this.is("{")) return this.parseBlock();
    if (this.is("const") || this.is("let")) return this.parseVarDecl();
    if (this.is("var")) throw this.fail("use `let` or `const`");
    if (this.accept(";")) return this.node("Block", start, { body: [] });
    if (this.accept("if")) {
      this.expect("(");
      const test = this.parseExpr();
      this.expect(")");
      const cons = this.parseStatement();
      const alt = this.accept("else") ? this.parseStatement() : null;
      return this.node("If", start, { test, cons, alt });
    }
    if (this.accept("while")) {
      this.expect("(");
      const test = this.parseExpr();
      this.expect(")");
      return this.node("While", start, { test, body: this.parseStatement() });
    }
    if (this.accept("for")) {
      this.expect("(");
      let init = null;
      if (this.is("const") || this.is("let")) {
        init = this.parseVarDecl();
        if (this.is("of", this.tokens[this.pos - 1]) || this.is("of") || this.is("in")) throw this.fail("for...of and for...in are not supported; use for (let i = 0; i < n; i++)");
      } else if (!this.accept(";")) {
        init = this.node("ExprStmt", this.tok, { expr: this.parseExpr() });
        this.expect(";");
      }
      const test = this.is(";") ? null : this.parseExpr();
      this.expect(";");
      const update = this.is(")") ? null : this.parseExpr();
      this.expect(")");
      return this.node("For", start, { init, test, update, body: this.parseStatement() });
    }
    if (this.accept("break")) {
      this.semicolon();
      return this.node("Break", start);
    }
    if (this.accept("continue")) {
      this.semicolon();
      return this.node("Continue", start);
    }
    if (this.accept("return")) {
      const arg = this.is(";") || this.is("}") || this.tok.line !== start.line ? null : this.parseExpr();
      this.semicolon();
      return this.node("Return", start, { arg });
    }
    if (this.is("function")) throw this.fail("functions are declared at the top level");
    for (const word of ["do", "switch", "try", "throw", "class"]) {
      if (this.is(word)) throw this.fail(`'${word}' is not supported`);
    }
    const expr = this.parseExpr();
    this.semicolon();
    return this.node("ExprStmt", start, { expr });
  }

  // -- expressions --

  /** @returns {Node} */
  parseExpr() {
    const left = this.parseConditional();
    if (this.tok.kind === "punct" && ASSIGN_OPS.has(this.tok.text)) {
      const op = this.take();
      const value = this.parseExpr();
      return this.node("Assign", op, { op: op.text, target: left, value });
    }
    return left;
  }

  /** @returns {Node} */
  parseConditional() {
    const test = this.parseBinary(1);
    const q = this.accept("?");
    if (!q) return test;
    const cons = this.parseExpr();
    this.expect(":");
    const alt = this.parseExpr();
    return this.node("Cond", q, { test, cons, alt });
  }

  /** @param {number} min @returns {Node} */
  parseBinary(min) {
    let left = this.parseUnary();
    for (;;) {
      const token = this.tok;
      if (token.kind === "name" && (token.text === "as" || token.text === "satisfies")) {
        this.take();
        if (this.accept("const")) continue;
        this.parseType();
        continue;
      }
      const prec = token.kind === "punct" ? PRECEDENCE[/** @type {keyof typeof PRECEDENCE} */ (token.text)] : undefined;
      if (prec === undefined || prec < min) return left;
      this.take();
      if (token.text === "??") throw this.fail("'??' is not supported", token);
      if (token.text === "**") throw this.fail("'**' is not supported; multiply", token);
      const right = this.parseBinary(prec + 1);
      const type = token.text === "&&" || token.text === "||" ? "Logical" : "Binary";
      left = this.node(type, token, { op: token.text, left, right });
    }
  }

  /** @returns {Node} */
  parseUnary() {
    const token = this.tok;
    if (token.kind === "punct" && ["!", "-", "+", "~"].includes(token.text)) {
      this.take();
      return this.node("Unary", token, { op: token.text, arg: this.parseUnary() });
    }
    if (token.kind === "punct" && (token.text === "++" || token.text === "--")) {
      this.take();
      return this.node("Update", token, { op: token.text, target: this.parseUnary() });
    }
    if (this.is("typeof") || this.is("void") || this.is("delete")) throw this.fail(`'${token.text}' is not supported`);
    return this.parsePostfix();
  }

  /** @returns {Node} */
  parsePostfix() {
    let expr = this.parsePrimary();
    for (;;) {
      const token = this.tok;
      if (this.accept(".")) {
        const prop = this.tok;
        if (prop.kind !== "name") throw this.fail(`expected a property name, found ${describe(prop)}`);
        this.take();
        expr = this.node("Member", prop, { object: expr, prop: prop.text });
      } else if (this.is("?.")) {
        throw this.fail("'?.' is not supported");
      } else if (this.accept("[")) {
        const index = this.parseExpr();
        this.expect("]");
        expr = this.node("Index", token, { object: expr, index });
      } else if (this.is("(")) {
        expr = this.node("Call", token, { callee: expr, args: this.parseArgs() });
      } else if (token.kind === "punct" && (token.text === "++" || token.text === "--") && token.line === this.tokens[this.pos - 1].line) {
        this.take();
        expr = this.node("Update", token, { op: token.text, target: expr });
      } else {
        return expr;
      }
    }
  }

  parseArgs() {
    this.expect("(");
    /** @type {Node[]} */
    const args = [];
    if (this.accept(")")) return args;
    do {
      if (this.is(")")) break; // trailing comma
      args.push(this.parseExpr());
    } while (this.accept(","));
    this.expect(")");
    return args;
  }

  /** Whether the tokens at `pos` start an arrow function. */
  arrowAhead() {
    if (this.tok.kind === "name" && this.is("=>", this.peek())) return true;
    if (!this.is("(")) return false;
    let depth = 0;
    for (let k = this.pos; k < this.tokens.length; k += 1) {
      const t = this.tokens[k];
      if (this.is("(", t)) depth += 1;
      else if (this.is(")", t)) {
        depth -= 1;
        if (depth === 0) {
          const next = this.tokens[k + 1];
          if (this.is("=>", next)) return true;
          // `(a): number => ...`, but not `c ? (x) : y`: a return type is
          // a name followed by the arrow.
          return this.is(":", next) && this.tokens[k + 2]?.kind === "name" && this.is("=>", this.tokens[k + 3]);
        }
      } else if (t.kind === "eof") return false;
    }
    return false;
  }

  parseArrow() {
    const start = this.tok;
    /** @type {{name: string, type: string|null, at: Token}[]} */
    let params;
    if (this.tok.kind === "name") {
      const nameToken = this.expectName();
      params = [{ name: nameToken.text, type: null, at: nameToken }];
    } else {
      params = this.parseParams();
    }
    if (this.accept(":")) this.parseType();
    this.expect("=>");
    if (this.is("{")) return this.node("Arrow", start, { params, body: this.parseBlock() });
    const expr = this.parseExpr();
    const body = this.node("Block", expr, { body: [this.node("ExprStmt", expr, { expr })] });
    return this.node("Arrow", start, { params, body });
  }

  /** @returns {Node} */
  parsePrimary() {
    const token = this.tok;
    if (token.kind === "number") {
      this.take();
      return this.node("Num", token, { value: token.value });
    }
    if (token.kind === "string") {
      this.take();
      return this.node("Str", token, { value: token.value });
    }
    if (this.arrowAhead()) return this.parseArrow();
    if (this.accept("true")) return this.node("Bool", token, { value: true });
    if (this.accept("false")) return this.node("Bool", token, { value: false });
    if (this.accept("(")) {
      const expr = this.parseExpr();
      this.expect(")");
      return expr;
    }
    if (this.accept("new")) {
      const callee = this.expectName();
      if (this.is("<")) throw this.fail("type arguments are not supported");
      const args = this.is("(") ? this.parseArgs() : [];
      return this.node("New", callee, { callee: callee.text, args });
    }
    if (this.is("{")) {
      this.take();
      /** @type {{key: string, value: Node, at: Token}[]} */
      const props = [];
      while (!this.accept("}")) {
        const key = this.tok;
        if (key.kind !== "name" && key.kind !== "string") throw this.fail(`expected a property name, found ${describe(key)}`);
        this.take();
        this.expect(":");
        props.push({ key: String(key.kind === "string" ? key.value : key.text), value: this.parseExpr(), at: key });
        if (!this.accept(",")) {
          this.expect("}");
          break;
        }
      }
      return this.node("Object", token, { props });
    }
    if (this.is("[")) {
      // Only a Region's [first, last]; anywhere else the compiler refuses it.
      this.take();
      /** @type {Node[]} */
      const items = [];
      while (!this.accept("]")) {
        items.push(this.parseExpr());
        if (!this.accept(",")) {
          this.expect("]");
          break;
        }
      }
      return this.node("Array", token, { items });
    }
    if (this.is("function")) throw this.fail("function expressions are not supported; use an arrow function in on(), or a top-level function");
    if (token.kind === "name") {
      if (RESERVED.has(token.text)) throw this.fail(`'${token.text}' is not supported here`);
      this.take();
      return this.node("Ident", token, { name: token.text });
    }
    throw this.fail(`unexpected ${describe(token)}`);
  }
}

/** @param {Token} token */
function describe(token) {
  return token.kind === "eof" ? "end of file" : `'${token.text}'`;
}

// --- code generation ---------------------------------------------------------

/**
 * @typedef {"number"|"boolean"|"void"} ValueType
 *
 * @typedef {{kind: "const", value: number, type: ValueType}
 *   | {kind: "global", slot: number, type: ValueType, mutable: boolean}
 *   | {kind: "array", base: number, length: number}
 *   | {kind: "object", cls: string, op: string|null, slot: number, edge: {prev: number, rose: number, fell: number}|null, at: Node, name: string, persist: boolean}
 *   | {kind: "region", params: {r0: number, c0: number, r1: number, c1: number, rel: number}}
 *   | {kind: "function", index: number}} GlobalSymbol
 *
 * @typedef {{kind: "local", index: number, type: ValueType, mutable: boolean}} LocalSymbol
 */

/**
 * @typedef {object} FnRecord
 * @property {string} name
 * @property {number} index
 * @property {{name: string, type: string|null, at: Token}[]} params
 * @property {ValueType} returns
 * @property {Node|null} body
 * @property {boolean} entry compiled as a handler: `return` ends the run
 * @property {Assembler} asm
 * @property {number} locals
 * @property {Map<string, LocalSymbol>[]} scopes
 * @property {{breakLabel: number, continueLabel: number}[]} loops
 * @property {Node} at
 * @property {Set<number>} calls function indices it calls
 */

const BINARY_INSN = Object.freeze({
  "+": "add", "-": "sub", "*": "mul", "/": "div", "%": "mod",
  "<": "lt", "<=": "le", ">": "gt", ">=": "ge",
  "===": "eq", "==": "eq", "!==": "ne", "!=": "ne",
  "&": "band", "|": "bor", "^": "bxor", "<<": "shl", ">>": "shr", ">>>": "shr",
});
const COMPARISON = new Set(["<", "<=", ">", ">=", "===", "==", "!==", "!="]);

/** The VM's arithmetic, for folding constants exactly as the device would compute them. */
function fold(/** @type {string} */ op, /** @type {number} */ a, /** @type {number} */ b) {
  switch (op) {
    case "+": return f32(a + b);
    case "-": return f32(a - b);
    case "*": return f32(a * b);
    case "/": return b !== 0 ? f32(a / b) : 0;
    case "%": return b !== 0 ? f32(a % b) : 0;
    default: return null;
  }
}

class Compiler {
  /** @param {Node[]} program */
  constructor(program) {
    this.program = program;
    /** @type {number[]} */
    this.consts = [];
    /** @type {Map<string, number>} */
    this.constIndex = new Map();
    /** @type {string[]} */
    this.strings = [];
    this.arena = 0;
    /** @type {Map<string, GlobalSymbol>} */
    this.globals = new Map();
    /** @type {FnRecord[]} */
    this.functions = [];
    /** @type {Record<string, number>} */
    this.entries = {};
    /** @type {Set<string>} */
    this.caps = new Set();
    /** State slots of shared readings, by op and parameters (native()). @type {Map<string, number>} */
    this.readings = new Map();
    /** @type {{message: string, line: number|null, col: number|null}[]} */
    this.notes = [];
    /** @type {[number, number][]} */
    this.init = [];
    /** @type {Record<string, any>} */
    this.manifest = {};
    /** @type {{topic: string, fn: number, at: Node}[]} */
    this.messageHandlers = [];
    /** Objects whose rose/fell is read, by name. @type {Set<string>} */
    this.edgesUsed = new Set();
    /** Counters updated with a reset argument. @type {Set<string>} */
    this.countersWithReset = new Set();
    /** Names called as functions. @type {Set<string>} */
    this.calledNames = new Set();
    /** @type {Set<string>} */
    this.storeKeys = new Set();
    /** @type {FnRecord|null} */
    this.fn = null;
    this.noted = new Set();
  }

  /** @param {string} reason @param {Node|Token} at */
  fail(reason, at) {
    return new CompileError(reason, at.line, at.col, at.endCol);
  }

  /** @param {string} key @param {string} message @param {Node|Token|null} at */
  note(key, message, at) {
    if (this.noted.has(key)) return;
    this.noted.add(key);
    this.notes.push({ message, line: at ? at.line : null, col: at ? at.col : null });
  }

  // -- pools --

  /** @param {number} value */
  constant(value) {
    const v = f32(value);
    const key = Object.is(v, -0) ? "-0" : String(v);
    let index = this.constIndex.get(key);
    if (index === undefined) {
      index = this.consts.length;
      this.consts.push(v);
      this.constIndex.set(key, index);
    }
    return index;
  }

  /** A native op's parameter record: reused when an identical run exists. @param {number[]} values */
  record(values) {
    const consts = this.consts;
    for (let i = 0; values.length > 0 && i + values.length <= consts.length; i += 1) {
      if (values.every((v, k) => Object.is(consts[i + k], f32(v)))) return i;
    }
    const at = consts.length;
    for (const v of values) consts.push(f32(v));
    return at;
  }

  /** @param {string} text @param {Node} at @param {string} what */
  string(text, at, what) {
    if (text.length === 0) throw this.fail(`${what} cannot be empty`, at);
    if (text.length > VM_MAX_STRING) throw this.fail(`${what} '${text}' is longer than ${VM_MAX_STRING} characters`, at);
    if (!/^[\x20-\x7e]*$/.test(text)) throw this.fail(`${what} is printable ASCII only`, at);
    let index = this.strings.indexOf(text);
    if (index < 0) {
      if (this.strings.length >= VM_MAX_STRINGS) throw this.fail(`more than ${VM_MAX_STRINGS} distinct strings`, at);
      index = this.strings.length;
      this.strings.push(text);
    }
    return index;
  }

  /** @param {number} n */
  allocate(n) {
    const base = this.arena;
    this.arena += n;
    if (this.arena > VM_MAX_ARENA) throw new CompileError(`the app needs more than ${VM_MAX_ARENA} values of memory`);
    return base;
  }

  // -- top level --

  compile() {
    // Pass 1: declarations, so functions and globals may be used before
    // they appear, as in TypeScript.
    /** @type {Node[]} */
    const handlers = [];
    for (const item of this.program) {
      if (item.type === "Manifest") this.readManifest(item);
      else if (item.type === "VarDecl") {
        for (const decl of item.decls) this.declareGlobal(item.kind, decl);
      } else if (item.type === "Function") this.declareFunction(item);
      else if (item.type === "ExprStmt") {
        const e = item.expr;
        if (e.type === "Call" && e.callee.type === "Ident" && e.callee.name === "on") handlers.push(e);
        else throw this.fail("only declarations and on(...) are allowed at the top level; put code in a handler", item);
      }
    }
    if (!this.manifest.id) throw new CompileError("missing `export const manifest = { id: ..., ... }`");
    this.scanUses();
    this.allocateObjects();
    for (const call of handlers) this.declareHandler(call);
    if (Object.keys(this.entries).length === 0 && this.messageHandlers.length === 0) {
      throw new CompileError("no handlers: add on(\"frame\", () => { ... })");
    }
    for (const record of [...this.functions]) this.compileFunction(record);
    if (this.messageHandlers.length > 0) this.compileMessageDispatch();
    this.checkRecursion();
    return this.finish();
  }

  /** @param {Node} item */
  readManifest(item) {
    const value = item.value;
    if (!value || value.type !== "Object") throw this.fail("manifest must be an object literal", item);
    for (const prop of value.props) {
      const v = prop.value;
      if (["capabilities", "min_os", "nodes"].includes(prop.key)) {
        throw this.fail(`manifest.${prop.key} is computed by the compiler; remove it`, v);
      }
      if (v.type === "Str") this.manifest[prop.key] = v.value;
      else if (v.type === "Num") this.manifest[prop.key] = v.value;
      else if (v.type === "Bool") this.manifest[prop.key] = v.value;
      else throw this.fail(`manifest.${prop.key} must be a literal`, v);
    }
    for (const key of ["capabilities", "min_os", "nodes"]) {
      if (key in this.manifest) throw this.fail(`manifest.${key} is computed by the compiler; remove it`, item);
    }
  }

  /** @param {string} kind @param {{name: string, type: string|null, init: Node|null, at: Token}} decl */
  declareGlobal(kind, decl) {
    const { name, init, at } = decl;
    if (this.globals.has(name)) throw this.fail(`'${name}' is already declared`, at);
    if (BUILTIN_NAMES.has(name)) throw this.fail(`'${name}' is a built-in name`, at);
    if (init && init.type === "New") {
      if (kind !== "const") throw this.fail(`declare '${name}' with const: it is created once`, at);
      this.globals.set(name, this.declareNew(name, init));
      return;
    }
    if (init && init.type === "Arrow") throw this.fail("declare functions with `function name() {}`", init);
    const constValue = init ? this.constValue(init) : 0;
    if (init && constValue === null) {
      throw this.fail(`a top-level value must be a constant; compute '${name}' in on("start", ...) instead`, init);
    }
    const type = declaredType(decl.type, init, at, this);
    if (kind === "const") {
      this.globals.set(name, { kind: "const", value: /** @type {number} */ (constValue), type });
      return;
    }
    const slot = this.allocate(1);
    if (constValue) this.init.push([slot, this.constant(/** @type {number} */ (constValue))]);
    this.globals.set(name, { kind: "global", slot, type, mutable: true });
  }

  /** @param {string} name @param {Node} init @returns {GlobalSymbol} */
  declareNew(name, init) {
    const cls = init.callee;
    const args = init.args;
    if (cls === "Float32Array") {
      if (args.length !== 1) throw this.fail("new Float32Array(length) takes one length", init);
      const length = this.constInt(args[0], "an array length", 1, 512);
      return { kind: "array", base: this.allocate(length), length };
    }
    if (cls === "Region") return { kind: "region", params: this.regionParams(init) };
    if (!Object.hasOwn(CLASSES, cls)) throw this.fail(`unknown class '${cls}'`, init);
    // Slots are allocated once every use has been seen (allocateObjects).
    return { kind: "object", cls, op: CLASSES[/** @type {keyof typeof CLASSES} */ (cls)].op, slot: -1, edge: null, at: init, name, persist: false };
  }

  /** @param {Node} init */
  regionParams(init) {
    const config = init.args[0];
    if (init.args.length !== 1 || !config || config.type !== "Object") {
      throw this.fail("new Region({ rows: [first, last], cols: [first, last], percent: true })", init);
    }
    /** @type {Record<string, Node>} */
    const props = Object.fromEntries(config.props.map((/** @type {any} */ p) => [p.key, p.value]));
    for (const key of Object.keys(props)) {
      if (!["rows", "cols", "percent"].includes(key)) throw this.fail(`unknown Region option '${key}'`, props[key]);
    }
    const percent = props.percent ? this.constValue(props.percent) === 1 : false;
    const limit = percent ? MAX_REL_PERCENT : MAX_REGION_INDEX;
    /** @param {string} key */
    const span = (key) => {
      const node = props[key];
      if (!node) return [0, limit];
      if (node.type !== "Array" || node.items.length !== 2) throw this.fail(`Region ${key} is [first, last]`, node);
      const what = `a ${key === "rows" ? "row" : "column"} ${percent ? "percentage" : "index"}`;
      const a = this.constInt(node.items[0], what, 0, limit);
      const b = this.constInt(node.items[1], what, 0, limit);
      if (a > b) throw this.fail(`Region ${key} is inverted`, node);
      return [a, b];
    };
    const [r0, r1] = span("rows");
    const [c0, c1] = span("cols");
    if (percent) this.note("percent", "percent bounds are resolved against each board's own matrix; a row or column a boundary splits belongs to both sides", init);
    return { r0, c0, r1, c1, rel: percent ? REL_ROWS | REL_COLS : 0 };
  }

  /** @param {Node} item */
  declareFunction(item) {
    if (this.globals.has(item.name)) throw this.fail(`'${item.name}' is already declared`, item.nameAt);
    if (BUILTIN_NAMES.has(item.name)) throw this.fail(`'${item.name}' is a built-in name`, item.nameAt);
    const index = this.addFunction(item.name, item.params, returnType(item.returns, item, this), item.body, item);
    this.globals.set(item.name, { kind: "function", index });
  }

  /**
   * @param {string} name
   * @param {{name: string, type: string|null, at: Token}[]} params
   * @param {ValueType} returns
   * @param {Node|null} body
   * @param {Node} at
   */
  addFunction(name, params, returns, body, at) {
    if (this.functions.length >= VM_MAX_FUNCTIONS) throw this.fail(`more than ${VM_MAX_FUNCTIONS} functions and handlers`, at);
    const index = this.functions.length;
    this.functions.push({
      name, index, params, returns, body, entry: false, asm: new Assembler(), locals: 0, scopes: [], loops: [], at, calls: new Set(),
    });
    return index;
  }

  /** Records which objects need edges and which counters take a reset. */
  scanUses() {
    /** @param {any} node */
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (node.type === "Member" && node.object?.type === "Ident" && (node.prop === "rose" || node.prop === "fell")) {
        this.edgesUsed.add(node.object.name);
      }
      if (node.type === "Call" && node.callee?.type === "Member" && node.callee.prop === "update"
        && node.callee.object?.type === "Ident" && node.args.length === 2) {
        this.countersWithReset.add(node.callee.object.name);
      }
      if (node.type === "Call" && node.callee?.type === "Ident") this.calledNames.add(node.callee.name);
      for (const [key, value] of Object.entries(node)) {
        if (key !== "line" && key !== "col" && key !== "endCol" && key !== "at" && key !== "nameAt") walk(value);
      }
    };
    walk(this.program);
  }

  allocateObjects() {
    for (const [name, sym] of this.globals) {
      if (sym.kind !== "object") continue;
      const spec = CLASSES[/** @type {keyof typeof CLASSES} */ (sym.cls)];
      const args = sym.at.args;
      if (sym.cls === "Counter") {
        if (this.countersWithReset.has(name)) sym.op = "counter_reset";
        const options = args[0];
        if (args.length > 1 || (options && options.type !== "Object")) throw this.fail("new Counter() or new Counter({ persist: true })", sym.at);
        for (const prop of options?.props ?? []) {
          if (prop.key !== "persist") throw this.fail(`unknown Counter option '${prop.key}'`, prop.value);
          sym.persist = this.constValue(prop.value) === 1;
        }
        if (sym.persist) {
          this.caps.add("persist");
          this.note("persist", "a persist counter is kept across reboots in the device's NVS, written at most every 30 s; a new version starts it from 0", sym.at);
        }
      }
      if (sym.op) {
        const layout = NATIVE_LAYOUT[sym.op];
        sym.slot = this.allocate(layout.state + (sym.op === "mean" || sym.op === "max_hold" || sym.op === "integrate" ? this.windowOf(sym) : 0));
        if (sym.op === "delta" && args.length > 0) {
          const initial = this.constValue(args[0]);
          if (initial === null) throw this.fail("new Delta(initial) takes a constant", args[0]);
          if (initial !== 0) this.init.push([sym.slot + 1, this.constant(initial)]);
        }
      }
      if (spec.boolean && (sym.cls === "Edge" || this.edgesUsed.has(name))) {
        const base = this.allocate(3);
        sym.edge = { prev: base, rose: base + 1, fell: base + 2 };
        if (sym.cls === "Edge") sym.slot = base;
      }
      this.checkConstructor(sym);
    }
  }

  /** @param {Extract<GlobalSymbol, {kind: "object"}>} sym */
  windowOf(sym) {
    const arg = sym.at.args[0];
    if (sym.at.args.length !== 1) throw this.fail(`new ${sym.cls}(frames) takes the window length`, sym.at);
    return this.constInt(arg, "a window", 1, MAX_WINDOW);
  }

  /** @param {Extract<GlobalSymbol, {kind: "object"}>} sym */
  checkConstructor(sym) {
    const args = sym.at.args;
    const max = { Threshold: 2, Debounce: 1, Mean: 1, MaxHold: 1, Integrate: 1, Delta: 1, Counter: 1, Duration: 0, Interval: 0, PeakSince: 0, Features: 0, Edge: 0 }[sym.cls] ?? 0;
    const min = { Threshold: 1, Debounce: 1, Mean: 1, MaxHold: 1, Integrate: 1 }[sym.cls] ?? 0;
    if (args.length < min || args.length > max) throw this.fail(`new ${sym.cls}() takes ${min === max ? min : `${min} to ${max}`} argument(s)`, sym.at);
  }

  /** The native parameters of an object's update. @param {Extract<GlobalSymbol, {kind: "object"}>} sym */
  objectParams(sym) {
    const args = sym.at.args;
    switch (sym.cls) {
      case "Threshold": {
        const on = this.constValue(args[0]);
        const hysteresis = args[1] ? this.constValue(args[1]) : 0;
        if (on === null || hysteresis === null) throw this.fail("new Threshold(on, hysteresis) takes constants", sym.at);
        if (hysteresis < 0) throw this.fail("hysteresis cannot be negative", args[1]);
        return { value: on, hysteresis };
      }
      case "Debounce":
        return { ms: this.constInt(args[0], "a debounce time in ms", 0, MAX_DEBOUNCE_MS) };
      case "Mean": case "MaxHold": case "Integrate":
        return { window: this.windowOf(sym) };
      case "Counter":
        return { persist: sym.persist ? 1 : 0 };
      default:
        return {};
    }
  }

  /** @param {Node} call */
  declareHandler(call) {
    const args = call.args;
    const eventNode = args[0];
    if (!eventNode || eventNode.type !== "Str") throw this.fail(`on() takes an event name: ${Object.keys(HANDLER_EVENTS).join(", ")}`, call);
    const event = String(eventNode.value);
    if (!Object.hasOwn(HANDLER_EVENTS, event)) throw this.fail(`unknown event '${event}' (${Object.keys(HANDLER_EVENTS).join(", ")})`, eventNode);
    const cap = HANDLER_CAPS[/** @type {keyof typeof HANDLER_CAPS} */ (event)];
    if (cap) this.caps.add(cap);
    if (event === "idle") this.note("idle", "an idle handler runs 10 times a second while no frames arrive; matrix reads hold their last values then", call);
    if (event === "message") {
      const topicNode = args[1];
      if (args.length !== 3 || topicNode.type !== "Str") throw this.fail("on(\"message\", \"topic\", (value) => { ... })", call);
      const topic = String(topicNode.value);
      this.string(topic, topicNode, "a topic");
      if (this.messageHandlers.some((h) => h.topic === topic)) throw this.fail(`two handlers for message '${topic}'`, topicNode);
      const handler = args[2];
      let fn;
      if (handler.type === "Arrow") {
        if (handler.params.length > 1) throw this.fail("a message handler takes (value)", handler);
        fn = this.addFunction(`message:${topic}`, handler.params, "void", handler.body, handler);
      } else {
        fn = this.handlerFunction(handler, 1);
      }
      this.messageHandlers.push({ topic, fn, at: call });
      return;
    }
    if (args.length !== 2) throw this.fail(`on("${event}", () => { ... })`, call);
    const entry = HANDLER_EVENTS[/** @type {keyof typeof HANDLER_EVENTS} */ (event)];
    if (Object.hasOwn(this.entries, entry)) throw this.fail(`a second handler for '${event}'`, eventNode);
    const handler = args[1];
    let fn;
    if (handler.type === "Arrow") {
      if (handler.params.length > 0) throw this.fail(`a ${event} handler takes no parameters`, handler);
      fn = this.addFunction(`on:${event}`, [], "void", handler.body, handler);
      this.functions[fn].entry = true;
    } else {
      fn = this.handlerFunction(handler, 0);
      const record = this.functions[fn];
      // A function that is only a handler runs as one; a function that is
      // also called needs a wrapper, since a handler ends the run.
      if (!this.calledNames.has(record.name)) {
        record.entry = true;
      } else {
        fn = this.addFunction(`on:${event}`, [], "void", null, handler);
        this.functions[fn].entry = true;
        this.functions[fn].wrap = this.handlerFunction(handler, 0);
      }
    }
    this.entries[entry] = fn;
  }

  /** @param {Node} handler @param {number} params */
  handlerFunction(handler, params) {
    if (handler.type !== "Ident") throw this.fail("a handler is an arrow function or a function name", handler);
    const sym = this.globals.get(handler.name);
    if (!sym || sym.kind !== "function") throw this.fail(`'${handler.name}' is not a function`, handler);
    const record = this.functions[sym.index];
    if (record.params.length !== params) throw this.fail(`a handler function takes ${params} parameter(s)`, handler);
    if (record.returns !== "void") throw this.fail("a handler function returns nothing", handler);
    return sym.index;
  }

  // -- functions --

  /** @param {FnRecord & {wrap?: number}} record */
  compileFunction(record) {
    this.fn = record;
    record.scopes = [new Map()];
    record.locals = 0;
    for (const param of record.params) {
      if (record.scopes[0].has(param.name)) throw this.fail(`duplicate parameter '${param.name}'`, param.at);
      record.scopes[0].set(param.name, { kind: "local", index: record.locals, type: typeOf(param.type, param.at, this), mutable: true });
      record.locals += 1;
    }
    const asm = record.asm;
    if (record.wrap !== undefined) {
      asm.op("call", record.wrap);
      record.calls.add(record.wrap);
      asm.op("end");
    } else {
      this.block(/** @type {Node} */ (record.body), false);
      if (record.entry) asm.op("end");
      else if (record.returns === "void") asm.op("ret", 0);
      else {
        asm.op("push0");
        asm.op("ret", 1);
      }
    }
    if (record.locals > 255) throw this.fail("too many local variables", record.at);
    this.fn = null;
  }

  compileMessageDispatch() {
    const index = this.addFunction("on:message", [], "void", null, this.messageHandlers[0].at);
    const record = this.functions[index];
    record.entry = true;
    record.scopes = [new Map()];
    this.fn = record;
    const asm = record.asm;
    for (const handler of this.messageHandlers) {
      const next = asm.newLabel();
      asm.op("pushk", this.constant(this.string(handler.topic, handler.at, "a topic")));
      this.sys("msg_is");
      asm.jump("jz", next);
      const target = this.functions[handler.fn];
      if (target.params.length === 1) this.sys("msg_value");
      asm.op("call", handler.fn);
      record.calls.add(handler.fn);
      asm.bind(next);
    }
    asm.op("end");
    this.entries.message = index;
    this.fn = null;
  }

  checkRecursion() {
    const state = new Map();
    /** @param {number} f @param {number} depth */
    const visit = (f, depth) => {
      if (state.get(f) === 1) throw this.fail(`'${this.functions[f].name}' calls itself (directly or through others); recursion is not supported`, this.functions[f].at);
      if (state.get(f) === 2) return;
      state.set(f, 1);
      for (const callee of this.functions[f].calls) visit(callee, depth + 1);
      state.set(f, 2);
    };
    for (let f = 0; f < this.functions.length; f += 1) visit(f, 0);
  }

  get asm() {
    return /** @type {FnRecord} */ (this.fn).asm;
  }

  /** @param {string} name @param {Node} [at] */
  sys(name, at) {
    const index = VM_SYSCALLS.findIndex((s) => s.name === name);
    if (index < 0) throw new Error(`unknown syscall ${name}`);
    const cap = VM_SYSCALLS[index].cap;
    if (cap) this.caps.add(cap);
    if (cap && DANGEROUS_CAPABILITIES.includes(cap)) {
      this.note(`cap:${cap}`, `uses '${cap}': the device asks the operator to allow it at install`, at ?? null);
    }
    this.asm.op("sys", index);
  }

  // -- statements --

  /** @param {Node} block @param {boolean} scoped */
  block(block, scoped = true) {
    const fn = /** @type {FnRecord} */ (this.fn);
    if (scoped) fn.scopes.push(new Map());
    for (const statement of block.body) this.statement(statement);
    if (scoped) fn.scopes.pop();
  }

  /** @param {Node} s */
  statement(s) {
    const fn = /** @type {FnRecord} */ (this.fn);
    const asm = this.asm;
    switch (s.type) {
      case "Block":
        this.block(s);
        return;
      case "VarDecl":
        for (const decl of s.decls) this.localDecl(s.kind, decl);
        return;
      case "ExprStmt":
        this.exprStatement(s.expr);
        return;
      case "If": {
        const otherwise = asm.newLabel();
        this.condition(s.test);
        asm.jump("jz", otherwise);
        this.statement(s.cons);
        if (s.alt) {
          const done = asm.newLabel();
          asm.jump("jmp", done);
          asm.bind(otherwise);
          this.statement(s.alt);
          asm.bind(done);
        } else {
          asm.bind(otherwise);
        }
        return;
      }
      case "While": {
        const top = asm.newLabel();
        const done = asm.newLabel();
        asm.bind(top);
        this.condition(s.test);
        asm.jump("jz", done);
        fn.loops.push({ breakLabel: done, continueLabel: top });
        this.statement(s.body);
        fn.loops.pop();
        asm.jump("jmp", top);
        asm.bind(done);
        return;
      }
      case "For": {
        fn.scopes.push(new Map());
        if (s.init) this.statement(s.init);
        const top = asm.newLabel();
        const next = asm.newLabel();
        const done = asm.newLabel();
        asm.bind(top);
        if (s.test) {
          this.condition(s.test);
          asm.jump("jz", done);
        }
        fn.loops.push({ breakLabel: done, continueLabel: next });
        this.statement(s.body);
        fn.loops.pop();
        asm.bind(next);
        if (s.update) this.exprStatement(s.update);
        asm.jump("jmp", top);
        asm.bind(done);
        fn.scopes.pop();
        return;
      }
      case "Break":
      case "Continue": {
        const loop = fn.loops[fn.loops.length - 1];
        if (!loop) throw this.fail(`'${s.type.toLowerCase()}' outside a loop`, s);
        asm.jump("jmp", s.type === "Break" ? loop.breakLabel : loop.continueLabel);
        return;
      }
      case "Return": {
        if (fn.entry) {
          if (s.arg) throw this.fail("a handler returns nothing", s.arg);
          asm.op("end");
        } else if (fn.returns === "void") {
          if (s.arg) throw this.fail(`'${fn.name}' returns nothing; declare its return type`, s.arg);
          asm.op("ret", 0);
        } else {
          if (!s.arg) throw this.fail(`'${fn.name}' must return a ${fn.returns}`, s);
          this.value(s.arg);
          asm.op("ret", 1);
        }
        return;
      }
      default:
        throw this.fail(`unexpected ${s.type}`, s);
    }
  }

  /** @param {string} kind @param {{name: string, type: string|null, init: Node|null, at: Token}} decl */
  localDecl(kind, decl) {
    const fn = /** @type {FnRecord} */ (this.fn);
    const scope = fn.scopes[fn.scopes.length - 1];
    if (scope.has(decl.name)) throw this.fail(`'${decl.name}' is already declared`, decl.at);
    if (decl.init && decl.init.type === "New") throw this.fail("objects and arrays are created at the top level, once", decl.init);
    let type = typeOf(decl.type, decl.at, this);
    if (decl.init) {
      const got = this.value(decl.init);
      if (!decl.type) type = got;
    } else {
      // Handlers' locals keep the previous run's values: always initialise.
      this.asm.op("push0");
    }
    const index = fn.locals;
    fn.locals += 1;
    this.asm.op("storel", index);
    scope.set(decl.name, { kind: "local", index, type, mutable: kind === "let" });
  }

  /** An expression whose value, if any, is discarded. @param {Node} e */
  exprStatement(e) {
    if (e.type === "Assign") {
      this.assign(e);
      return;
    }
    if (e.type === "Update") {
      this.update(e);
      return;
    }
    if (e.type === "Call" && e.callee.type === "Ident" && e.callee.name === "on") throw this.fail("on() is called at the top level", e);
    if (e.type !== "Call") throw this.fail("this expression does nothing", e);
    const type = this.expr(e);
    if (type !== "void") this.asm.op("pop");
  }

  /** @param {Node} e an if/while condition */
  condition(e) {
    this.value(e);
  }

  /** @param {Node} target */
  lvalue(target) {
    const asm = this.asm;
    if (target.type === "Ident") {
      const sym = this.lookup(target.name, target);
      if (sym.kind === "local") {
        if (!sym.mutable) throw this.fail(`'${target.name}' is const`, target);
        return { load: () => asm.op("loadl", sym.index), store: () => asm.op("storel", sym.index), prepare: () => {} };
      }
      if (sym.kind === "global") {
        return { load: () => asm.op("loadg", sym.slot), store: () => asm.op("storeg", sym.slot), prepare: () => {} };
      }
      if (sym.kind === "const") throw this.fail(`'${target.name}' is const`, target);
      throw this.fail(`cannot assign to '${target.name}'`, target);
    }
    if (target.type === "Index") {
      const array = this.arrayOf(target.object);
      // Element writes need the index below the value: index is computed
      // once into a scratch local when the operation also reads.
      return {
        array,
        index: target.index,
        load: null,
        store: null,
        prepare: null,
      };
    }
    throw this.fail("cannot assign to this", target);
  }

  /** @param {Node} e */
  assign(e) {
    const asm = this.asm;
    const target = e.target;
    const op = e.op === "=" ? null : e.op.slice(0, -1);
    if (target.type === "Index") {
      const array = this.arrayOf(target.object);
      if (op === null) {
        this.arrayIndex(array, target.index);
        this.value(e.value);
        asm.op("astore", array.base, array.length);
        return;
      }
      const temp = this.scratchLocal();
      this.arrayIndex(array, target.index);
      asm.op("storel", temp);
      asm.op("loadl", temp);
      asm.op("loadl", temp);
      asm.op("aload", array.base, array.length);
      this.value(e.value);
      asm.op(BINARY_INSN[/** @type {keyof typeof BINARY_INSN} */ (op)]);
      asm.op("astore", array.base, array.length);
      return;
    }
    const place = this.lvalue(target);
    if (op !== null) {
      if (!Object.hasOwn(BINARY_INSN, op)) throw this.fail(`'${e.op}' is not supported`, e);
      /** @type {any} */ (place).load();
      this.value(e.value);
      asm.op(BINARY_INSN[/** @type {keyof typeof BINARY_INSN} */ (op)]);
    } else {
      this.value(e.value);
    }
    /** @type {any} */ (place).store();
  }

  /**
   * Pushes an array index. A constant one is checked here, so the mistake
   * shows in the editor rather than as an array_bounds fault on the device.
   * @param {{base: number, length: number}} array
   * @param {Node} index
   */
  arrayIndex(array, index) {
    const constant = index.type === "Num" ? index.value
      : index.type === "Unary" && index.op === "-" && index.arg?.type === "Num" ? -index.arg.value : null;
    if (constant !== null && (!Number.isInteger(constant) || constant < 0 || constant >= array.length)) {
      throw this.fail(`index ${constant} is out of range (the array has ${array.length})`, index);
    }
    this.value(index);
  }

  /** @param {Node} e */
  update(e) {
    const asm = this.asm;
    const insn = e.op === "++" ? "add" : "sub";
    if (e.target.type === "Index") {
      const array = this.arrayOf(e.target.object);
      const temp = this.scratchLocal();
      this.arrayIndex(array, e.target.index);
      asm.op("storel", temp);
      asm.op("loadl", temp);
      asm.op("loadl", temp);
      asm.op("aload", array.base, array.length);
      asm.op("push1");
      asm.op(insn);
      asm.op("astore", array.base, array.length);
      return;
    }
    const place = /** @type {any} */ (this.lvalue(e.target));
    place.load();
    asm.op("push1");
    asm.op(insn);
    place.store();
  }

  scratchLocal() {
    const fn = /** @type {FnRecord} */ (this.fn);
    const index = fn.locals;
    fn.locals += 1;
    return index;
  }

  // -- names --

  /** @param {string} name @param {Node} at @returns {LocalSymbol|GlobalSymbol} */
  lookup(name, at) {
    const fn = this.fn;
    if (fn) {
      for (let i = fn.scopes.length - 1; i >= 0; i -= 1) {
        const sym = fn.scopes[i].get(name);
        if (sym) return sym;
      }
    }
    const sym = this.globals.get(name);
    if (sym) return sym;
    if (BUILTIN_NAMES.has(name)) throw this.fail(`'${name}' is not a value; see nhos.d.ts for how to use it`, at);
    throw this.fail(`unknown name '${name}'`, at);
  }

  /** @param {Node} node */
  arrayOf(node) {
    if (node.type !== "Ident") throw this.fail("expected an array name", node);
    const sym = this.lookup(node.name, node);
    if (sym.kind !== "array") throw this.fail(`'${node.name}' is not a Float32Array`, node);
    return sym;
  }

  /** @param {Node} node */
  objectOf(node) {
    if (node.type !== "Ident") return null;
    if (this.fn) {
      for (let i = this.fn.scopes.length - 1; i >= 0; i -= 1) if (this.fn.scopes[i].has(node.name)) return null;
    }
    return this.globals.get(node.name) ?? null;
  }

  // -- constants --

  /**
   * The value of a constant expression, or null.
   * @param {Node} e
   * @returns {number|null}
   */
  constValue(e) {
    switch (e.type) {
      case "Num": return f32(e.value);
      case "Bool": return e.value ? 1 : 0;
      case "Unary": {
        const v = this.constValue(e.arg);
        if (v === null) return null;
        if (e.op === "-") return f32(-v);
        if (e.op === "+") return v;
        if (e.op === "!") return v === 0 ? 1 : 0;
        return null;
      }
      case "Binary": {
        const a = this.constValue(e.left);
        if (a === null) return null;
        const b = this.constValue(e.right);
        if (b === null) return null;
        return fold(e.op, a, b);
      }
      case "Ident": {
        if (e.name === "NaN") return NaN;
        if (e.name === "Infinity") return Infinity;
        if (this.fn) {
          for (let i = this.fn.scopes.length - 1; i >= 0; i -= 1) if (this.fn.scopes[i].has(e.name)) return null;
        }
        const sym = this.globals.get(e.name);
        return sym && sym.kind === "const" ? sym.value : null;
      }
      case "Member":
        if (e.object.type === "Ident" && e.object.name === "Math") {
          if (e.prop === "PI") return f32(Math.PI);
          if (e.prop === "E") return f32(Math.E);
        }
        return null;
      default:
        return null;
    }
  }

  /** @param {Node} e @param {string} what @param {number} lo @param {number} hi */
  constInt(e, what, lo, hi) {
    const v = this.constValue(e);
    if (v === null || !Number.isInteger(v)) throw this.fail(`expected ${what}: a whole constant number`, e);
    if (v < lo || v > hi) throw this.fail(`${what} must be ${lo} to ${hi}`, e);
    return v;
  }

  /** @param {Node} e @param {string} what */
  constNumber(e, what) {
    const v = this.constValue(e);
    if (v === null) throw this.fail(`expected ${what}: a constant number`, e);
    return v;
  }

  /** @param {Node} e @param {string} what */
  constString(e, what) {
    if (!e || e.type !== "Str") throw this.fail(`expected ${what}: a string in quotes`, e ?? { line: null, col: null });
    return String(e.value);
  }

  /** @param {Node} e */
  colour(e) {
    if (e && e.type === "Member" && e.object.type === "Ident" && e.object.name === "Color" && Object.hasOwn(COLOURS, e.prop)) {
      return LED_COLOURS[COLOURS[e.prop]];
    }
    throw this.fail(`expected a colour: ${Object.keys(COLOURS).map((c) => `Color.${c}`).join(", ")}`, e);
  }

  /** @param {number} v */
  pushConst(v) {
    if (Object.is(v, 0)) this.asm.op("push0");
    else if (v === 1) this.asm.op("push1");
    else this.asm.op("pushk", this.constant(v));
  }

  // -- expressions --

  /** An expression that must produce a value. @param {Node} e @returns {ValueType} */
  value(e) {
    const type = this.expr(e);
    if (type === "void") throw this.fail("this has no value", e);
    return type;
  }

  /** @param {Node} e @returns {ValueType} */
  expr(e) {
    const asm = this.asm;
    if (e.type === "Scratch") {
      // A value the compiler parked in a hidden local (see oled.text).
      asm.op("loadl", e.index);
      return "number";
    }
    const folded = e.type === "Binary" || e.type === "Unary" ? this.constValue(e) : null;
    if (folded !== null) {
      this.pushConst(folded);
      return e.type === "Unary" && e.op === "!" ? "boolean" : "number";
    }
    switch (e.type) {
      case "Num":
        this.pushConst(f32(e.value));
        return "number";
      case "Bool":
        asm.op(e.value ? "push1" : "push0");
        return "boolean";
      case "Str":
        throw this.fail("a string is only allowed as a name, label, key or topic", e);
      case "Ident": {
        if (e.name === "NaN" || e.name === "Infinity") {
          this.pushConst(e.name === "NaN" ? NaN : Infinity);
          return "number";
        }
        const sym = this.lookup(e.name, e);
        switch (sym.kind) {
          case "local": asm.op("loadl", sym.index); return sym.type;
          case "global": asm.op("loadg", sym.slot); return sym.type;
          case "const": this.pushConst(sym.value); return sym.type;
          case "object": throw this.fail(`'${e.name}' is an object; read ${e.name}.value`, e);
          case "array": throw this.fail(`'${e.name}' is an array; read ${e.name}[i]`, e);
          case "region": throw this.fail(`'${e.name}' is a region; call ${e.name}.sum() or another reading`, e);
          default: throw this.fail(`'${e.name}' is a function; call it`, e);
        }
      }
      case "Member":
        return this.member(e);
      case "Index": {
        const array = this.arrayOf(e.object);
        this.arrayIndex(array, e.index);
        asm.op("aload", array.base, array.length);
        return "number";
      }
      case "Call":
        return this.call(e);
      case "Unary": {
        if (e.op === "~") throw this.fail("'~' is not supported", e);
        const type = this.value(e.arg);
        if (e.op === "!") {
          asm.op("not");
          return "boolean";
        }
        if (e.op === "-") asm.op("neg");
        return type === "boolean" && e.op === "+" ? "number" : "number";
      }
      case "Binary": {
        const insn = BINARY_INSN[/** @type {keyof typeof BINARY_INSN} */ (e.op)];
        if (!insn) throw this.fail(`'${e.op}' is not supported`, e);
        this.value(e.left);
        this.value(e.right);
        asm.op(insn);
        return COMPARISON.has(e.op) ? "boolean" : "number";
      }
      case "Logical": {
        // JavaScript's value semantics: a && b is a when a is falsy, else b.
        const done = asm.newLabel();
        const left = this.value(e.left);
        asm.op("dup");
        asm.jump(e.op === "&&" ? "jz" : "jnz", done);
        asm.op("pop");
        const right = this.value(e.right);
        asm.bind(done);
        return left === "boolean" && right === "boolean" ? "boolean" : "number";
      }
      case "Cond": {
        const otherwise = asm.newLabel();
        const done = asm.newLabel();
        this.value(e.test);
        asm.jump("jz", otherwise);
        const a = this.value(e.cons);
        asm.jump("jmp", done);
        asm.bind(otherwise);
        const b = this.value(e.alt);
        asm.bind(done);
        return a === "boolean" && b === "boolean" ? "boolean" : "number";
      }
      case "Assign":
      case "Update":
        throw this.fail("assignments are statements; write them on their own line", e);
      case "New":
        throw this.fail("objects and arrays are created at the top level, once", e);
      case "Arrow":
        throw this.fail("an arrow function is only allowed as a handler in on()", e);
      case "Object":
        throw this.fail("object literals are only allowed as options and in the manifest", e);
      case "Array":
        throw this.fail("array literals are only allowed in a Region; use new Float32Array(n)", e);
      default:
        throw this.fail(`unexpected ${e.type}`, e);
    }
  }

  /** A property read. @param {Node} e @returns {ValueType} */
  member(e) {
    const asm = this.asm;
    const objectNode = e.object;
    const prop = e.prop;
    const sym = this.objectOf(objectNode);
    if (sym) {
      if (sym.kind === "array") {
        if (prop === "length") {
          this.pushConst(sym.length);
          return "number";
        }
        throw this.fail(`an array has only .length and [i]`, e);
      }
      if (sym.kind === "object") {
        const spec = CLASSES[/** @type {keyof typeof CLASSES} */ (sym.cls)];
        if (prop === "value") {
          asm.op("loadg", sym.edge && sym.cls === "Edge" ? sym.edge.prev : sym.slot);
          return spec.boolean ? "boolean" : "number";
        }
        if ((prop === "rose" || prop === "fell") && sym.edge) {
          asm.op("loadg", prop === "rose" ? sym.edge.rose : sym.edge.fell);
          return "boolean";
        }
        if (sym.cls === "Features" && Object.hasOwn(FEATURE_PROPS, prop)) {
          asm.op("loadg", sym.slot + 1 + FEATURE_PROPS[prop]);
          return prop === "inContact" ? "boolean" : "number";
        }
        throw this.fail(`${sym.cls} has no property '${prop}'`, e);
      }
      if (sym.kind === "const" || sym.kind === "global" || sym.kind === "function" || sym.kind === "region") {
        throw this.fail(`'${objectNode.name}' has no property '${prop}'`, e);
      }
    }
    if (objectNode.type !== "Ident") throw this.fail("properties are read from a named object", e);
    switch (objectNode.name) {
      case "imu":
        if (!Object.hasOwn(IMU_PROPS, prop)) throw this.fail(`imu has ${Object.keys(IMU_PROPS).join(", ")}`, e);
        return this.native("imu", [], { field: IMU_PROPS[prop] }, e);
      case "mag":
        if (!Object.hasOwn(MAG_PROPS, prop)) throw this.fail(`mag has ${Object.keys(MAG_PROPS).join(", ")}`, e);
        return this.native("mag", [], { field: MAG_PROPS[/** @type {keyof typeof MAG_PROPS} */ (prop)] }, e);
      case "matrix":
        if (prop === "rows" || prop === "cols") {
          this.sys(prop, e);
          return "number";
        }
        throw this.fail(`matrix.${prop} is a method or unknown; see nhos.d.ts`, e);
      case "budget":
        if (prop === "load") return this.native("budget_load", [], {}, e);
        if (prop === "graceLeft") return this.native("grace_left", [], {}, e);
        throw this.fail("budget has load and graceLeft", e);
      case "Math": {
        const v = this.constValue(e);
        if (v !== null) {
          this.pushConst(v);
          return "number";
        }
        throw this.fail(`Math.${prop} is not supported`, e);
      }
      case "Color":
        throw this.fail("a colour is only an argument of led.set and strip.pixel", e);
      default:
        throw this.fail(`unknown name '${objectNode.name}'`, objectNode);
    }
  }

  /**
   * A native op with its own state, one per place in the source unless
   * `slot` names an object's. A reading (`matrix.total()`, `imu.ax`, a
   * region's sum...) shares one slot per distinct reading instead: every
   * place computes the same value from the same frame, and a handler that
   * runs without a frame (idle, tick, button) reads what the last frame left.
   * @param {string} op
   * @param {Node[]} inputs
   * @param {Record<string, number>} params by NATIVE_LAYOUT key
   * @param {Node} at
   * @param {number} [slot]
   * @returns {ValueType}
   */
  native(op, inputs, params, at, slot) {
    const layout = NATIVE_LAYOUT[op];
    for (const input of inputs) this.value(input);
    const values = layout.params.map((key) => params[key] ?? 0);
    let state = slot;
    if (state === undefined && inputs.length === 0 && SHARED_READINGS.has(op)) {
      const key = `${op}:${values.join(",")}`;
      state = this.readings.get(key);
      if (state === undefined) {
        state = this.allocate(layout.state);
        this.readings.set(key, state);
      }
    }
    state ??= this.allocate(layout.state + (params.window ?? 0));
    const param = values.length > 0 ? this.record(values) : 0;
    this.asm.op("nat", flowOpNumber(op), state, param);
    const capability = OPS[op].capability;
    if (capability) this.caps.add(capability);
    return OPS[op].boolean ? "boolean" : "number";
  }

  /** @param {Node} e @param {number} n @param {number} [max] */
  arity(e, n, max = n) {
    if (e.args.length < n || e.args.length > max) {
      throw this.fail(`${calleeName(e.callee)}() takes ${n === max ? n : `${n} to ${max}`} argument(s)`, e);
    }
  }

  /** @param {Node} e @returns {ValueType} */
  call(e) {
    const asm = this.asm;
    const callee = e.callee;
    const args = e.args;
    if (callee.type === "Ident") {
      const name = callee.name;
      const sym = this.globals.get(name);
      const shadowed = this.fn?.scopes.some((scope) => scope.has(name));
      if (sym && sym.kind === "function" && !shadowed) {
        const target = this.functions[sym.index];
        if (args.length !== target.params.length) throw this.fail(`${name}() takes ${target.params.length} argument(s)`, e);
        if (target.entry && !target.wrap) {
          // A handler function that is also called: compiled as a function.
          throw this.fail(`'${name}' is a handler and cannot also be called`, e);
        }
        for (const arg of args) this.value(arg);
        asm.op("call", sym.index);
        /** @type {FnRecord} */ (this.fn).calls.add(sym.index);
        return target.returns;
      }
      if (shadowed || sym) throw this.fail(`'${name}' is not a function`, callee);
      return this.builtinCall(name, e);
    }
    if (callee.type === "Member" && callee.object.type === "Ident") {
      const sym = this.objectOf(callee.object);
      if (sym && sym.kind === "object") return this.objectCall(sym, callee.prop, e);
      if (sym && sym.kind === "region") return this.regionCall(sym, callee.prop, e);
      if (sym) throw this.fail(`'${callee.object.name}' has no method '${callee.prop}'`, callee);
      return this.namespaceCall(callee.object.name, callee.prop, e);
    }
    throw this.fail("call a function or a method by name", e);
  }

  /** @param {string} name @param {Node} e @returns {ValueType} */
  builtinCall(name, e) {
    const asm = this.asm;
    const args = e.args;
    switch (name) {
      case "emit": {
        this.arity(e, 2);
        const event = this.constString(args[0], "an event name");
        if (event.length > MAX_EVENT_NAME) throw this.fail(`an event name is at most ${MAX_EVENT_NAME} characters`, args[0]);
        this.pushConst(this.string(event, args[0], "an event name"));
        this.value(args[1]);
        this.sys("emit_value", e);
        return "void";
      }
      case "event": {
        this.arity(e, 2);
        const event = this.constString(args[0], "an event name");
        this.native("emit", [args[1]], { event: this.string(event, args[0], "an event name") }, e);
        asm.op("pop");
        return "void";
      }
      case "log": {
        this.arity(e, 2);
        this.pushConst(this.string(this.constString(args[0], "a label"), args[0], "a label"));
        this.value(args[1]);
        this.sys("log", e);
        return "void";
      }
      case "clamp":
        this.arity(e, 3);
        for (const arg of args) this.value(arg);
        asm.op("clamp");
        return "number";
      case "atan2deg":
        this.arity(e, 2);
        this.value(args[0]);
        this.value(args[1]);
        asm.op("atan2");
        return "number";
      case "battery":
        this.arity(e, 0);
        return this.native("battery", [], {}, e);
      case "linked":
        this.arity(e, 0);
        return this.native("linked", [], {}, e);
      case "uptime":
        this.arity(e, 0);
        return this.native("uptime", [], {}, e);
      case "now":
        this.arity(e, 0);
        this.sys("now_ms", e);
        return "number";
      case "frameSeq":
        this.arity(e, 0);
        this.sys("frame_seq", e);
        return "number";
      case "on":
        throw this.fail("on() is called at the top level", e);
      default:
        throw this.fail(`unknown function '${name}'`, e.callee);
    }
  }

  /**
   * @param {Extract<GlobalSymbol, {kind: "object"}>} sym
   * @param {string} method
   * @param {Node} e
   * @returns {ValueType}
   */
  objectCall(sym, method, e) {
    const asm = this.asm;
    const spec = CLASSES[/** @type {keyof typeof CLASSES} */ (sym.cls)];
    if (method !== "update") throw this.fail(`${sym.cls} has update() and .value`, e.callee);
    let type;
    if (sym.cls === "Edge") {
      this.arity(e, 1);
      this.value(e.args[0]);
      type = "boolean";
    } else if (sym.op === "counter_reset") {
      this.arity(e, 1, 2);
      if (e.args.length === 1) {
        // Same counter updated elsewhere with a reset: no reset here.
        this.value(e.args[0]);
        asm.op("push0");
        asm.op("nat", flowOpNumber("counter_reset"), sym.slot, this.record([sym.persist ? 1 : 0]));
        return "number";
      }
      type = this.native("counter_reset", e.args, this.objectParams(sym), e, sym.slot);
    } else {
      this.arity(e, spec.inputs);
      type = this.native(/** @type {string} */ (sym.op), e.args, this.objectParams(sym), e, sym.slot);
    }
    if (sym.edge) {
      const { prev, rose, fell } = sym.edge;
      asm.op("dup");
      asm.op("loadg", prev);
      asm.op("not");
      asm.op("and");
      asm.op("storeg", rose);
      asm.op("dup");
      asm.op("not");
      asm.op("loadg", prev);
      asm.op("and");
      asm.op("storeg", fell);
      asm.op("dup");
      asm.op("storeg", prev);
    }
    return /** @type {ValueType} */ (type);
  }

  /**
   * @param {Extract<GlobalSymbol, {kind: "region"}>} sym
   * @param {string} method
   * @param {Node} e
   */
  regionCall(sym, method, e) {
    const ops = { sum: "region_sum", peak: "region_peak", active: "region_active", rowCentroid: "region_row_centroid", colCentroid: "region_col_centroid" };
    const op = ops[/** @type {keyof typeof ops} */ (method)];
    if (!op) throw this.fail(`a Region has ${Object.keys(ops).join(", ")}`, e.callee);
    this.arity(e, method === "active" ? 1 : 0);
    const value = method === "active" ? this.constNumber(e.args[0], "a level") : 0;
    return this.native(op, [], { ...sym.params, value }, e);
  }

  /** @param {string} ns @param {string} method @param {Node} e @returns {ValueType} */
  namespaceCall(ns, method, e) {
    const asm = this.asm;
    const args = e.args;
    const key = `${ns}.${method}`;
    switch (key) {
      case "Math.abs": case "Math.sqrt": case "Math.floor":
        this.arity(e, 1);
        this.value(args[0]);
        asm.op(method);
        return "number";
      case "Math.ceil":
        this.arity(e, 1);
        this.value(args[0]);
        asm.op("neg");
        asm.op("floor");
        asm.op("neg");
        return "number";
      case "Math.round":
        this.arity(e, 1);
        this.value(args[0]);
        this.pushConst(0.5);
        asm.op("add");
        asm.op("floor");
        return "number";
      case "Math.min": case "Math.max": {
        if (args.length < 2) throw this.fail(`${key}() takes at least 2 arguments`, e);
        this.value(args[0]);
        for (let i = 1; i < args.length; i += 1) {
          this.value(args[i]);
          asm.op(method);
        }
        return "number";
      }
      case "matrix.total": case "matrix.peak": case "matrix.argMax": case "matrix.rowCentroid": case "matrix.colCentroid": {
        this.arity(e, 0);
        const op = { total: "total", peak: "peak", argMax: "arg_max", rowCentroid: "row_centroid", colCentroid: "col_centroid" }[method];
        return this.native(/** @type {string} */ (op), [], {}, e);
      }
      case "matrix.activeCells":
        this.arity(e, 1);
        return this.native("active_cells", [], { value: this.constNumber(args[0], "a level") }, e);
      case "matrix.cell":
        this.arity(e, 2);
        this.value(args[0]);
        this.value(args[1]);
        this.sys("cell", e);
        return "number";
      case "button.pressed":
        this.arity(e, 0);
        return this.native("button", [], {}, e);
      case "led.set": {
        this.arity(e, 2);
        const [r, g, b] = this.colour(args[0]);
        this.native("led", [args[1]], { r, g, b }, e);
        asm.op("pop");
        return "void";
      }
      case "strip.pixel": {
        this.arity(e, 3);
        const index = this.constInt(args[0], "a pixel index", 0, MAX_EXT_LEDS - 1);
        const [r, g, b] = this.colour(args[1]);
        this.note("strip", "while this app runs it takes the external LED strip over from the device's preset", e);
        this.native("ext_pixel", [args[2]], { index, r, g, b }, e);
        asm.op("pop");
        return "void";
      }
      case "strip.meter": {
        this.arity(e, 3);
        const lo = this.constNumber(args[1], "the low end");
        const hi = this.constNumber(args[2], "the high end");
        if (!(hi > lo)) throw this.fail("a meter's range must go from low to high", args[2]);
        this.note("strip", "while this app runs it takes the external LED strip over from the device's preset", e);
        this.native("ext_meter", [args[0]], { lo, hi }, e);
        asm.op("pop");
        return "void";
      }
      case "oled.text": case "oled.bar": {
        if (method === "text") this.arity(e, 3, 4);
        else this.arity(e, 5);
        const fixedRow = this.constValue(args[0]);
        const label = this.constString(args[1], "a label");
        if (label.length > MAX_OLED_LABEL) throw this.fail(`an OLED label is at most ${MAX_OLED_LABEL} characters`, args[1]);
        if (!OLED_LABEL_RE.test(label)) throw this.fail("an OLED label is printable ASCII only", args[1]);
        this.note("oled", "OLED rows are shown only while the device's OLED page is set to 'app'", e);
        const labelIndex = this.string(label || " ", args[1], "a label");
        const digits = method === "text" && args[3] ? this.constInt(args[3], "a number of decimals", 0, MAX_OLED_DIGITS) : 0;
        const lo = method === "bar" ? this.constNumber(args[3], "the low end") : 0;
        const hi = method === "bar" ? this.constNumber(args[4], "the high end") : 0;
        if (method === "bar" && !(hi > lo)) throw this.fail("a bar's range must go from low to high", args[4]);
        /** @param {number} row @param {Node} input */
        const draw = (row, input) => {
          if (method === "text") this.native("oled_text", [input], { row, label: labelIndex, digits }, e);
          else this.native("oled_bar", [input], { row, label: labelIndex, lo, hi }, e);
          asm.op("pop");
        };
        if (fixedRow !== null) {
          draw(this.constInt(args[0], "an OLED row", 0, OLED_ROWS - 1), args[2]);
          return "void";
        }
        // A row computed at run time: one draw per row, the matching one
        // runs (a row outside 0-3 draws nothing).
        this.value(args[2]);
        const value = this.scratchLocal();
        asm.op("storel", value);
        this.value(args[0]);
        const row = this.scratchLocal();
        asm.op("storel", row);
        const done = asm.newLabel();
        for (let r = 0; r < OLED_ROWS; r += 1) {
          const next = asm.newLabel();
          asm.op("loadl", row);
          this.pushConst(r);
          asm.op("eq");
          asm.jump("jz", next);
          draw(r, /** @type {Node} */ ({ type: "Scratch", index: value, line: e.line, col: e.col }));
          asm.jump("jmp", done);
          asm.bind(next);
        }
        asm.bind(done);
        return "void";
      }
      case "store.get": case "store.set": {
        this.arity(e, method === "get" ? 1 : 2);
        const k = this.constString(args[0], "a key");
        this.storeKeys.add(k);
        if (this.storeKeys.size > VM_STORE_MAX_KEYS) throw this.fail(`an app keeps at most ${VM_STORE_MAX_KEYS} keys`, args[0]);
        this.pushConst(this.string(k, args[0], "a key"));
        if (method === "set") this.value(args[1]);
        this.sys(method === "get" ? "store_get" : "store_set", e);
        return method === "get" ? "number" : "void";
      }
      case "store.append": {
        this.arity(e, 2, 5);
        const file = this.storeFile(args[0]);
        this.pushConst(file);
        for (let i = 1; i <= 4; i += 1) {
          if (args[i]) this.value(args[i]);
          else this.pushConst(NaN);
        }
        this.note("append", "store.append keeps 16 KB per app; when full it returns false and the device reports store_full", e);
        this.sys("store_append", e);
        return "boolean";
      }
      case "store.clear":
        this.arity(e, 1);
        this.pushConst(this.storeFile(args[0]));
        this.sys("store_clear", e);
        return "void";
      case "app.publish": {
        this.arity(e, 2);
        const topic = this.constString(args[0], "a topic");
        this.pushConst(this.string(topic, args[0], "a topic"));
        this.value(args[1]);
        this.sys("app_publish", e);
        return "void";
      }
      case "device.configGet": case "device.configSet": {
        this.arity(e, method === "configGet" ? 1 : 2);
        const configKey = this.constString(args[0], "a setting");
        if (!VM_DEVICE_CONFIG_KEYS.includes(configKey)) throw this.fail(`an app may change ${VM_DEVICE_CONFIG_KEYS.join(", ")}`, args[0]);
        this.pushConst(this.string(configKey, args[0], "a setting"));
        if (method === "configSet") {
          this.value(args[1]);
          this.note("config", "device settings an app changes are not saved, and are restored when it stops", e);
          this.sys("device_config_set", e);
          return "boolean";
        }
        this.sys("device_config_get", e);
        return "number";
      }
      case "device.stream":
        this.arity(e, 1);
        this.value(args[0]);
        this.note("stream", "streaming an app pauses is resumed when it stops", e);
        this.sys("device_stream", e);
        return "void";
      case "i2c.read8": case "i2c.read16": case "i2c.write8": case "i2c.read": case "i2c.write": {
        this.note("i2c", "I2C is available on v1.5.F and v2.0.F only; the board's own chips' addresses are refused", e);
        const addr = args[0];
        const fixed = addr ? this.constValue(addr) : null;
        if (fixed !== null && (fixed < 0x08 || fixed > 0x77 || I2C_DENIED.includes(fixed))) {
          throw this.fail(`I2C address 0x${fixed.toString(16)} is ${fixed < 0x08 || fixed > 0x77 ? "reserved" : "one of the board's own chips"}`, addr);
        }
        if (method === "read8" || method === "read16") {
          this.arity(e, 2);
          this.value(args[0]);
          this.value(args[1]);
          this.sys(`i2c_${method}`, e);
          return "number";
        }
        if (method === "write8") {
          this.arity(e, 3);
          for (const arg of args) this.value(arg);
          this.sys("i2c_write8", e);
          return "number";
        }
        if (method === "read") {
          this.arity(e, 4);
          this.value(args[0]);
          this.value(args[1]);
          this.buffer(args[2], args[3]);
          this.sys("i2c_read", e);
          return "number";
        }
        this.arity(e, 3);
        this.value(args[0]);
        this.buffer(args[1], args[2]);
        this.sys("i2c_write", e);
        return "number";
      }
      case "uart.open":
        this.arity(e, 1);
        this.value(args[0]);
        this.note("uart", "UART is available on v1.5.F and v2.0.F only (FPC1.17 TX, FPC1.16 RX); it closes when the app stops", e);
        this.sys("uart_open", e);
        return "boolean";
      case "uart.close":
        this.arity(e, 0);
        this.sys("uart_close", e);
        return "void";
      case "uart.write":
        this.arity(e, 1);
        this.value(args[0]);
        this.sys("uart_write", e);
        return "number";
      case "uart.writeBytes":
        this.arity(e, 2);
        this.buffer(args[0], args[1]);
        this.sys("uart_write_buf", e);
        return "number";
      case "uart.available":
        this.arity(e, 0);
        this.sys("uart_available", e);
        return "number";
      case "uart.read":
        this.arity(e, 0);
        this.sys("uart_read", e);
        return "number";
      default:
        throw this.fail(`unknown function '${key}'`, e.callee);
    }
  }

  /** A store file name argument, as its string index. @param {Node} node */
  storeFile(node) {
    const file = this.constString(node, "a file name");
    if (!VM_STORE_FILE_RE.test(file)) throw this.fail("a file name is 1-8 of a-z, 0-9 and _ (it becomes <name>.csv)", node);
    return this.string(file, node, "a file name");
  }

  /**
   * A (Float32Array, count) argument pair: pushes base and a count kept
   * within the array, so a transfer never touches another value.
   * @param {Node} arrayNode
   * @param {Node} countNode
   */
  buffer(arrayNode, countNode) {
    const array = this.arrayOf(arrayNode);
    const limit = Math.min(array.length, 32);
    this.pushConst(array.base);
    const fixed = this.constValue(countNode);
    if (fixed !== null) {
      if (!Number.isInteger(fixed) || fixed < 0 || fixed > limit) throw this.fail(`a count of 0 to ${limit} for this array`, countNode);
      this.pushConst(fixed);
      return;
    }
    this.value(countNode);
    this.pushConst(0);
    this.pushConst(limit);
    this.asm.op("clamp");
  }

  // -- output --

  finish() {
    // Functions laid out in index order; each one's code is self-contained.
    /** @type {number[]} */
    const code = [];
    const functions = this.functions.map((record) => {
      const bytes = record.asm.finish();
      const pc = code.length;
      for (const b of bytes) code.push(b);
      const base = this.allocate(record.locals);
      return { pc, base, args: record.params.length, locals: record.locals, rets: record.returns === "void" || record.entry ? 0 : 1 };
    });
    if (code.length > VM_MAX_CODE) throw new CompileError(`the app compiles to ${code.length} bytes of code; the limit is ${VM_MAX_CODE}`);
    if (this.consts.length > VM_MAX_CONSTS) throw new CompileError(`the app needs ${this.consts.length} constants; the limit is ${VM_MAX_CONSTS}`);

    // The node table: stateful objects, then scalar globals, named in
    // `symbols` -- what persistence and the Desktop's live view read.
    /** @type {{op: number, flags: number, slot: number}[]} */
    const nodes = [];
    /** @type {{name: string, kind: string, type: string}[]} */
    const symbols = [];
    for (const [name, sym] of this.globals) {
      if (sym.kind !== "object" || nodes.length >= VM_MAX_NODES) continue;
      const spec = CLASSES[/** @type {keyof typeof CLASSES} */ (sym.cls)];
      nodes.push({
        op: flowOpNumber(sym.op ?? "const"),
        flags: (sym.persist ? 1 : 0) | (spec.boolean ? 2 : 0),
        slot: sym.cls === "Edge" && sym.edge ? sym.edge.prev : sym.slot,
      });
      symbols.push({ name, kind: sym.cls, type: spec.boolean ? "boolean" : "number" });
    }
    for (const [name, sym] of this.globals) {
      if (sym.kind !== "global" || nodes.length >= VM_MAX_NODES) continue;
      nodes.push({ op: flowOpNumber("const"), flags: sym.type === "boolean" ? 2 : 0, slot: sym.slot });
      symbols.push({ name, kind: "let", type: sym.type });
    }

    const capabilities = [...this.caps].sort();
    /** @type {import("./vm.mjs").VmImageParts} */
    const parts = {
      code: Uint8Array.from(code),
      consts: this.consts,
      strings: this.strings,
      functions,
      entries: this.entries,
      init: this.init,
      nodes,
      arena: Math.max(1, this.arena),
      stack: VM_MAX_STACK,
    };
    let verified;
    try {
      verified = verifyImage(encodeImage(parts), { capabilities });
      parts.stack = Math.max(1, verified.maxStack);
      verified = verifyImage(encodeImage(parts), { capabilities });
    } catch (error) {
      if (error instanceof VmImageError) {
        const reason = { stack_too_small: "expressions nest too deeply", call_too_deep: "functions call each other too deeply (at most 8)" }[error.message];
        throw new CompileError(reason ?? `the compiled image was refused: ${error.message}`);
      }
      throw error;
    }
    const image = encodeImage(parts);

    let minOs = VM_TS_MIN_OS;
    for (const cap of capabilities) {
      const since = CAPABILITY_SINCE[cap];
      if (since && compareVersions(since, minOs) > 0) minOs = since;
    }
    /** @type {Record<string, any>} */
    const manifest = { ...this.manifest };
    if (!("name" in manifest)) manifest.name = manifest.id;
    manifest.capabilities = capabilities;
    manifest.min_os = minOs;
    const pkg = {
      nhapp: 1,
      kind: "flow",
      name: String(manifest.id),
      manifest,
      vm: toBase64(image),
      symbols,
    };
    return {
      pkg,
      verified,
      symbols,
      image,
    };
  }
}

const BUILTIN_NAMES = new Set([
  ...LANGUAGE.globals, ...LANGUAGE.classes, "NaN", "Infinity", "manifest",
]);

/**
 * @param {string|null} annotation
 * @param {Node|null} init
 * @param {Node|Token} at
 * @param {Compiler} compiler
 * @returns {ValueType}
 */
function declaredType(annotation, init, at, compiler) {
  if (annotation) return typeOf(annotation, at, compiler);
  if (init && (init.type === "Bool" || (init.type === "Unary" && init.op === "!"))) return "boolean";
  return "number";
}

/** @param {string|null} annotation @param {Node|Token} at @param {Compiler} compiler @returns {ValueType} */
function typeOf(annotation, at, compiler) {
  if (annotation === null || annotation === "number") return "number";
  if (annotation === "boolean") return "boolean";
  throw compiler.fail(`a value is a number or a boolean, not ${annotation}`, at);
}

/** @param {string|null} annotation @param {Node} at @param {Compiler} compiler @returns {ValueType} */
function returnType(annotation, at, compiler) {
  if (annotation === null || annotation === "void") return annotation === null ? "void" : "void";
  return typeOf(annotation, at, compiler);
}

/** @param {Node} callee */
function calleeName(callee) {
  if (callee.type === "Ident") return callee.name;
  if (callee.type === "Member" && callee.object.type === "Ident") return `${callee.object.name}.${callee.prop}`;
  return "this";
}

// --- driver ------------------------------------------------------------------

/**
 * @typedef {object} CompileReport
 * @property {number} codeBytes
 * @property {number} arenaSlots
 * @property {number} poolBytes RAM the image takes from the device's app pool
 * @property {number} memoryBytes all the app takes of the pool while it runs: control block, image and store (v2.1.0)
 * @property {number} maxStack
 * @property {boolean} loopFree
 * @property {number|null} estimatedUs worst case per frame at `cellCount`; null with loops (time-sliced)
 * @property {number} cellCount
 * @property {string} minOs
 * @property {string[]} capabilities
 * @property {string[]} dangerous capabilities the operator must allow
 * @property {{message: string, line: number|null, col: number|null}[]} notes
 * @property {{name: string, kind: string, type: string}[]} symbols
 */

/**
 * Compile an app.ts source. Throws CompileError on the first error.
 * @param {string} source
 * @param {{cellCount?: number}} [options]
 * @returns {{package: Record<string, any>, report: CompileReport}}
 */
export function compileSource(source, options = {}) {
  const cellCount = options.cellCount ?? DEFAULT_CELL_COUNT;
  const program = new Parser(tokenize(source)).parseProgram();
  const compiler = new Compiler(program);
  const { pkg, image, symbols } = compiler.compile();
  const verified = verifyImage(image, { capabilities: pkg.manifest.capabilities, cellCount });
  /** @type {CompileReport} */
  const report = {
    codeBytes: verified.image.code.length,
    arenaSlots: verified.image.arena,
    poolBytes: verified.poolBytes,
    memoryBytes: appMemoryBytes(verified.poolBytes, pkg.manifest.capabilities),
    maxStack: verified.maxStack,
    loopFree: verified.loopFree,
    estimatedUs: verified.loopFree ? Math.ceil(verified.estimatedNs / 1000) : null,
    cellCount,
    minOs: pkg.manifest.min_os,
    capabilities: pkg.manifest.capabilities,
    dangerous: pkg.manifest.capabilities.filter((/** @type {string} */ cap) => DANGEROUS_CAPABILITIES.includes(cap)),
    notes: compiler.notes,
    symbols,
  };
  return { package: pkg, report };
}
