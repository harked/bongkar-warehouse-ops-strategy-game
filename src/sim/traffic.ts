/**
 * Truck traffic: path following with a speed envelope, gap keeping by probing the truck's own
 * future footprint against everyone else, and zone reservation (junctions, manoeuvres) with a
 * keep-the-box-clear rule so trucks never stop inside a junction they cannot leave.
 */
import { clamp } from '../core/geom';
import type { Path } from './path';
import type { Truck, ZoneReq } from './truck';
import { Zone, makeObb, obbOverlap, type OBB } from './zones';

const BRAKE = 2.6;
const PROBE = makeObb();
const EXIT = makeObb();

export interface ExplicitReq {
  zone: Zone;
  /** If omitted, found by scanning the path. */
  sEnter?: number;
  sRelease: number;
}

export class Traffic {
  readonly held = new Set<Zone>();
  stats = { ghosts: 0, log: [] as string[] };
  private near: Truck[] = [];

  constructor(
    readonly trucks: Truck[],
    readonly staticZones: Zone[],
  ) {}

  /** Assign a fresh path. Zones the truck holds and still needs stay held. */
  setPath(t: Truck, path: Path, dir: number, k: number, explicit: ExplicitReq[] = [], keepS = false): void {
    const prevHeld = t.reqs.filter((r) => r.zone.owner === t);
    t.path = path;
    if (!keepS) t.s = 0;
    t.s = Math.min(t.s, path.length);
    t.dir = dir;
    t.k = k;
    t.reqs = this.scan(t, path, explicit);
    t.reqs.sort((a, b) => a.sEnter - b.sEnter);
    // release held zones that the new path no longer needs and the body is out of
    for (const r of prevHeld) {
      if (t.reqs.some((q) => q.zone === r.zone)) continue;
      if (r.zone.hits(t.body)) {
        // keep until the body is out
        t.reqs.push({ zone: r.zone, sEnter: t.s, sRelease: t.s + 25, sExit: NaN });
      } else this.release(r.zone);
    }
    t.poseFromPath();
  }

  private scan(t: Truck, path: Path, explicit: ExplicitReq[]): ZoneReq[] {
    const reqs: ZoneReq[] = [];
    const body = makeObb();
    const s0 = t.s;
    const cands = this.staticZones.filter((z) => {
      // quick reject: zone far from the whole path
      for (let i = 0; i < path.x.length; i++) {
        if (path.s[i] < s0 - 5) continue;
        const dx = path.x[i] - z.cx;
        const dz = path.z[i] - z.cz;
        if (dx * dx + dz * dz < (z.radius + 40) * (z.radius + 40)) return true;
      }
      return false;
    });
    const want = [...cands.map((z) => ({ zone: z, sEnter: undefined as number | undefined, sRelease: NaN })), ...explicit];
    const found = new Map<Zone, { enter: number; exit: number }>();
    const step = 1.5;
    for (let s = s0; ; s += step) {
      const ss = Math.min(s, path.length);
      tempProbe(t, path, ss, body, 0.2, 0.1);
      for (const w of want) {
        const f = found.get(w.zone);
        const hit = w.zone.hits(body);
        if (hit && !f) found.set(w.zone, { enter: Math.max(s0, ss - step), exit: NaN });
        else if (!hit && f && Number.isNaN(f.exit)) f.exit = ss;
      }
      if (ss >= path.length) break;
    }
    for (const w of want) {
      const f = found.get(w.zone);
      const isExplicit = explicit.includes(w as ExplicitReq);
      if (!f && !isExplicit) continue;
      const enter = w.sEnter ?? f?.enter ?? s0;
      const exit = f?.exit ?? NaN;
      const rel = isExplicit ? w.sRelease : Number.isNaN(exit) ? path.length + 1 : exit + 0.5;
      reqs.push({ zone: w.zone, sEnter: Math.max(s0, enter), sRelease: rel, sExit: exit });
    }
    return reqs;
  }

  release(z: Zone): void {
    z.owner = null;
    this.held.delete(z);
  }

  releaseAll(t: Truck): void {
    for (const r of t.reqs) if (r.zone.owner === t) this.release(r.zone);
    t.reqs = [];
  }

  /** Grab a zone outright (used when placing trucks at start). */
  grab(t: Truck, z: Zone): void {
    z.owner = t;
    this.held.add(z);
  }

  private chainBlocked(o: Truck, t: Truck): boolean {
    let c: Truck | null = o;
    for (let i = 0; i < 8 && c; i++) {
      c = c.blockedBy;
      if (c === t) return true;
    }
    return false;
  }

