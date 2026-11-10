// Tools → Relay performance: how many devices this computer (and its link to
// the server) can relay, and what limits it. The work runs in the main
// process (sync area relayBench): 3 s of per-frame relay work, then the
// server round trip and -- when signed in -- an upload.
import { useMemo, useState } from 'react';
import { Gauge } from 'lucide-react';

import type { RelayBenchReport } from '../../../shared/areas/sync';
import { Card, Facts, Notice } from '../../components/ui';
import { useStudio } from '../../state/studio';
import { useAreaT } from '../i18n';
import { syncApi } from '../sync/api';
import { toolsStrings } from './toolsStrings';

export function RelayBenchTool() {
  const t = useAreaT(toolsStrings);
  const { api, errorText } = useStudio();
  const sync = useMemo(() => syncApi(api), [api]);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<RelayBenchReport | null>(null);
  const [error, setError] = useState('');

  const run = async () => {
    setBusy(true);
    setError('');
    setReport(null);
    try {
      setReport(await sync.relayBench());
    } catch (e) {
      setError(errorText(e instanceof Error ? (e.message.split(': ').pop() ?? '') : String(e)));
    } finally {
      setBusy(false);
    }
  };

  const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB/s`;
  const link = report?.link;
  const est = report?.estimate;
  return (
    <Card
      title={t('benchTitle')}
      copy={t('benchCopy')}
      actions={
        <button className="button primary" type="button" disabled={busy} onClick={() => void run()}>
          <Gauge size={16} aria-hidden="true" /> {busy ? t('benchRunning') : t('benchRun')}
        </button>
      }
    >
      {error ? <Notice kind="error">{error}</Notice> : null}
      {report && est && link ? (
        <>
          <div className="bench-headline">
            <strong>{t('benchDevicesValue', { count: est.devices })}</strong>
            <span className="muted">{t('benchDevicesNote', { fps: est.fps, sensors: est.sensors })}</span>
          </div>
          <Facts
            items={[
              [t('benchMachine'), t('benchMachineValue', { fps: Math.round(report.framesPerSecond).toLocaleString(), count: est.devicesByMachine })],
              [
                t('benchLink'),
                !link.ok
                  ? t('benchLinkFailed', { error: link.error })
                  : link.uploadBytesPerSecond === null
                    ? t('benchLinkRttOnly', { rtt: Math.round(link.rttMs ?? 0) })
                    : t('benchLinkValue', { rtt: Math.round(link.rttMs ?? 0), upload: kib(link.uploadBytesPerSecond), count: est.devicesByNetwork ?? 0 }),
              ],
              [t('benchPerDevice'), kib(est.bytesPerDevicePerSecond)],
            ]}
          />
          <Notice kind={est.bottleneck === 'unknown' ? 'info' : 'success'}>
            {t(est.bottleneck === 'network' ? 'benchBottleneckNetwork' : est.bottleneck === 'machine' ? 'benchBottleneckMachine' : 'benchBottleneckUnknown', { perDevice: kib(est.bytesPerDevicePerSecond) })}
          </Notice>
        </>
      ) : null}
    </Card>
  );
}
