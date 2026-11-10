import { describe, expect, it } from 'vitest';

import { isLoopback } from '../src/web/server';
import { appTokenStatus, withoutSecrets } from '../src/appToken';

describe('app token', () => {
  it('only loopback requests may change it', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1']) expect(isLoopback(a)).toBe(true);
    for (const a of ['192.168.1.14', '::ffff:10.0.0.2', '', undefined]) expect(isLoopback(a)).toBe(false);
  });

  it('is masked in status and dropped from the public config', () => {
    const token = 'nhapp_0123456789ab_secretsecret9z';
    const config = { target_mode: 'local', manual_url: '', sync_app_token: token, sync_app_token_server: 'http://127.0.0.1:5051/newhorizons' };
    expect(appTokenStatus(config)).toEqual({ set: true, masked: 'nhapp_0123456789ab_…et9z', server: 'http://127.0.0.1:5051/newhorizons', active: true });
    expect(withoutSecrets(config)).not.toHaveProperty('sync_app_token');
    expect(appTokenStatus({ ...config, target_mode: 'production' }).active).toBe(false);
  });
});
