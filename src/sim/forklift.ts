/**
 * Forklift agent: executes a plan of small actions (drive a polyline forward or in reverse,
 * pivot, move the forks, pick, set down, take or release a lane lock). Lanes (rack aisles,
 * door lanes, the charger lane) are single-occupancy and locked; on the shared cross aisles
 * forklifts keep to the right and yield to whatever is in front of them.
 */
import type { ForkliftView } from '../core/contracts';
import { DOCK_HEIGHT, FORKLIFT } from '../core/constants';
import { angleDelta, clamp } from '../core/geom';
import type { ForkliftState, V2 } from '../core/types';
import type { Loc } from './model';
import type { Pallet } from './pallets';
import { Path } from './path';
import { makeObb, obbOverlap, setObb, type OBB } from './zones';

export const FL_FRONT = 2.2;
export const FL_BACK = 1.65;
export const FL_HALF_W = 0.62;
const FL_PATH = { latAcc: 0.9, decel: 1.1, step: 0.2 };

export type Action =
  | {
      k: 'drive';
      pts: V2[];
      rev: boolean;
      speed: number;
      acquire: { key: string; s: number }[];
      release: { key: string; s: number }[];
      /** Cross-aisle cells to reserve (all at once) before setting off. */
      cells?: string[];
    }
  | { k: 'pivot'; h: number }
  | { k: 'forks'; h: number; wait: boolean }
  | { k: 'lock'; key: string }
  | { k: 'unlock'; key: string }
  | { k: 'attach'; pallet: Pallet }
  | { k: 'detach'; pallet: Pallet; loc: Loc }
  | { k: 'call'; fn: () => void }
  | { k: 'wait'; t: number };

export interface FlHost {
  tryLock(fl: Forklift, key: string): boolean;
  unlock(fl: Forklift, key: string): void;
  attach(fl: Forklift, p: Pallet): void;
  detach(fl: Forklift, p: Pallet, loc: Loc): void;
  others(fl: Forklift): Forklift[];
  lockOwner(key: string): Forklift | null;
  tryCells(fl: Forklift, ids: string[]): boolean;
}

export class Forklift {
  x = 0;
  z = 0;
  h = 0;
  fork = 0.05;
  forkTarget = 0.05;
  wheel = 0;
  battery = 1;
  state: ForkliftState = 'idle';
  task: string = 'Parked at charger';
  moved = 0;
  node: string;
  plan: Action[] = [];
  // current drive
  private path: Path | null = null;
  private s = 0;
  v = 0;
  private dir = 1;
  private actT = 0;
  private acquire: { key: string; s: number }[] = [];
  private release: { key: string; s: number }[] = [];
  readonly locks = new Set<string>();
  /** Reserved cross-aisle cells -> whether we have driven onto them yet. */
  readonly cells = new Map<string, boolean>();
  /** Cells requested by the current drive. */
  driveCells: string[] = [];
  reversing = false;
  carrying: Pallet | null = null;
  charging = false;
  parked = true;
  body: OBB = makeObb();
  private probe: OBB = makeObb();
  blockedT = 0;
  blockedBy: Forklift | null = null;
  waitLock: string | null = null;
  ghost = 0;
  moving = false;
  /** Remaining polyline of the current drive, for route threads. */
  routeCache: V2[] = [];
  homeIdx: number;
  /** Set by ops: the current task, if any. */
  job: unknown = null;
  stats = { ghosts: 0 };

  constructor(
    readonly id: string,
    readonly label: string,
    readonly siteId: string,
    readonly index: number,
    readonly view: ForkliftView,
    home: { node: string; homeIdx: number },
  ) {
    this.node = home.node;
    this.homeIdx = home.homeIdx;
  }

  get busy(): boolean {
    return this.plan.length > 0 || this.path !== null;
  }

  updateBody(): void {
    setObb(this.body, this.x, this.z, this.h, FL_FRONT, FL_BACK, FL_HALF_W);
  }

  push(...a: Action[]): void {
    this.plan.push(...a);
  }

