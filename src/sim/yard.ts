/**
 * Yard geometry derived from the shared layout: right-hand lanes, the reverse-into-dock and
 * pull-out manoeuvres for every door, queue bays, hold points and the reservable zones that
 * keep trucks from conflicting (gates, highway junctions, manoeuvre sweeps).
 */
import { TRUCK } from '../core/constants';
import { highwayPath, TRUNK_Z, YARD } from '../core/layout';
import type { DoorLayout, SiteLayout, V2, WorldLayout } from '../core/types';
import { Path, offsetRight, simplify } from './path';
import { Zone, makeObb, rect, setObb } from './zones';

export const LANE = 2.4;
export const HALF_L = TRUCK.length / 2;
export const HALF_W = TRUCK.width / 2;
/** Tracked point for reversing / docking (near the trailer axles). */
export const K_REAR = -5.5;

export const SPD = { trunk: 16, spur: 11, yard: 6, pull: 3, reverse: 1.8, queue: 4 };
export const TRUCK_PATH = { latAcc: 1.5, decel: 1.6, step: 1.2 };

/** A route polyline with per-vertex fillet radius and per-segment speed. */
export interface Route {
  pts: V2[];
  radii: number[];
  speeds: number[];
}

export function routePath(r: Route, endSpeed = 0): Path {
  return new Path(r.pts, { radius: r.radii, speed: r.speeds, ...TRUCK_PATH, endSpeed });
}

export function concatRoutes(a: Route, b: Route): Route {
  // b starts where a ends: drop b's first point
  return {
    pts: [...a.pts, ...b.pts.slice(1)],
    radii: [...a.radii.slice(0, a.pts.length - 1), b.radii[0] ?? 0, ...b.radii.slice(1)],
    speeds: [...a.speeds.slice(0, a.pts.length - 1), ...b.speeds],
  };
}

export interface QueueBay {
  id: string;
  index: number;
  pos: V2;
  heading: number;
  /** 'direct': turn off the spur straight into the bay row; 'lane': S-curve from the westbound lane. */
  entry: 'direct' | 'lane';
  /** Doors with x <= reachX can be reached from this bay. */
  reachX: number;
  entryZone: Zone | null;
  /** Exit zones per door id, built lazily. */
  exitZones: Map<string, Zone>;
}

export interface DoorGeo {
  door: DoorLayout;
  wallZ: number;
  /** +1 south side (v grows with z), -1 north side. */
  sgn: number;
  westV: number;
  eastV: number;
  dockR: number;
  /** Truck origin where the forward approach ends and reversing starts. */
  revStart: V2;
  reverse: Route;
  pull: Route;
  /** Distance along the pull-out route after which the pull-out zone is released. */
  /** Tracked point for the pull-out (0 south, K_REAR north). */
  pullK: number;
  pullRelease: number;
  pullEnd: V2;
  dockZone: Zone;
  pullZone: Zone;
}

export interface SiteYard {
  site: SiteLayout;
  /** Gate (centre of the lane at the fence). */
  G: V2;
  /** Point on the spur centreline 26 m before the gate (hold point lies on its right lane). */
  Gp: V2;
  hold: V2;
  laneS: number;
  laneN: number;
  connX: number;
  gateZone: Zone;
  connZone: Zone | null;
  /** Teluk Bayur: connector hold point for north docks. */
  connHold: V2 | null;
  doors: Map<string, DoorGeo>;
  bays: QueueBay[];
  staticZones: Zone[];
}

const toW = (g: { door: DoorLayout; wallZ: number; sgn: number }, a: number, v: number): V2 => ({ x: a, z: g.wallZ + g.sgn * v });

function frameRect(g: { wallZ: number; sgn: number }, x0: number, v0: number, x1: number, v1: number) {
  return rect(x0, g.wallZ + g.sgn * v0, x1, g.wallZ + g.sgn * v1);
}

