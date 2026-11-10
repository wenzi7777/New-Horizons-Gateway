import { useLocalSearchParams } from 'expo-router';

import { DeviceScreen } from '../../ui/screens/DeviceScreen';

export default function DeviceRoute() {
  const { uid = '' } = useLocalSearchParams<{ uid?: string }>();
  return <DeviceScreen uid={uid} />;
}
