// Gateway self-updates (update_manager.py), for the single-binary Gateway.
//
// Kept from Python: the channel rules, check() (12 s timeout, required fields,
// release notes and their translations), required_update from any newer
// version (manifest or server), state()/update_block() field names, the
// progress figures and the phase names the WebUI and Desktop know.
//
// Changed on purpose:
//  - the manifest is gateway-bin-{latest,beta}.json with per-platform assets
//    (manifest.ts); a release without an asset for this platform is "no update
//    here", never a lock: required_update is not reported for it;
//  - the download is held in memory, checked against the manifest's size and
//    sha256, then handed to the host's UpdateInstaller (installer.ts) instead
//    of being unzipped into an inactive slot;
//  - Python's worker thread is an async sequence; startUpdate() resolves once it
//    has started and waitForIdle() resolves when it has finished.
//
// Phases: idle -> checking -> checked | error
//         -> downloading -> downloaded -> staging (installer.stage) -> staged
//         -> switch_pending (installer.activate, then the restart callback)
//         restart() with nothing staged -> restarting (soft restart)
import type { Json, UpdateControl } from '../contracts';
import type { Clock, Http, Logger, Sha256 } from '../ports';
import { compareVersions } from '../versioning';
import { silentLogger } from '../ports';
import { pyStr, pyStrip, pyTruthy } from '../py';
import { pyIsoUtcFromEpochUs } from '../upstream/pyIso';
import { DEFAULT_UPDATE_CHANNEL, isNewerVersion, normalizeChannel, type UpdateChannel } from '../versioning';
import type { UpdateInstaller } from './installer';
import { binManifestUrlFor, localizedNotesUrl, NOTES_TRANSLATIONS, parseBinManifest, type BinManifest } from './manifest';

export const DEFAULT_AUTO_CHECK_INTERVAL_SEC = 600;
export const MANIFEST_TIMEOUT_MS = 12_000;
export const NOTES_TIMEOUT_MS = 12_000;
/**
 * Python's urlopen(timeout=30) bounded each socket read, not the transfer.
 * Http.getBytes does not say which it bounds, so this is long enough for a
 * whole binary on a slow link either way.
 */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/** Labels for state() slot fields; there are no slots any more (installer.ts). */
export const ACTIVE_SLOT_LABEL = 'current';
export const STAGED_SLOT_LABEL = 'staged';

export interface UpdateManagerOptions {
  /** The running version (Python's __version__). */
  version: string;
  /** Which manifest asset this host runs (manifest.ts PLATFORM_KEYS). */
  platformKey: string;
  http: Http;
  sha256: Sha256;
  clock: Clock;
  installer: UpdateInstaller;
  channel?: string;
  /** Overrides the channel's manifest (Python: NEWHORIZONS_GATEWAY_UPDATE_MANIFEST). */
  manifestUrl?: string;
  /** Python: NEWHORIZONS_GATEWAY_UPDATE_INTERVAL_SEC; at least 60. */
  autoCheckIntervalSec?: number;
  logger?: Logger;
}

export class GatewayUpdateManager implements UpdateControl {
  readonly currentVersion: string;
  readonly platformKey: string;
  updateChannel: UpdateChannel;
  latestManifest: BinManifest | null = null;
  phase = 'idle';
  lastError = '';
  restartRequired = false;
  manualUpdateRequired = false;
  latestGatewayVersion = '';
  updateSignalSource = '';
  notesMarkdown = '';
  notesTranslations: Record<string, string> = {};
  lastCheckedAt = '';
  readonly autoCheckIntervalSec: number;
  downloadProgressPct = 0;
  applyProgressPct = 0;
  busy = false;
  downloadedSha256 = '';
  /**
   * Set by restart() when nothing is staged: the host re-runs the runtime
   * in-process instead of exiting (Python main.run returned RESTART).
   */
  softRestartRequested = false;

