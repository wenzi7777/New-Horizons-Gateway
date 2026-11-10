// The seams between the runtime (state, FindMe, device commands, operations,
// remote commands: runtime/*) and the upstream link + updater (upstream/*,
// update/*). They mirror the Python objects main.py wires together --
// upstream_wss.UpstreamWSSClient, update_manager.GatewayUpdateManager and
// auto_update.RequiredUpdateAutoApplier -- method for method, so either side
// can be built and tested against a fake of the other.
//
// Dicts that Python returns as-is (status(), state(), update_block()) stay
// loosely typed: their exact keys are what the Backend and the web UI read,
// and they are pinned by the implementations' tests, not by these types.

export type Json = Record<string, unknown>;

/** remote_commands.CAPABILITIES: advertised in hello, so the Backend knows this Gateway takes gateway_command and auto-updates. */
export const CAPABILITIES = ['gateway_command', 'auto_update'] as const;

/** upstream_wss.UpstreamWSSClient as main.py / operations.py / remote_commands.py use it. */
export interface UpstreamLink {
  readonly gatewayId: string;
  start(): void;
  stop(): void;
  isConnected(): boolean;
  /** status(): server_url, connected, last_error, queue/rate counters (sent upstream inside gateway_status). */
  status(): Json;
  /** hello / status / update_progress / result → device_hello / device_status / device_update_progress / device_result. */
  sendDeviceMessage(msgType: string, payload: Json): void;
  /** Coalesced: only the newest queued gateway_status is sent. */
  sendGatewayStatus(payload: Json): void;
  sendGatewayCommandResult(requestId: string, result: Json): void;
  sendClaimRequest(deviceUid: string, claimId: string, ttlMs: number): void;
  /** A raw sensor packet; travels as the text frame "NHPKT1:" + base64. */
  sendPacket(packet: Uint8Array): void;
  /** Re-announces (hello) so hello_ack carries the new channel's latest version. */
  setUpdateChannel(channel: string): void;
  /** Reconnects to a new URL (after set_config / save_settings). */
  updateServer(serverUrl: string): void;
}

/** What the upstream link hands to the runtime (main.py's on_command / on_upstream_message). */
export interface UpstreamCallbacks {
  /** `command` from the Backend for a device. */
  onCommand(deviceUid: string, payload: Json): void;
  /** Every other JSON message: gateway_command, gateway_hello_ack, gateway_claim_update, error, pong, … */
  onMessage(message: Json): void;
  onConnectionChange?(connected: boolean): void;
  /** The Backend refused this client's app token (unauthorized / app_token_required): the user must sign in again. */
  onAuthRejected?(code: string): void;
}

/** update_manager.GatewayUpdateManager as the runtime uses it. Long operations are async here (Python ran them on a worker thread). */
export interface UpdateControl {
  manifestUrl(): string;
  /** set_channel(): switches stable/beta, clears the old channel's requirement, returns state(). */
  setChannel(channel: string): Json;
  /** state(): the ~35-field dict the web UI shows. */
  state(): Json;
  /** update_block(): the Hub-compatible `update` field of gateway_status. */
  updateBlock(autoApply?: string): Json;
  /** From gateway_hello_ack.latest_gateway_version: any newer version means required_update. */
  setServerLatestVersion(version: string, source?: string): Json;
  /** Re-checks when the last check is older than the auto-check interval. */
  maybeRefresh(): Promise<Json>;
  check(force?: boolean): Promise<Json>;
  /** Download, verify and stage the update, then restart into it. Resolves when the work has been started. */
  startUpdate(): Promise<Json>;
  /** Restart (into a staged update if there is one). */
  restart(): Json;
  readonly requiredUpdate: boolean;
  readonly autoCheckIntervalMs: number;
  /** Host hook: called when the runtime must restart (soft restart or switch to a staged update). */
  setRestartCallback(callback: () => void): void;
}

/** auto_update.RequiredUpdateAutoApplier: applies a required update once no device has been served for a while. */
export interface AutoApplier {
  /** "", "waiting_for_idle" or "retry_later". */
  status(): string;
  /** Ticked by the runtime's main loop. */
  service(): void;
}
