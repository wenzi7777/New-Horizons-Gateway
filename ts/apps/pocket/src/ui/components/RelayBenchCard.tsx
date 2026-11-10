// Settings → Relay performance: how many devices this phone (and its link to
// the server) can relay. Runs the per-frame relay work for 3 s, then times
// the server link (the upload only when signed in).
import { Gauge } from 'lucide-react-native';
import { useState } from 'react';
import { estimateCapacity, runCpuBench, type CapacityEstimate, type LinkBenchResult } from '@nhgw/host';

import { useI18n } from '../i18n';
import { usePocketSync } from '../store';
import { Button, Caption, Card, Divider, FactRow } from './primitives';

export function RelayBenchCard() {
  const { t } = useI18n();
  const { sync } = usePocketSync();
  const [phase, setPhase] = useState<'idle' | 'machine' | 'link' | 'done'>('idle');
  const [result, setResult] = useState<{ estimate: CapacityEstimate; link: LinkBenchResult; fps: number } | null>(null);

  const run = async () => {
    setResult(null);
    setPhase('machine');
    const cpu = await runCpuBench({ durationMs: 3000 });
    setPhase('link');
    const link = await sync.benchLink().catch((): LinkBenchResult => ({ ok: false, error: 'network', rttMs: null, uploadBytesPerSecond: null }));
    setResult({ estimate: estimateCapacity({ cpu, link }), link, fps: Math.round(cpu.framesPerSecond) });
    setPhase('done');
  };

  const kib = (bytes: number) => `${(bytes / 1024).toFixed(0)} KiB/s`;
  const busy = phase === 'machine' || phase === 'link';
  return (
    <Card>
      <Caption>{t('benchCopy')}</Caption>
      {result ? (
        <>
          <FactRow label={t('benchDevices')} value={t('benchDevicesValue', { count: result.estimate.devices })} />
          <Divider />
          <FactRow label={t('benchMachine')} value={t('benchMachineValue', { fps: result.fps.toLocaleString(), count: result.estimate.devicesByMachine })} />
          <Divider />
          <FactRow
            label={t('benchLink')}
            value={
              !result.link.ok
                ? t('benchLinkFailed', { error: result.link.error })
                : result.link.uploadBytesPerSecond === null
                  ? t('benchLinkRttOnly', { rtt: Math.round(result.link.rttMs ?? 0) })
                  : t('benchLinkValue', { rtt: Math.round(result.link.rttMs ?? 0), upload: kib(result.link.uploadBytesPerSecond), count: result.estimate.devicesByNetwork ?? 0 })
            }
          />
          <Caption>
            {t(result.estimate.bottleneck === 'network' ? 'benchBottleneckNetwork' : result.estimate.bottleneck === 'machine' ? 'benchBottleneckMachine' : 'benchBottleneckUnknown', {
              perDevice: kib(result.estimate.bytesPerDevicePerSecond),
            })}
          </Caption>
        </>
      ) : null}
      <Button
        label={phase === 'machine' ? t('benchRunningMachine') : phase === 'link' ? t('benchRunningLink') : t('benchRun')}
        icon={Gauge}
        variant="primary"
        compact
        busy={busy}
        disabled={busy}
        onPress={() => void run()}
        style={{ alignSelf: 'flex-start' }}
      />
    </Card>
  );
}
