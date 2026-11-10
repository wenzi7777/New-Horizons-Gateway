// @ts-nocheck -- ported JavaScript, kept close to the original so the two stay comparable.
// Ported from the Desktop's frontend/tests/sdkProject.test.mjs (node:test + Vite SSR -> vitest).
import assert from 'node:assert/strict';
import { test } from 'vitest';

import * as project from '../../src/renderer/areas/apps/lib/sdkProject';
import * as language from '../../src/renderer/areas/apps/lib/nhsLanguage';
import * as sdk from '../../src/renderer/areas/apps/sdk/lib/index.mjs';
import * as state from '@codemirror/state';

const modules = Promise.resolve({ project, language, sdk, state });


test("both new-app templates are accepted by the device as written", async () => {
  // An author's first sight of the SDK must not be an error.
  const { project, sdk } = await modules;
  const flow = sdk.analyzeFlow(project.flowTemplate("my_app", "jane"));
  assert.equal(flow.ok, true, JSON.stringify(flow.diagnostics));
  assert.ok(flow.package.manifest.capabilities.includes("drive_led"));
  const readout = sdk.analyzeReadout(project.readoutTemplate("my_readout", "jane"));
  assert.equal(readout.ok, true, JSON.stringify(readout.diagnostics));
});

test("an author name the lexer would split is made into one word", async () => {
  const { project, sdk } = await modules;
  const analysis = sdk.analyzeFlow(project.flowTemplate("my_app", "Jane Doe"));
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  assert.equal(analysis.package.manifest.author, "Jane_Doe");
});

test("the app id is read without compiling, from either kind", async () => {
  const { project } = await modules;
  assert.equal(project.appIdOf({ kind: "flow", source: "# hi\napp heel_strike {\n}" }), "heel_strike");
  assert.equal(project.appIdOf({ kind: "readout", source: '{"manifest": {"id": "sysmon"}}' }), "sysmon");
  // A readout mid-edit is not valid JSON; the id is still found.
  assert.equal(project.appIdOf({ kind: "readout", source: '{"manifest": {"id": "sysmon", ' }), "sysmon");
});

test("new drafts get an id no other draft uses", async () => {
  const { project } = await modules;
  const drafts = [
    { kind: "flow", source: "app my_app {}" },
    { kind: "flow", source: "app my_app2 {}" },
  ];
  assert.equal(project.freshAppId(drafts), "my_app3");
  assert.equal(project.freshAppId([]), "my_app");
});

test("opened files are recognised by name and content", async () => {
  const { project } = await modules;
  assert.equal(project.kindOfFile("app.nhs", "anything"), "flow");
  assert.equal(project.kindOfFile("readout.json", '{"kind": "readout"}'), "readout");
  // A .nha is a compiled package, not a source: there is nothing to edit.
  assert.equal(project.kindOfFile("app.nha", '{"kind": "flow"}'), null);
  assert.equal(project.kindOfFile("data.json", '{"kind": "flow"}'), null);
});

test("export carries the exact bytes the library build would publish", async () => {
  const { project, sdk } = await modules;
  const draft = project.newProject("flow", project.flowTemplate("my_app", "jane"));
  const analysis = sdk.analyzeFlow(draft.source);
  const files = project.exportFiles(draft, analysis);
  assert.deepEqual(files.map((file) => file.filename), ["app.nhs", "app.nha", "meta.json", "README.md"]);
  assert.deepEqual(files[1].content, analysis.bytes);
  assert.equal(new TextDecoder().decode(files[1].content), sdk.canonicalText(analysis.package));
  const meta = JSON.parse(files[2].content);
  assert.deepEqual(Object.keys(meta.name), ["en", "ja", "zh-CN"]);
});

test("nothing is exported while the device would refuse the app", async () => {
  const { project, sdk } = await modules;
  const draft = project.newProject("flow", project.flowTemplate("my_app", "jane").replace("led green", "led purple"));
  const analysis = sdk.analyzeFlow(draft.source);
  assert.equal(analysis.ok, false);
  assert.deepEqual(project.exportFiles(draft, analysis), []);
});

