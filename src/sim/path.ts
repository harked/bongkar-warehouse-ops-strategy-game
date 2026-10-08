/**
 * Drivable paths: polylines with filleted corners, sampled with tangent headings, plus a
 * precomputed speed envelope (curvature limit and braking to the end of the path).
 */
import { angleDelta, headingOf } from '../core/geom';
import type { V2 } from '../core/types';

export interface PathOpts {
  /** Fillet radius per vertex (index into pts), or one radius for all. */
  radius: number | number[];
  /** Cruise speed per segment (index into pts, segment i = pts[i] -> pts[i+1]), or one for all. */
  speed: number | number[];
  /** Lateral acceleration used for the curvature speed limit. */
  latAcc: number;
  /** Comfortable braking used for the planned envelope. */
  decel: number;
  /** Arc sampling step (m). */
  step: number;
  /** Speed at the end of the path (0 = stop). */
  endSpeed?: number;
}

export interface Pose {
  x: number;
  z: number;
  h: number;
}

export class Path {
  readonly x: number[] = [];
  readonly z: number[] = [];
  /** Tangent heading at each point. */
  readonly h: number[] = [];
  /** Cumulative distance at each point. */
  readonly s: number[] = [];
  /** Speed cap of the piece that starts at point i. */
  readonly cap: number[] = [];
  /** Max allowed speed when passing point i (braking envelope). */
  readonly vmax: number[] = [];
  length = 0;
  private decel: number;

  constructor(pts: V2[], opts: PathOpts) {
    this.decel = opts.decel;
    const n = pts.length;
    const rad = (i: number) => (typeof opts.radius === 'number' ? opts.radius : (opts.radius[i] ?? 0));
    const spd = (i: number) => (typeof opts.speed === 'number' ? opts.speed : (opts.speed[Math.min(i, opts.speed.length - 1)] ?? 1));
    // curvature cap per point (Infinity on straights)
    const curv: number[] = [];
    const segOf: number[] = [];
    const push = (x: number, z: number, h: number, c: number, seg: number) => {
      const L = this.x.length;
      if (L > 0) {
        const dx = x - this.x[L - 1];
        const dz = z - this.z[L - 1];
        if (dx * dx + dz * dz < 1e-8) {
          this.h[L - 1] = h;
          curv[L - 1] = Math.min(curv[L - 1], c);
          return;
        }
      }
      this.x.push(x);
      this.z.push(z);
      this.h.push(h);
      curv.push(c);
      segOf.push(seg);
    };
    if (n < 2) {
      const p = pts[0] ?? { x: 0, z: 0 };
      push(p.x, p.z, 0, Infinity, 0);
      push(p.x + 1e-3, p.z, 0, Infinity, 0);
    } else {
      push(pts[0].x, pts[0].z, headingOf(pts[1].x - pts[0].x, pts[1].z - pts[0].z), Infinity, 0);
      for (let i = 1; i < n - 1; i++) {
        const A = pts[i - 1];
        const B = pts[i];
        const C = pts[i + 1];
        let u1x = B.x - A.x;
        let u1z = B.z - A.z;
        const L1 = Math.hypot(u1x, u1z) || 1e-9;
        u1x /= L1;
        u1z /= L1;
        let u2x = C.x - B.x;
        let u2z = C.z - B.z;
        const L2 = Math.hypot(u2x, u2z) || 1e-9;
        u2x /= L2;
        u2z /= L2;
        const cross = u1x * u2z - u1z * u2x;
        const dot = u1x * u2x + u1z * u2z;
        const phi = Math.atan2(Math.abs(cross), dot);
        const r0 = rad(i);
        if (phi < 1e-3 || r0 <= 0) {
          push(B.x, B.z, headingOf(u2x, u2z), Infinity, i);
          continue;
        }
        const tanHalf = Math.tan(phi / 2);
        let t = r0 * tanHalf;
        const avail1 = i === 1 ? L1 : L1 / 2;
        const avail2 = i === n - 2 ? L2 : L2 / 2;
        t = Math.min(t, avail1, avail2);
        const r = t / tanHalf;
        const p1x = B.x - u1x * t;
        const p1z = B.z - u1z * t;
        // normal toward the turn
        let nx = u2x - u1x * dot;
        let nz = u2z - u1z * dot;
        const nl = Math.hypot(nx, nz) || 1;
        nx /= nl;
        nz /= nl;
        const cx = p1x + nx * r;
        const cz = p1z + nz * r;
        const sign = cross > 0 ? 1 : -1;
        const k = Math.max(2, Math.ceil((phi * r) / opts.step));
        const vx = p1x - cx;
        const vz = p1z - cz;
        for (let j = 0; j <= k; j++) {
          const a = (sign * phi * j) / k;
          const ca = Math.cos(a);
          const sa = Math.sin(a);
          const px = cx + vx * ca - vz * sa;
          const pz = cz + vx * sa + vz * ca;
          const tx = u1x * ca - u1z * sa;
          const tz = u1x * sa + u1z * ca;
          push(px, pz, headingOf(tx, tz), Math.sqrt(opts.latAcc * Math.max(r, 0.05)), j === k ? i : i - 1);
        }
      }
      const a = pts[n - 2];
      const b = pts[n - 1];
      push(b.x, b.z, headingOf(b.x - a.x, b.z - a.z), Infinity, n - 2);
    }
    // cumulative distance + caps
    const m = this.x.length;
    let acc = 0;
    for (let i = 0; i < m; i++) {
      if (i > 0) acc += Math.hypot(this.x[i] - this.x[i - 1], this.z[i] - this.z[i - 1]);
      this.s.push(acc);
    }
    this.length = acc;
    for (let i = 0; i < m; i++) {
      const next = Math.min(i + 1, m - 1);
      this.cap.push(Math.min(spd(segOf[i]), curv[i], curv[next]));
    }
    const vend = opts.endSpeed ?? 0;
    for (let i = 0; i < m; i++) this.vmax.push(0);
    this.vmax[m - 1] = Math.min(vend, this.cap[m - 1]);
    for (let i = m - 2; i >= 0; i--) {
      const ds = this.s[i + 1] - this.s[i];
      this.vmax[i] = Math.min(this.cap[i], Math.sqrt(this.vmax[i + 1] * this.vmax[i + 1] + 2 * this.decel * ds));
    }
  }

