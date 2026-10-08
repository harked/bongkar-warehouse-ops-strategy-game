/**
 * Geometry assembly helpers. Every vehicle is merged into very few meshes: each part is baked
 * with a vertex colour, a material tag (paint slot, glass, rubber, lamp channel) and a motion
 * descriptor (wheel spin, door hinge, mast lift) that the shared vehicle shader reads.
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Material tags read by the vehicle shader (see material.ts). */
export const TAG = {
  plain: 0,
  /** Multiplied by the per-unit paint A (truck cab, forklift body). */
  paintA: 1,
  /** Multiplied by the per-unit paint B (trailer). */
  paintB: 2,
  glass: 3,
  rubber: 4,
  /** Satin metal / chrome-ish trim (low roughness). */
  chrome: 5,
  /** Lamp channel n is tag lamp + n. */
  lamp: 8,
} as const;

/** Lamp channels (index into the uLamp uniform array). */
export const LAMP = {
  brake: 0,
  reverse: 1,
  blinkLeft: 2,
  blinkRight: 3,
  marker: 4,
  head: 5,
  status: 6,
  /** Forklift beacon; on trucks the same channel lights the trailer interior when doors open. */
  beacon: 7,
  interior: 7,
} as const;

/** Motion kinds for the aMove attribute (x component). */
export const MOVE = { none: 0, spin: 1, hinge: 2, lift: 3 } as const;

export type Vec4 = [number, number, number, number];
export type ColorFn = (p: THREE.Vector3, n: THREE.Vector3) => number;

export interface PartOpts {
  color: number | ColorFn;
  tag?: number | ((p: THREE.Vector3, n: THREE.Vector3) => number);
  move?: Vec4;
  pos?: [number, number, number];
  rot?: [number, number, number];
  /** Optional extra matrix applied before rot/pos. */
  matrix?: THREE.Matrix4;
}

const _c = new THREE.Color();
const _p = new THREE.Vector3();
const _n = new THREE.Vector3();
const colorCache = new Map<number, THREE.Color>();

/** sRGB hex -> linear working colour (cached). */
export function lin(hex: number): THREE.Color {
  let c = colorCache.get(hex);
  if (!c) {
    c = new THREE.Color(hex);
    colorCache.set(hex, c);
  }
  return c;
}

/** Mix two sRGB hex colours (in sRGB space), returns hex. */
export function mixHex(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255,
    ag = (a >> 8) & 255,
    ab = a & 255;
  const br = (b >> 16) & 255,
    bg = (b >> 8) & 255,
    bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Strip to position + normal and make sure the geometry is indexed. */
function normalise(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', src.getAttribute('position').clone());
  if (!src.getAttribute('normal')) src.computeVertexNormals();
  g.setAttribute('normal', src.getAttribute('normal').clone());
  if (src.index) g.setIndex(src.index.clone());
  else {
    const n = src.getAttribute('position').count;
    const idx = new Array<number>(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    g.setIndex(idx);
  }
  return g;
}

export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];
  /** When set, every part added gets this extra attribute set (for instanced pallets we skip tags). */
  constructor(private withTags = true) {}

  add(src: THREE.BufferGeometry, o: PartOpts): this {
    const g = normalise(src);
    src.dispose();
    const m = new THREE.Matrix4();
    if (o.matrix) m.copy(o.matrix);
    if (o.rot) m.premultiply(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(o.rot[0], o.rot[1], o.rot[2])));
    if (o.pos) m.premultiply(new THREE.Matrix4().makeTranslation(o.pos[0], o.pos[1], o.pos[2]));
    g.applyMatrix4(m);
    const pos = g.getAttribute('position');
    const nor = g.getAttribute('normal');
    const n = pos.count;
    const col = new Float32Array(n * 3);
    const tag = new Float32Array(n);
    const mv = new Float32Array(n * 4);
    const move = o.move ?? [0, 0, 0, 0];
    for (let i = 0; i < n; i++) {
      _p.fromBufferAttribute(pos, i);
      _n.fromBufferAttribute(nor, i);
      const hex = typeof o.color === 'function' ? o.color(_p, _n) : o.color;
      _c.copy(lin(hex));
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
      tag[i] = typeof o.tag === 'function' ? o.tag(_p, _n) : (o.tag ?? 0);
      mv[i * 4] = move[0];
      mv[i * 4 + 1] = move[1];
      mv[i * 4 + 2] = move[2];
      mv[i * 4 + 3] = move[3];
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (this.withTags) {
      g.setAttribute('aTag', new THREE.BufferAttribute(tag, 1));
      g.setAttribute('aMove', new THREE.BufferAttribute(mv, 4));
    }
    this.parts.push(g);
    return this;
  }

  /** Axis aligned box from min/max corners. */
  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: Omit<PartOpts, 'pos'>, omit?: string): this {
    const g = boxGeo(x1 - x0, y1 - y0, z1 - z0, omit);
    return this.add(g, { ...o, matrix: new THREE.Matrix4().makeTranslation((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2).multiply(o.matrix ?? new THREE.Matrix4()) });
  }

  /** Mirror helper: adds the same box at +x and its mirror at -x. */
  boxX(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, o: Omit<PartOpts, 'pos'>, omit?: string): this {
    this.box(x0, y0, z0, x1, y1, z1, o, omit);
    return this.box(-x1, y0, z0, -x0, y1, z1, o, omit);
  }

  get count(): number {
    return this.parts.length;
  }

  build(): THREE.BufferGeometry {
    const g = mergeGeometries(this.parts, false);
    if (!g) throw new Error('vehicles: merge failed');
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  }
}

/**
 * Box with optional omitted faces ("+x-y" etc) to save vertices on hidden sides.
 * Face order matches THREE.BoxGeometry: +x, -x, +y, -y, +z, -z.
 */
export function boxGeo(w: number, h: number, d: number, omit?: string): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d);
  if (!omit) return g;
  const faces = ['+x', '-x', '+y', '-y', '+z', '-z'];
  const keep: number[] = [];
  const idx = g.index!.array;
  faces.forEach((f, i) => {
    if (omit.includes(f)) return;
    for (let k = 0; k < 6; k++) keep.push(idx[i * 6 + k]);
  });
  g.setIndex(keep);
  return g;
}

/** Cylinder whose axis runs along X (wheels, axles). */
export function cylX(r: number, len: number, seg: number, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, open);
  g.rotateZ(Math.PI / 2);
  return g;
}

/** Cylinder whose axis runs along Z. */
export function cylZ(r: number, len: number, seg: number, open = false): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r, r, len, seg, 1, open);
  g.rotateX(Math.PI / 2);
  return g;
}

/** Flat disc facing +x or -x (cap for X-axis cylinders), indexed. */
export function discX(r: number, seg: number, facing: 1 | -1): THREE.BufferGeometry {
  const g = new THREE.CircleGeometry(r, seg);
  g.rotateY((facing * Math.PI) / 2);
  return g;
}
