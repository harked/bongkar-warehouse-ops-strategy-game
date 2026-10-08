/**
 * Roads (highways and site yard roads), lane paint, curbs, aprons, parking stalls, dock lines
 * and bridges. Everything here is flat decals or static props merged into a few draw calls.
 */
import * as THREE from 'three';
import { P } from '../core/palette';
import type { RoadSeg, V2, WorldLayout } from '../core/types';
import { islandEdgeX, SEA_Y, type TerrainCtx, WATER_Y } from './terrain';
import { Batch, clipOutside, decalMaterial, type ORect } from './util';

/** Layer heights above the ground (y = 0). Each layer also gets a polygon offset. */
export const Y = {
  apron: 0.04,
  road: 0.08,
  paint: 0.115,
};

const WHITE = 0xfbfdff;
const CURB = 0xf3f6fa;
const BRIDGE_REACH = 1600;

export interface RoadBuild {
  apron: Batch;
  road: Batch;
  paint: Batch;
  /** Static 3D props (curbs, bridges). */
  props: Batch;
  rects: ORect[];
}

function dir(a: V2, b: V2): V2 {
  const dx = b.x - a.x, dz = b.z - a.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: dx / l, z: dz / l };
}

/** Right-hand perpendicular in the heading convention used by core/geom. */
const right = (t: V2): V2 => ({ x: -t.z, z: t.x });

/** Offset a polyline by d (positive = right of travel) with true mitre joins. */
export function mitreOffset(pts: V2[], d: number): V2[] {
  return pts.map((p, i) => {
    if (i === 0) {
      const n = right(dir(pts[0], pts[1]));
      return { x: p.x + n.x * d, z: p.z + n.z * d };
    }
    if (i === pts.length - 1) {
      const n = right(dir(pts[i - 1], pts[i]));
      return { x: p.x + n.x * d, z: p.z + n.z * d };
    }
    const t0 = dir(pts[i - 1], p), t1 = dir(p, pts[i + 1]);
    const n0 = right(t0);
    let bx = t0.x + t1.x, bz = t0.z + t1.z;
    const bl = Math.hypot(bx, bz) || 1;
    bx /= bl;
    bz /= bl;
    const n = right({ x: bx, z: bz });
    const s = d / Math.max(0.2, n.x * n0.x + n.z * n0.z);
    return { x: p.x + n.x * s, z: p.z + n.z * s };
  });
}

/** Extend the polyline ends by `e0` / `e1` metres. */
function extend(pts: V2[], e0: number, e1: number): V2[] {
  const out = pts.map((p) => ({ ...p }));
  const d0 = dir(pts[1], pts[0]);
  out[0] = { x: pts[0].x + d0.x * e0, z: pts[0].z + d0.z * e0 };
  const n = pts.length;
  const d1 = dir(pts[n - 2], pts[n - 1]);
  out[n - 1] = { x: pts[n - 1].x + d1.x * e1, z: pts[n - 1].z + d1.z * e1 };
  return out;
}

/** Road surface ribbon (mitred). */
function ribbon(b: Batch, pts: V2[], w: number, y: number, color: number): void {
  const L = mitreOffset(pts, -w / 2);
  const R = mitreOffset(pts, w / 2);
  for (let i = 1; i < pts.length; i++) b.quad([L[i - 1], R[i - 1], R[i], L[i]], y, color);
}

/** Emit a painted/solid line along a polyline, clipped outside `rects`. */
function lineAlong(pts: V2[], emit: (a: V2, b: V2) => void, rects: ORect[], margin: number, dash?: [number, number], phase = 0): void {
  let s = phase;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    const t = dir(a, b);
    const pieces: [V2, V2][] = [];
    if (dash) {
      const [on, off] = dash;
      const period = on + off;
      let u = -((s % period) + period) % period;
      for (; u < len; u += period) {
        const u0 = Math.max(0, u), u1 = Math.min(len, u + on);
        if (u1 - u0 > 0.3) pieces.push([{ x: a.x + t.x * u0, z: a.z + t.z * u0 }, { x: a.x + t.x * u1, z: a.z + t.z * u1 }]);
      }
      s += len;
    } else pieces.push([a, b]);
    for (const [p, q] of pieces) for (const [c, d] of clipOutside(p, q, rects, margin)) emit(c, d);
  }
}

function roadRects(seg: RoadSeg, pts: V2[]): ORect[] {
  const out: ORect[] = [];
  for (let i = 1; i < pts.length; i++) out.push({ a: pts[i - 1], b: pts[i], hw: seg.width / 2, cap: seg.width / 2 });
  return out;
}

