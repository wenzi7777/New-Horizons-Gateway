// 3D pressure surface (the Desktop Visualization's 3D Surface, as NH Studio's
// components/Surface3D.tsx): one vertex per (interpolated) sensor, height and
// colour from the pressure scale, drawn on an expo-gl context by the small
// WebGL 1 renderer in surfaceGl.ts (three.js needs WebGL 2, which expo-gl does
// not fully provide on Android). One finger orbits, two fingers zoom. It
// draws only when something changed (a new frame or a gesture), at most 30
// times a second, and not at all while `active` is false. Any GL failure,
// at setup or while drawing, stops it and calls `onUnavailable` (the screen
// falls back to 2D) -- nothing is thrown out of the draw loop.

import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { surfaceGeometry } from '@nhgw/host';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, View, type GestureResponderEvent } from 'react-native';

import { rgbForValue, valueRatio, type PressureRange } from '../pressureColor';
import { useTheme } from '../theme';
import { parseCssColor, SURFACE_START, SurfaceRenderer, type Orbit } from './surfaceGl';

const MIN_FRAME_MS = 1000 / 30;

type GlState = { gl: ExpoWebGLRenderingContext; renderer: SurfaceRenderer };

function touchDistance(e: GestureResponderEvent): number | null {
  const touches = e.nativeEvent.touches;
  if (touches.length < 2) return null;
  const [a, b] = [touches[0]!, touches[1]!];
  return Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);
}

export function Surface3D({
  values,
  rows,
  cols,
  range,
  height,
  active,
  label,
  onUnavailable,
}: {
  /** Row-major values (already transformed and interpolated), or null before the first frame. */
  values: readonly number[] | null;
  rows: number;
  cols: number;
  range: PressureRange;
  height: number;
  /** Draw only while the screen is in front. */
  active: boolean;
  label: string;
  /** No usable GL context: the screen falls back to 2D. */
  onUnavailable: () => void;
}) {
  const theme = useTheme();
  const glRef = useRef<GlState | null>(null);
  const orbit = useRef<Orbit>({ ...SURFACE_START });
  const dirty = useRef(true);
  const geometryDirty = useRef(true);
  const failed = useRef(false);
  const mounted = useRef(true);
  const [ready, setReady] = useState(false);
  const latest = useRef({ values, rows, cols, range });
  latest.current = { values, rows, cols, range };
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const colors = { clear: theme.colors.panelSoft, line: theme.colors.textMuted };
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  /** Stop drawing for good and let the screen fall back to 2D. */
  const fail = () => {
    if (failed.current) return;
    failed.current = true;
    const current = glRef.current;
    glRef.current = null;
    try {
      current?.renderer.dispose();
    } catch {
      // The context is already unusable.
    }
    if (mounted.current) unavailable.current();
  };

  const onContextCreate = (gl: ExpoWebGLRenderingContext) => {
    if (!mounted.current || failed.current) return;
    try {
      const renderer = new SurfaceRenderer(gl as unknown as WebGLRenderingContext);
      glRef.current = { gl, renderer };
      dirty.current = true;
      geometryDirty.current = true;
      setReady(true);
    } catch {
      fail();
    }
  };

  /** One draw, if anything changed; false once drawing has failed. */
  const drawFrame = (): boolean => {
    const current = glRef.current;
    if (!current || failed.current) return false;
    try {
      const { renderer, gl } = current;
      if (geometryDirty.current) {
        geometryDirty.current = false;
        const { values: v, rows: r, cols: c, range: rg } = latest.current;
        if (v && r > 0 && c > 0) {
          const { positions, colors: vertexColors, indices } = surfaceGeometry(v, r, c, (x) => valueRatio(x, rg), (x) => rgbForValue(x, rg), rg.min);
          renderer.setGeometry(positions, vertexColors, indices);
        }
      }
      renderer.setColors(parseCssColor(colorsRef.current.clear, [0.2, 0.2, 0.21]), parseCssColor(colorsRef.current.line, [0.56, 0.56, 0.58]));
      renderer.draw(gl.drawingBufferWidth, gl.drawingBufferHeight, orbit.current);
      gl.endFrameEXP();
      return true;
    } catch {
      fail();
      return false;
    }
  };

  // Draw loop: only when dirty, at most 30 fps; stopped while inactive and after a failure.
  useEffect(() => {
    if (!ready || !active) return undefined;
    let frame = 0;
    let last = 0;
    let running = true;
    const loop = (now: number) => {
      if (!running || !mounted.current) return;
      if (dirty.current && now - last >= MIN_FRAME_MS) {
        dirty.current = false;
        last = now;
        if (!drawFrame()) return;
      }
      frame = requestAnimationFrame(loop);
    };
    dirty.current = true;
    frame = requestAnimationFrame(loop);
    return () => {
      running = false;
      cancelAnimationFrame(frame);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, active]);

  useEffect(() => {
    geometryDirty.current = true;
    dirty.current = true;
  }, [values, rows, cols, range]);

  useEffect(() => {
    dirty.current = true;
  }, [colors.clear, colors.line]);

  useEffect(
    () => () => {
      mounted.current = false;
      const current = glRef.current;
      glRef.current = null;
      try {
        current?.renderer.dispose();
      } catch {
        // Context already gone.
      }
    },
    [],
  );

  const gesture = useRef<{ x: number; y: number; pinch: number | null; start: Orbit }>({ x: 0, y: 0, pinch: null, start: SURFACE_START });
  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: (e, g) => {
          gesture.current = { x: g.dx, y: g.dy, pinch: touchDistance(e), start: { ...orbit.current } };
        },
        onPanResponderMove: (e, g) => {
          const pinch = touchDistance(e);
          if (pinch !== null) {
            if (gesture.current.pinch === null) gesture.current = { x: g.dx, y: g.dy, pinch, start: { ...orbit.current } };
            const scale = gesture.current.pinch! / Math.max(pinch, 1);
            orbit.current = { ...orbit.current, distance: Math.min(8, Math.max(0.8, gesture.current.start.distance * scale)) };
          } else {
            if (gesture.current.pinch !== null) gesture.current = { x: g.dx, y: g.dy, pinch: null, start: { ...orbit.current } };
            const { start } = gesture.current;
            orbit.current = {
              ...orbit.current,
              theta: start.theta - (g.dx - gesture.current.x) * 0.01,
              phi: Math.min(1.45, Math.max(0.12, start.phi - (g.dy - gesture.current.y) * 0.01)),
            };
          }
          dirty.current = true;
        },
      }),
    [],
  );

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{ width: '100%', height, borderRadius: theme.radius.sm, overflow: 'hidden', backgroundColor: theme.colors.panelSoft }}
      {...responder.panHandlers}
    >
      <GLView style={{ flex: 1 }} onContextCreate={onContextCreate} />
    </View>
  );
}