test("device targets come from each device's matrix shape", async () => {
  const { project } = await modules;
  const targets = project.deviceTargets([
    { uid: "A", displayName: "Left insole", firmwareVersion: "v1.2.3", matrix: { rows: 14, cols: 14 } },
    { uid: "B", displayName: "Unknown", matrix: null },
    { uid: "C", displayName: "Mat", matrix: { rows: 15, cols: 15 } },
  ]);
  assert.deepEqual(targets.map((t) => [t.key, t.rows * t.cols]), [["device:A", 196], ["device:C", 225]]);
  // Carried so the Build tab can warn before an install would be refused.
  assert.equal(targets[0].firmware, "v1.2.3");
  assert.equal(targets[1].firmware, undefined);
});

test("device targets name the board when its hardware model is known", async () => {
  const { project } = await modules;
  const [known, unknown] = project.deviceTargets([
    { uid: "A", displayName: "NHOS-A", hardwareModel: "VD-CTL/R v1.5.F 2026.7", matrix: { rows: 2, cols: 2 } },
    { uid: "B", displayName: "NHOS-B", hardwareModel: "TIA-CTL v9.9 2027.1", matrix: { rows: 5, cols: 5 } },
  ]);
  assert.equal(known.label, "NHOS-A · v1.5.F · 2 × 2");
  assert.equal(known.board.externalLeds, 9);
  // A board this list does not know yet still gets a short name.
  assert.equal(unknown.label, "NHOS-B · v9.9 · 5 × 5");
  assert.equal(unknown.board, undefined);
  // Every name the firmware has used for a board names the same board.
  const renamed = project.deviceTargets([
    { uid: "C", displayName: "NHOS-C", hardwareModel: "TIA-CTL v1.5.F 2026.7", matrix: { rows: 2, cols: 2 } },
    { uid: "D", displayName: "NHOS-D", hardwareModel: "TIA-CTL/R v1.5.F 2026.7", matrix: { rows: 2, cols: 2 } },
  ]);
  for (const target of renamed) assert.equal(target.board.externalLeds, 9);
});

test("boards mirror the firmware's BoardConfig.h", async () => {
  const { project } = await modules;
  const shapes = Object.fromEntries(project.BOARDS.map((b) => [b.id, [b.rows, b.cols, b.oled, b.button, b.externalLeds]]));
  assert.deepEqual(shapes, {
    v23d: [15, 15, false, false, 0],
    v10f: [10, 21, true, true, 3],
    v15f: [14, 14, true, true, 9],
    v20f: [14, 14, true, true, 9],
    v22c: [10, 12, false, false, 0],
    v21: [10, 12, false, false, 0],
  });
});

test("a virtual device's matrix stays within its board", async () => {
  const { project } = await modules;
  const board = project.boardById("v21");
  assert.deepEqual(project.clampShape(board, 40, 0), { rows: 10, cols: 1 });
  assert.deepEqual(project.clampShape(board, 3.7, 5), { rows: 3, cols: 5 });
  const target = project.virtualTarget({ ...project.defaultVirtualDevice(), boardId: "v21", rows: 4, cols: 6 }, "Virtual");
  assert.equal(target.key, project.VIRTUAL_TARGET_KEY);
  assert.equal(target.label, "Virtual · v2.1 GCU LTS · 4 × 6");
  assert.equal(target.rows * target.cols, 24);
});

test("the runtime share shrinks as more apps run", async () => {
  const { project } = await modules;
  const shares = project.runtimeShares(60);
  assert.deepEqual(shares.map((s) => s.apps), [1, 2, 3, 4]);
  // 250 permille of a 60 Hz frame, divided among the running apps.
  assert.equal(shares[0].us, 4166);
  assert.equal(shares[3].us, 1041);
});

test("diagnostics land on the characters the compiler pointed at", async () => {
  const { language, state } = await modules;
  const doc = state.Text.of(["app x {", "}", "signal a = nope"]);
  const [diagnostic] = language.toCmDiagnostics(doc, [
    { severity: "error", message: "unknown value 'nope'", line: 3, col: 12, endCol: 16, code: null },
  ]);
  assert.equal(doc.sliceString(diagnostic.from, diagnostic.to), "nope");
  // An error with no place in the source still shows, on the first line.
  const [whole] = language.toCmDiagnostics(doc, [
    { severity: "error", message: "over_budget", line: null, col: null, endCol: null, code: "over_budget" },
  ]);
  assert.equal(whole.from, 0);
});