export function buildRoads(layout: WorldLayout, ctx: TerrainCtx): RoadBuild {
  const apron = new Batch();
  const road = new Batch();
  const paint = new Batch();
  const props = new Batch();

  // ---- collect road polylines (trunk extended over the sea on bridges) ---------------------
  type R = { seg: RoadSeg; pts: V2[]; idx: number };
  const roads: R[] = [];
  const all: RoadSeg[] = [...layout.roads, ...layout.sites.flatMap((s) => s.roads)];
  all.forEach((seg, idx) => {
    let pts = seg.points.map((p) => ({ ...p }));
    if (seg.kind === 'trunk') {
      pts = [{ x: -BRIDGE_REACH, z: pts[0].z }, ...pts, { x: BRIDGE_REACH, z: pts[pts.length - 1].z }];
      // Drop duplicate points.
      pts = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.z - pts[i - 1].z) > 0.01);
    } else {
      pts = extend(pts, seg.width / 2, seg.width / 2);
    }
    roads.push({ seg, pts, idx });
  });
  const rectsOf = roads.map((r) => roadRects(r.seg, r.pts));
  const allRects = rectsOf.flat();
  const apronRects: ORect[] = layout.sites.flatMap((s) =>
    s.aprons.map((a) => ({ a: { x: a.x0, z: (a.z0 + a.z1) / 2 }, b: { x: a.x1, z: (a.z0 + a.z1) / 2 }, hw: (a.z1 - a.z0) / 2, cap: 0 })),
  );

  // ---- aprons ---------------------------------------------------------------------------------
  for (const s of layout.sites) for (const a of s.aprons) apron.rect(a.x0, a.z0, a.x1, a.z1, Y.apron, P.concrete);

  // ---- surfaces, paint and curbs ---------------------------------------------------------------
  const yardTone = 0xb3bdca;
  for (const r of roads) {
    const { seg, pts } = r;
    const others = rectsOf.filter((_, i) => i !== r.idx).flat();
    const highway = seg.kind === 'trunk' || seg.kind === 'spur';
    // Highways sit a hair above yard roads so their overlap at the gate never z-fights.
    ribbon(road, pts, seg.width, highway ? Y.road : Y.road - 0.012, highway ? P.asphalt : yardTone);

    const hw = seg.width / 2;
    const paintLine = (w: number, color: number) => (a: V2, b: V2) => paint.strip(a, b, w, Y.paint, color);
    // Centre dashes.
    lineAlong(pts, paintLine(0.28, WHITE), others, 0.6, seg.kind === 'trunk' ? [4.5, 5] : [3, 3.5]);
    // Edge lines.
    const edgeInset = highway ? 0.55 : 0.45;
    for (const sgn of [-1, 1]) {
      lineAlong(mitreOffset(pts, sgn * (hw - edgeInset)), paintLine(0.2, WHITE), others, 0.2);
    }
    // Soft raised curbs on highways only (yard roads sit flush in the concrete).
    if (highway) {
      for (const sgn of [-1, 1]) {
        const cpts = mitreOffset(pts, sgn * (hw + 0.3));
        lineAlong(cpts, (a, b) => props.segBox(a, b, 0.6, 0, 0.2, CURB), [...others, ...apronRects], 0);
      }
    }
  }

  // ---- parking stalls and dock bay lines inside sites ------------------------------------------
  for (const s of layout.sites) {
    for (const q of s.queueSpots) {
      const h = q.heading;
      const fx = Math.sin(h), fz = Math.cos(h);
      const rx = -fz, rz = fx;
      const L = 18.4, W = 3.9, lw = 0.16;
      const corner = (u: number, v: number): V2 => ({ x: q.pos.x + fx * u + rx * v, z: q.pos.z + fz * u + rz * v });
      // Side lines and the closed back.
      paint.strip(corner(-L / 2, -W / 2), corner(L / 2, -W / 2), lw, Y.paint, WHITE);
      paint.strip(corner(-L / 2, W / 2), corner(L / 2, W / 2), lw, Y.paint, WHITE);
      paint.strip(corner(-L / 2 + lw / 2, -W / 2), corner(-L / 2 + lw / 2, W / 2), lw, Y.paint, WHITE);
      // Front stop bar in Sunbeam.
      paint.strip(corner(L / 2 - 0.25, -W / 2 + 0.3), corner(L / 2 - 0.25, W / 2 - 0.3), 0.4, Y.paint, P.sunbeam);
    }
    // Bay separators between doors, from the wall to past the truck cab.
    for (const side of ['S', 'N'] as const) {
      const ds = s.doors.filter((d) => d.side === side).sort((a, b) => a.pos.x - b.pos.x);
      if (!ds.length) continue;
      const spacing = s.def.doorSpacing;
      const nz = ds[0].normal.z;
      const wz = ds[0].pos.z;
      const xs = [ds[0].pos.x - spacing / 2, ...ds.map((d) => d.pos.x + spacing / 2)];
      for (const x of xs) paint.strip({ x, z: wz + nz * 1.2 }, { x, z: wz + nz * 19 }, 0.26, Y.paint, WHITE);
      for (const d of ds) {
        // Yellow alignment marks either side of the bay centre.
        for (const sgn of [-1, 1]) {
          paint.strip({ x: d.pos.x + sgn * 1.75, z: wz + nz * 1.2 }, { x: d.pos.x + sgn * 1.75, z: wz + nz * 6 }, 0.14, Y.paint, P.sunbeam);
        }
      }
    }
  }

  // ---- bridges ---------------------------------------------------------------------------------
  const trunk = roads.find((r) => r.seg.kind === 'trunk')!;
  const tz = trunk.pts[0].z;
  const tw = trunk.seg.width;
  const railing = (x0: number, x1: number, z: number, yb: number) => {
    const n = Math.max(1, Math.round((x1 - x0) / 3));
    for (let i = 0; i <= n; i++) props.box(x0 + ((x1 - x0) * i) / n, yb + 0.55, z, 0.16, 1.1, 0.16, WHITE);
    props.boxMinMax(x0, yb + 1.0, z - 0.11, x1, yb + 1.18, z + 0.11, P.cobalt);
    props.boxMinMax(x0, yb + 0.5, z - 0.06, x1, yb + 0.6, z + 0.06, WHITE);
  };
  // Off-island causeways east and west.
  for (const side of [-1, 1] as const) {
    const xe = islandEdgeX(tz, side) - side * 2;
    const xa = Math.min(xe, side * BRIDGE_REACH), xb = Math.max(xe, side * BRIDGE_REACH);
    props.boxMinMax(xa, -1.3, tz - tw / 2 - 1, xb, 0.06, tz + tw / 2 + 1, 0xf1f5f9);
    props.boxMinMax(xa, -1.5, tz - tw / 2 - 1.05, xb, -1.25, tz + tw / 2 + 1.05, P.cobalt);
    railing(xa, xb, tz - tw / 2 - 0.6, 0.06);
    railing(xa, xb, tz + tw / 2 + 0.6, 0.06);
    for (let x = xe + side * 30; Math.abs(x) < BRIDGE_REACH; x += side * 42) {
      props.add(new THREE.CylinderGeometry(1.5, 1.8, -1.3 - SEA_Y + 1, 10), 0xe9eef4, x, (SEA_Y - 1 - 1.3) / 2, tz);
      props.boxMinMax(x - 1.4, -2.3, tz - tw / 2 - 0.6, x + 1.4, -1.3, tz + tw / 2 + 0.6, 0xe9eef4);
    }
  }
  // River bridge where the trunk crosses.
  let bestX = 0, bestD = Infinity;
  for (let x = 300; x < 470; x += 0.5) {
    const d = ctx.riverDist(x, tz);
    if (d < bestD) {
      bestD = d;
      bestX = x;
    }
  }
  if (bestD < 5) {
    const span = 15;
    const x0 = bestX - span, x1 = bestX + span;
    props.boxMinMax(x0, WATER_Y + 0.12, tz - tw / 2 - 1, x1, 0.06, tz + tw / 2 + 1, 0xf1f5f9);
    props.boxMinMax(x0, WATER_Y + 0.05, tz - tw / 2 - 1.05, x1, WATER_Y + 0.25, tz + tw / 2 + 1.05, P.cobalt);
    railing(x0, x1, tz - tw / 2 - 0.6, 0.06);
    railing(x0, x1, tz + tw / 2 + 0.6, 0.06);
    // Abutment blocks on the banks.
    for (const x of [x0, x1]) props.boxMinMax(x - 1.2, -1.8, tz - tw / 2 - 1.3, x + 1.2, 0.3, tz + tw / 2 + 1.3, 0xe3e9f0);
  }

  return { apron, road, paint, props, rects: allRects };
}

export function roadMaterials() {
  return {
    apron: decalMaterial(1, { roughness: 0.9 }),
    road: decalMaterial(2, { roughness: 0.92 }),
    paint: decalMaterial(3, { roughness: 0.7 }),
  };
}
