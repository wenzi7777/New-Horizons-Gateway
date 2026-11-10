// Package validation: the defence gate before anything is written to a
// device. A port of the Desktop's app_library.py validate_package() and its
// panel rules, with the same error codes. The library's own CI is the
// authoring gate; this one keeps a hand-edited, stale or foreign catalog from
// putting a malformed package on a device.

import { CAPABILITIES, KNOWN_OPS, MAX_EVENT_NAME, MAX_NODES } from './contract';

export const DEVICE_APP_DIR = 'apps';
export const APP_ID_RE = /^[a-z][a-z0-9_]{0,14}$/;
export const RESERVED_APP_IDS: ReadonlySet<string> = new Set(['index']);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const MIN_OS_RE = /^v?\d+\.\d+\.\d+$/;

/** Commands a readout may poll; nothing that renders in an operator's window may write to a device. */
export const READOUT_SOURCES: ReadonlySet<string> = new Set([
  'task_list', 'service_list', 'app_list', 'app_list_packages', 'app_events',
  'memory_status', 'scan_health', 'storage_status', 'status', 'capabilities',
  'sensor_sample', 'sysmon', 'thread_list',
]);
const READOUT_SECTION_KINDS: ReadonlySet<string> = new Set(['stats', 'table', 'chart']);
const PANEL_SECTION_KINDS: ReadonlySet<string> = new Set([...READOUT_SECTION_KINDS, 'tabs', 'run']);

/** What a panel may send, per declared permission (the App Library's panelset.mjs). */
export const PANEL_PERMISSIONS: Readonly<Record<string, readonly string[]>> = {
  task_control: ['task_stop', 'task_start', 'task_set_period'],
  service_control: ['service_stop', 'service_start', 'service_restart'],
  app_control: ['app_stop', 'app_start', 'app_revive'],
};
const PANEL_FORBIDDEN_PREFIXES = ['set_', 'file_write', 'file_delete', 'reboot', 'calibration_'];
const PANEL_FORBIDDEN_COMMANDS: ReadonlySet<string> = new Set([
  'file_delete', 'app_install', 'app_uninstall', 'app_activate', 'app_deactivate',
  'app_enable', 'app_disable', 'app_load_flow', 'app_unload_flow', 'app_reindex',
  'enter_maintenance', 'exit_maintenance', 'apply_update', 'check_update',
  'config_set', 'power_set_state', 'resync_battery_gauge', 'factory_reset', 'ota_update',
]);
export const MAX_PANEL_ACTIONS = 16;
export const MAX_PANEL_TABS = 8;
const PANEL_TEMPLATE_RE = /^\$(row|input)\.([A-Za-z_][A-Za-z0-9_]*)$/;
const PANEL_ROW_TEMPLATE_RE = /^\$row\.[A-Za-z_][A-Za-z0-9_]*$/;

/** A package that must not be sent to a device; `message` is the code. */
export class AppPackageError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'AppPackageError';
  }
}

export type PackageKind = 'flow' | 'readout' | 'panel';

export interface PackageSummary {
  id: string;
  version: string;
  min_os: string;
  kind: PackageKind;
  nodes: number;
  capabilities: string[];
  permissions?: string[];
  device_path: string;
}

type Rec = Record<string, unknown>;

function require_(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AppPackageError(code);
}

const isRecord = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);
/** Python's str() of a value for the few places the Desktop compares str(x). */
const pyStr = (value: unknown): string => (value === null || value === undefined ? 'None' : String(value));
/** Python's `str(x or default)`. */
const orStr = (value: unknown, fallback: string): string => (value ? String(value) : fallback);

export function panelCommandAllowed(command: string, permissions: readonly string[]): boolean {
  if (PANEL_FORBIDDEN_COMMANDS.has(command) || PANEL_FORBIDDEN_PREFIXES.some((prefix) => command.startsWith(prefix))) return false;
  return permissions.some((permission) => (PANEL_PERMISSIONS[permission] ?? []).includes(command));
}

