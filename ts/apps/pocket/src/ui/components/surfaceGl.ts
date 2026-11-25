// A minimal WebGL 1 renderer for the live 3D pressure surface. Pocket used
// three.js here, but three.js r187 only speaks WebGL 2 (GLSL ES 3.00), which
// expo-gl does not fully implement on Android: on a Pixel 4a switching to 3D
// threw inside the draw loop and the app closed. This draws the same picture
// (NH Studio's Surface3D: vertex-coloured surface, ground grid, same camera)
// with only the WebGL 1 calls expo-gl supports: one GLSL ES 1.00 program,
// Float32 vertex buffers, Uint16 indices, GL_TRIANGLES and GL_LINES.
//
// The matrix helpers are pure (tested in test/ui/surfaceGl.test.ts); the
// renderer throws on any GL failure so the caller can fall back to 2D.

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;
export type Orbit = { theta: number; phi: number; distance: number };

export const SURFACE_TARGET: Vec3 = [0, 0.15, 0];
// The Desktop's starting view (VisualizationPage resetSurfaceCamera: camera at
// (0.8, 0.75, 1.15) x the surface size): turned about 35 deg to the side and
// looking down about 28 deg, so the surface opens at an angle rather than
// face-on. The host geometry spans +-1, twice the Desktop's unit, hence the
// distance.
export const SURFACE_START: Orbit = { theta: 0.608, phi: 1.079, distance: 3.0 };
export const SURFACE_FOV_DEG = 42;
/** three.js GridHelper(2.4, 12), just under the surface. */
export const GRID_SIZE = 2.4;
export const GRID_DIVISIONS = 12;
const GRID_Y = -0.01;

/** Column-major perspective projection (as gl-matrix / three.js). */
export function perspective(fovyDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / (aspect || 1);
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 1e-12 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Column-major view matrix looking from `eye` at `target`. */
export function lookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const z = normalize(sub(eye, target));
  let x = normalize(cross(up, z));
  if (x[0] === 0 && x[1] === 0 && x[2] === 0) x = [1, 0, 0];
  const y = cross(z, x);
  const out = new Float32Array(16);
  out[0] = x[0];
  out[1] = y[0];
  out[2] = z[0];
  out[4] = x[1];
  out[5] = y[1];
  out[6] = z[1];
  out[8] = x[2];
  out[9] = y[2];
  out[10] = z[2];
  out[12] = -dot(x, eye);
  out[13] = -dot(y, eye);
  out[14] = -dot(z, eye);
  out[15] = 1;
  return out;
}

/** a × b (column-major). */
export function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + row]! * b[col * 4 + k]!;
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

/** Where the camera sits for an orbit around SURFACE_TARGET. */
export function orbitEye({ theta, phi, distance }: Orbit, target: Vec3 = SURFACE_TARGET): Vec3 {
  return [
    target[0] + distance * Math.sin(phi) * Math.sin(theta),
    target[1] + distance * Math.cos(phi),
    target[2] + distance * Math.sin(phi) * Math.cos(theta),
  ];
}

/** Projection × view for an orbit and a viewport aspect. */
export function orbitMatrix(orbit: Orbit, aspect: number): Mat4 {
  return multiply(perspective(SURFACE_FOV_DEG, aspect, 0.01, 100), lookAt(orbitEye(orbit), SURFACE_TARGET));
}

/** The ground grid as line-segment endpoints (x, y, z per point). */
export function gridLines(size = GRID_SIZE, divisions = GRID_DIVISIONS, y = GRID_Y): Float32Array {
  const half = size / 2;
  const out = new Float32Array((divisions + 1) * 4 * 3);
  let k = 0;
  for (let i = 0; i <= divisions; i++) {
    const p = -half + (size * i) / divisions;
    out.set([-half, y, p, half, y, p, p, y, -half, p, y, half], k);
    k += 12;
  }
  return out;
}

/** Indices as Uint16 (WebGL 1 without extensions), or null if a vertex is out of reach. */
export function toUint16Indices(indices: readonly number[], vertexCount: number): Uint16Array | null {
  if (vertexCount > 65536) return null;
  return Uint16Array.from(indices);
}

/** A CSS colour (#rgb, #rrggbb, rgb()/rgba()) as 0..1 rgb, or the fallback. */
export function parseCssColor(value: string, fallback: Vec3): Vec3 {
  const v = value.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return [0, 1, 2].map((i) => parseInt(m![1]![i]! + m![1]![i]!, 16) / 255) as Vec3;
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1]!.slice(i, i + 2), 16) / 255) as Vec3;
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(v);
  if (m) return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255];
  return fallback;
}

const VERTEX_SHADER = `
attribute vec3 aPosition;
attribute vec3 aColor;
uniform mat4 uMatrix;
varying vec3 vColor;
void main() {
  vColor = aColor;
  gl_Position = uMatrix * vec4(aPosition, 1.0);
}
`;

