/**
 * Small geometry toolkit for the world builder: a vertex-colour batch that merges many
 * primitives into one draw call, plus 2D helpers (clipping lines against road footprints).
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { V2 } from '../core/types';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();

/** Mix two hex colours in sRGB space (t = 0 gives a). Returns a hex number. */
export function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const bl = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | bl;
}

/** Prepare a geometry for merging: non-indexed, position + normal (+ uv) + colour. */
function normalise(geo: THREE.BufferGeometry, color: number | null, keepUv: boolean): THREE.BufferGeometry {
  let g = geo.index ? geo.toNonIndexed() : geo;
  if (g === geo) g = geo.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'color' && !(keepUv && name === 'uv')) g.deleteAttribute(name);
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  if (keepUv && !g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  if (color !== null || !g.attributes.color) {
    _c.setHex(color ?? 0xffffff);
    const n = g.attributes.position.count;
    const arr = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      arr[i * 3] = _c.r;
      arr[i * 3 + 1] = _c.g;
      arr[i * 3 + 2] = _c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  }
  g.morphAttributes = {};
  g.clearGroups();
  return g;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);

/**
 * Accumulates coloured primitives and merges them into a single mesh. All parts share one
 * vertex-coloured material, so a whole site's static shell costs one draw call.
 */
export class Batch {
  private parts: THREE.BufferGeometry[] = [];
  constructor(private keepUv = false) {}

  get empty(): boolean {
    return this.parts.length === 0;
  }

  /** Add a geometry transformed by position / rotation (Euler XYZ) / scale, painted one colour. */
  add(
    geo: THREE.BufferGeometry,
    color: number | null,
    px = 0,
    py = 0,
    pz = 0,
    rx = 0,
    ry = 0,
    rz = 0,
    sx = 1,
    sy = 1,
    sz = 1,
  ): void {
    const g = normalise(geo, color, this.keepUv);
    _e.set(rx, ry, rz);
    _q.setFromEuler(_e);
    _m.compose(_p.set(px, py, pz), _q, _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    this.parts.push(g);
  }

  /** Add a geometry transformed by an explicit matrix. */
  addMatrix(geo: THREE.BufferGeometry, color: number | null, m: THREE.Matrix4): void {
    const g = normalise(geo, color, this.keepUv);
    g.applyMatrix4(m);
    this.parts.push(g);
  }

  /** Add an already-placed geometry (world space). */
  addRaw(geo: THREE.BufferGeometry, color: number | null): void {
    this.parts.push(normalise(geo, color, this.keepUv));
  }

  /** Axis-aligned box by centre and size, optional yaw. */
  box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, color: number, ry = 0): void {
    this.add(unitBox, color, cx, cy, cz, 0, ry, 0, sx, sy, sz);
  }