  private readonly http: Http;
  private readonly sha256: Sha256;
  private readonly clock: Clock;
  private readonly installer: UpdateInstaller;
  private readonly logger: Logger;
  private readonly manifestOverride: string;
  private requiredUpdateRaw = false;
  /** gateway_hello_ack's version on its own: check() overwrites latestGatewayVersion with the manifest's. */
  private serverLatestVersion = '';
  private downloadedBytes: Uint8Array | null = null;
  private downloaded = false;
  private lastManifestCheckMs: number | null = null;
  private restartCallback: (() => void) | null = null;
  private worker: Promise<void> | null = null;
  private checkInFlight: Promise<Json> | null = null;
  private switchInFlight: Promise<void> | null = null;

  constructor(options: UpdateManagerOptions) {
    this.currentVersion = options.version;
    this.platformKey = options.platformKey;
    this.http = options.http;
    this.sha256 = options.sha256;
    this.clock = options.clock;
    this.installer = options.installer;
    this.logger = options.logger ?? silentLogger;
    this.manifestOverride = options.manifestUrl ?? '';
    this.updateChannel = normalizeChannel(options.channel ?? DEFAULT_UPDATE_CHANNEL);
    this.autoCheckIntervalSec = Math.max(60, Math.trunc(options.autoCheckIntervalSec ?? DEFAULT_AUTO_CHECK_INTERVAL_SEC));
  }

  get autoCheckIntervalMs(): number {
    return this.autoCheckIntervalSec * 1000;
  }

  /**
   * A newer version is required -- unless the checked manifest is that release
   * (or newer) and has no build for this platform, which would otherwise lock
   * the Gateway's config with nothing it could ever install.
   */
  get requiredUpdate(): boolean {
    return this.requiredUpdateRaw && !this.platformUnsupported() && !this.latestRolledBack();
  }

  /** The newest known version is the one that already failed its health check here. */
  private latestRolledBack(): boolean {
    const rolledBack = this.installer.bootStatus?.().rolledBackVersion ?? '';
    if (!rolledBack) return false;
    const latest = this.latestGatewayVersion || this.serverLatestVersion;
    return Boolean(latest) && compareVersions(latest, rolledBack) === 0;
  }

  manifestUrl(): string {
    return this.manifestOverride || binManifestUrlFor(this.updateChannel);
  }

  setRestartCallback(callback: () => void): void {
    this.restartCallback = callback;
  }

  /**
   * What the old channel said is dropped: a beta "required update" must not
   * survive a switch back to stable. Leaving beta never downgrades -- an older
   * stable is just not newer.
   */
  setChannel(channel: string): Json {
    const normalized = normalizeChannel(channel);
    if (normalized !== this.updateChannel) {
      this.updateChannel = normalized;
      if (!this.busy) {
        this.latestManifest = null;
        this.latestGatewayVersion = '';
        this.updateSignalSource = '';
        this.requiredUpdateRaw = false;
        this.serverLatestVersion = '';
        this.notesMarkdown = '';
        this.notesTranslations = {};
        this.lastManifestCheckMs = null;
      }
    }
    return this.state();
  }

  state(): Json {
    const manifest = this.latestManifest;
    const latestVersion = manifest?.version ?? '';
    const asset = manifest?.asset ?? null;
    const staged = this.installer.staged();
    const boot = this.installer.bootStatus?.() ?? {};
    const rollbackReason = boot.rollbackReason ?? '';
    const requiredUpdate = this.requiredUpdate;
    const stagedVersion = staged?.version ?? '';
    return {
      phase: this.phase,
      current_version: this.currentVersion,
      latest_gateway_version: this.latestGatewayVersion,
      latest_version: latestVersion,
      update_signal_source: this.updateSignalSource,
      required_update: requiredUpdate,
      update_available: Boolean(
        requiredUpdate || (latestVersion && asset && isNewerVersion(latestVersion, this.currentVersion)),
      ),
      manifest_url: this.manifestUrl(),
      update_channel: this.updateChannel,
      platform_key: this.platformKey,
      platform_supported: manifest ? asset !== null : true,
      // zip_url kept for readers of the Python field; it is the platform asset now.
      zip_url: asset?.url ?? '',
      asset_url: asset?.url ?? '',
      asset_size: asset?.size ?? 0,
      notes_url: manifest?.notesUrl ?? '',
      notes_markdown: this.notesMarkdown,
      notes_markdown_i18n: { ...this.notesTranslations },
      sha256: asset?.sha256 ?? '',
      downloaded: this.downloaded,
      downloaded_sha256: this.downloadedSha256,
      pending_release_ready: staged !== null,
      restart_required: this.restartRequired,
      manual_update_required: this.manualUpdateRequired,
      last_checked_at: this.lastCheckedAt,
      checked_at: this.lastCheckedAt,
      auto_check_interval_sec: this.autoCheckIntervalSec,
      download_progress_pct: this.downloadProgressPct,
      apply_progress_pct: this.applyProgressPct,
      progress_pct: this.overallProgressPct(),
      progress_label: this.progressLabel(),
      busy: this.busy,
      last_error: this.lastError,
      active_slot: ACTIVE_SLOT_LABEL,
      inactive_slot: STAGED_SLOT_LABEL,
      pending_slot: staged ? STAGED_SLOT_LABEL : '',
      boot_phase: staged ? 'pending_switch' : rollbackReason ? 'rolled_back' : 'idle',
      rollback_reason: rollbackReason,
      target_version: stagedVersion,
      health_ready: Boolean(boot.healthReady),
      active_slot_version: this.currentVersion,
      pending_slot_version: stagedVersion,
    };
  }

