import { useLocalSearchParams } from 'expo-router';

import { MagCalibrationScreen } from '../../ui/screens/MagCalibrationScreen';

export default function MagCalibrationRoute() {
  const { uid = '', fromEnable } = useLocalSearchParams<{ uid?: string; fromEnable?: string }>();
  return <MagCalibrationScreen uid={uid} fromEnable={fromEnable === '1'} />;
}
