// True once the screen's push animation has finished. Heavy parts (the board
// drawing, the live map) mount then instead of during the animation: their
// react-native-svg nodes are created on the UI thread and made the push
// stutter on a Pixel 4a. A placeholder of the same size holds their place.
import { useNavigation } from 'expo-router';
import { useEffect, useState } from 'react';

/** Upper bound if no transitionEnd arrives (no animation, reduced motion, already shown). */
const FALLBACK_MS = 450;

export function useAfterTransition(): boolean {
  const navigation = useNavigation();
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (done) return undefined;
    let live = true;
    const finish = () => {
      if (live) setDone(true);
    };
    const unsubscribe = navigation.addListener('transitionEnd' as never, finish);
    const timer = setTimeout(finish, FALLBACK_MS);
    return () => {
      live = false;
      unsubscribe();
      clearTimeout(timer);
    };
  }, [navigation, done]);
  return done;
}
