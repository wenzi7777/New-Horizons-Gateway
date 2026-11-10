// The "tools" area's page: a hub (#/tools) and its tools by route.path:
//   #/tools/analysis[/<recording id>]   recording analysis
//   #/tools/terminal[/<uid>]            device terminal
//   #/tools/files[/<uid>]               device files
//   #/tools/timestamp                   timestamp converter
//   #/tools/pressure                    lab pressure chamber
import { ArrowLeft, ChartLine, FolderTree, Gauge, SquareTerminal, Timer } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card, Notice } from '../../components/ui';
import type { Route } from '../../lib/navigation';
import { useAreaT } from '../i18n';
import { RecordingAnalysisTool } from './analysis/RecordingAnalysisTool';
import { TimestampConverter } from './analysis/TimestampConverter';
import { DeviceFilesTool } from './DeviceFilesTool';
import { PressureControlTool } from './PressureControlTool';
import { TerminalTool } from './TerminalTool';
import { toolsStrings, type ToolsStringsKey } from './toolsStrings';
import './tools-analysis.css';

export type ToolsPageProps = { route: Extract<Route, { area: 'tools' }>; navigate: (route: Route) => void };

const TOOLS: { id: string; title: ToolsStringsKey; copy: ToolsStringsKey; icon: ReactNode }[] = [
  { id: 'analysis', title: 'toolAnalysis', copy: 'toolAnalysisCopy', icon: <ChartLine size={16} aria-hidden="true" /> },
  { id: 'terminal', title: 'toolTerminal', copy: 'toolTerminalCopy', icon: <SquareTerminal size={16} aria-hidden="true" /> },
  { id: 'files', title: 'toolFiles', copy: 'toolFilesCopy', icon: <FolderTree size={16} aria-hidden="true" /> },
  { id: 'timestamp', title: 'toolTimestamp', copy: 'toolTimestampCopy', icon: <Timer size={16} aria-hidden="true" /> },
  { id: 'pressure', title: 'toolPressure', copy: 'toolPressureCopy', icon: <Gauge size={16} aria-hidden="true" /> },
];

export default function ToolsPage({ route, navigate }: ToolsPageProps) {
  const t = useAreaT(toolsStrings);
  const [tool, ...rest] = route.path;
  const back = (
    <button className="button ghost tiny tools-back" type="button" onClick={() => navigate({ area: 'tools', path: [] })}>
      <ArrowLeft size={13} aria-hidden="true" />
      {t('back')}
    </button>
  );
  const uid = rest[0] ?? null;

  switch (tool) {
    case undefined:
      return (
        <div className="stack">
          <Card title={t('toolsTitle')} copy={t('toolsCopy')}>
            <ul className="tools-hub">
              {TOOLS.map((item) => (
                <li key={item.id}>
                  <button className="tools-hub-item" type="button" onClick={() => navigate({ area: 'tools', path: [item.id] })}>
                    <strong>
                      {item.icon}
                      {t(item.title)}
                    </strong>
                    <span>{t(item.copy)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </div>
      );
    case 'analysis':
      return (
        <div className="stack">
          {back}
          <RecordingAnalysisTool recordingId={rest.length === 3 ? rest.join('/') : null} navigate={navigate} />
        </div>
      );
    case 'terminal':
      return (
        <div className="stack">
          {back}
          <TerminalTool uid={uid} navigate={navigate} />
        </div>
      );
    case 'files':
      return (
        <div className="stack">
          {back}
          <DeviceFilesTool uid={uid} navigate={navigate} />
        </div>
      );
    case 'timestamp':
      return (
        <div className="stack">
          {back}
          <Card title={t('toolTimestamp')}>
            <TimestampConverter recordingRange={null} />
          </Card>
        </div>
      );
    case 'pressure':
      return (
        <div className="stack">
          {back}
          <PressureControlTool />
        </div>
      );
    default:
      return (
        <div className="stack">
          {back}
          <Notice kind="warning">{t('notFound')}</Notice>
        </div>
      );
  }
}