  /** Advance the plan. Returns true while something is happening. */
  step(dt: number, host: FlHost): void {
    this.moving = false;
    // fork animation (runs alongside everything)
    const df = this.forkTarget - this.fork;
    if (Math.abs(df) > 1e-4) {
      const rate = 0.8;
      const d = clamp(df, -rate * dt, rate * dt);
      this.fork += d;
      this.battery -= Math.abs(d) * 1.2e-4 * (this.carrying ? 2 : 1);
    }
    if (this.ghost > 0) this.ghost -= dt;
    let guard = 0;
    while (guard++ < 8) {
      const a = this.plan[0];
      if (!a) return;
      if (a.k === 'drive') {
        if (!this.path) {
          const p0 = a.pts[0];
          const p1 = a.pts[1];
          if (!p1 || Math.hypot(p1.x - p0.x, p1.z - p0.z) < 1e-4) {
            this.plan.shift();
            continue;
          }
          if (a.cells && a.cells.length && !host.tryCells(this, a.cells)) {
            this.blockedT += dt;
            this.waitLock = 'cells';
            return;
          }
          if (a.cells) this.driveCells = a.cells;
          this.waitLock = null;
          // line up first: pivot in place toward the first segment
          let h0 = Math.atan2(p1.x - p0.x, p1.z - p0.z);
          if (a.rev) h0 += Math.PI;
          // a short leg straight behind us: just reverse along it
          if (!a.rev && Math.abs(angleDelta(this.h, h0)) > 2.5) {
            let len = 0;
            let straight = true;
            for (let i = 1; i < a.pts.length; i++) {
              len += Math.hypot(a.pts[i].x - a.pts[i - 1].x, a.pts[i].z - a.pts[i - 1].z);
              const hh = Math.atan2(a.pts[i].x - a.pts[i - 1].x, a.pts[i].z - a.pts[i - 1].z);
              if (Math.abs(angleDelta(hh, h0 - Math.PI)) > 0.05 && len > 0.5) straight = false;
            }
            if (len < 25 && straight) {
              this.plan[0] = { ...a, rev: true, speed: Math.min(a.speed, 1.3) };
              continue;
            }
          }
          if (!a.rev && Math.abs(angleDelta(this.h, h0)) > 2.3) {
            // facing into a lane we are leaving: back out to the first corner, then turn there
            let k = 1;
            for (; k < a.pts.length - 1; k++) {
              const ha = Math.atan2(a.pts[k].x - a.pts[k - 1].x, a.pts[k].z - a.pts[k - 1].z);
              const hb = Math.atan2(a.pts[k + 1].x - a.pts[k].x, a.pts[k + 1].z - a.pts[k].z);
              if (Math.abs(angleDelta(ha, hb)) > 0.3) break;
            }
            let L = 0;
            for (let i = 1; i <= k; i++) L += Math.hypot(a.pts[i].x - a.pts[i - 1].x, a.pts[i].z - a.pts[i - 1].z);
            const back: Action = {
              k: 'drive',
              pts: a.pts.slice(0, k + 1),
              rev: true,
              speed: Math.min(a.speed, 1.3),
              acquire: [],
              release: a.release.filter((r) => r.s <= L),
            };
            const rest: Action = {
              k: 'drive',
              pts: a.pts.slice(k),
              rev: false,
              speed: a.speed,
              acquire: [],
              release: a.release.filter((r) => r.s > L).map((r) => ({ key: r.key, s: r.s - L })),
            };
            this.plan.splice(0, 1, back, ...(k < a.pts.length - 1 ? [rest] : []));
            continue;
          }
          if (Math.abs(angleDelta(this.h, h0)) > 0.3) {
            this.plan.unshift({ k: 'pivot', h: this.h + angleDelta(this.h, h0) });
            continue;
          }
          this.startDrive(a);
        }
        if (this.driveStep(dt, host)) {
          this.path = null;
          this.plan.shift();
          this.actT = 0;
          continue;
        }
        return;
      }
      if (a.k === 'pivot') {
        const d = angleDelta(this.h, a.h);
        if (Math.abs(d) < 0.01) {
          this.h = a.h;
          this.plan.shift();
          this.actT = 0;
          this.updateBody();
          continue;
        }
        // wait for room unless it has been a while
        if (this.actT === 0 || this.actT < 4) {
          const blocker = this.pivotBlocked(host);
          if (blocker && this.ghost <= 0) {
            this.actT += dt * 0.5;
            this.blockedT += dt;
            this.blockedBy = blocker;
            if (this.actT < 4) return;
          }
        }
        this.actT = Math.max(this.actT, 4);
        const rate = 1.6;
        const turn = clamp(d, -rate * dt, rate * dt);
        this.h += turn;
        this.wheel += Math.abs(turn) * 0.4;
        this.moving = true;
        this.blockedT = 0;
        this.updateBody();
        return;
      }
      if (a.k === 'forks') {
        this.forkTarget = a.h;
        if (a.wait && Math.abs(this.fork - a.h) > 1e-3) return;
        this.plan.shift();
        continue;
      }
      if (a.k === 'lock') {
        if (!host.tryLock(this, a.key)) {
          this.blockedT += dt;
          this.waitLock = a.key;
          this.blockedBy = host.lockOwner(a.key);
          return;
        }
        this.waitLock = null;
        this.blockedT = 0;
        this.locks.add(a.key);
        this.plan.shift();
        continue;
      }
      if (a.k === 'unlock') {
        host.unlock(this, a.key);
        this.locks.delete(a.key);
        this.plan.shift();
        continue;
      }
      if (a.k === 'attach') {
        host.attach(this, a.pallet);
        this.plan.shift();
        continue;
      }
      if (a.k === 'detach') {
        host.detach(this, a.pallet, a.loc);
        this.plan.shift();
        continue;
      }
      if (a.k === 'call') {
        this.plan.shift();
        a.fn();
        continue;
      }
      if (a.k === 'wait') {
        this.actT += dt;
        if (this.actT < a.t) return;
        this.actT = 0;
        this.plan.shift();
        continue;
      }
    }
  }