  /**
   * The `update` block reported upstream in gateway_status and command
   * results. Field names follow the Hub's (hubUpdateJson) so the Desktop reads
   * both the same way; `version` is the *available* one.
   */
  updateBlock(autoApply = ''): Json {
    const st = this.state();
    const availableVersion = (st.latest_version as string) || (st.latest_gateway_version as string);
    return {
      channel: st.update_channel,
      resolved_manifest_url: st.manifest_url,
      required_update: Boolean(st.required_update),
      latest_gateway_version: st.latest_gateway_version,
      auto_apply: st.required_update ? autoApply : '',
      phase: st.phase,
      operation: st.progress_label,
      available: Boolean(st.update_available),
      version: availableVersion,
      current_version: st.current_version,
      changelog_url: st.notes_url,
      notes_url: st.notes_url,
      progress_pct: Math.trunc(st.progress_pct as number),
      busy: Boolean(st.busy),
      error: st.last_error,
      checked_at: st.last_checked_at,
    };
  }

  setServerLatestVersion(version: string, source = 'server_ws'): Json {
    const normalized = pyStrip(pyTruthy(version) ? pyStr(version) : '');
    if (!normalized) return this.state();
    this.latestGatewayVersion = normalized;
    this.serverLatestVersion = normalized;
    this.updateSignalSource = source;
    this.requiredUpdateRaw = isNewerVersion(normalized, this.currentVersion);
    return this.state();
  }

  async maybeRefresh(): Promise<Json> {
    if (this.busy) return this.state();
    const manifestVersion = this.latestManifest?.version ?? '';
    const now = this.clock.monotonicMs();
    const stale = this.lastManifestCheckMs === null || now - this.lastManifestCheckMs >= this.autoCheckIntervalMs;
    if (this.requiredUpdateRaw && (!this.latestManifest || manifestVersion !== this.latestGatewayVersion || stale)) {
      return this.check(false);
    }
    return this.state();
  }

  /** Concurrent callers share one fetch: Python's threads could overlap, a host loop would stack them. */
  check(force = true): Promise<Json> {
    if (this.busy && ['downloading', 'staging', 'switch_pending'].includes(this.phase)) {
      return Promise.resolve(this.state());
    }
    if (!force && !this.requiredUpdateRaw) return Promise.resolve(this.state());
    if (!this.checkInFlight) {
      this.checkInFlight = this.runCheck(force).finally(() => {
        this.checkInFlight = null;
      });
    }
    return this.checkInFlight;
  }

  private async runCheck(force: boolean): Promise<Json> {
    const checkedAt = this.isoNow();
    try {
      const body = await this.http.getText(this.manifestUrl(), MANIFEST_TIMEOUT_MS);
      const manifest = parseBinManifest(body, this.platformKey);
      this.latestManifest = manifest;
      if (isNewerVersion(manifest.version, this.currentVersion)) {
        this.latestGatewayVersion = manifest.version;
        this.requiredUpdateRaw = true;
      }
      if (!this.updateSignalSource) this.updateSignalSource = 'manifest';
      this.notesMarkdown = await this.downloadNotes(manifest.notesUrl);
      this.notesTranslations = await this.downloadTranslations(manifest.notesUrl);
      this.phase = 'checked';
      if (!this.notesMarkdown && manifest.notesUrl) this.lastError = this.lastError || 'notes_unavailable';
      else this.lastError = '';
      this.lastCheckedAt = checkedAt;
    } catch (exc) {
      this.phase = 'error';
      this.lastError = errorText(exc);
      this.lastCheckedAt = checkedAt;
      if (!this.updateSignalSource && force) this.updateSignalSource = 'manifest';
    }
    this.lastManifestCheckMs = this.clock.monotonicMs();
    return this.state();
  }