function isConstant(value: unknown): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  // A string that looks like a template must be one.
  return typeof value === 'string' && !value.startsWith('$');
}

function* walkSections(sections: unknown[], depth = 0): Generator<[Rec, number]> {
  for (const section of sections) {
    require_(isRecord(section), 'invalid_section');
    yield [section, depth];
    if (section.kind === 'tabs') {
      const tabs = section.tabs;
      require_(Array.isArray(tabs) && tabs.length > 0, 'missing_tabs');
      require_(tabs.length <= MAX_PANEL_TABS, 'too_many_tabs');
      for (const tab of tabs) {
        require_(isRecord(tab) && Array.isArray(tab.sections), 'invalid_tab');
        yield* walkSections(tab.sections as unknown[], depth + 1);
      }
    }
  }
}

function validateView(spec: Rec, sectionKinds: ReadonlySet<string>): void {
  const sources = spec.sources;
  require_(Array.isArray(sources) && sources.length > 0, 'missing_sources');
  for (const source of sources) {
    require_(isRecord(source), 'invalid_source');
    require_(READOUT_SOURCES.has(pyStr(source.command)), 'readout_source_not_allowed');
  }
  const sections = spec.sections;
  require_(Array.isArray(sections) && sections.length > 0, 'missing_sections');
  for (const [section, depth] of walkSections(sections)) {
    require_(sectionKinds.has(pyStr(section.kind)), 'unknown_section_kind');
    require_(!(section.kind === 'tabs' && depth > 0), 'nested_tabs');
  }
}

function validatePanelActions(panel: Rec, permissions: readonly string[]): void {
  const actions = panel.actions ?? [];
  require_(Array.isArray(actions), 'invalid_actions');
  require_(actions.length <= MAX_PANEL_ACTIONS, 'too_many_actions');
  const ids = new Set<string>();
  for (const action of actions) {
    require_(isRecord(action), 'invalid_action');
    const actionId = action.id;
    require_(typeof actionId === 'string' && actionId && !ids.has(actionId), 'invalid_action');
    ids.add(actionId);
    require_(panelCommandAllowed(orStr(action.command, ''), permissions), 'panel_action_not_permitted');
    const input = action.input;
    require_(input === undefined || input === null || (isRecord(input) && typeof input.field === 'string' && input.field), 'invalid_input');
    const userInput = isRecord(input) ? input : null;
    const args = action.args ?? {};
    require_(isRecord(args), 'invalid_arg_template');
    for (const [key, value] of Object.entries(args)) {
      require_(key !== 'command' && key !== 'request_id', 'invalid_arg_name');
      if (typeof value === 'string' && value.startsWith('$')) {
        const match = PANEL_TEMPLATE_RE.exec(value);
        require_(match !== null, 'invalid_arg_template');
        if (match[1] === 'input') require_(userInput !== null && userInput.field === match[2], 'input_not_declared');
      } else {
        require_(isConstant(value), 'invalid_arg_template');
      }
    }
    if (userInput !== null && 'default' in userInput) {
      const fallback = userInput.default;
      require_(isConstant(fallback) || (typeof fallback === 'string' && PANEL_ROW_TEMPLATE_RE.test(fallback)), 'invalid_arg_template');
    }
  }
  const sources = Array.isArray(panel.sources) ? panel.sources : [];
  const sourceIds = new Set(sources.filter(isRecord).map((source) => pyStr(source.id)));
  for (const [section] of walkSections((panel.sections as unknown[]) ?? [])) {
    const rowActions = section.row_actions ?? [];
    require_(Array.isArray(rowActions), 'invalid_section');
    for (const id of rowActions) require_(typeof id === 'string' && ids.has(id), 'unknown_action');
    if (section.kind === 'run') {
      const candidates = section.candidates;
      require_(Array.isArray(candidates) && candidates.length > 0, 'missing_candidates');
      for (const candidate of candidates) {
        require_(isRecord(candidate), 'invalid_section');
        require_(typeof candidate.action === 'string' && ids.has(candidate.action), 'unknown_action');
        require_(sourceIds.has(pyStr(candidate.source)), 'unknown_source');
      }
    }
  }
}

