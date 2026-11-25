// 3D pressure surface (the Desktop Visualization's 3D Surface, as NH Studio's
// components/Surface3D.tsx): one vertex per (interpolated) sensor, height and
// colour from the pressure scale, drawn with three.js on an expo-gl context.
// One finger orbits, two fingers zoom. It draws only when something changed
// (a new frame or a gesture), and not at all while `active` is false.

import { GLView, type ExpoWebGLRenderingContext } from 'expo-gl';
import { surfaceGeometry } from '@nhgw/host';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PanResponder, View, type GestureResponderEvent } from 'react-native';
import * as THREE from 'three';

import { rgbForValue, valueRatio, type PressureRange } from '../pressureColor';
import { useTheme } from '../theme';

type Orbit = { theta: number; phi: number; distance: number };

const START: Orbit = { theta: 0, phi: 0.67, distance: 2.4 };
const TARGET = new THREE.Vector3(0, 0.15, 0);

type SceneState = {
  gl: ExpoWebGLRenderingContext;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  grid: THREE.GridHelper;
  shape: string;
};

function safeColor(value: string, fallback: string): THREE.Color {
  try {
    return new THREE.Color().setStyle(value.startsWith('#') || value.startsWith('rgb') ? value : fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

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
  const sceneRef = useRef<SceneState | null>(null);
  const orbit = useRef<Orbit>({ ...START });
  const dirty = useRef(true);
  const [ready, setReady] = useState(false);
  const latest = useRef({ values, rows, cols, range });
  latest.current = { values, rows, cols, range };
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;
  const colors = { clear: theme.colors.panelSoft, line: theme.colors.textMuted };
  const colorsRef = useRef(colors);
  colorsRef.current = colors;

  const placeCamera = () => {
    const current = sceneRef.current;
    if (!current) return;
    const { theta, phi, distance } = orbit.current;
    current.camera.position.set(
      TARGET.x + distance * Math.sin(phi) * Math.sin(theta),
      TARGET.y + distance * Math.cos(phi),
      TARGET.z + distance * Math.sin(phi) * Math.cos(theta),
    );
    current.camera.lookAt(TARGET);
    dirty.current = true;
  };

  const applyGeometry = () => {
    const current = sceneRef.current;
    const { values: v, rows: r, cols: c, range: rg } = latest.current;
    if (!current || !v || r < 1 || c < 1) return;
    const { positions, colors: vertexColors, indices } = surfaceGeometry(v, r, c, (x) => valueRatio(x, rg), (x) => rgbForValue(x, rg), rg.min);
    const geometry = current.mesh.geometry;
    const shape = `${r}x${c}`;
    if (current.shape !== shape) {
      geometry.setIndex(indices);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(vertexColors, 3));
      current.shape = shape;
    } else {
      (geometry.getAttribute('position') as THREE.BufferAttribute).copyArray(positions).needsUpdate = true;
      (geometry.getAttribute('color') as THREE.BufferAttribute).copyArray(vertexColors).needsUpdate = true;
    }
    dirty.current = true;
  };

  const applyTheme = () => {
    const current = sceneRef.current;
    if (!current) return;
    current.renderer.setClearColor(safeColor(colorsRef.current.clear, '#333336'), 1);
    const line = safeColor(colorsRef.current.line, '#8e8e93');
    const materials = Array.isArray(current.grid.material) ? current.grid.material : [current.grid.material];
    for (const material of materials) {
      (material as THREE.LineBasicMaterial).color = line;
      material.opacity = 0.35;
      material.transparent = true;
    }
    dirty.current = true;
  };

  const onContextCreate = (gl: ExpoWebGLRenderingContext) => {
    try {
      const width = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      // three.js only needs a canvas-shaped object around expo-gl's context.
      const canvas = {
        width,
        height: h,
        style: {},
        clientHeight: h,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        getContext: () => gl,
      } as unknown as HTMLCanvasElement;
      const renderer = new THREE.WebGLRenderer({ canvas, context: gl as unknown as WebGL2RenderingContext, antialias: true });
      renderer.setPixelRatio(1);
      renderer.setSize(width, h, false);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, width / Math.max(h, 1), 0.01, 100);
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      scene.add(mesh);
      const grid = new THREE.GridHelper(2.4, 12);
      grid.position.y = -0.01;
      scene.add(grid);
      sceneRef.current = { gl, renderer, scene, camera, mesh, grid, shape: '' };
      applyTheme();
      placeCamera();
      applyGeometry();
      setReady(true);
    } catch {
      unavailable.current();
    }
  };

  // Draw loop: render only when dirty; stopped while inactive.
  useEffect(() => {
    if (!ready || !active) return undefined;
    let frame = 0;
    const loop = () => {
      const current = sceneRef.current;
      if (current && dirty.current) {
        dirty.current = false;
        current.renderer.render(current.scene, current.camera);
        current.gl.endFrameEXP();
      }
      frame = requestAnimationFrame(loop);
    };
    dirty.current = true;
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [ready, active]);

  useEffect(() => {
    if (ready) applyGeometry();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, values, rows, cols, range]);

  useEffect(() => {
    if (ready) applyTheme();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, colors.clear, colors.line]);

  useEffect(
    () => () => {
      const current = sceneRef.current;
      sceneRef.current = null;
      if (!current) return;
      current.mesh.geometry.dispose();
      current.mesh.material.dispose();
      current.grid.dispose();
      current.renderer.dispose();
    },
    [],
  );

  const gesture = useRef<{ x: number; y: number; pinch: number | null; start: Orbit }>({ x: 0, y: 0, pinch: null, start: START });
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
          placeCamera();
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
