// 3D pressure surface (the Desktop Visualization's PressureSurface3D idea):
// one vertex per sensor, height and colour from the pressure scale, orbit
// controls. Lazy-loaded so three.js stays out of the first bundle. Scene
// colours come from the theme tokens; only the surface uses the data scale.

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { rgbForValue, valueRatio, type PressureRange } from '../lib/pressureColor';

export type Surface3DProps = {
  values: readonly number[] | null;
  rows: number;
  cols: number;
  range: PressureRange;
  label: string;
  onUnavailable: () => void;
};

/** Positions (x, height, z) and colours for a rows×cols surface, plus its triangle indices. */
export function surfaceGeometry(values: readonly number[], rows: number, cols: number, range: PressureRange) {
  const scale = Math.max(rows, cols, 1);
  const width = cols / scale;
  const depth = rows / scale;
  const positions = new Float32Array(rows * cols * 3);
  const colors = new Float32Array(rows * cols * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const value = values[i] ?? range.min;
      positions[i * 3] = (cols === 1 ? 0 : c / (cols - 1) - 0.5) * width * 2;
      positions[i * 3 + 1] = valueRatio(value, range) * 0.6;
      positions[i * 3 + 2] = (rows === 1 ? 0 : r / (rows - 1) - 0.5) * depth * 2;
      const [red, green, blue] = rgbForValue(value, range);
      colors[i * 3] = red;
      colors[i * 3 + 1] = green;
      colors[i * 3 + 2] = blue;
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const a = r * cols + c;
      const b = a + 1;
      const d = a + cols;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  return { positions, colors, indices };
}

function token(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value.startsWith('#') ? value : fallback;
}

export default function Surface3D({ values, rows, cols, range, label, onUnavailable }: Surface3DProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<{
    renderer: THREE.WebGLRenderer;
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    controls: OrbitControls;
    mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    grid: THREE.GridHelper;
    frame: number;
    observer: ResizeObserver | null;
    shape: string;
  } | null>(null);
  const unavailable = useRef(onUnavailable);
  unavailable.current = onUnavailable;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.domElement.setAttribute('role', 'img');
      renderer.domElement.setAttribute('aria-label', label);
      container.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.01, 100);
      camera.position.set(0, 1.5, 1.9);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = true;
      controls.dampingFactor = 0.12;
      controls.target.set(0, 0.15, 0);
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
      mesh.frustumCulled = false;
      scene.add(mesh);
      const grid = new THREE.GridHelper(2.4, 12);
      grid.position.y = -0.01;
      scene.add(grid);

      const applyColors = () => {
        renderer.setClearColor(new THREE.Color(token('--panel-soft', '#333336')), 1);
        const line = new THREE.Color(token('--text-muted', '#8e8e93'));
        const materials = Array.isArray(grid.material) ? grid.material : [grid.material];
        for (const material of materials) {
          (material as THREE.LineBasicMaterial).color = line;
          material.opacity = 0.35;
          material.transparent = true;
        }
      };
      applyColors();
      const themeObserver = new MutationObserver(applyColors);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

      const resize = () => {
        const w = Math.max(container.clientWidth, 1);
        const h = Math.max(container.clientHeight, 1);
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
      observer?.observe(container);
      resize();
      const animate = () => {
        controls.update();
        renderer.render(scene, camera);
        const current = sceneRef.current;
        if (current) current.frame = window.requestAnimationFrame(animate);
      };
      sceneRef.current = { renderer, scene, camera, controls, mesh, grid, frame: 0, observer, shape: '' };
      animate();
      return () => {
        themeObserver.disconnect();
        const current = sceneRef.current;
        sceneRef.current = null;
        if (!current) return;
        window.cancelAnimationFrame(current.frame);
        current.observer?.disconnect();
        current.controls.dispose();
        current.mesh.geometry.dispose();
        current.mesh.material.dispose();
        current.grid.dispose();
        current.renderer.dispose();
        current.renderer.domElement.remove();
      };
    } catch {
      unavailable.current();
      return undefined;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const current = sceneRef.current;
    if (!current || !values) return;
    const { positions, colors, indices } = surfaceGeometry(values, rows, cols, range);
    const geometry = current.mesh.geometry;
    const shape = `${rows}x${cols}`;
    if (current.shape !== shape) {
      geometry.setIndex(indices);
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      current.shape = shape;
    } else {
      (geometry.getAttribute('position') as THREE.BufferAttribute).copyArray(positions).needsUpdate = true;
      (geometry.getAttribute('color') as THREE.BufferAttribute).copyArray(colors).needsUpdate = true;
    }
  }, [values, rows, cols, range]);

  return <div ref={containerRef} className="surface-3d" />;
}
