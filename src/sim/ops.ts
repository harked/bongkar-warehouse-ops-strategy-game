/**
 * Per-site operations: dock doors (roll-up, signals, truck work), storage slots, the forklift
 * task pool and the plans forklifts execute (trailer to stage to rack, rack to stage to trailer,
 * cross-dock floor moves, charging).
 */
import { DOCK_HEIGHT, FORKLIFT, TRUCK_CARGO_SLOTS } from '../core/constants';
import { smoothstep } from '../core/geom';
import type { CargoKind, SiteLayout, SlotLayout, V2 } from '../core/types';
import type { SimCore } from './core';
import { Forklift, type Action, type FlHost } from './forklift';
import type { DoorState, Loc, Shipment } from './model';
import { NavInfo } from './nav';

import type { Pallet } from './pallets';
import type { Truck } from './truck';
import type { SiteYard } from './yard';

export interface Task {
  id: number;
  kind: 'unload' | 'putaway' | 'pick' | 'load';
  pallet: Pallet;
  dst: Loc;
  prio: number;
  fl: Forklift | null;
  door: DoorState | null;
  truck: Truck | null;
  created: number;
}

let taskSeq = 1;

export const zoneFor = (c: CargoKind): SlotLayout['zone'] => (c === 'frozen' ? 'frozen' : c === 'produce' ? 'chill' : 'ambient');

export class SiteOps implements FlHost {
  readonly id: string;
  readonly nav: NavInfo;
  readonly doors: DoorState[] = [];
  readonly doorById = new Map<string, DoorState>();
  readonly slotPallet: (Pallet | null)[];
  readonly slotRes: Uint8Array;
  readonly forklifts: Forklift[] = [];
  readonly locks = new Map<string, Forklift>();
  readonly tasks: Task[] = [];
  readonly bays: (Truck | null)[];
  readonly holdLine: Truck[] = [];
  readonly connLine: Truck[] = [];
  readonly moveTimes: number[] = [];
  movesToday = 0;
  stored = 0;
  idleSince = new Map<Forklift, number>();
  private genT = 0;
  readonly floor: boolean;
  tempC = -18.6;

  constructor(
    readonly L: SiteLayout,
    readonly yard: SiteYard,
    readonly sim: SimCore,
  ) {
    this.id = L.id;
    this.nav = new NavInfo(L);
    this.floor = L.def.storage === 'floor';
    this.slotPallet = new Array(L.slots.length).fill(null);
    this.slotRes = new Uint8Array(L.slots.length);
    this.bays = new Array(yard.bays.length).fill(null);
    for (const d of L.doors) {
      const ds: DoorState = {
        L: d,
        geo: yard.doors.get(d.id)!,
        siteId: L.id,
        state: 'idle',
        truck: null,
        open: 0,
        signal: 'idle',
        stage: new Array(d.stageSlots.length).fill(null),
        stageRes: new Array(d.stageSlots.length).fill(false),
        shipment: null,
        turns: 0,
        lastTruck: null,
        lock: null,
      };
      this.doors.push(ds);
      this.doorById.set(d.id, ds);
    }
  }

  get capacity(): number {
    return this.floor ? this.L.slots.length : this.L.slots.length;
  }

  throughputPerHour(): number {
    const t = this.sim.t;
    while (this.moveTimes.length && this.moveTimes[0] < t - 3600) this.moveTimes.shift();
    // ramp the window during the first sim hour
    const span = Math.min(3600, Math.max(900, t - this.firstT));
    return Math.round((this.moveTimes.length * 3600) / span);
  }
  firstT = 0;

