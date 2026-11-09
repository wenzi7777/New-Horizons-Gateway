import { describe, expect, it } from 'vitest';

import type { Json, UpdateControl } from '../../src/contracts';
import { GatewayUpdateManager, RequiredUpdateAutoApplier } from '../../src/update';
import { FakeClock, FakeHttp, FakeInstaller, nodeSha256 } from './fakes';

/** test_gateway_remote_commands._FakeManager: only required_update, busy and start_update matter. */
class FakeManager implements UpdateControl {
  required = true;
  busy = false;
  starts = 0;
  readonly autoCheckIntervalMs = 600_000;
  get requiredUpdate() {
    return this.required;
  }
  state(): Json {
    return { required_update: this.required, busy: this.busy };
  }
  async startUpdate(): Promise<Json> {
    this.starts += 1;
    this.busy = true;
    return this.state();
  }
  manifestUrl() {
    return '';
  }
  setChannel(): Json {
    return this.state();
  }
  updateBlock(): Json {
    return {};
  }
  setServerLatestVersion(): Json {
    return this.state();
  }
  async maybeRefresh(): Promise<Json> {
    return this.state();
  }
  async check(): Promise<Json> {
    return this.state();
  }
  restart(): Json {
    return this.state();
  }
  setRestartCallback() {}
}

function setup() {
  const clock = new FakeClock();
  const idle = { value: true };
  const manager = new FakeManager();
  const applier = new RequiredUpdateAutoApplier(manager, { isIdle: () => idle.value, clock });
  /** Python's tick(until, step=5.0), in seconds. */
  const tick = (untilSec: number, stepSec = 5) => {
    while (clock.mono < untilSec * 1000) {
      clock.mono += stepSec * 1000;
      applier.service();
    }
  };
  return { clock, idle, manager, applier, tick };
}

describe('RequiredUpdateAutoApplier (AutoApplyTest)', () => {
  it('waits out the boot grace, then the idle period', () => {
    const { applier, manager, tick } = setup();
    expect(applier.status()).toBe('waiting_for_idle');
    tick(59);
    expect(manager.starts).toBe(0);
    tick(125);
    expect(manager.starts).toBe(1);
  });

  it('a busy device resets the idle timer', () => {
    const { manager, idle, tick } = setup();
    tick(100);
    idle.value = false;
    tick(400);
    expect(manager.starts).toBe(0);
    idle.value = true;
    tick(470);
    expect(manager.starts).toBe(1);
  });

  it('a failed attempt waits out the retry window', () => {
    const { applier, manager, tick } = setup();
    tick(125);
    expect(manager.starts).toBe(1);
    manager.busy = false; // finished without restarting us
    tick(130);
    expect(applier.status()).toBe('retry_later');
    tick(130 + 29 * 60);
    expect(manager.starts).toBe(1);
    tick(130 + 32 * 60);
    expect(manager.starts).toBe(2);
  });

  it('does nothing when no update is required', () => {
    const { applier, manager, tick } = setup();
    manager.required = false;
    tick(1000);
    expect(manager.starts).toBe(0);
    expect(applier.status()).toBe('');
  });

  it('never starts while an update is already running', () => {
    const { manager, tick } = setup();
    manager.busy = true;
    tick(1000);
    expect(manager.starts).toBe(0);
  });

  it('drives the real manager: a failing release is retried only after the window', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp(); // no manifest: every check fails
    const manager = new GatewayUpdateManager({
      version: 'v2.0.0',
      platformKey: 'linux-x64',
      http,
      sha256: nodeSha256,
      clock,
      installer: new FakeInstaller(),
      manifestUrl: 'https://example.com/m.json',
    });
    manager.setServerLatestVersion('v9.9.9');
    const applier = new RequiredUpdateAutoApplier(manager, { isIdle: () => true, clock });
    const step = async (untilSec: number) => {
      while (clock.mono < untilSec * 1000) {
        clock.mono += 5000;
        applier.service();
        await manager.waitForIdle();
      }
    };
    await step(125);
    // One attempt fetches twice, as in Python: check(), then download() re-checks with no manifest in hand.
    expect(http.requests.length).toBe(2);
    expect(manager.state().phase).toBe('error');
    await step(130);
    expect(applier.status()).toBe('retry_later');
    expect(manager.updateBlock(applier.status()).auto_apply).toBe('retry_later');
    await step(130 + 29 * 60);
    expect(http.requests.length).toBe(2);
    await step(130 + 32 * 60);
    expect(http.requests.length).toBe(4);
  });
});