  tryAcquire(t: Truck, r: ZoneReq, claim = true, chain: Zone[] = []): boolean {
    const z = r.zone;
    if (z.owner === t) return true;
    if (z.owner) return this.refuse(t, 'held', z.owner as Truck);
    for (const h of this.held) if (h.owner !== t && !chain.includes(h) && h.overlaps(z)) return this.refuse(t, `overlap ${h.id}`, h.owner as Truck);
    for (const o of this.trucks) {
      if (o === t || !o.active) continue;
      const dx = o.x - z.cx;
      const dz = o.z - z.cz;
      if (dx * dx + dz * dz > (z.radius + 12) * (z.radius + 12)) continue;
      if (z.hits(o.body)) return this.refuse(t, 'body', o);
    }
    if (!z.isStatic) {
      // let approaching traffic through first
      for (const o of this.trucks) {
        if (o === t || !o.active || !o.path || o.phase === 'docked') continue;
        if (o.s >= o.path.length - 0.05) continue;
        const dx = o.x - z.cx;
        const dz = o.z - z.cz;
        if (dx * dx + dz * dz > (z.radius + 60) * (z.radius + 60)) continue;
        if (this.chainBlocked(o, t)) continue;
        const look = (o.v * o.v) / (2 * 2) + 22;
        const end = Math.min(o.path.length, o.s + look);
        for (let s = o.s + 1; s <= end; s += 2) {
          tempProbe(o, o.path, s, EXIT, 0, 0);
          if (z.hits(EXIT)) return this.refuse(t, 'approach', o);
        }
      }
    } else if (!Number.isNaN(r.sExit) && t.path) {
      // keep the box clear: the spot just past the zone must be free
      for (const s of [r.sExit, Math.min(t.path.length, r.sExit + 4)]) {
        tempProbe(t, t.path, s, EXIT, 1.5, 0.3);
        for (const o of this.trucks) {
          if (o === t || !o.active) continue;
          if (obbOverlap(EXIT, o.body)) return this.refuse(t, 'exit body', o);
        }
        for (const h of this.held) if (h !== z && h.owner !== t && !chain.includes(h) && h.hits(EXIT)) return this.refuse(t, `exit zone ${h.id}`, h.owner as Truck);
      }
    }
    if (!claim) return true;
    z.owner = t;
    this.held.add(z);
    return true;
  }

  /** Zones that follow each other closely are taken together or not at all. */
  private tryChain(t: Truck, start: number): boolean {
    const reqs = t.reqs;
    const chain: ZoneReq[] = [reqs[start]];
    for (let i = start + 1; i < reqs.length; i++) {
      const prev = chain[chain.length - 1];
      const end = Number.isFinite(prev.sRelease) ? prev.sRelease : prev.sEnter;
      if (reqs[i].sEnter > end + 18) break;
      chain.push(reqs[i]);
    }
    const zones = chain.map((r) => r.zone);
    for (const r of chain) if (r.zone.owner !== t && !this.tryAcquire(t, r, false, zones)) return false;
    for (const r of chain) {
      if (r.zone.owner === t) continue;
      r.zone.owner = t;
      this.held.add(r.zone);
    }
    return true;
  }

  private refuse(t: Truck, why: string, by: Truck | null): boolean {
    t.zoneWhy = why;
    t.zoneBy = by;
    return false;
  }

  private inCycle(t: Truck): boolean {
    let c = t.blockedBy;
    for (let i = 0; i < 12 && c; i++) {
      if (c === t) return true;
      c = c.blockedBy;
    }
    return false;
  }

