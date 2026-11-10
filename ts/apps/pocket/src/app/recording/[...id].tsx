import { useLocalSearchParams } from 'expo-router';

import { RecordingScreen } from '../../ui/screens/RecordingScreen';

export default function RecordingRoute() {
  // Recording ids are folder paths (UID/YYYYMMDD/HHMMSS): a catch-all route
  // keeps the slashes as segments instead of relying on %2F encoding.
  const { id } = useLocalSearchParams<{ id?: string | string[] }>();
  return <RecordingScreen id={Array.isArray(id) ? id.join('/') : id ?? ''} />;
}