const FRAGMENT_SHADER = `
precision mediump float;
varying vec3 vColor;
uniform float uAlpha;
void main() {
  gl_FragColor = vec4(vColor, uAlpha);
}
`;

/** The subset of WebGLRenderingContext used here (expo-gl's context provides it). */
type GL = WebGLRenderingContext;

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('createShader failed');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader: ${log ?? 'compile failed'}`);
  }
  return shader;
}

function buffer(gl: GL): WebGLBuffer {
  const b = gl.createBuffer();
  if (!b) throw new Error('createBuffer failed');
  return b;
}

/** Draws one surface and the grid; every method may throw (the caller falls back to 2D). */
export class SurfaceRenderer {
  private readonly gl: GL;
  private readonly program: WebGLProgram;
  private readonly shaders: WebGLShader[];
  private readonly aPosition: number;
  private readonly aColor: number;
  private readonly uMatrix: WebGLUniformLocation;
  private readonly uAlpha: WebGLUniformLocation;
  private readonly positions: WebGLBuffer;
  private readonly colors: WebGLBuffer;
  private readonly indices: WebGLBuffer;
  private readonly grid: WebGLBuffer;
  private readonly gridCount: number;
  private indexCount = 0;
  private vertexCount = 0;
  private clear: Vec3 = [0.2, 0.2, 0.21];
  private line: Vec3 = [0.56, 0.56, 0.58];

  constructor(gl: GL) {
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    this.shaders = [vs, fs];
    const program = gl.createProgram();
    if (!program) throw new Error('createProgram failed');
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program) ?? 'link failed'}`);
    this.program = program;
    this.aPosition = gl.getAttribLocation(program, 'aPosition');
    this.aColor = gl.getAttribLocation(program, 'aColor');
    const uMatrix = gl.getUniformLocation(program, 'uMatrix');
    const uAlpha = gl.getUniformLocation(program, 'uAlpha');
    if (this.aPosition < 0 || this.aColor < 0 || !uMatrix || !uAlpha) throw new Error('shader inputs missing');
    this.uMatrix = uMatrix;
    this.uAlpha = uAlpha;
    this.positions = buffer(gl);
    this.colors = buffer(gl);
    this.indices = buffer(gl);
    this.grid = buffer(gl);
    const lines = gridLines();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grid);
    gl.bufferData(gl.ARRAY_BUFFER, lines, gl.STATIC_DRAW);
    this.gridCount = lines.length / 3;
  }

  setColors(clear: Vec3, line: Vec3): void {
    this.clear = clear;
    this.line = line;
  }

  /** New surface data (positions / colours: 3 floats per vertex). */
  setGeometry(positions: Float32Array, colors: Float32Array, indices: readonly number[]): void {
    const gl = this.gl;
    const vertexCount = positions.length / 3;
    const sameShape = vertexCount === this.vertexCount && indices.length === this.indexCount;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
    if (sameShape) gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);
    else gl.bufferData(gl.ARRAY_BUFFER, positions, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
    if (sameShape) gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
    else gl.bufferData(gl.ARRAY_BUFFER, colors, gl.DYNAMIC_DRAW);
    if (!sameShape) {
      const index = toUint16Indices(indices, vertexCount);
      if (!index) throw new Error('too many vertices');
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, index, gl.STATIC_DRAW);
      this.indexCount = index.length;
      this.vertexCount = vertexCount;
    }
  }

  draw(width: number, height: number, orbit: Orbit): void {
    const gl = this.gl;
    gl.viewport(0, 0, width, height);
    gl.clearColor(this.clear[0], this.clear[1], this.clear[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.useProgram(this.program);
    gl.uniformMatrix4fv(this.uMatrix, false, orbitMatrix(orbit, width / Math.max(height, 1)));

    // Surface: per-vertex colour, opaque.
    if (this.indexCount > 0) {
      gl.disable(gl.BLEND);
      gl.uniform1f(this.uAlpha, 1);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.positions);
      gl.enableVertexAttribArray(this.aPosition);
      gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
      gl.enableVertexAttribArray(this.aColor);
      gl.vertexAttribPointer(this.aColor, 3, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    }

    // Grid: one colour, translucent.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.uniform1f(this.uAlpha, 0.35);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grid);
    gl.enableVertexAttribArray(this.aPosition);
    gl.vertexAttribPointer(this.aPosition, 3, gl.FLOAT, false, 0, 0);
    gl.disableVertexAttribArray(this.aColor);
    gl.vertexAttrib3f(this.aColor, this.line[0], this.line[1], this.line[2]);
    gl.drawArrays(gl.LINES, 0, this.gridCount);
    gl.flush();
  }

  dispose(): void {
    const gl = this.gl;
    for (const b of [this.positions, this.colors, this.indices, this.grid]) gl.deleteBuffer(b);
    gl.deleteProgram(this.program);
    for (const s of this.shaders) gl.deleteShader(s);
  }
}
