import { useLocalSearchParams } from 'expo-router';

import { LiveScreen } from '../../ui/screens/LiveScreen';

export default function LiveRoute() {
  const { uid = '' } = useLocalSearchParams<{ uid?: string }>();
  return <LiveScreen uid={uid} />;
}