/** Sample body corners along a path; return world AABBs split at a frame-v threshold. */
function sweep(
  paths: { path: Path; k: number; dir: number; s0?: number; s1?: number }[],
  g: { wallZ: number; sgn: number },
  vSplit: number,
): { lo: { x0: number; x1: number; v0: number; v1: number }; hi: { x0: number; x1: number; v0: number; v1: number } } {
  const lo = { x0: Infinity, x1: -Infinity, v0: Infinity, v1: -Infinity };
  const hi = { x0: Infinity, x1: -Infinity, v0: Infinity, v1: -Infinity };
  const p = { x: 0, z: 0, h: 0 };
  for (const q of paths) {
    const s0 = q.s0 ?? 0;
    const s1 = q.s1 ?? q.path.length;
    for (let s = s0; ; s += 0.5) {
      const ss = Math.min(s, s1);
      q.path.pose(ss, p);
      const h = q.dir > 0 ? p.h : p.h + Math.PI;
      const fx = Math.sin(h);
      const fz = Math.cos(h);
      const ox = p.x - fx * q.k;
      const oz = p.z - fz * q.k;
      for (const a of [-1, 1])
        for (const b of [-1, 1]) {
          const cx = ox + fx * HALF_L * a + fz * HALF_W * b;
          const cz = oz + fz * HALF_L * a - fx * HALF_W * b;
          const v = (cz - g.wallZ) * g.sgn;
          const t = v < vSplit ? lo : hi;
          t.x0 = Math.min(t.x0, cx);
          t.x1 = Math.max(t.x1, cx);
          t.v0 = Math.min(t.v0, v);
          t.v1 = Math.max(t.v1, v);
        }
      if (ss >= s1) break;
    }
  }
  return { lo, hi };
}

function buildDoor(site: SiteLayout, d: DoorLayout, laneOff: number): DoorGeo {
  const sgn = d.normal.z > 0 ? 1 : -1;
  const wallZ = d.pos.z;
  const g = { door: d, wallZ, sgn };
  const south = sgn > 0;
  const westV = south ? laneOff - LANE : laneOff + LANE;
  const eastV = south ? laneOff + LANE : laneOff - LANE;
  const dx = d.pos.x;
  const dockR = south ? 8 : 10;
  const dockV = 0.3 + HALF_L; // origin v when docked
  const revStart = toW(g, dx - dockR + K_REAR, westV);
  // Reverse: tracked point (k = -5.5) from (dx - r, westV) arcing to the wall.
  const reverse: Route = {
    pts: [toW(g, dx - dockR, westV), toW(g, dx, westV), toW(g, dx, dockV + K_REAR)],
    radii: [0, dockR, 0],
    speeds: [SPD.reverse, SPD.reverse],
  };
  // Pull-out (origin tracked): straight until the trailer clears the docks, then curve east.
  const clearV = 0.3 + TRUCK.length + 0.5; // rear must be past docked neighbours
  const turnV = clearV + HALF_L;
  let pull: Route;
  let pullRelease: number;
  if (south) {
    const r = eastV - turnV;
    pull = {
      pts: [toW(g, dx, dockV), toW(g, dx, eastV), toW(g, dx + r + 14, eastV)],
      radii: [0, r, 0],
      speeds: [SPD.pull, SPD.pull],
    };
  } else {
    // North side: the near lane is the eastbound one, too close for an origin-tracked turn, so the
    // trailer axles (k = -5.5) lead: straight until the rear clears, then a tight swing east.
    const vP = clearV - 0.5 + (HALF_L + K_REAR);
    const r = eastV - vP;
    pull = {
      pts: [toW(g, dx, dockV + K_REAR), toW(g, dx, eastV), toW(g, dx + r + 6, eastV)],
      radii: [0, r, 0],
      speeds: [SPD.pull, SPD.pull],
    };
  }
  const pullK = south ? 0 : K_REAR;
  const pullPath = routePath(pull);
  pullRelease = south ? pullPath.length - 1 : Infinity;
  const last = pull.pts[pull.pts.length - 1];
  const pullEnd = { x: last.x - pullK, z: last.z };

  // Zones: a corridor at the door plus a band over the lanes.
  const approach = new Path([toW(g, dx + 4, westV), revStart], { radius: 0, speed: 1, ...TRUCK_PATH });
  const revPath = routePath(reverse);
  const vSplit = 17.6;
  const dz = sweep(
    [
      { path: approach, k: 0, dir: 1 },
      { path: revPath, k: K_REAR, dir: -1 },
    ],
    g,
    vSplit,
  );
  const corridor = frameRect(g, dx - 1.75, 0.2, dx + 1.75, vSplit);
  const dockZone = new Zone(`${d.id}:dock`, [corridor, frameRect(g, dz.hi.x0 - 0.5, vSplit, dz.hi.x1 + 0.5, dz.hi.v1 + 0.5)], false);
  const pz = sweep([{ path: pullPath, k: pullK, dir: 1 }], g, vSplit);
  const pullZone = new Zone(`${d.id}:pull`, [corridor, frameRect(g, pz.hi.x0 - 0.5, vSplit, pz.hi.x1 + 1.5, pz.hi.v1 + 0.5)], false);
  void site;
  return { door: d, wallZ, sgn, westV, eastV, dockR, revStart, reverse, pull, pullK, pullRelease, pullEnd, dockZone, pullZone };
}