test("every function the language has is documented in the editor", async () => {
  // Completion and the Reference tab both read these; a function added to the
  // SDK without a line here would show up blank in both.
  const { language, sdk } = await modules;
  const missing = sdk.LANGUAGE.functions.filter((name) => !language.functionDoc(name)?.info);
  assert.deepEqual(missing, []);
});

test("manifest fields read and write back in a flow app", async () => {
  const { project, sdk } = await modules;
  const flow = { kind: "flow", source: project.flowTemplate("my_app", "jane") };
  assert.deepEqual(project.readManifestFields(flow), {
    name: "My App",
    author: "jane",
    summary: "What this app does, in one line.",
  });
  let source = project.writeManifestField(flow, "author", "Nick Xu");
  source = project.writeManifestField({ kind: "flow", source }, "name", "Grip \"Meter\"");
  source = project.writeManifestField({ kind: "flow", source }, "summary", "Counts grips.");
  const fields = project.readManifestFields({ kind: "flow", source });
  assert.deepEqual(fields, { name: "Grip Meter", author: "Nick_Xu", summary: "Counts grips." });
  // Still a valid app, and nothing outside the header moved.
  const analysis = sdk.analyzeFlow(source);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  assert.equal(analysis.package.manifest.author, "Nick_Xu");
  assert.ok(source.includes("led green when pressed"));
});

test("manifest fields read and write back in a readout", async () => {
  const { project, sdk } = await modules;
  const readout = { kind: "readout", source: project.readoutTemplate("my_readout", "jane") };
  const source = project.writeManifestField(readout, "author", "nick");
  assert.equal(project.readManifestFields({ kind: "readout", source }).author, "nick");
  assert.equal(sdk.analyzeReadout(source).ok, true);
  // Mid-edit JSON is left alone rather than clobbered.
  assert.equal(project.writeManifestField({ kind: "readout", source: "{ broken" }, "author", "x"), "{ broken");
});

test("the panel template is accepted as written, by the SDK and by the Desktop's gate", async () => {
  const { project, sdk } = await modules;
  const source = project.panelTemplate("my_panel", "jane");
  const analysis = sdk.analyzePanel(source);
  assert.equal(analysis.ok, true, JSON.stringify(analysis.diagnostics));
  assert.equal(analysis.kind, "panel");
  assert.deepEqual(analysis.package.manifest.permissions, ["task_control"]);
  assert.equal(analysis.validation.minOs, sdk.panelset.PANEL_MIN_OS);
  // It shows both condition forms the author will copy from.
  const doc = JSON.parse(source);
  assert.ok(doc.panel.actions.some((action) => action.when && action.hidden_when));
});

test("panel drafts survive a reload and open, export and switch kind as panels", async () => {
  const { project } = await modules;
  assert.equal(project.kindOfFile("panel.json", '{"kind": "panel"}'), "panel");
  assert.equal(project.viewKindOfSource('{"kind": "panel"}'), "panel");
  assert.equal(project.viewKindOfSource('{"kind": "readout"}'), "readout");
  assert.equal(project.viewKindOfSource('{"kind": "pan'), null);
  assert.equal(project.sourceFilename("panel"), "panel.json");
  assert.equal(project.sourceFilename("readout"), "readout.json");
  assert.equal(project.sourceFilename("flow"), "app.nhs");
  assert.equal(project.isViewKind("panel"), true);
  assert.equal(project.isViewKind("flow"), false);
  assert.equal(project.appIdOf({ kind: "panel", source: '{"manifest": {"id": "sysmon"}}' }), "sysmon");
});

test("a panel exports panel.json and lists its permissions and actions", async () => {
  const { project, sdk } = await modules;
  const source = project.panelTemplate("my_panel", "jane");
  const draft = project.newProject("panel", source);
  const files = project.exportFiles(draft, sdk.analyzePanel(source));
  assert.deepEqual(files.map((file) => file.filename), ["panel.json", "app.nha", "meta.json", "README.md"]);
  const readme = files.find((file) => file.filename === "README.md").content;
  assert.ok(readme.includes("## Permissions") && readme.includes("`task_control`"));
  assert.ok(readme.includes("(`task_stop`)"));
});
