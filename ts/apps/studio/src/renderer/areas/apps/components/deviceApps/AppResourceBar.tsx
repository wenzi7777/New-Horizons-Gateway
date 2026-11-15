// The Apps section's resource summary (the Desktop's AppResourceBar.tsx):
// the app memory pool and the time the apps used lately, one colour per
// running app, and how many more apps of a typical size would fit.
import { type AppResources, type DeviceApp, formatBytes, formatCpu, moreThatFit } from '../../lib/deviceApps';
import { useAppsT } from '../../strings';

export function AppResourceBar({
  running,
  resources,
  cpuByApp,
  ceilingPermille,
  colourOf,
}: {
  running: DeviceApp[];
  resources: AppResources | null;
  /** cpu10 (permille of wall time) per app id. */
  cpuByApp: ReadonlyMap<string, number>;
  /** The governor's ceiling for all apps together, permille. */
  ceilingPermille: number;
  colourOf: (id: string) => number;
}) {
  const t = useAppsT();
  if (!resources) return null;
  const poolBytes = Math.max(1, resources.poolBytes);
  const ceiling = Math.max(1, ceilingPermille);
  const cpuTotal = running.reduce((sum, app) => sum + (cpuByApp.get(app.id) ?? 0), 0);
  // "More that fit" is judged by the apps already running, the best guess at
  // what this operator runs; with none running, only the free space is shown.
  const typical = running.length ? Math.round(running.reduce((sum, app) => sum + app.memoryBytes, 0) / running.length) : 0;
  const more = moreThatFit(resources, typical);

  return (
    <div className="dapps-resources" aria-label={t('appsResources')}>
      <div className="dapps-resource">
        <div className="dapps-resource-caption">
          <span>{t('appsMemory')}</span>
          <span className="dapps-resource-value">
            {formatBytes(resources.poolUsed)} / {formatBytes(resources.poolBytes)}
          </span>
        </div>
        <div className="dapps-resource-track" role="img" aria-label={`${formatBytes(resources.poolUsed)} / ${formatBytes(resources.poolBytes)}`}>
          {running.map((app) => (
            <span key={app.id} className={`dapps-resource-segment dapps-colour-${colourOf(app.id)}`} style={{ width: `${(app.memoryBytes / poolBytes) * 100}%` }} title={`${app.name}: ${formatBytes(app.memoryBytes)}`} />
          ))}
        </div>
      </div>

      <div className="dapps-resource">
        <div className="dapps-resource-caption">
          <span>{t('appsCpu')}</span>
          <span className="dapps-resource-value">
            {formatCpu(cpuTotal)} / {formatCpu(ceiling)}
          </span>
        </div>
        <div className="dapps-resource-track" role="img" aria-label={`${formatCpu(cpuTotal)} / ${formatCpu(ceiling)}`}>
          {running.map((app) => {
            const cpu = cpuByApp.get(app.id) ?? 0;
            return cpu > 0 ? (
              <span key={app.id} className={`dapps-resource-segment dapps-colour-${colourOf(app.id)}`} style={{ width: `${Math.min(100, (cpu / ceiling) * 100)}%` }} title={`${app.name}: ${formatCpu(cpu)}`} />
            ) : null;
          })}
        </div>
      </div>

      {running.length ? (
        <ul className="dapps-resource-legend">
          {running.map((app) => (
            <li key={app.id}>
              <i className={`dapps-colour-${colourOf(app.id)}`} aria-hidden="true" />
              {app.name}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="dapps-resource-note">
        {more !== null ? t('appsMoreFit', { count: more, size: formatBytes(typical) }) : t('appsPoolFree', { free: formatBytes(resources.poolFree) })}
      </p>
    </div>
  );
}