function buildSiteYard(site: SiteLayout, world: WorldLayout): SiteYard {
  const G = site.gate;
  const laneS = site.lanes[0].z;
  const laneN = site.lanes[1]?.z ?? NaN;
  const connX = site.building.rect.x1 + YARD.connectorInset;
  // spur direction from the gate
  const hp = highwayPath(site.id, 'east');
  const nx = hp[1].x - G.x;
  const nz = hp[1].z - G.z;
  const nl = Math.hypot(nx, nz) || 1;
  const Gp = { x: G.x + (nx / nl) * 26, z: G.z + (nz / nl) * 26 };
  const hold = offsetRight([Gp, G], LANE)[0];
  const spurSouth = nz / nl > 0.5;
  const zones: Zone[] = [];
  let gateZone: Zone;
  if (spurSouth) {
    const west = site.lanes.length > 1 ? connX - 10 : G.x - 13;
    const rects = [rect(west, G.z - 6, G.x + 5.5, G.z + 5), rect(G.x - 4.5, G.z + 5, G.x + 5.5, G.z + 16)];
    // connector mouth: trucks coming down the connector wait clear of trucks turning onto it
    if (site.lanes.length > 1) rects.push(rect(connX - 6, G.z - 17, connX + 6, G.z - 6));
    gateZone = new Zone(`${site.id}:gate`, rects, true);
  } else {
    gateZone = new Zone(`${site.id}:gate`, [rect(G.x - 6, G.z - 6, G.x + 14, G.z + 6)], true);
  }
  zones.push(gateZone);
  let connZone: Zone | null = null;
  let connHold: V2 | null = null;
  if (site.lanes.length > 1) {
    connZone = new Zone(`${site.id}:conn`, [rect(connX - 12, laneN - 8, connX + 6, laneN + 8), rect(connX - 5, laneN + 8, connX + 6, laneN + 16)], true);
    zones.push(connZone);
    connHold = { x: connX + LANE, z: laneN + 26 };
  }
  const doors = new Map<string, DoorGeo>();
  for (const d of site.doors) doors.set(d.id, buildDoor(site, d, YARD.laneOffset));

  // Queue bays: spaced at least 38 m apart so trucks can pull in and out between neighbours.
  const bays: QueueBay[] = [];
  let lastX = Infinity;
  site.queueSpots.forEach((q, i) => {
    const entry: 'direct' | 'lane' = i === 0 && spurSouth ? 'direct' : 'lane';
    if (entry === 'lane') {
      // need room after the gate corner for the S-curve
      const room = spurSouth ? G.x - 7 : G.x;
      if (q.pos.x + 28 > room) return;
    }
    if (lastX - q.pos.x < 38) return;
    lastX = q.pos.x;
    bays.push({ id: q.id, index: bays.length, pos: q.pos, heading: q.heading, entry, reachX: q.pos.x - 10.3, entryZone: null, exitZones: new Map() });
  });
  void world;
  return { site, G, Gp, hold, laneS, laneN, connX, gateZone, connZone, connHold, doors, bays, staticZones: zones };
}

export class YardGeometry {
  readonly sites = new Map<string, SiteYard>();
  readonly junctions: Zone[] = [];
  readonly staticZones: Zone[] = [];
  private hwCache = new Map<string, V2[]>();