  /** Box from min/max corners. */
  boxMinMax(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, color: number): void {
    const sx = Math.abs(x1 - x0), sy = Math.abs(y1 - y0), sz = Math.abs(z1 - z0);
    if (sx < 1e-4 || sy < 1e-4 || sz < 1e-4) return;
    this.box((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, sx, sy, sz, color);
  }

  /** Box spanning a 2D segment a->b (centre line), width w across, y0..y1. */
  segBox(a: V2, b: V2, w: number, y0: number, y1: number, color: number): void {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    this.add(unitBox, color, (a.x + b.x) / 2, (y0 + y1) / 2, (a.z + b.z) / 2, 0, Math.atan2(dx, dz), 0, w, y1 - y0, len);
  }

  /** Flat horizontal quad (two triangles, normal up) from four corners at height y. */
  quad(pts: V2[], y: number, color: number, uv?: [number, number][]): void {
    const pos = new Float32Array(18);
    const order = [0, 2, 1, 0, 3, 2];
    // Make winding counter-clockwise when viewed from above (+y).
    const area = (pts[1].x - pts[0].x) * (pts[2].z - pts[0].z) - (pts[2].x - pts[0].x) * (pts[1].z - pts[0].z);
    const idx = area > 0 ? order : [0, 1, 2, 0, 2, 3];
    idx.forEach((k, i) => {
      pos[i * 3] = pts[k].x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = pts[k].z;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const nrm = new Float32Array(18);
    for (let i = 0; i < 6; i++) nrm[i * 3 + 1] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    if (uv) {
      const u = new Float32Array(12);
      idx.forEach((k, i) => {
        u[i * 2] = uv[k][0];
        u[i * 2 + 1] = uv[k][1];
      });
      g.setAttribute('uv', new THREE.BufferAttribute(u, 2));
    }
    this.addRaw(g, color);
  }

  /** Axis-aligned horizontal rectangle. */
  rect(x0: number, z0: number, x1: number, z1: number, y: number, color: number): void {
    this.quad([{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }], y, color);
  }

  /** Horizontal strip along a segment. */
  strip(a: V2, b: V2, w: number, y: number, color: number): void {
    const dx = b.x - a.x, dz = b.z - a.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return;
    const nx = (-dz / len) * (w / 2), nz = (dx / len) * (w / 2);
    this.quad([{ x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz }, { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz }], y, color);
  }

  /** Rectangle outline (painted lines) of an axis-aligned box centred at (cx, cz). */
  outline(cx: number, cz: number, sx: number, sz: number, lw: number, y: number, color: number): void {
    const hx = sx / 2, hz = sz / 2;
    this.rect(cx - hx, cz - hz, cx + hx, cz - hz + lw, y, color);
    this.rect(cx - hx, cz + hz - lw, cx + hx, cz + hz, y, color);
    this.rect(cx - hx, cz - hz + lw, cx - hx + lw, cz + hz - lw, y, color);
    this.rect(cx + hx - lw, cz - hz + lw, cx + hx, cz + hz - lw, y, color);
  }

  geometry(): THREE.BufferGeometry {
    const g = this.parts.length ? mergeGeometries(this.parts, false)! : new THREE.BufferGeometry();
    for (const p of this.parts) p.dispose();
    this.parts = [];
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }

  mesh(material: THREE.Material, opts: { cast?: boolean; receive?: boolean; pickable?: boolean } = {}): THREE.Mesh {
    const m = new THREE.Mesh(this.geometry(), material);
    m.castShadow = opts.cast ?? false;
    m.receiveShadow = opts.receive ?? true;
    m.matrixAutoUpdate = false;
    m.updateMatrix();
    if (!opts.pickable) noRaycast(m);
    return m;
  }
}

/** Decor never takes part in picking: skip the (expensive) raycast entirely. */
export function noRaycast(o: THREE.Object3D): void {
  o.raycast = () => {};
}

/** Shared vertex-colour materials. */
export function vcMaterial(opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0, ...opts });
}

/** Decal material for flat paint layered over ground: polygon offset avoids z-fighting. */
export function decalMaterial(layer: number, opts: THREE.MeshStandardMaterialParameters = {}): THREE.MeshStandardMaterial {
  return vcMaterial({ polygonOffset: true, polygonOffsetFactor: -layer, polygonOffsetUnits: -layer * 2, ...opts });
}

// ---- 2D helpers ------------------------------------------------------------------------------

/** Oriented rectangle: centre segment a->b extended by `cap` at both ends, half width hw. */
export interface ORect {
  a: V2;
  b: V2;
  hw: number;
  cap: number;
}

/** Inside test for a point against an oriented rectangle. */
export function inORect(p: V2, r: ORect, margin = 0): boolean {
  const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  const px = p.x - r.a.x, pz = p.z - r.a.z;
  const along = px * ux + pz * uz;
  const across = -px * uz + pz * ux;
  return along > -r.cap - margin && along < len + r.cap + margin && Math.abs(across) < r.hw + margin;
}

/** Parameter interval [t0, t1] of segment p->q inside an oriented rectangle, or null. */
function clipInterval(p: V2, q: V2, r: ORect, margin: number): [number, number] | null {
  const dx = r.b.x - r.a.x, dz = r.b.z - r.a.z;
  const len = Math.hypot(dx, dz) || 1;
  const ux = dx / len, uz = dz / len;
  // Local coordinates: along (u) and across (v).
  const loc = (s: V2) => {
    const px = s.x - r.a.x, pz = s.z - r.a.z;
    return [px * ux + pz * uz, -px * uz + pz * ux];
  };
  const [pu, pv] = loc(p);
  const [qu, qv] = loc(q);
  let t0 = 0, t1 = 1;
  const slabs: [number, number, number, number][] = [
    [pu, qu - pu, -r.cap - margin, len + r.cap + margin],
    [pv, qv - pv, -r.hw - margin, r.hw + margin],
  ];
  for (const [o, d, lo, hi] of slabs) {
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    let a = (lo - o) / d, b = (hi - o) / d;
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 >= t1) return null;
  }
  return [t0, t1];
}

/** Pieces of segment p->q that lie OUTSIDE all rectangles. */
export function clipOutside(p: V2, q: V2, rects: ORect[], margin = 0): [V2, V2][] {
  const cuts: [number, number][] = [];
  for (const r of rects) {
    const iv = clipInterval(p, q, r, margin);
    if (iv) cuts.push(iv);
  }
  cuts.sort((a, b) => a[0] - b[0]);
  const keep: [number, number][] = [];
  let t = 0;
  for (const [a, b] of cuts) {
    if (a > t) keep.push([t, a]);
    t = Math.max(t, b);
  }
  if (t < 1) keep.push([t, 1]);
  const at = (s: number): V2 => ({ x: p.x + (q.x - p.x) * s, z: p.z + (q.z - p.z) * s });
  return keep.filter(([a, b]) => (b - a) * Math.hypot(q.x - p.x, q.z - p.z) > 0.05).map(([a, b]) => [at(a), at(b)]);
}

export function distToSeg(p: V2, a: V2, b: V2): number {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l2 = dx * dx + dz * dz;
  let t = l2 > 0 ? ((p.x - a.x) * dx + (p.z - a.z) * dz) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t);
}

export function distToPolyline(p: V2, pts: V2[]): number {
  let d = Infinity;
  for (let i = 1; i < pts.length; i++) d = Math.min(d, distToSeg(p, pts[i - 1], pts[i]));
  return d;
}

export function distToRect(p: V2, r: { x0: number; z0: number; x1: number; z1: number }): number {
  const dx = Math.max(r.x0 - p.x, 0, p.x - r.x1);
  const dz = Math.max(r.z0 - p.z, 0, p.z - r.z1);
  return Math.hypot(dx, dz);
}
