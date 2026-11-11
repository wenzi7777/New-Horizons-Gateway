import { useLocalSearchParams } from 'expo-router';

import { AnalysisScreen } from '../../ui/screens/AnalysisScreen';

export default function AnalysisRoute() {
  // Recording ids are folder paths (UID/YYYYMMDD/HHMMSS): a catch-all route keeps the slashes as segments.
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  return <AnalysisScreen id={Array.isArray(id) ? id.join('/') : id ?? ''} />;
}
