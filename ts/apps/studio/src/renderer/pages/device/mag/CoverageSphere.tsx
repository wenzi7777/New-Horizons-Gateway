import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { COVERAGE_DIRECTIONS, type MagCoverage, type MagFace, type MagVec } from "@nhgw/host";

// Where the field has been seen from: 26 directions on a sphere, lit once
// covered, the least-covered face's still-dark ones pulsing (turn the board
// so those fill), and every kept sample as a faint dot. In the sensor's own
// frame. Three.js, slowly turning, draggable; an SVG view of the same when
// WebGL is not available.

const FACE_AXIS: Record<MagFace, MagVec> = { "+x": [1, 0, 0], "-x": [-1, 0, 0], "+y": [0, 1, 0], "-y": [0, -1, 0], "+z": [0, 0, 1], "-z": [0, 0, -1] };
const MAX_DOTS = 2000;

export function isNextFaceDirection(dir: MagVec, nextFace: MagFace | null): boolean {
  if (!nextFace) return false;
  const axis = FACE_AXIS[nextFace];
  return dir[0] * axis[0] + dir[1] * axis[1] + dir[2] * axis[2] > 0.5;
}

/** Sample directions around the cloud's centre, on the unit sphere. */
function sampleDirections(points: readonly MagVec[], centre: MagVec): MagVec[] {
  const out: MagVec[] = [];
  for (const p of points) {
    const d: MagVec = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
    const n = Math.hypot(d[0], d[1], d[2]);
    if (n > 0) out.push([d[0] / n, d[1] / n, d[2] / n]);
  }
  return out;
}

function cssColor(element: Element, name: string, fallback: string): THREE.Color {
  const value = getComputedStyle(element).getPropertyValue(name).trim();
  try {
    return new THREE.Color(value || fallback);
  } catch {
    return new THREE.Color(fallback);
  }
}

type Scene = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  markers: THREE.Mesh<THREE.SphereGeometry, THREE.MeshBasicMaterial>[];
  samples: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  disposables: { dispose(): void }[];
  frame: number;
  resize: ResizeObserver | null;
};

