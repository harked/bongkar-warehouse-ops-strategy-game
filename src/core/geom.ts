import type { V2 } from './types';

/** rotation.y that points an object's local +Z along (dx, dz). */
export const headingOf = (dx: number, dz: number): number => Math.atan2(dx, dz);

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const smoothstep = (t: number): number => {
  const c = clamp(t, 0, 1);
  return c * c * (3 - 2 * c);
};
export const dist2 = (a: V2, b: V2): number => Math.hypot(a.x - b.x, a.z - b.z);

/** Shortest signed angle from a to b, in (-PI, PI]. */
export const angleDelta = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
};

/** Exponential smoothing factor for frame-rate independent damping. */
export const damp = (lambda: number, dt: number): number => 1 - Math.exp(-lambda * dt);

export function polylineLength(pts: V2[]): number {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += dist2(pts[i - 1], pts[i]);
  return L;
}

/** Point and tangent heading at distance s along a polyline. */
export function samplePolyline(pts: V2[], s: number, out: V2 = { x: 0, z: 0 }): { p: V2; heading: number } {
  let rem = s;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = dist2(a, b);
    if (rem <= len || i === pts.length - 1) {
      const t = len > 0 ? clamp(rem / len, 0, 1) : 0;
      out.x = lerp(a.x, b.x, t);
      out.z = lerp(a.z, b.z, t);
      return { p: out, heading: headingOf(b.x - a.x, b.z - a.z) };
    }
    rem -= len;
  }
  out.x = pts[0].x;
  out.z = pts[0].z;
  return { p: out, heading: 0 };
}

/** Offset a polyline sideways (positive = to the right of travel direction, Y up). */
export function offsetPolyline(pts: V2[], d: number): V2[] {
  return pts.map((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    // Right of travel with Y up and heading atan2(x,z): right = (-tz, tx).
    return { x: p.x - tz * d, z: p.z + tx * d };
  });
}

/** Deterministic PRNG (mulberry32) so layouts and decor are stable between reloads. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
