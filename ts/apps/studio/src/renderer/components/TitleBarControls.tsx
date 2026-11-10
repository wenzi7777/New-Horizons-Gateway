// Minimize / maximize / close for the frameless window on Windows and Linux
// (macOS keeps its own traffic lights; the browser preview has none). The
// top bar around it is the drag region.
import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';

import { useStudio } from '../state/studio';

export function TitleBarControls() {
  const controls = typeof window !== 'undefined' ? window.nhStudioWindow : undefined;
  const { t } = useStudio();
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!controls || controls.platform === 'darwin') return undefined;
    void controls.isMaximized().then(setMaximized, () => undefined);
    return controls.onMaximized(setMaximized);
  }, [controls]);
  if (!controls || controls.platform === 'darwin') return null;
  return (
    <div className="window-controls no-drag" role="group" aria-label={t('windowControls')}>
      <button type="button" className="window-control" aria-label={t('windowMinimize')} title={t('windowMinimize')} onClick={() => void controls.minimize()}>
        <Minus size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="window-control"
        aria-label={maximized ? t('windowRestore') : t('windowMaximize')}
        title={maximized ? t('windowRestore') : t('windowMaximize')}
        onClick={() => void controls.toggleMaximize().then(setMaximized, () => undefined)}
      >
        {maximized ? <Copy size={14} strokeWidth={1.6} aria-hidden="true" /> : <Square size={13} strokeWidth={1.6} aria-hidden="true" />}
      </button>
      <button type="button" className="window-control close" aria-label={t('windowClose')} title={t('windowClose')} onClick={() => void controls.close()}>
        <X size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
    </div>
  );
}
