import { useLocalSearchParams } from 'expo-router';

import { IoScreen } from '../../ui/screens/IoScreen';

export default function PinsRoute() {
  const { uid = '' } = useLocalSearchParams<{ uid?: string }>();
  return <IoScreen uid={uid} />;
}