  private startDrive(a: Extract<Action, { k: 'drive' }>): void {
    const pts = a.pts;
    this.path = new Path(pts, { radius: 1.0, speed: a.speed, ...FL_PATH });
    this.s = 0;
    this.dir = a.rev ? -1 : 1;
    this.reversing = a.rev;
    this.acquire = a.acquire.slice();
    this.release = a.release.slice();
    this.routeCache = pts;

  }

  private driveStep(dt: number, host: FlHost): boolean {
    const path = this.path!;
    // lock acquisition points
    let limit = path.length - this.s;
    let lockKey: string | null = null;
    for (let i = 0; i < this.acquire.length; i++) {
      const q = this.acquire[i];
      if (this.locks.has(q.key)) {
        this.acquire.splice(i--, 1);
        continue;
      }
      const d = q.s - this.s;
      const brake = (this.v * this.v) / (2 * 1.1) + 1.2;
      if (d <= brake) {
        if (host.tryLock(this, q.key)) {
          this.locks.add(q.key);
          this.acquire.splice(i--, 1);
          continue;
        }
      }
      if (Math.max(0, d) < limit) {
        limit = Math.max(0, d);
        lockKey = q.key;
      }
    }
    // obstacle probe
    const free = this.ghost > 0 ? Infinity : this.probeFree(host, Math.min(limit, 7));
    const room = Math.min(free - 0.05, limit);
    let target = Math.min(path.speedAt(this.s), Math.sqrt(2 * 1.6 * Math.max(0, room)));
    if (room > 0.04) target = Math.max(target, 0.06);
    const acc = 0.9;
    if (target > this.v) this.v = Math.min(target, this.v + acc * dt);
    else this.v = Math.max(target, this.v - 3 * dt);
    if (room <= 0.002) this.v = 0;
    const ds = Math.max(0, Math.min(this.v * dt, path.length - this.s, Math.max(0, room)));
    if (ds <= 1e-5 && this.s < path.length - 0.005) {
      this.blockedT += dt;
      if (lockKey && limit <= free) {
        this.waitLock = lockKey;
        this.blockedBy = host.lockOwner(lockKey);
      } else this.waitLock = null;
    } else {
      this.waitLock = null;
      this.blockedT = 0;
      this.blockedBy = null;
    }
    this.s += ds;
    this.wheel += ds * this.dir;
    this.battery -= ds * 3e-5 * (this.carrying ? 1.3 : 1);
    if (ds > 1e-5) this.moving = true;
    const p = path.pose(this.s, P);
    this.x = p.x;
    this.z = p.z;
    // heading follows tangent, eased so tight fillets never snap
    const target_h = this.dir > 0 ? p.h : p.h + Math.PI;
    const dh = angleDelta(this.h, target_h);
    this.h += Math.abs(dh) < 0.6 ? dh : Math.sign(dh) * Math.min(Math.abs(dh), 2.5 * dt + 0.02);
    this.updateBody();
    for (let i = 0; i < this.release.length; i++) {
      const r = this.release[i];
      if (this.s >= r.s) {
        host.unlock(this, r.key);
        this.locks.delete(r.key);
        this.release.splice(i--, 1);
      }
    }
    if (this.s >= path.length - 0.005) {
      for (const r of this.release) {
        host.unlock(this, r.key);
        this.locks.delete(r.key);
      }
      this.release = [];
      this.v = 0;
      // settle exactly on the final tangent
      const end = this.dir > 0 ? p.h : p.h + Math.PI;
      if (Math.abs(angleDelta(this.h, end)) > 0.02) {
        // let the next pivot or tick finish the heading
        this.h += angleDelta(this.h, end) * 0.5;
        this.updateBody();
        return false;
      }
      this.h = end;
      this.updateBody();
      return true;
    }
    return false;
  }

