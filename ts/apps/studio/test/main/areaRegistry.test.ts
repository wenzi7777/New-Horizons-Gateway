import { describe, expect, it } from 'vitest';

import { AREA_EVENT } from '../../src/shared/areas';
import { AreaRegistry, type AreaContext } from '../../src/main/areas';
import type { IpcEventLike, SenderLike } from '../../src/main/ipc';

function sender(id = 1): SenderLike & { sent: unknown[][] } {
  const sent: unknown[][] = [];
  return { id, sent, send: (...args: unknown[]) => void sent.push(args), isDestroyed: () => false, once: () => undefined };
}

const logger = { info() {}, warn() {}, error() {} };

function registry(trusted = (event: IpcEventLike) => event.sender.id === 1) {
  const window = sender(1);
  const reg = new AreaRegistry(
    { controller: {} as AreaContext['controller'], logger, userDataDir: '/tmp', version: 'v0' },
    { isTrustedSender: trusted, senders: () => [window] },
  );
  let emit: AreaContext['emit'] = () => undefined;
  reg.add({
    area: 'tools',
    register(context) {
      emit = context.emit;
      return { add: (a: number, b: number) => a + b, ping: async () => 'pong' };
    },
  });
  return { reg, window, emit: (...args: Parameters<AreaContext['emit']>) => emit(...args) };
}

describe('AreaRegistry', () => {
  it('calls registered methods with their arguments', async () => {
    const { reg, window } = registry();
    expect(await reg.call({ sender: window }, 'tools', 'add', [2, 3])).toBe(5);
    expect(await reg.call({ sender: window }, 'tools', 'ping', [])).toBe('pong');
  });

  it('refuses unknown areas, unregistered or inherited methods, and untrusted senders', async () => {
    const { reg, window } = registry();
    await expect(reg.call({ sender: window }, 'nope', 'add', [])).rejects.toThrow('unknown_area');
    await expect(reg.call({ sender: window }, 'apps', 'add', [])).rejects.toThrow('unknown_method');
    await expect(reg.call({ sender: window }, 'tools', 'toString', [])).rejects.toThrow('unknown_method');
    await expect(reg.call({ sender: window }, 'tools', '__proto__', [])).rejects.toThrow('unknown_method');
    await expect(reg.call({ sender: window }, 'tools', 'constructor', [])).rejects.toThrow('unknown_method');
    await expect(reg.call({ sender: sender(2) }, 'tools', 'add', [1, 1])).rejects.toThrow('untrusted_sender');
  });

  it('broadcasts area events to every window', () => {
    const { window, emit } = registry();
    emit('progress', { pct: 50 });
    expect(window.sent).toEqual([[AREA_EVENT, 'tools', 'progress', { pct: 50 }]]);
  });

  it('rejects registering an area twice', () => {
    const { reg } = registry();
    expect(() => reg.add({ area: 'tools', register: () => ({}) })).toThrow('registered twice');
  });
});