export function CoverageSphere({ coverage, points, label }: { coverage: MagCoverage; points: readonly MagVec[]; label: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<Scene | null>(null);
  const stateRef = useRef({ coverage, points });
  stateRef.current = { coverage, points };
  const [webglFailed, setWebglFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let current: Scene;
    try {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      host.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 50);
      camera.position.set(2.6, 2.0, 3.4);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enablePan = false;
      controls.enableZoom = false;
      controls.autoRotate = !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      controls.autoRotateSpeed = 1.2;
      const disposables: { dispose(): void }[] = [];

      const line = cssColor(host, "--text-muted", "#86868b");
      const wire = new THREE.WireframeGeometry(new THREE.SphereGeometry(1, 18, 12));
      const wireMaterial = new THREE.LineBasicMaterial({ color: line, transparent: true, opacity: 0.18 });
      scene.add(new THREE.LineSegments(wire, wireMaterial));
      disposables.push(wire, wireMaterial);

      // Sensor axes: x red, y green, z blue (the usual convention).
      const axes: [MagVec, number][] = [[[1, 0, 0], 0xd9534f], [[0, 1, 0], 0x3aa57f], [[0, 0, 1], 0x3b82f6]];
      for (const [dir, color] of axes) {
        const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(dir[0] * 1.35, dir[2] * 1.35, -dir[1] * 1.35)]);
        const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.7 });
        scene.add(new THREE.Line(geometry, material));
        disposables.push(geometry, material);
      }

      const markerGeometry = new THREE.SphereGeometry(0.075, 16, 12);
      disposables.push(markerGeometry);
      const markers = COVERAGE_DIRECTIONS.map((dir) => {
        const material = new THREE.MeshBasicMaterial({ color: line });
        const mesh = new THREE.Mesh(markerGeometry, material);
        // Sensor z up on screen: (x, y, z) -> (x, z, -y).
        mesh.position.set(dir[0], dir[2], -dir[1]);
        scene.add(mesh);
        disposables.push(material);
        return mesh;
      });

      const sampleGeometry = new THREE.BufferGeometry();
      sampleGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(MAX_DOTS * 3), 3));
      sampleGeometry.setDrawRange(0, 0);
      const sampleMaterial = new THREE.PointsMaterial({ color: cssColor(host, "--accent", "#1f6b54"), size: 0.03, transparent: true, opacity: 0.55 });
      const samples = new THREE.Points(sampleGeometry, sampleMaterial);
      scene.add(samples);
      disposables.push(sampleGeometry, sampleMaterial);

      const applySize = () => {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
      };
      applySize();
      const resize = typeof ResizeObserver !== "undefined" ? new ResizeObserver(applySize) : null;
      resize?.observe(host);

      current = { renderer, scene, camera, controls, markers, samples, disposables, frame: 0, resize };
      sceneRef.current = current;
    } catch {
      setWebglFailed(true);
      return;
    }

    const accent = cssColor(host, "--accent", "#1f6b54");
    const warning = cssColor(host, "--warning", "#b25000");
    const idle = cssColor(host, "--text-muted", "#86868b");
    const tick = (time: number) => {
      const { coverage: cov, points: pts } = stateRef.current;
      const pulse = 1 + 0.45 * (0.5 + 0.5 * Math.sin(time / 260));
      COVERAGE_DIRECTIONS.forEach((dir, i) => {
        const mesh = current.markers[i]!;
        const covered = cov.covered[i] === true;
        const next = !covered && isNextFaceDirection(dir, cov.nextFace);
        mesh.material.color.copy(covered ? accent : next ? warning : idle);
        mesh.scale.setScalar(covered ? 1.15 : next ? pulse : 0.8);
      });
      const dirs = sampleDirections(pts.slice(-MAX_DOTS), cov.centre);
      const attribute = current.samples.geometry.getAttribute("position") as THREE.BufferAttribute;
      dirs.forEach((d, i) => attribute.setXYZ(i, d[0] * 0.995, d[2] * 0.995, -d[1] * 0.995));
      attribute.needsUpdate = true;
      current.samples.geometry.setDrawRange(0, dirs.length);
      current.controls.update();
      current.renderer.render(current.scene, current.camera);
      current.frame = requestAnimationFrame(tick);
    };
    current.frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(current.frame);
      current.resize?.disconnect();
      current.controls.dispose();
      current.disposables.forEach((item) => item.dispose());
      current.renderer.dispose();
      current.renderer.domElement.remove();
      sceneRef.current = null;
    };
  }, []);

  return (
    <div className="mag-sphere" role="img" aria-label={label}>
      {webglFailed ? <CoverageSphereSvg coverage={coverage} points={points} /> : <div ref={hostRef} className="mag-sphere-canvas" />}
    </div>
  );
}

/** The same picture flat (oblique projection), for when WebGL is not there. */
export function CoverageSphereSvg({ coverage, points }: { coverage: MagCoverage; points: readonly MagVec[] }) {
  // Sensor z up; x to the lower right, y to the upper right.
  const project = (d: MagVec) => {
    const x = (d[0] - d[1]) * 0.8;
    const y = -d[2] * 0.9 + (d[0] + d[1]) * 0.35;
    const depth = d[0] + d[1];
    return { x: x * 80, y: y * 80, depth };
  };
  const dirs = sampleDirections(points.slice(-600), coverage.centre);
  const markers = COVERAGE_DIRECTIONS.map((dir, i) => ({ dir, i, ...project(dir) })).sort((a, b) => a.depth - b.depth);
  return (
    <svg viewBox="-110 -110 220 220" className="mag-sphere-svg" aria-hidden="true">
      <circle cx={0} cy={0} r={92} className="mag-sphere-outline" />
      <ellipse cx={0} cy={0} rx={92} ry={30} className="mag-sphere-outline faint" />
      {dirs.map((d, i) => {
        const p = project(d);
        return <circle key={`s${i}`} cx={p.x} cy={p.y} r={1.2} className="mag-sphere-sample" />;
      })}
      {markers.map(({ dir, i, x, y, depth }) => {
        const covered = coverage.covered[i] === true;
        const next = !covered && isNextFaceDirection(dir, coverage.nextFace);
        return (
          <circle
            key={i}
            cx={x}
            cy={y}
            r={depth < 0 ? 4 : 5.5}
            className={`mag-sphere-marker${covered ? " covered" : next ? " next" : ""}${depth < 0 ? " behind" : ""}`}
          />
        );
      })}
    </svg>
  );
}