  /** Free distance along the path before touching another forklift. */
  private probeFree(host: FlHost, maxD: number): number {
    const path = this.path!;
    const others = host.others(this);
    if (!others.length) return Infinity;
    const near: Forklift[] = [];
    for (const o of others) {
      if (o.parked) continue;
      const dx = o.x - this.x;
      const dz = o.z - this.z;
      if (dx * dx + dz * dz < (maxD + 6) * (maxD + 6)) near.push(o);
    }
    if (!near.length) return Infinity;
    const step = 0.3;
    const end = Math.min(maxD + 0.9, path.length - this.s);
    for (let d = step; d <= end + 1e-6; d += step) {
      const p = path.pose(this.s + d, P);
      const h = this.dir > 0 ? p.h : p.h + Math.PI;
      const fr = this.dir > 0 ? FL_FRONT + 0.35 : FL_FRONT + 0.05;
      const bk = this.dir > 0 ? FL_BACK + 0.05 : FL_BACK + 0.35;
      setObb(this.probe, p.x, p.z, h, fr, bk, FL_HALF_W + 0.04);
      for (const o of near) {
        if (obbOverlap(this.probe, o.body)) {
          // ignore if we already overlap at our current pose (do not freeze; we are leaving)
          setObb(TMPB, this.x, this.z, this.h, FL_FRONT, FL_BACK, FL_HALF_W);
          if (obbOverlap(TMPB, o.body) && d <= step + 1e-6) {
            // only block if moving brings us closer
            const dx0 = o.x - this.x;
            const dz0 = o.z - this.z;
            const dx1 = o.x - p.x;
            const dz1 = o.z - p.z;
            if (dx1 * dx1 + dz1 * dz1 > dx0 * dx0 + dz0 * dz0) continue;
          }
          this.blockedBy = o;
          return d - step;
        }
      }
    }
    return Infinity;
  }

  private pivotBlocked(host: FlHost): Forklift | null {
    for (const o of host.others(this)) {
      if (o.parked) continue;
      const dx = o.x - this.x;
      const dz = o.z - this.z;
      if (dx * dx + dz * dz > 30) continue;
      // circle of the sweep vs the other's box
      setObb(TMPB, this.x, this.z, 0, 1.95, 1.95, 1.95);
      if (obbOverlap(TMPB, o.body)) return o;
    }
    return null;
  }

  /** Remaining route for the thread: current drive plus queued drives. */
  routeAhead(): V2[] {
    const out: V2[] = [];
    if (this.path) {
      for (const p of this.path.remaining(this.s, 1.5, 0, 120)) out.push({ x: p.x, z: p.z });
    }
    for (const a of this.plan) {
      if (a.k === 'drive' && a !== this.plan[0]) {
        for (const p of a.pts) out.push(p);
      }
      if (out.length > 200) break;
    }
    return out;
  }

  syncView(dt: number, time: number): void {
    const o = this.view.object;
    o.position.set(this.x, DOCK_HEIGHT, this.z);
    o.rotation.y = this.h;
    this.view.setForkHeight(clamp(this.fork, 0, FORKLIFT.maxForkHeight));
    this.view.setWheelTravel(this.wheel);
    this.view.setBeacon(this.moving || this.busy);
    this.view.setCharging(this.charging);
    this.view.update(dt, time);
  }
}

const P = { x: 0, z: 0, h: 0 };
const TMPB: OBB = makeObb();
