/**
 * Oriented boxes for bodies, axis-aligned rects for reservable zones, and the zone type used to
 * keep vehicles from conflicting at junctions and during manoeuvres.
 */
import type { Rect } from '../core/types';

export interface OBB {
  cx: number;
  cz: number;
  /** Unit forward. */
  ux: number;
  uz: number;
  /** Half length along forward, half width across. */
  hl: number;
  hw: number;
}

export const makeObb = (): OBB => ({ cx: 0, cz: 0, ux: 0, uz: 1, hl: 1, hw: 1 });

/** Body box for a pose. `front`/`back` are distances from the origin along forward. */
export function setObb(o: OBB, x: number, z: number, h: number, front: number, back: number, halfW: number): OBB {
  o.ux = Math.sin(h);
  o.uz = Math.cos(h);
  const mid = (front - back) / 2;
  o.cx = x + o.ux * mid;
  o.cz = z + o.uz * mid;
  o.hl = (front + back) / 2;
  o.hw = halfW;
  return o;
}

export function obbOverlap(a: OBB, b: OBB): boolean {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const rr = a.hl + a.hw + b.hl + b.hw;
  if (dx * dx + dz * dz > rr * rr) return false;
  // axes: a.u, a.v, b.u, b.v  (v = perpendicular (uz, -ux))
  return (
    !separated(a, b, dx, dz, a.ux, a.uz) &&
    !separated(a, b, dx, dz, a.uz, -a.ux) &&
    !separated(a, b, dx, dz, b.ux, b.uz) &&
    !separated(a, b, dx, dz, b.uz, -b.ux)
  );
}

function separated(a: OBB, b: OBB, dx: number, dz: number, nx: number, nz: number): boolean {
  const ra = a.hl * Math.abs(a.ux * nx + a.uz * nz) + a.hw * Math.abs(a.uz * nx - a.ux * nz);
  const rb = b.hl * Math.abs(b.ux * nx + b.uz * nz) + b.hw * Math.abs(b.uz * nx - b.ux * nz);
  return Math.abs(dx * nx + dz * nz) > ra + rb;
}

export function obbRect(a: OBB, r: Rect): boolean {
  const rcx = (r.x0 + r.x1) / 2;
  const rcz = (r.z0 + r.z1) / 2;
  const rhx = (r.x1 - r.x0) / 2;
  const rhz = (r.z1 - r.z0) / 2;
  const dx = rcx - a.cx;
  const dz = rcz - a.cz;
  // world axes
  const ex = a.hl * Math.abs(a.ux) + a.hw * Math.abs(a.uz);
  if (Math.abs(dx) > ex + rhx) return false;
  const ez = a.hl * Math.abs(a.uz) + a.hw * Math.abs(a.ux);
  if (Math.abs(dz) > ez + rhz) return false;
  // box axes
  let nx = a.ux;
  let nz = a.uz;
  let rb = rhx * Math.abs(nx) + rhz * Math.abs(nz);
  if (Math.abs(dx * nx + dz * nz) > a.hl + rb) return false;
  nx = a.uz;
  nz = -a.ux;
  rb = rhx * Math.abs(nx) + rhz * Math.abs(nz);
  if (Math.abs(dx * nx + dz * nz) > a.hw + rb) return false;
  return true;
}

export const rectOverlap = (a: Rect, b: Rect): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;

/** A reservable area. Only its owner may move inside it while it is held. */
export class Zone {
  owner: object | null = null;
  readonly cx: number;
  readonly cz: number;
  readonly radius: number;
  constructor(
    readonly id: string,
    readonly rects: Rect[],
    /** Static zones (junctions) are needed by every path through them; others only by explicit request. */
    readonly isStatic: boolean,
  ) {
    let x0 = Infinity;
    let z0 = Infinity;
    let x1 = -Infinity;
    let z1 = -Infinity;
    for (const r of rects) {
      x0 = Math.min(x0, r.x0);
      z0 = Math.min(z0, r.z0);
      x1 = Math.max(x1, r.x1);
      z1 = Math.max(z1, r.z1);
    }
    this.cx = (x0 + x1) / 2;
    this.cz = (z0 + z1) / 2;
    this.radius = Math.hypot(x1 - x0, z1 - z0) / 2;
  }
  hits(o: OBB): boolean {
    for (const r of this.rects) if (obbRect(o, r)) return true;
    return false;
  }
  overlaps(z: Zone): boolean {
    for (const a of this.rects) for (const b of z.rects) if (rectOverlap(a, b)) return true;
    return false;
  }
}

export const rect = (x0: number, z0: number, x1: number, z1: number): Rect => ({
  x0: Math.min(x0, x1),
  z0: Math.min(z0, z1),
  x1: Math.max(x0, x1),
  z1: Math.max(z0, z1),
});
