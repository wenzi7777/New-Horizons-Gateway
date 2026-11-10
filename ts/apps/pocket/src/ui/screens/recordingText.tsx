import { Cloud, CloudUpload, Smartphone } from 'lucide-react-native';

import type { RecordingSummary } from '../../host/contract';
import { Badge } from '../components/primitives';
import { useI18n } from '../i18n';

export function SyncBadge({ state }: { state: RecordingSummary['syncState'] }) {
  const { t } = useI18n();
  if (state === 'synced') return <Badge label={t('syncSynced')} tone="success" icon={Cloud} />;
  if (state === 'uploading') return <Badge label={t('syncUploading')} tone="accent" icon={CloudUpload} />;
  return <Badge label={t('syncLocal')} tone="muted" icon={Smartphone} />;
}