  /** Advance one truck along its path. Returns true on arrival. */
  step(t: Truck, dt: number): boolean {
    const path = t.path;
    if (!path) return false;
    if (t.ghost > 0) t.ghost -= dt;
    // releases
    for (let i = 0; i < t.reqs.length; i++) {
      const r = t.reqs[i];
      if (r.zone.owner === t && t.s >= r.sRelease) {
        this.release(r.zone);
        t.reqs.splice(i--, 1);
      }
    }
    const rem = path.length - t.s;
    if (rem <= 0.005 && t.v === 0) return false;
    const brakeD = (t.v * t.v) / (2 * BRAKE);
    let limit = rem;
    let zoneBy: Truck | null = null;
    for (let i = 0; i < t.reqs.length; i++) {
      const r = t.reqs[i];
      if (r.zone.owner === t) continue;
      const d = r.sEnter - t.s;
      if (d > brakeD + 10) break; // not yet relevant (and nothing after it is)
      if (this.tryChain(t, i)) continue;
      if (Math.max(0, d - 0.6) < limit) {
        limit = Math.max(0, d - 0.6);
        zoneBy = t.zoneBy;
      }
      // never grab a later zone while waiting for an earlier one
      break;
    }
    const maxD = clamp(brakeD + 12, 10, 100);
    const free = this.probe(t, Math.min(maxD, limit + 2));
    if (limit < free && zoneBy) t.blockedBy = zoneBy;
    const room = Math.min(free - 0.5, limit);
    let target = Math.min(path.speedAt(t.s), Math.sqrt(2 * BRAKE * Math.max(0, room)));
    if (room > 0.05) target = Math.max(target, 0.12);
    const acc = t.v < 8 ? 1.1 : 0.7;
    const prevV = t.v;
    if (target > t.v) t.v = Math.min(target, t.v + acc * dt);
    else t.v = Math.max(target, t.v - 4 * dt);
    if (room <= 0.005) t.v = 0;
    t.braking = t.v < prevV - 1e-4 || (t.v < 0.05 && rem > 0.05);
    const ds = Math.max(0, Math.min(t.v * dt, rem, Math.max(0, room)));
    if (ds < 1e-4 && rem > 0.05) {
      t.blockedT += dt;
      // only a true standoff (a waiting cycle) lets one truck squeeze past
      if (t.blockedT > 20 && t.ghost <= 0 && this.inCycle(t)) {
        t.ghost = 6;
        t.blockedT = 0;
        this.stats.ghosts++;
        if (this.stats.log.length < 40) {
          const parts: string[] = [];
          let c: Truck | null = t;
          for (let i = 0; i < 6 && c; i++) {
            parts.push(`${c.label}(${c.phase} ${c.x.toFixed(0)},${c.z.toFixed(0)} ${c.zoneWhy} holds ${[...this.held].filter((z) => z.owner === c!).map((z) => z.id).join('+')} wants ${c!.reqs.filter((r) => r.zone.owner !== c).map((r) => r.zone.id + '@' + (r.sEnter - c!.s).toFixed(0)).join('+')})`);
            c = c.blockedBy;
            if (c === t) break;
          }
          this.stats.log.push(parts.join(' > '));
        }
      }
    } else t.blockedT = 0;
    t.s += ds;
    t.wheel += ds * t.dir;
    t.poseFromPath();
    if (t.s >= path.length - 0.005) {
      t.s = path.length;
      if (path.vmax[path.vmax.length - 1] <= 0) t.v = 0;
      return true;
    }
    return false;
  }

  /** Free distance along the path before touching another truck or a zone held by someone else. */
  private probe(t: Truck, maxD: number): number {
    const near = this.near;
    near.length = 0;
    const R = maxD + 22;
    if (t.ghost <= 0) {
      for (const o of this.trucks) {
        if (o === t || !o.active) continue;
        const dx = o.x - t.x;
        const dz = o.z - t.z;
        if (dx * dx + dz * dz < R * R) near.push(o);
      }
    }
    let zones = false;
    for (const z of this.held) {
      if (z.owner === t) continue;
      const dx = z.cx - t.x;
      const dz = z.cz - t.z;
      if (dx * dx + dz * dz < (R + z.radius) * (R + z.radius)) {
        zones = true;
        break;
      }
    }
    t.blockedBy = null;
    if (!near.length && !zones) return Infinity;
    const path = t.path!;
    const step = 1.2;
    const end = Math.min(maxD, path.length - t.s);
    for (let d = Math.min(step, end); d <= end + 1e-6; d += step) {
      tempProbe(t, path, t.s + d, PROBE, 1.1, 0.32);
      for (const o of near) {
        if (obbOverlap(PROBE, o.body)) {
          // already touching and moving apart: allow
          t.blockedBy = o;
          return Math.max(0, d - step);
        }
      }
      if (zones) {
        for (const z of this.held) {
          if (z.owner === t || !z.owner) continue;
          if (z.hits(PROBE)) {
            // a zone we are already inside does not stop us
            if (z.hits(t.body)) continue;
            t.blockedBy = z.owner as Truck;
            return Math.max(0, d - step);
          }
        }
      }
      if (d >= end) break;
    }
    return Infinity;
  }
}

/** Body box at path distance s, inflated. */
function tempProbe(t: Truck, path: Path, s: number, out: OBB, inflL: number, inflW: number): OBB {
  const saved = t.path;
  t.path = path;
  t.probeBody(s, out, inflL, inflW);
  t.path = saved;
  return out;
}