  // ---- FlHost ----------------------------------------------------------------------------------
  tryLock(fl: Forklift, key: string): boolean {
    const o = this.locks.get(key);
    if (o && o !== fl) return false;
    this.locks.set(key, fl);
    return true;
  }
  unlock(fl: Forklift, key: string): void {
    if (this.locks.get(key) === fl) this.locks.delete(key);
  }
  attach(fl: Forklift, p: Pallet): void {
    const loc = p.loc;
    if (loc.t === 'slot') {
      this.slotPallet[loc.slot.index] = null;
      this.stored--;
    } else if (loc.t === 'stage') loc.door.stage[loc.i] = null;
    else if (loc.t === 'trailer') loc.truck.cargo[loc.i] = null;
    fl.carrying = p;
    this.sim.pallets.setLoc(p, { t: 'forks', fl });
  }
  detach(fl: Forklift, p: Pallet, loc: Loc): void {
    fl.carrying = null;
    if (loc.t === 'slot') {
      this.slotPallet[loc.slot.index] = p;
      this.slotRes[loc.slot.index] = 0;
      this.stored++;
    } else if (loc.t === 'stage') {
      loc.door.stage[loc.i] = p;
      loc.door.stageRes[loc.i] = false;
    } else if (loc.t === 'trailer') {
      loc.truck.cargo[loc.i] = p;
      loc.truck.cargoRes[loc.i] = false;
    }
    p.siteId = this.id;
    this.sim.pallets.setLoc(p, loc);
    fl.moved++;
    this.movesToday++;
    this.moveTimes.push(this.sim.t);
  }
  /** Cross-aisle cell (node) reservations. */
  readonly cellOwner = new Map<string, Forklift>();
  tryCells(fl: Forklift, ids: string[]): boolean {
    for (const id of ids) {
      const o = this.cellOwner.get(id);
      if (o && o !== fl) {
        fl.blockedBy = o;
        return false;
      }
    }
    for (const id of ids) {
      this.cellOwner.set(id, fl);
      if (!fl.cells.has(id)) fl.cells.set(id, false);
    }
    return true;
  }
  /** Free cells the forklift has left behind (or all of a cross aisle once it is back in a lane). */
  private releaseCells(f: Forklift): void {
    if (!f.cells.size) return;
    const N = this.L.nav.nodes;
    const hx = Math.sin(f.h) * (f.reversing ? -1 : 1);
    const idle = !f.busy;
    for (const [id, visited] of f.cells) {
      const c = N[id];
      const off = Math.abs(f.z - c.z);
      if (!visited) {
        if (off < 2.6 && Math.abs(f.x - c.x) < 4) f.cells.set(id, true);
        else if (idle || f.parked) this.dropCell(f, id);
        continue;
      }
      const behind = f.moving && Math.abs(hx) > 0.5 && (c.x - f.x) * Math.sign(hx) < -3.4;
      if (off > 3.2 || behind || f.parked) this.dropCell(f, id);
    }
  }
  private dropCell(f: Forklift, id: string): void {
    f.cells.delete(id);
    if (this.cellOwner.get(id) === f) this.cellOwner.delete(id);
  }
  lockOwner(key: string): Forklift | null {
    return this.locks.get(key) ?? null;
  }
  /** Break gridlocks: in a waiting cycle, the first member stuck behind a body (not a lock) squeezes past. */
  private resolve(): void {
    for (const f of this.forklifts) {
      if (f.ghost > 0 || f.blockedT < 2.5) continue;
      const cyc: Forklift[] = [f];
      let c = f.blockedBy;
      let cycle = false;
      for (let i = 0; i < 8 && c; i++) {
        if (c === f) {
          cycle = true;
          break;
        }
        if (c.blockedT < 0.5) break;
        cyc.push(c);
        c = c.blockedBy;
      }
      if (!cycle && f.blockedT < 25) continue;
      const m = cyc.filter((x) => !x.waitLock && x.blockedBy).sort((a, b) => a.index - b.index)[0];
      if (m && m.ghost <= 0) {
        m.ghost = 2.5;
        m.stats.ghosts++;
      }
    }
  }
  private resolveT = 0;
  others(fl: Forklift): Forklift[] {
    return this.forklifts.length > 1 ? this.forklifts.filter((f) => f !== fl) : [];
  }