  private async downloadNotes(notesUrl: string): Promise<string> {
    if (!notesUrl) return '';
    try {
      return await this.http.getText(notesUrl, NOTES_TIMEOUT_MS);
    } catch (exc) {
      this.lastError = `notes_unavailable: ${errorText(exc)}`;
      return '';
    }
  }

  /** A missing translation is normal (older releases): failures are silent and the WebUI falls back. */
  private async downloadTranslations(notesUrl: string): Promise<Record<string, string>> {
    const found: Record<string, string> = {};
    for (const language of NOTES_TRANSLATIONS) {
      const url = localizedNotesUrl(notesUrl, language);
      if (!url) continue;
      let text: string;
      try {
        text = await this.http.getText(url, NOTES_TIMEOUT_MS);
      } catch {
        continue;
      }
      if (pyStrip(text)) found[language] = text;
    }
    return found;
  }

  /** Fetches this platform's asset and verifies size and sha256; the bytes are kept for apply(). */
  async download(): Promise<Json> {
    if (!this.latestManifest) await this.check();
    const asset = this.latestManifest?.asset ?? null;
    if (!asset) {
      this.phase = 'error';
      this.lastError = this.latestManifest ? 'no_asset_for_platform' : 'manifest_not_ready';
      return this.state();
    }
    try {
      this.phase = 'downloading';
      this.downloadProgressPct = 0;
      this.lastError = '';
      this.downloaded = false;
      this.downloadedBytes = null;
      const bytes = await this.http.getBytes(asset.url, DOWNLOAD_TIMEOUT_MS, (received, total) => {
        const expected = total && total > 0 ? total : asset.size;
        if (expected > 0) this.downloadProgressPct = Math.min(99, Math.trunc((received * 100) / expected));
      });
      if (bytes.length !== asset.size) throw new Error('size_mismatch');
      const actualSha = (await this.sha256(bytes)).toLowerCase();
      if (actualSha !== asset.sha256) throw new Error('sha256_mismatch');
      this.downloadedBytes = bytes;
      this.downloaded = true;
      this.downloadedSha256 = actualSha;
      this.downloadProgressPct = 100;
      this.phase = 'downloaded';
      this.lastError = '';
    } catch (exc) {
      this.phase = 'error';
      this.lastError = errorText(exc);
    }
    return this.state();
  }

  /** Python's apply() unzipped into the inactive slot; the installer stages the verified bytes instead. */
  async apply(): Promise<Json> {
    if (!this.downloadedBytes) await this.download();
    const bytes = this.downloadedBytes;
    const asset = this.latestManifest?.asset;
    if (!bytes || !asset || !this.latestManifest) return this.state();
    try {
      this.phase = 'staging';
      this.applyProgressPct = 0;
      this.lastError = '';
      await this.installer.stage(
        bytes,
        { version: this.latestManifest.version, platformKey: this.platformKey, url: asset.url, sha256: asset.sha256, size: asset.size },
        (pct) => {
          this.applyProgressPct = Math.max(0, Math.min(99, Math.trunc(pct)));
        },
      );
      // Staged on disk; holding a second copy of the binary in memory buys nothing.
      this.downloadedBytes = null;
      this.applyProgressPct = 100;
      this.phase = 'staged';
      this.lastError = '';
    } catch (exc) {
      this.phase = 'error';
      this.lastError = errorText(exc);
    }
    return this.state();
  }