  constructor(readonly layout: WorldLayout) {
    for (const s of layout.sites) {
      const y = buildSiteYard(s, layout);
      this.sites.set(s.id, y);
      this.staticZones.push(...y.staticZones);
    }
    // Highway corners and junctions (spur meets trunk); nearby ones share one zone.
    const pts: V2[] = [];
    for (const s of layout.sites) {
      for (const p of highwayPath(s.id, 'east')) {
        if (Math.abs(p.x - s.gate.x) < 0.01 && Math.abs(p.z - s.gate.z) < 0.01) continue;
        if (p.x === layout.edges.east.x) continue;
        if (!pts.some((q) => Math.abs(q.x - p.x) < 0.01 && Math.abs(q.z - p.z) < 0.01)) pts.push(p);
      }
    }
    // keep only corners/junctions (trunk points that a spur meets, and spur bends)
    const groups: V2[][] = [];
    for (const p of pts) {
      const g = groups.find((gr) => gr.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 60));
      if (g) g.push(p);
      else groups.push([p]);
    }
    for (const g of groups) {
      const x0 = Math.min(...g.map((p) => p.x)) - 22;
      const x1 = Math.max(...g.map((p) => p.x)) + 22;
      const z0 = Math.min(...g.map((p) => p.z)) - 22;
      const z1 = Math.max(...g.map((p) => p.z)) + 22;
      const z = new Zone(`J:${g.map((p) => `${p.x.toFixed(0)},${p.z.toFixed(0)}`).join('+')}`, [rect(x0, z0, x1, z1)], true);
      this.junctions.push(z);
      this.staticZones.push(z);
    }
  }

  hw(from: string, to: string): V2[] {
    const key = `${from}>${to}`;
    let p = this.hwCache.get(key);
    if (!p) {
      p = highwayPath(from, to);
      this.hwCache.set(key, p);
    }
    return p;
  }

  private inSite(p: V2, margin = 2): boolean {
    for (const s of this.layout.sites) {
      const b = s.bounds;
      if (p.x > b.x0 - margin && p.x < b.x1 + margin && p.z > b.z0 - margin && p.z < b.z1 + margin) return true;
    }
    return false;
  }

  /** Turn a centreline into a right-lane route with classified corner radii and speeds. */
  laneRoute(center: V2[], overrides?: { radii?: Record<number, number>; speeds?: Record<number, number> }): Route {
    const c = simplify(center);
    const pts = offsetRight(c, LANE);
    const radii: number[] = [];
    const speeds: number[] = [];
    for (let i = 0; i < c.length; i++) {
      const inside = this.inSite(c[i]);
      radii.push(overrides?.radii?.[i] ?? (inside ? 8 : 12));
      if (i < c.length - 1) {
        const a = c[i];
        const b = c[i + 1];
        let v: number;
        if (Math.abs(a.z - TRUNK_Z) < 0.5 && Math.abs(b.z - TRUNK_Z) < 0.5) v = SPD.trunk;
        else if (!this.inSite(a, -1) && !this.inSite(b, -1)) v = SPD.spur;
        else v = SPD.yard;
        speeds.push(overrides?.speeds?.[i] ?? v);
      }
    }
    return { pts, radii, speeds };
  }

  /** Highway leg ending at the site's hold point (on the spur, before the gate). */
  toHold(from: string, siteId: string): Route {
    const y = this.sites.get(siteId)!;
    const hw = this.hw(from, siteId).slice(0, -1);
    return this.laneRoute([...hw, y.Gp]);
  }

  /** Continuation from the hold point into the yard, ending where reversing into `doorId` starts. */
  holdToDoor(siteId: string, doorId: string): Route {
    const y = this.sites.get(siteId)!;
    const dg = y.doors.get(doorId)!;
    const c: V2[] = [y.Gp, y.G];
    const north = dg.sgn < 0;
    if (north) c.push({ x: y.connX, z: y.laneS }, { x: y.connX, z: y.laneN });
    // revStart is on the westbound lane; its centreline point is LANE back toward the lane centre
    c.push({ x: dg.revStart.x, z: north ? y.laneN : y.laneS });
    return this.laneRoute(c, { radii: { 1: 9 } });
  }

  holdToConnector(siteId: string): Route {
    const y = this.sites.get(siteId)!;
    return this.laneRoute([y.Gp, y.G, { x: y.connX, z: y.laneS }, { x: y.connX, z: y.connHold!.z }], { radii: { 1: 7, 2: 7 } });
  }

  connectorToDoor(siteId: string, doorId: string): Route {
    const y = this.sites.get(siteId)!;
    const dg = y.doors.get(doorId)!;
    return this.laneRoute([{ x: y.connX, z: y.connHold!.z }, { x: y.connX, z: y.laneN }, { x: dg.revStart.x, z: y.laneN }], { radii: { 1: 8 } });
  }

  holdToBay(siteId: string, bay: QueueBay): Route {
    const y = this.sites.get(siteId)!;
    const qz = bay.pos.z;
    if (bay.entry === 'direct') {
      return {
        pts: [y.hold, { x: y.hold.x, z: qz }, { ...bay.pos }],
        radii: [0, 6, 0],
        speeds: [SPD.queue, SPD.queue],
      };
    }
    const lane = this.laneRoute([y.Gp, y.G, { x: bay.pos.x + 28, z: y.laneS }], { radii: { 1: 9 } });
    const tail: Route = {
      pts: [lane.pts[lane.pts.length - 1], { x: bay.pos.x + 8, z: qz }, { ...bay.pos }],
      radii: [12, 12, 0],
      speeds: [SPD.queue, SPD.queue],
    };
    return concatRoutes(lane, tail);
  }

  bayToDoor(siteId: string, bay: QueueBay, doorId: string): Route {
    const y = this.sites.get(siteId)!;
    const dg = y.doors.get(doorId)!;
    const westZ = y.laneS - LANE;
    return {
      pts: [{ ...bay.pos }, { x: bay.pos.x - 4, z: bay.pos.z }, { x: bay.pos.x - 20, z: westZ }, { ...dg.revStart }],
      radii: [0, 10, 10, 0],
      speeds: [SPD.queue, SPD.queue, SPD.yard],
    };
  }

  /** Pull out of a door and drive to `dest` (site id -> its hold point, or 'west' / 'east'). */
  departure(siteId: string, doorId: string, dest: string): { pull: Route | null; route: Route } {
    const y = this.sites.get(siteId)!;
    const dg = y.doors.get(doorId)!;
    const north = dg.sgn < 0;
    const c: V2[] = [{ x: dg.pullEnd.x, z: north ? y.laneN : y.laneS }];
    if (north) c.push({ x: y.connX, z: y.laneN }, { x: y.connX, z: y.laneS });
    c.push(y.G);
    const hw = this.hw(siteId, dest);
    if (dest === 'west' || dest === 'east') c.push(...hw.slice(1));
    else {
      const dy = this.sites.get(dest)!;
      c.push(...hw.slice(1, -1), dy.Gp);
    }
    const radii: Record<number, number> = {};
    // gate corner (right turn onto the spur) and connector corners
    const gi = c.indexOf(y.G);
    radii[gi] = 7;
    if (north) {
      radii[1] = 7;
      radii[2] = 6;
    }
    const cont = this.laneRoute(c, { radii });
    if (dg.pullK !== 0) return { pull: dg.pull, route: cont };
    return { pull: null, route: concatRoutes(dg.pull, cont) };
  }

  /** Queue bay exit zone toward a door (built once per pair). */
  bayExitZone(siteId: string, bay: QueueBay, doorId: string): Zone {
    let z = bay.exitZones.get(doorId);
    if (z) return z;
    const y = this.sites.get(siteId)!;
    const r = this.bayToDoor(siteId, bay, doorId);
    const p = routePath(r);
    const wallZ = y.site.building.rect.z1;
    const g = { wallZ, sgn: 1 };
    const split = bay.pos.z - wallZ - 1.6;
    const sw = sweep([{ path: p, k: 0, dir: 1, s1: Math.min(p.length, 26) }], g, split);
    const rects = [frameRect(g, sw.lo.x0 - 0.5, Math.max(17.6, sw.lo.v0 - 0.5), sw.lo.x1 + 0.5, split)];
    if (sw.hi.x0 < Infinity) rects.push(frameRect(g, sw.hi.x0 - 0.5, split, sw.hi.x1 + 0.5, sw.hi.v1 + 0.3));
    z = new Zone(`${bay.id}:out:${doorId}`, rects, false);
    bay.exitZones.set(doorId, z);
    return z;
  }

  bayEntryZone(siteId: string, bay: QueueBay): Zone | null {
    if (bay.entry === 'direct') return null;
    if (bay.entryZone) return bay.entryZone;
    const y = this.sites.get(siteId)!;
    const r = this.holdToBay(siteId, bay);
    const p = routePath(r);
    const wallZ = y.site.building.rect.z1;
    const g = { wallZ, sgn: 1 };
    const split = bay.pos.z - wallZ - 1.6;
    // only the S-curve part (last ~40 m)
    const sw = sweep([{ path: p, k: 0, dir: 1, s0: Math.max(0, p.length - 40) }], g, split);
    const rects = [frameRect(g, sw.lo.x0 - 0.5, Math.max(17.6, sw.lo.v0 - 0.5), sw.lo.x1 + 0.5, split)];
    if (sw.hi.x0 < Infinity) rects.push(frameRect(g, sw.hi.x0 - 0.5, split, sw.hi.x1 + 0.5, sw.hi.v1 + 0.3));
    bay.entryZone = new Zone(`${bay.id}:in`, rects, false);
    return bay.entryZone;
  }

  /** Body box helper for tests. */
  static body(x: number, z: number, h: number) {
    return setObb(makeObb(), x, z, h, HALF_L, HALF_L, HALF_W);
  }
}