  /** Index i with s[i] <= s < s[i+1]. */
  index(s: number): number {
    const S = this.s;
    let lo = 0;
    let hi = S.length - 1;
    if (s <= 0) return 0;
    if (s >= S[hi]) return Math.max(0, hi - 1);
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (S[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  pose(s: number, out: Pose): Pose {
    const i = this.index(s);
    const j = Math.min(i + 1, this.x.length - 1);
    const ds = this.s[j] - this.s[i];
    const t = ds > 1e-9 ? Math.min(1, Math.max(0, (s - this.s[i]) / ds)) : 0;
    out.x = this.x[i] + (this.x[j] - this.x[i]) * t;
    out.z = this.z[i] + (this.z[j] - this.z[i]) * t;
    out.h = this.h[i] + angleDelta(this.h[i], this.h[j]) * t;
    return out;
  }

  /** Allowed speed at distance s (cruise, curvature and braking to the end). */
  speedAt(s: number): number {
    const i = this.index(s);
    const j = Math.min(i + 1, this.x.length - 1);
    const rem = Math.max(0, this.s[j] - s);
    return Math.min(this.cap[i], Math.sqrt(this.vmax[j] * this.vmax[j] + 2 * this.decel * rem));
  }

  /** Remaining points from s to the end, decimated to roughly `spacing` metres. */
  remaining(s: number, spacing: number, y: number, maxPts = 240): { x: number; y: number; z: number }[] {
    const out: { x: number; y: number; z: number }[] = [];
    const p: Pose = { x: 0, z: 0, h: 0 };
    this.pose(s, p);
    out.push({ x: p.x, y, z: p.z });
    let last = s;
    const i0 = this.index(s) + 1;
    for (let i = i0; i < this.x.length && out.length < maxPts; i++) {
      const si = this.s[i];
      // keep corners dense, straights sparse
      const turn = i + 1 < this.x.length ? Math.abs(angleDelta(this.h[i], this.h[i + 1])) > 0.01 : true;
      if (si - last >= spacing || turn || i === this.x.length - 1) {
        // subdivide long straights so ribbons stay smooth
        const gap = si - last;
        if (gap > spacing * 2) {
          const k = Math.floor(gap / spacing);
          for (let j = 1; j < k && out.length < maxPts; j++) {
            this.pose(last + (gap * j) / k, p);
            out.push({ x: p.x, y, z: p.z });
          }
        }
        out.push({ x: this.x[i], y, z: this.z[i] });
        last = si;
      }
    }
    return out;
  }
}

/** Offset a polyline to the right of travel (mitered corners). */
export function offsetRight(pts: V2[], d: number): V2[] {
  const n = pts.length;
  if (n < 2) return pts.map((p) => ({ ...p }));
  const ux: number[] = [];
  const uz: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const dz = pts[i + 1].z - pts[i].z;
    const l = Math.hypot(dx, dz) || 1;
    ux.push(dx / l);
    uz.push(dz / l);
  }
  // right of travel (Y up, heading atan2(x,z)): (-uz, ux)
  const out: V2[] = [];
  out.push({ x: pts[0].x - uz[0] * d, z: pts[0].z + ux[0] * d });
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i].x - uz[i - 1] * d;
    const az = pts[i].z + ux[i - 1] * d;
    const bx = pts[i].x - uz[i] * d;
    const bz = pts[i].z + ux[i] * d;
    const cr = ux[i - 1] * uz[i] - uz[i - 1] * ux[i];
    if (Math.abs(cr) < 1e-6) {
      out.push({ x: ax, z: az });
      continue;
    }
    const t = ((bx - ax) * uz[i] - (bz - az) * ux[i]) / cr;
    out.push({ x: ax + ux[i - 1] * t, z: az + uz[i - 1] * t });
  }
  out.push({ x: pts[n - 1].x - uz[n - 2] * d, z: pts[n - 1].z + ux[n - 2] * d });
  return out;
}

/** Drop consecutive duplicates and collinear interior points. */
export function simplify(pts: V2[]): V2[] {
  const out: V2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < 1e-6 && Math.abs(last.z - p.z) < 1e-6) continue;
    out.push({ x: p.x, z: p.z });
    while (out.length >= 3) {
      const a = out[out.length - 3];
      const b = out[out.length - 2];
      const c = out[out.length - 1];
      const cr = (b.x - a.x) * (c.z - b.z) - (b.z - a.z) * (c.x - b.x);
      const dot = (b.x - a.x) * (c.x - b.x) + (b.z - a.z) * (c.z - b.z);
      if (Math.abs(cr) < 1e-6 && dot > 0) out.splice(out.length - 2, 1);
      else break;
    }
  }
  return out;
}