  async startUpdate(): Promise<Json> {
    if (this.worker) return this.state();
    // Set before the first await so callers (and the auto-applier) see busy at once, as with Python's thread start.
    this.busy = true;
    this.restartRequired = false;
    this.manualUpdateRequired = false;
    this.downloadProgressPct = 0;
    this.applyProgressPct = 0;
    this.lastError = '';
    this.phase = 'checking';
    this.worker = this.runUpdateSequence().finally(() => {
      this.busy = false;
      this.worker = null;
    });
    return this.state();
  }

  /** Python wait_for_idle(): resolves when the update sequence and any switch in progress have finished. */
  async waitForIdle(): Promise<void> {
    while (this.worker || this.switchInFlight) {
      await (this.worker ?? this.switchInFlight);
    }
  }

  restart(): Json {
    if (!this.restartCallback) {
      this.restartRequired = true;
      this.manualUpdateRequired = true;
      return this.state();
    }
    const switchStaged = this.installer.staged() !== null;
    this.softRestartRequested = !switchStaged;
    if (switchStaged) {
      this.phase = 'switch_pending';
      this.restartRequired = false;
      this.manualUpdateRequired = false;
      this.lastError = '';
      void this.switchToStaged();
      return this.state();
    }
    try {
      this.restartCallback();
      this.phase = 'restarting';
      this.restartRequired = false;
      this.manualUpdateRequired = false;
      this.lastError = '';
    } catch (exc) {
      this.phase = 'error';
      this.lastError = errorText(exc);
    }
    return this.state();
  }

  private async runUpdateSequence(): Promise<void> {
    try {
      await this.check(true);
      if (!this.state().update_available) {
        this.phase = 'checked';
        return;
      }
      await this.download();
      if (this.phase === 'error') return;
      await this.apply();
      if (this.phase === 'error') return;
      await this.stageSwitch();
    } catch (exc) {
      this.phase = 'error';
      this.lastError = errorText(exc);
      this.logger.error(`gateway update failed: ${this.lastError}`);
    }
  }

  private async stageSwitch(): Promise<void> {
    this.phase = 'switch_pending';
    this.restartRequired = this.restartCallback === null;
    this.manualUpdateRequired = this.restartCallback === null;
    if (!this.restartCallback) return;
    this.softRestartRequested = false;
    await this.switchToStaged();
  }

  /** Activation first, so the restart callback never runs into a half-swapped install. */
  private switchToStaged(): Promise<void> {
    if (this.switchInFlight) return this.switchInFlight;
    this.switchInFlight = (async () => {
      try {
        await this.installer.activate();
        this.restartCallback?.();
      } catch (exc) {
        this.phase = 'error';
        this.lastError = errorText(exc);
        this.logger.error(`gateway update switch failed: ${this.lastError}`);
      }
    })().finally(() => {
      this.switchInFlight = null;
    });
    return this.switchInFlight;
  }

  private platformUnsupported(): boolean {
    const manifest = this.latestManifest;
    if (!manifest || manifest.asset) return false;
    // A manifest older than the server's version is lagging, not a verdict on this platform.
    return !isNewerVersion(this.serverLatestVersion, manifest.version) && !isNewerVersion(this.latestGatewayVersion, manifest.version);
  }

  private overallProgressPct(): number {
    const phase = this.phase;
    if (phase === 'idle' || phase === 'error') return 0;
    if (phase === 'checking') return 2;
    if (phase === 'downloading' || phase === 'downloaded') return Math.min(50, Math.trunc(this.downloadProgressPct * 0.5));
    if (['staging', 'staged', 'switch_pending', 'restarting'].includes(phase)) {
      return Math.min(100, 50 + Math.trunc(this.applyProgressPct * 0.5));
    }
    return 0;
  }

  private progressLabel(): string {
    switch (this.phase) {
      case 'checking':
        return 'Checking for update';
      case 'downloading':
      case 'downloaded':
        return 'Downloading update';
      case 'staging':
      case 'staged':
        return 'Installing update';
      case 'switch_pending':
        return 'Switching to update';
      case 'restarting':
        return 'Restarting';
      case 'error':
        return 'Update failed';
      default:
        return 'Waiting';
    }
  }

  private isoNow(): string {
    return pyIsoUtcFromEpochUs(this.clock.nowEpochUs());
  }
}

function errorText(exc: unknown): string {
  return exc instanceof Error ? exc.message : pyStr(exc);
}
