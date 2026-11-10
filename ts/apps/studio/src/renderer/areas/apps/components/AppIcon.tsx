// A library app's icon, fetched by the main process as a data: URL (the
// renderer's CSP allows no remote images); a tile when there is none.
import { useEffect, useMemo, useState } from 'react';
import { Gauge, SlidersHorizontal, Workflow } from 'lucide-react';

import { useStudio } from '../../../state/studio';
import { appsApi } from '../api';
import type { AppCatalogEntry } from '../lib/appLibrary';

const cache = new Map<string, string | null>();

export function KindGlyph({ kind, large = false }: { kind: string | undefined; large?: boolean }) {
  const size = large ? 26 : 18;
  return (
    <span className={`apps-glyph${large ? ' large' : ''}${kind === 'readout' || kind === 'panel' ? ' view' : ''}`} aria-hidden="true">
      {kind === 'panel' ? <SlidersHorizontal size={size} /> : kind === 'readout' ? <Gauge size={size} /> : <Workflow size={size} />}
    </span>
  );
}

export function AppIcon({ entry, large = false }: { entry: Pick<AppCatalogEntry, 'icon_url' | 'kind'>; large?: boolean }) {
  const { api } = useStudio();
  const client = useMemo(() => appsApi(api), [api]);
  const url = entry.icon_url ?? '';
  const [src, setSrc] = useState<string | null>(() => (url ? cache.get(url) ?? null : null));
  useEffect(() => {
    if (!url) return undefined;
    if (cache.has(url)) {
      setSrc(cache.get(url) ?? null);
      return undefined;
    }
    let cancelled = false;
    client
      .libraryIcon(url)
      .then((data) => {
        cache.set(url, data);
        if (!cancelled) setSrc(data);
      })
      .catch(() => cache.set(url, null));
    return () => {
      cancelled = true;
    };
  }, [client, url]);
  if (!src) return <KindGlyph kind={entry.kind} large={large} />;
  return <img className={`apps-icon${large ? ' large' : ''}`} src={src} alt="" />;
}