  // ---- slots -------------------------------------------------------------------------------------
  /** Free storage slot nearest to a point, matching the cargo's temperature zone. */
  freeSlot(cargo: CargoKind, near: V2): SlotLayout | null {
    const zone = this.L.def.kind === 'cold' ? zoneFor(cargo) : null;
    let best: SlotLayout | null = null;
    let bestD = Infinity;
    const r = this.sim.rand;
    for (const s of this.L.slots) {
      if (this.slotPallet[s.index] || this.slotRes[s.index]) continue;
      if (zone && s.zone !== zone) continue;
      const d = Math.abs(s.pos.x - near.x) + Math.abs(s.pos.z - near.z) * 0.7 + s.level * 2.5 + r() * 14;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best;
  }

  /** Pre-fill storage with stock pallets. */
  seedStock(fill: number, cargoFor: (s: SlotLayout) => CargoKind, origin: (c: CargoKind) => string): void {
    const r = this.sim.rand;
    for (const s of this.L.slots) {
      if (r() > fill) continue;
      const cargo = cargoFor(s);
      const p = this.sim.pallets.create(
        { cargo, ...productOf(cargo, r), origin: origin(cargo), siteId: this.id, shipment: null, loc: { t: 'slot', slot: s }, receivedAt: this.sim.t - 3600 * (2 + r() * 40) },
        r,
      );
      if (!p) return;
      this.slotPallet[s.index] = p;
      this.stored++;
    }
  }

  // ---- docks ------------------------------------------------------------------------------------
  stepDoors(dt: number): void {
    const view = this.sim.world.sites.get(this.id);
    for (const d of this.doors) {
      const t = d.truck;
      let openTarget = 0;
      if (t && t.door === d && t.phase === 'docked') {
        if (t.dockStep === 'opening') {
          openTarget = 1;
          if (d.open > 0.6) t.dampRear(1, dt);
          if (d.open >= 1 && t.rearDoors >= 1) {
            t.dockStep = 'working';
            t.dockT = this.sim.t;
            for (const p of t.cargo) if (p) this.sim.pallets.place(p);
            this.sim.fleet.onWorkStart(t);
          }
        } else if (t.dockStep === 'working') {
          openTarget = 1;
          if (this.workDone(t)) {
            t.dockStep = 'closing';
            this.sim.fleet.onWorkDone(t);
          }
        } else if (t.dockStep === 'closing') {
          const shut = t.dampRear(0, dt);
          if (t.rearDoors < 0.02) for (const p of t.cargo) if (p) this.sim.pallets.place(p);
          openTarget = shut ? 0 : 1;
          if (shut && d.open <= 0) {
            t.dockStep = 'ready';
            this.sim.fleet.depart(t);
          }
        }
      }
      if (d.open !== openTarget) {
        d.open += Math.sign(openTarget - d.open) * Math.min(Math.abs(openTarget - d.open), dt / 2);
        if (view && !this.sim.headless) view.setDoorOpen(d.L.id, smoothstep(d.open));
      }
      // dock state + signal
      let sig: DoorState['signal'] = 'idle';
      if (!t) d.state = 'idle';
      else if (t.door === d) {
        if (t.phase === 'docked') {
          if (t.dockStep === 'opening' || t.dockStep === 'working') {
            d.state = t.job.kind === 'collect' ? 'loading' : 'unloading';
            sig = this.sim.t - t.arrivedAt > 3000 ? 'alert' : 'busy';
          } else {
            d.state = 'departing';
            sig = 'ready';
          }
        } else if (t.phase === 'pullout') {
          d.state = 'departing';
          sig = 'ready';
        } else if (t.phase === 'reversing') {
          d.state = 'docking';
          sig = 'busy';
        } else d.state = 'reserved';
      }
      if (sig !== d.signal) {
        d.signal = sig;
        if (view && !this.sim.headless) view.setDoorSignal(d.L.id, sig);
      }
    }
  }

  syncDoorViews(): void {
    const view = this.sim.world.sites.get(this.id);
    if (!view) return;
    for (const d of this.doors) {
      view.setDoorOpen(d.L.id, smoothstep(d.open));
      view.setDoorSignal(d.L.id, d.signal);
    }
  }

  private workDone(t: Truck): boolean {
    for (const k of this.tasks) if (k.truck === t) return false;
    if (t.job.kind === 'deliver') return t.cargoCount === 0;
    if (t.job.kind === 'collect') {
      const sh = t.job.shipment;
      if (!sh) return true;
      return t.cargoCount >= sh.count;
    }
    return true;
  }

  // ---- tasks ---------------------------------------------------------------------------------------
  step(dt: number): void {
    
    this.stepDoors(dt);
    this.genT -= dt;
    if (this.genT <= 0) {
      this.genT = 1;
      this.generate();
    }
    this.assign();
    this.resolveT -= dt;
    if (this.resolveT <= 0) {
      this.resolveT = 0.5;
      this.resolve();
    }
    for (const f of this.forklifts) {
      f.step(dt, this);
      this.releaseCells(f);
      if (!f.busy && !f.parked) this.onIdle(f);
      if (f.parked) {
        f.charging = f.battery < 0.995;
        if (f.charging) f.battery = Math.min(1, f.battery + dt * 3.2e-4);
        f.state = f.charging ? 'charging' : 'idle';
        f.task = f.charging ? `Charging, ${Math.round(f.battery * 100)}%` : 'Parked at charger';
      } else {
        f.battery -= dt * 2e-6;
        f.charging = false;
      }
      if (f.battery < 0.02) f.battery = 0.02;
    }
    if (this.L.def.kind === 'cold') this.tempC += (-18.4 + Math.sin(this.sim.t / 900) * 0.5 - this.tempC) * Math.min(1, dt * 0.01);
  }

  private countTasks(pred: (k: Task) => boolean): number {
    let n = 0;
    for (const k of this.tasks) if (pred(k)) n++;
    return n;
  }

  private add(kind: Task['kind'], pallet: Pallet, dst: Loc, prio: number, door: DoorState | null, truck: Truck | null): void {
    pallet.busy = true;
    if (dst.t === 'slot') this.slotRes[dst.slot.index] = 1;
    else if (dst.t === 'stage') dst.door.stageRes[dst.i] = true;
    else if (dst.t === 'trailer') dst.truck.cargoRes[dst.i] = true;
    this.tasks.push({ id: taskSeq++, kind, pallet, dst, prio, fl: null, door, truck, created: this.sim.t });
  }

  private generate(): void {
    for (const d of this.doors) {
      const t = d.truck;
      if (t && t.door === d && t.phase === 'docked' && t.dockStep === 'working') {
        const active = this.countTasks((k) => k.truck === t);
        if (active < 2) {
          if (t.job.kind === 'deliver') {
            // unload, rear rows first
            for (let i = 0; i < 20; i++) {
              const p = t.cargo[i];
              if (!p || p.busy) continue;
              let dst: Loc | null = null;
              if (!this.floor) {
                const si = d.stage.findIndex((s, j) => !s && !d.stageRes[j]);
                if (si >= 0) dst = { t: 'stage', door: d, i: si };
              }
              if (!dst) {
                const slot = this.freeSlot(p.cargo, d.L.pos);
                if (slot) dst = { t: 'slot', slot };
              }
              if (dst) this.add('unload', p, dst, 3, d, t);
              break;
            }
          } else if (t.job.kind === 'collect' && t.job.shipment) {
            const sh = t.job.shipment;
            // front rows first
            let ti = -1;
            for (let i = 19; i >= 0; i--) {
              if (!t.cargo[i] && !t.cargoRes[i]) {
                ti = i;
                break;
              }
            }
            if (ti >= 0) {
              let src: Pallet | null = null;
              for (const p of sh.pallets) if (!p.busy && p.loc.t === 'stage') src = src ?? p;
              if (!src) for (const p of sh.pallets) if (!p.busy && p.loc.t === 'slot') src = src ?? p;
              if (src) this.add('load', src, { t: 'trailer', truck: t, i: ti }, 4, d, t);
            }
          }
        }
      }
      // putaway from inbound stage lanes
      if (!this.floor && d.L.role === 'inbound') {
        const active = this.countTasks((k) => k.kind === 'putaway' && k.door === d);
        if (active < 2) {
          for (const p of d.stage) {
            if (!p || p.busy) continue;
            const slot = this.freeSlot(p.cargo, d.L.pos);
            if (slot) this.add('putaway', p, { t: 'slot', slot }, 2, d, null);
            break;
          }
        }
      }
      // picking toward an outbound stage lane
      const sh = d.shipment;
      if (sh && sh.stage === 0 && !this.floor) {
        const active = this.countTasks((k) => k.kind === 'pick' && k.door === d);
        if (active < 2) {
          const si = d.stage.findIndex((s, j) => !s && !d.stageRes[j]);
          if (si >= 0) {
            for (const p of sh.pallets) {
              if (p.busy || p.loc.t !== 'slot') continue;
              this.add('pick', p, { t: 'stage', door: d, i: si }, 1, d, null);
              break;
            }
          }
        }
      }
    }
  }

  private available(f: Forklift): boolean {
    if (f.job || f.busy) return false;
    if (f.state === 'to-charge') return false;
    if (f.parked) return f.battery >= 0.55;
    return f.battery >= 0.25;
  }

  private assign(): void {
    if (!this.tasks.length) return;
    const open = this.tasks.filter((k) => !k.fl);
    if (!open.length) return;
    open.sort((a, b) => b.prio - a.prio || a.created - b.created);
    for (const k of open) {
      const from = this.taskSourcePos(k);
      const cands = this.forklifts.filter((f) => this.available(f));
      if (!cands.length) return;
      cands.sort((a, b) => this.distTo(a, from) - this.distTo(b, from));
      for (const f of cands) {
        const keys = this.taskKeys(f, k);
        if (!keys) continue;
        // reserve every lane the task touches at once: nobody ever waits for a lane on the cross aisle
        for (const key of keys) {
          this.locks.set(key, f);
          f.locks.add(key);
        }
        k.fl = f;
        f.job = k;
        this.idleSince.delete(f);
        this.planTask(f, k);
        break;
      }
    }
  }

  private distTo(f: Forklift, p: V2): number {
    return Math.abs(f.x - p.x) + Math.abs(f.z - p.z) + (f.parked ? 25 : 0);
  }

  /** Lane keys a task needs; null if any is held by someone else. */
  private taskKeys(f: Forklift, k: Task): Set<string> | null {
    const keys = new Set<string>();
    const src = this.targetNode(k.pallet.loc);
    const dst = this.targetNode(k.dst);
    if (!src || !dst) return null;
    const after = src;
    const add = (nodes: string[]) => {
      for (const n of nodes) {
        const key = this.nav.key.get(n);
        if (key) keys.add(key);
      }
    };
    add(this.nav.path(f.node, src));
    add(this.nav.path(after, dst));
    if (f.parked) keys.add('svc');
    for (const key of keys) {
      const o = this.locks.get(key);
      if (o && o !== f) return null;
    }
    return keys;
  }

  private taskSourcePos(k: Task): V2 {
    const l = k.pallet.loc;
    if (l.t === 'slot') return l.slot.pos;
    if (l.t === 'stage') return l.door.L.stageSlots[l.i].pos;
    if (l.t === 'trailer' && l.truck.door) return l.truck.door.L.pos;
    return { x: 0, z: 0 };
  }

  // ---- plans ------------------------------------------------------------------------------------
  /** Drive along the nav graph to a node, with lock handling. */
  private go(f: Forklift, from: string, to: string, held: Set<string>, end?: V2, speed = FORKLIFT.speed, start?: V2, keep?: Set<string>): Action[] {
    const nodes = this.nav.path(from, to);
    if (nodes.length < 2) {
      if (end) return [drive([start ?? this.nav.pos(from), end], false, 0.8)];
      return [];
    }
    const { pts, s } = this.nav.polyline(start ?? this.nav.pos(from), nodes, end);
    const lk = this.nav.locks(nodes, s, held);
    if (keep) lk.release = lk.release.filter((r) => !keep.has(r.key));
    for (const a of lk.acquire) held.add(a.key);
    for (const r of lk.release) held.delete(r.key);
    void f;
    return [{ k: 'drive', pts, rev: false, speed, acquire: lk.acquire, release: lk.release, cells: this.nav.cells(nodes) }];
  }

  private engageSlot(s: SlotLayout, pick: boolean, p: Pallet, dst: Loc | null): Action[] {
    const level = s.pos.y - DOCK_HEIGHT;
    const N = this.nav.pos(s.node);
    const out: Action[] = [{ k: 'pivot', h: s.heading }];
    const fx = Math.sin(s.heading);
    const fz = Math.cos(s.heading);
    const grab: Action = pick ? { k: 'attach', pallet: p } : { k: 'detach', pallet: p, loc: dst! };
    if (level < 0.1) {
      out.push(
        { k: 'forks', h: pick ? 0.02 : 0.15, wait: true },
        drive([N, s.access], false, 0.9),
        ...(pick ? [grab, { k: 'forks', h: 0.14, wait: true } as Action] : [{ k: 'forks', h: 0.0, wait: true } as Action, grab]),
        drive([s.access, N], true, 0.9),
        { k: 'forks', h: pick ? 0.15 : 0.05, wait: false },
      );
    } else {
      const pre = { x: s.access.x - fx * 1.0, z: s.access.z - fz * 1.0 };
      out.push(
        drive([N, pre], true, 0.7),
        { k: 'forks', h: pick ? level : level + 0.12, wait: true },
        drive([pre, s.access], false, 0.7),
        ...(pick ? [grab, { k: 'forks', h: level + 0.12, wait: true } as Action] : [{ k: 'forks', h: level, wait: true } as Action, grab]),
        drive([s.access, pre], true, 0.7),
        { k: 'forks', h: pick ? 0.15 : 0.05, wait: true },
        drive([pre, N], false, 0.7),
      );
    }
    return out;
  }

  /** Trailer slot engage; ends reversed out to the door's cross-aisle node with the lane lock released. */
  private engageTrailer(d: DoorState, t: Truck, i: number, pick: boolean, p: Pallet, dst: Loc | null): Action[] {
    const n = d.L.normal;
    const c = TRUCK_CARGO_SLOTS[i];
    const ch = Math.cos(t.h);
    const sh = Math.sin(t.h);
    const px = t.x + c.x * ch + c.z * sh;
    const pz = t.z - c.x * sh + c.z * ch;
    const access = { x: px - n.x * FORKLIFT.forkOffset, z: pz - n.z * FORKLIFT.forkOffset };
    const lat = access.x - d.L.pos.x;
    const inward = (depth: number, la: number): V2 => ({ x: d.L.pos.x + la - n.x * depth, z: d.L.pos.z - n.z * depth });
    const rowNodes = [d.L.stageSlots[0].node, d.L.stageSlots[2].node, d.L.stageSlots[4].node];
    const inPts: V2[] = [this.nav.pos(rowNodes[0]), inward(1.7, lat), access];
    const outPts: V2[] = [access, inward(1.7, lat), this.nav.pos(rowNodes[0])];
    const grab: Action = pick ? { k: 'attach', pallet: p } : { k: 'detach', pallet: p, loc: dst! };
    return [
      { k: 'pivot', h: d.L.dockHeading },
      { k: 'forks', h: pick ? 0.02 : 0.15, wait: true },
      drive(inPts, false, 1.1),
      ...(pick ? [grab, { k: 'forks', h: 0.14, wait: true } as Action] : [{ k: 'forks', h: 0.0, wait: true } as Action, grab]),
      { k: 'forks', h: pick ? 0.15 : 0.05, wait: false },
      drive(outPts, true, 1.1),
    ];
  }


  private targetNode(loc: Loc): string {
    if (loc.t === 'slot') return loc.slot.node;
    if (loc.t === 'stage') return loc.door.L.stageSlots[loc.i].node;
    if (loc.t === 'trailer' && loc.truck.door) return loc.truck.door.L.stageSlots[0].node;
    return '';
  }

  private planTask(f: Forklift, k: Task): void {
    const held = new Set(f.locks);
    const acts: Action[] = [];
    const wasParked = f.parked;
    const unpark = this.leaveCharger(f, held, this.taskSourcePos(k));
    acts.push(...unpark);
    let start: V2 | undefined;
    if (wasParked) {
      const last = unpark[unpark.length - 1];
      if (last && last.k === 'drive') start = last.pts[last.pts.length - 1];
    } else start = { x: f.x, z: f.z };
    const src = k.pallet.loc;
    let at = f.node;
    const keep = new Set<string>();
    {
      const srcNode = this.targetNode(src);
      const after = srcNode;
      for (const n of this.nav.path(after, this.targetNode(k.dst))) {
        const key = this.nav.key.get(n);
        if (key) keep.add(key);
      }
    }
    let first = true;
    const step = (loc: Loc, pick: boolean): void => {
      const node = this.targetNode(loc);
      acts.push(...this.go(f, at, node, held, undefined, FORKLIFT.speed, start, first ? keep : undefined));
      first = false;
      start = undefined;
      at = node;
      if (loc.t === 'slot') acts.push(...this.engageSlot(loc.slot, pick, k.pallet, pick ? null : loc));
      else if (loc.t === 'stage') acts.push(...this.engageSlot(loc.door.L.stageSlots[loc.i], pick, k.pallet, pick ? null : loc));
      else if (loc.t === 'trailer' && loc.truck.door) {
        const d = loc.truck.door;
        acts.push(...this.engageTrailer(d, loc.truck, loc.i, pick, k.pallet, pick ? null : loc));
        at = d.L.stageSlots[0].node;
      }
    };
    acts.push({ k: 'call', fn: () => this.setState(f, 'to-pick', this.describe(k, false)) });
    const n0 = acts.length;
    step(src, true);
    // switch to "carrying" the moment the pallet is on the forks
    const ai = acts.findIndex((a, i) => i >= n0 && a.k === 'attach');
    acts.splice(ai + 1, 0, { k: 'call', fn: () => this.setState(f, 'carrying', this.describe(k, true)) });
    step(k.dst, false);
    acts.push({ k: 'call', fn: () => this.finish(f, k, at) });
    f.parked = false;
    f.charging = false;
    f.state = 'to-pick';
    f.task = this.describe(k, false);
    f.push(...acts);
  }

  private setState(f: Forklift, s: Forklift['state'], task: string): void {
    f.state = s;
    f.task = task;
  }

  private where(loc: Loc): string {
    if (loc.t === 'slot') {
      const parts = loc.slot.id.split(':');
      return this.floor ? `floor lane ${parts[1]}` : `${parts[1]}-L${loc.slot.level + 1}`;
    }
    if (loc.t === 'stage') return `${loc.door.L.label} staging`;
    if (loc.t === 'trailer') return `${loc.truck.label} at ${loc.truck.door?.L.label ?? 'dock'}`;
    return 'dock';
  }

  describe(k: Task, carrying: boolean): string {
    const src = this.where(k.pallet.loc.t === 'forks' ? k.dst : k.pallet.loc);
    const dst = this.where(k.dst);
    if (!carrying) return `To ${src} for ${k.pallet.id}`;
    return `${k.pallet.id} to ${dst}`;
  }

  private finish(f: Forklift, k: Task, at: string): void {
    f.node = at;
    f.job = null;
    const i = this.tasks.indexOf(k);
    if (i >= 0) this.tasks.splice(i, 1);
    k.pallet.busy = false;
    this.sim.shipments.onMove(this, k);
    f.state = 'idle';
    f.task = 'Waiting for a task';
    this.idleSince.set(f, this.sim.t);
  }

  private onIdle(f: Forklift): void {
    if (f.job) return;
    if (f.battery < 0.25) {
      if (f.state !== 'to-charge' && this.goPark(f, 'to-charge', 'Low battery, heading to charger')) {
        this.sim.event(`${f.label} heading to charge, ${Math.round(f.battery * 100)}% battery`, 'warn', this.id, { kind: 'forklift', id: f.id });
      }
      return;
    }
    const since = this.idleSince.get(f) ?? this.sim.t;
    if (!this.idleSince.has(f)) this.idleSince.set(f, since);
    const atCross = this.nav.kind.get(f.node) === 'cross';
    if (this.sim.t - since > (atCross ? 2 : 10)) this.goPark(f, 'idle', 'Returning to charger');
  }

  /** Drive home and park nose-in at the charger. */
  goPark(f: Forklift, state: Forklift['state'], text: string): boolean {
    const ch = this.L.chargers[f.homeIdx];
    const keys = new Set<string>(['svc']);
    for (const n of this.nav.path(f.node, ch.node)) {
      const k = this.nav.key.get(n);
      if (k) keys.add(k);
    }
    for (const k of keys) {
      const o = this.locks.get(k);
      if (o && o !== f) return false;
    }
    for (const k of keys) {
      this.locks.set(k, f);
      f.locks.add(k);
    }
    const held = new Set(f.locks);
    const lane = { x: this.nav.laneX, z: ch.pos.z };
    const acts = this.go(f, f.node, ch.node, held, lane, FORKLIFT.speed, { x: f.x, z: f.z });
    acts.push(drive([lane, { x: this.nav.parkX, z: ch.pos.z }], false, 0.7));
    acts.push({ k: 'unlock', key: 'svc' });
    acts.push({
      k: 'call',
      fn: () => {
        f.parked = true;
        f.node = ch.node;
        this.idleSince.delete(f);
        if (state === 'to-charge') this.sim.event(`${f.label} plugged in at the charger`, 'cold', this.id, { kind: 'forklift', id: f.id });
      },
    });
    f.state = state;
    f.task = text;
    f.job = state === 'to-charge' ? { charge: true } : null;
    if (state === 'to-charge') acts.push({ k: 'call', fn: () => (f.job = null) });
    f.push(...acts);
    return true;
  }

  /** Back out of the charger bay facing the way we are going. */
  private leaveCharger(f: Forklift, held: Set<string>, toward: V2): Action[] {
    if (!f.parked) return [];
    const ch = this.L.chargers[f.homeIdx];
    const crossS = this.L.crossAisles[0];
    let exitSouth = true;
    if (this.L.crossAisles.length > 1) exitSouth = Math.abs(toward.z - crossS) < Math.abs(toward.z - this.L.crossAisles[1]);
    // exiting toward larger z means backing toward smaller z
    const sign = exitSouth === crossS > ch.pos.z ? -1 : 1;
    held.add('svc');
    f.parked = false;
    return [
      { k: 'lock', key: 'svc' },
      drive([{ x: this.nav.parkX, z: ch.pos.z }, { x: this.nav.laneX, z: ch.pos.z }, { x: this.nav.laneX, z: ch.pos.z + sign * 1.8 }], true, 0.7),
    ];
  }

  /** Place forklifts at their chargers. */
  spawnForklifts(make: (label: string, i: number) => Forklift): void {
    this.L.chargers.forEach((ch, i) => {
      const f = make(`FL-${String(i + 1).padStart(2, '0')}`, i);
      f.x = this.nav.parkX;
      f.z = ch.pos.z;
      f.h = ch.heading;
      f.parked = true;
      f.updateBody();
      this.forklifts.push(f);
    });
  }
}

function drive(pts: V2[], rev: boolean, speed: number): Action {
  return { k: 'drive', pts, rev, speed, acquire: [], release: [] };
}

import { product } from './names';
function productOf(c: CargoKind, r: () => number) {
  const p = product(c, r);
  return { sku: p.sku, desc: p.desc, kg: p.kg };
}

export type { Shipment };