/** Structural checks, no I/O. Throws AppPackageError, returns a summary. */
export function validatePackage(doc: unknown): PackageSummary {
  require_(isRecord(doc), 'not_a_package');
  require_(doc.nhapp === 1, 'unsupported_package_version');
  const kind = orStr(doc.kind, 'flow');
  require_(kind === 'flow' || kind === 'readout' || kind === 'panel', 'unsupported_kind');

  const manifest = doc.manifest;
  require_(isRecord(manifest), 'missing_manifest');
  const appId = orStr(manifest.id, '');
  // "/files/apps/<id>.nha" must fit SPIFFS' 31-character path limit.
  require_(APP_ID_RE.test(appId), 'invalid_id');
  require_(!RESERVED_APP_IDS.has(appId), 'reserved_id');
  require_(SEMVER_RE.test(orStr(manifest.version, '')), 'invalid_version');
  for (const field of ['name', 'author', 'summary']) require_(orStr(manifest[field], '').trim(), 'invalid_manifest');
  const minOs = orStr(manifest.min_os, 'v1.0.0');
  require_(MIN_OS_RE.test(minOs), 'invalid_min_os');

  const capabilities = manifest.capabilities ?? [];
  require_(Array.isArray(capabilities), 'invalid_manifest');
  for (const capability of capabilities) require_(typeof capability === 'string' && CAPABILITIES.has(capability), 'unknown_capability');

  const permissions = manifest.permissions ?? [];
  require_(Array.isArray(permissions), 'invalid_manifest');
  require_(kind === 'panel' || permissions.length === 0, 'permissions_need_a_panel');
  for (const permission of permissions) require_(typeof permission === 'string' && permission in PANEL_PERMISSIONS, 'unknown_permission');

  const base = {
    id: appId,
    version: String(manifest.version),
    min_os: minOs,
    capabilities: [...(capabilities as string[])],
    device_path: `${DEVICE_APP_DIR}/${appId}.nha`,
  };

  if (kind === 'panel') {
    require_(!('nodes' in doc) && !('readout' in doc), 'panel_must_not_declare_nodes');
    const panel = doc.panel;
    require_(isRecord(panel), 'missing_panel');
    validateView(panel, PANEL_SECTION_KINDS);
    validatePanelActions(panel, permissions as string[]);
    return { ...base, kind: 'panel', nodes: 0, permissions: [...(permissions as string[])] };
  }

  if (kind === 'readout') {
    require_(!('nodes' in doc), 'readout_must_not_declare_nodes');
    const readout = doc.readout;
    require_(isRecord(readout), 'missing_readout');
    require_(!('actions' in readout), 'readout_must_not_declare_actions');
    validateView(readout, READOUT_SECTION_KINDS);
    return { ...base, kind: 'readout', nodes: 0 };
  }

  require_(!('readout' in doc) && !('panel' in doc), 'flow_must_not_declare_a_readout');
  const nodes = doc.nodes;
  require_(Array.isArray(nodes), 'missing_nodes');
  require_(nodes.length > 0, 'empty_graph');
  require_(nodes.length <= MAX_NODES, 'too_many_nodes');
  nodes.forEach((node, index) => {
    require_(isRecord(node), 'invalid_node');
    require_(KNOWN_OPS.has(orStr(node.op, '')), 'unknown_op');
    let refs = node.in ?? [];
    if (typeof refs === 'number' && Number.isInteger(refs)) refs = [refs];
    require_(Array.isArray(refs), 'invalid_node');
    // Backward-only references are what make a cycle unrepresentable.
    for (const ref of refs) require_(Number.isInteger(ref) && typeof ref === 'number' && ref >= 0 && ref < index, 'input_out_of_order');
    const event = node.event;
    if (event !== undefined && event !== null) {
      require_(typeof event === 'string' && event.length > 0 && event.length <= MAX_EVENT_NAME, 'invalid_event_name');
    }
  });
  return { ...base, kind: 'flow', nodes: nodes.length };
}
