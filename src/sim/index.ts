/**
 * Bongkar simulation: clock, trucks, forklifts, pallets and shipments, with view sync and the
 * HUD snapshot. Starts Thursday 8 Oct at 07:30 with the world already mid-shift.
 */
import * as THREE from 'three';
import type { CreateSimulation, SimDeps, Simulation, WorldView } from '../core/contracts';
import { DOCK_HEIGHT, TRUCK_CARGO_SLOTS } from '../core/constants';
import { rng } from '../core/geom';
import type { CargoKind, EntityRef, HudSnapshot, SlotLayout, Tone, V3, WorldLayout } from '../core/types';
import type { SimCore } from './core';
import { Feed } from './feed';
import { Fleet } from './fleet';
import { Forklift } from './forklift';
import type { DoorState } from './model';
import { pick, product, supplierFor } from './names';
import { SiteOps } from './ops';
import { PalletStore } from './pallets';
import { ShipmentBook } from './shipments';
import { buildSnapshot } from './snapshot';
import { YardGeometry } from './yard';

const START = 7.5 * 3600;
const PREWARM = 240;
const MAX_STEP = 0.1;

export class Sim implements SimCore, Simulation {
  t = START - PREWARM;
  readonly rand = rng(20261008);
  readonly layout: WorldLayout;
  readonly world: WorldView;
  readonly yard: YardGeometry;
  readonly pallets: PalletStore;
  readonly feed = new Feed();
  readonly fleet: Fleet;
  readonly shipments: ShipmentBook;
  readonly sites = new Map<string, SiteOps>();
  headless = true;
  speed = 1;
  paused = false;
  palletsBefore = 0;
  private time = 0;
  /** Rolling cost of update() in ms, for diagnostics. */
  perf = { last: 0, avg: 0, max: 0, steps: 0, prewarmMs: 0 };

  constructor(deps: SimDeps) {
    this.layout = deps.layout;
    this.world = deps.world;
    this.yard = new YardGeometry(deps.layout);
    const renderer = deps.vehicles.createPalletRenderer(6000);
    deps.scene.add(renderer.object);
    this.pallets = new PalletStore(renderer);
    this.fleet = new Fleet(this, deps.vehicles, deps.scene);
    this.shipments = new ShipmentBook(this);
    for (const s of deps.layout.sites) {
      const ops = new SiteOps(s, this.yard.sites.get(s.id)!, this);
      this.sites.set(s.id, ops);
      ops.spawnForklifts((label, i) => {
        const id = `${s.id}:${label}`;
        const view = deps.vehicles.createForklift({ label });
        view.object.userData.pick = { kind: 'forklift', id };
        deps.scene.add(view.object);
        return new Forklift(id, label, s.id, i, view, { node: s.chargers[i].node, homeIdx: i });
      });
    }
    this.seed();
    // pre-warm: fast data-only steps so the first frame is mid-shift
    const t0 = performance.now();
    while (this.t < START) this.stepSim(0.25);
    // trucks out on the highways for the first frame
    for (const ops of this.sites.values()) {
      for (let i = 0; i < (ops.floor ? 2 : 1); i++) this.shipments.createInbound(ops.id, { seedOnRoute: -1 });
    }
    this.headless = false;
    this.perf.prewarmMs = performance.now() - t0;
    this.syncAll();
  }

  event(text: string, tone: Tone, siteId?: string, ref?: EntityRef): void {
    this.feed.push(this.t, text, tone, siteId, ref);
  }

  // ---- seeding ---------------------------------------------------------------------------------
  private seed(): void {
    const r = this.rand;
    const cargoFor: Record<string, (s: SlotLayout) => CargoKind> = {
      'pasa-ateh': () => pick(['cartons', 'cartons', 'wrapped', 'drums'] as CargoKind[], r),
      ambacang: (s) => (s.zone === 'frozen' ? 'frozen' : 'produce'),
      'stasiun-tabing': () => pick(['parcels', 'parcels', 'cartons'] as CargoKind[], r),
      'teluk-bayur': () => pick(['cartons', 'wrapped', 'parcels'] as CargoKind[], r),
    };
    for (const ops of this.sites.values()) {
      if (ops.floor) continue;
      ops.seedStock(0.55 + r() * 0.1, cargoFor[ops.id], (c) => supplierFor(c, r));
    }
    // forklift batteries
    for (const ops of this.sites.values()) {
      ops.forklifts.forEach((f, i) => (f.battery = i === 1 ? 0.27 + r() * 0.04 : 0.45 + r() * 0.5));
    }
    // docked trucks mid-unload / mid-load
    for (const ops of this.sites.values()) {
      const inbound = ops.doors.filter((d) => d.L.role === 'inbound');
      const outbound = ops.doors.filter((d) => d.L.role === 'outbound');
      const nIn = ops.id === 'pasa-ateh' ? inbound.length : Math.max(1, Math.round(inbound.length * 0.5));
      for (const d of pickN(inbound, nIn, r)) this.seedDockedInbound(ops, d);
      if (ops.id === 'pasa-ateh' && ops.yard.bays.length) {
        // one more inbound load waiting in the yard for a door
        const sh = this.shipments.createInbound(ops.id, { seedOnRoute: 0 });
        if (sh?.truck) {
          this.fleet.traffic.releaseAll(sh.truck);
          this.fleet.placeInBay(sh.truck, ops, 0, { kind: 'deliver', shipment: sh, dest: ops.id });
          sh.doneAt[2] = this.t - 300;
          sh.stage = 3;
        }
      }
      if (!ops.floor) {
        const nOut = Math.max(1, Math.round(outbound.length * 0.6));
        let k = 0;
        for (let i = 0; i < nOut; i++) {
          const sh = this.shipments.createOutbound(ops.id, r() < 0.2 ? 'teluk-bayur' : null, { truckIn: 1e9 });
          if (!sh) break;
          // a couple already have their truck at the door
          if (k++ % 2 === 0 && sh.door) this.seedDockedCollect(ops, sh.door);
          else this.shipmentsTruckSoon(sh);
        }
      }
    }
    // Teluk Bayur: cross-dock loads on the floor, one already loading at a north door
    const rv = [...this.sites.values()].find((o) => o.floor);
    if (rv) {
      for (let k = 0; k < 2; k++) {
        const cargo = pick(['cartons', 'wrapped', 'parcels'] as CargoKind[], r);
        const pallets = [];
        const n = 10 + Math.floor(r() * 6);
        for (const slot of rv.L.slots) {
          if (pallets.length >= n) break;
          if (rv.slotPallet[slot.index] || r() < 0.4) continue;
          const p = this.pallets.create(
            { cargo, ...productOf(cargo, r), origin: supplierFor(cargo, r), siteId: rv.id, shipment: null, loc: { t: 'slot', slot }, receivedAt: this.t - 300 - r() * 900 },
            r,
          );
          if (!p) break;
          rv.slotPallet[slot.index] = p;
          rv.stored++;
          pallets.push(p);
        }
        const sh = this.shipments.crossDock(rv, pallets, cargo, k === 0 ? 1e9 : 60);
        if (k === 0) {
          const north = rv.doors.filter((d) => d.L.side === 'N' && !d.truck);
          const t = this.fleet.free('dry');
          if (t && north.length) {
            const d = pick(north, r);
            this.fleet.placeDocked(t, rv, d, { kind: 'collect', shipment: sh, dest: rv.id });
            this.shipments.needTruck.delete(sh);
            let ti = 19;
            for (const p of sh.pallets.slice(0, Math.floor(sh.count * 0.4))) {
              if (p.loc.t !== 'slot') continue;
              rv.slotPallet[p.loc.slot.index] = null;
              rv.stored--;
              t.cargo[ti] = p;
              this.pallets.setLoc(p, { t: 'trailer', truck: t, i: ti-- });
            }
          }
        }
      }
    }
    this.shipments.doneToday = 11 + Math.floor(r() * 5);
    // an hour and a half of shift already behind us: throughput history and counters
    const rate: Record<string, number> = { 'pasa-ateh': 260, ambacang: 180, 'teluk-bayur': 150, 'stasiun-tabing': 170 };
    let before = 0;
    for (const ops of this.sites.values()) {
      const per = rate[ops.id] ?? 150;
      const n = Math.round(per * (0.9 + r() * 0.2));
      for (let i = 0; i < n; i++) ops.moveTimes.push(this.t - 3600 + (3600 * i) / n);
      ops.firstT = this.t - 3600;
      const today = Math.round(per * 1.4);
      ops.movesToday = today;
      before += 0;
      ops.forklifts.forEach((f) => (f.moved = Math.round((today / ops.forklifts.length) * (0.7 + r() * 0.6))));
    }
    this.palletsBefore = before;
    this.event('Early shift under way at all four sites', 'neutral');
  }

  private shipmentsTruckSoon(sh: import('./model').Shipment): void {
    // keep the scheduler from waiting the full delay used while seeding
    this.shipments.needTruck.set(sh, this.t + 20 + this.rand() * 200);
  }

  private seedDockedInbound(ops: SiteOps, d: DoorState): void {
    const r = this.rand;
    const cargo = ops.id === 'ambacang' ? (r() < 0.5 ? 'frozen' : 'produce') : ops.id === 'stasiun-tabing' ? 'parcels' : pick(['cartons', 'wrapped', 'drums'] as CargoKind[], r);
    const sh = this.shipments.createInbound(ops.id, { cargo, seedOnRoute: 0 });
    if (!sh || !sh.truck) return;
    const t = sh.truck;
    // pull it back off the road and dock it
    this.fleet.traffic.releaseAll(t);
    this.fleet.placeDocked(t, ops, d, { kind: 'deliver', shipment: sh, dest: ops.id });
    sh.stage = 4;
    sh.doneAt[2] = this.t - 900 - r() * 600;
    sh.doneAt[3] = this.t - 600 - r() * 300;
    sh.stageStart = this.t - 300;
    // part of the trailer is already unloaded (rear rows first)
    const gone = Math.floor(sh.count * (0.2 + r() * 0.5));
    for (let i = 0; i < gone; i++) {
      const p = t.cargo[i];
      if (!p) continue;
      t.cargo[i] = null;
      const si = d.stage.findIndex((x) => !x);
      if (!ops.floor && si >= 0 && r() < 0.6) {
        d.stage[si] = p;
        this.pallets.setLoc(p, { t: 'stage', door: d, i: si });
      } else {
        const slot = ops.freeSlot(p.cargo, d.L.pos);
        if (!slot) continue;
        ops.slotPallet[slot.index] = p;
        ops.stored++;
        this.pallets.setLoc(p, { t: 'slot', slot });
      }
      p.siteId = ops.id;
      p.receivedAt = this.t - r() * 600;
    }
    for (const p of t.cargo) if (p) this.pallets.place(p);
  }

  private seedDockedCollect(ops: SiteOps, d: DoorState): void {
    const sh = d.shipment!;
    const r = this.rand;
    const { variantFor } = { variantFor: (c: string) => (c === 'frozen' || c === 'produce' ? 'reefer' : c === 'parcels' ? 'box' : 'dry') as 'reefer' | 'box' | 'dry' };
    const t = this.fleet.free(variantFor(sh.cargo));
    if (!t) return;
    this.fleet.placeDocked(t, ops, d, { kind: 'collect', shipment: sh, dest: ops.id });
    sh.stage = 1;
    sh.doneAt[0] = this.t - 400;
    // some pallets already in the trailer (front rows first), some staged
    const n = Math.floor(sh.count * (0.2 + r() * 0.4));
    let ti = 19;
    let k = 0;
    for (const p of sh.pallets) {
      if (p.loc.t !== 'slot') continue;
      const slot = p.loc.slot;
      ops.slotPallet[slot.index] = null;
      ops.stored--;
      if (k < n) {
        t.cargo[ti] = p;
        this.pallets.setLoc(p, { t: 'trailer', truck: t, i: ti });
        ti--;
      } else {
        const si = d.stage.findIndex((x) => !x);
        if (si < 0) {
          ops.slotPallet[slot.index] = p;
          ops.stored++;
          break;
        }
        d.stage[si] = p;
        this.pallets.setLoc(p, { t: 'stage', door: d, i: si });
      }
      k++;
    }
  }

  // ---- stepping ------------------------------------------------------------------------------------
  private stepSim(h: number): void {
    this.t += h;
    this.shipments.step(h);
    this.fleet.step(h);
    for (const ops of this.sites.values()) ops.step(h);
  }

  private syncAll(): void {
    for (const ops of this.sites.values()) ops.syncDoorViews();
    for (const p of this.pallets.all) if (p) this.pallets.place(p);
    this.syncViews(0);
  }

  private syncViews(dt: number): void {
    this.fleet.syncViews(dt, this.time);
    for (const ops of this.sites.values()) for (const f of ops.forklifts) f.syncView(dt, this.time);
    this.pallets.frame();
  }

  update(dt: number): void {
    const t0 = performance.now();
    this.time += dt;
    if (!this.paused) {
      const simDt = Math.min(dt, 0.1) * this.speed;
      const n = Math.max(1, Math.ceil(simDt / MAX_STEP - 1e-9));
      const h = simDt / n;
      for (let i = 0; i < n; i++) this.stepSim(h);
      this.perf.steps = n;
    }
    this.syncViews(dt);
    const ms = performance.now() - t0;
    this.perf.last = ms;
    this.perf.avg = this.perf.avg * 0.95 + ms * 0.05;
    this.perf.max = Math.max(this.perf.max * 0.999, ms);
  }

  snapshot(activeSiteId: string, selection: EntityRef | null): HudSnapshot {
    return buildSnapshot(this, activeSiteId, selection);
  }

  // ---- selection helpers ----------------------------------------------------------------------------
  private tmpV: V3 = { x: 0, y: 0, z: 0 };

  getEntityPosition(ref: EntityRef, out: THREE.Vector3): boolean {
    switch (ref.kind) {
      case 'truck': {
        const t = this.fleet.get(ref.id);
        if (!t || !t.active) return false;
        out.set(t.x, 0, t.z);
        return true;
      }
      case 'forklift': {
        const f = this.sites.get(ref.id.split(':')[0])?.forklifts.find((x) => x.id === ref.id);
        if (!f) return false;
        out.set(f.x, DOCK_HEIGHT, f.z);
        return true;
      }
      case 'pallet': {
        const p = this.pallets.byId.get(ref.id);
        if (!p) return false;
        const w = this.pallets.where(p, this.tmpV);
        if (p.loc.t === 'trailer' && !w.ok) {
          const t = p.loc.truck;
          if (!t.active) return false;
        }
        if (p.loc.t === 'gone') return false;
        out.set(this.tmpV.x, this.tmpV.y, this.tmpV.z);
        return true;
      }
      case 'dock': {
        const ops = this.sites.get(ref.id.split(':')[0]);
        const d = ops?.doorById.get(ref.id);
        if (!d) return false;
        out.set(d.L.pos.x + d.L.normal.x * 1.5, 0, d.L.pos.z + d.L.normal.z * 1.5);
        return true;
      }
      case 'site': {
        const s = this.layout.siteById[ref.id];
        if (!s) return false;
        out.set(s.building.cx, 0, s.building.cz);
        return true;
      }
    }
    return false;
  }

  getEntityRadius(ref: EntityRef): number {
    switch (ref.kind) {
      case 'truck':
        return 6;
      case 'forklift':
        return 1.8;
      case 'pallet':
        return 0.9;
      case 'dock':
        return 3;
      case 'site': {
        const b = this.layout.siteById[ref.id]?.building;
        return b ? Math.hypot(b.w, b.d) / 2 : 40;
      }
    }
    return 2;
  }

  getEntityRoute(ref: EntityRef): V3[] | null {
    if (ref.kind === 'truck') {
      const t = this.fleet.get(ref.id);
      if (!t || !t.active || !t.path) return null;
      if (t.phase === 'docked' || t.phase === 'bay' || t.phase === 'hold' || t.phase === 'conn') return null;
      if (t.path.length - t.s < 0.5) return null;
      const pts = t.path.remaining(t.s, 5, 0, 260);
      // start the thread under the truck's origin rather than its tracked point
      if (t.k !== 0 && pts.length) pts[0] = { x: t.x, y: 0, z: t.z };
      return pts;
    }
    if (ref.kind === 'forklift') {
      const f = this.sites.get(ref.id.split(':')[0])?.forklifts.find((x) => x.id === ref.id);
      if (!f) return null;
      const ahead = f.routeAhead();
      if (ahead.length < 1) return null;
      const out: V3[] = [{ x: f.x, y: DOCK_HEIGHT, z: f.z }];
      for (const p of ahead) {
        const l = out[out.length - 1];
        if (Math.hypot(p.x - l.x, p.z - l.z) > 0.05) out.push({ x: p.x, y: DOCK_HEIGHT, z: p.z });
      }
      return out.length >= 2 ? out : null;
    }
    return null;
  }

  getEntityLabel(ref: EntityRef): string {
    switch (ref.kind) {
      case 'truck': {
        const t = this.fleet.get(ref.id);
        return t ? `${t.label} · ${t.carrier}` : ref.id;
      }
      case 'forklift': {
        const ops = this.sites.get(ref.id.split(':')[0]);
        const f = ops?.forklifts.find((x) => x.id === ref.id);
        return f && ops ? `${f.label} · ${ops.L.def.name}` : ref.id;
      }
      case 'pallet': {
        const p = this.pallets.byId.get(ref.id);
        return p ? `${p.id} · ${p.desc}` : ref.id;
      }
      case 'dock': {
        const ops = this.sites.get(ref.id.split(':')[0]);
        const d = ops?.doorById.get(ref.id);
        return d && ops ? `${ops.L.def.name} ${d.L.label} · ${d.L.role}` : ref.id;
      }
      case 'site':
        return this.layout.siteById[ref.id]?.def.name ?? ref.id;
    }
    return ref.id;
  }

  dayFraction(): number {
    return (((this.t % 86400) + 86400) % 86400) / 86400;
  }

  setSpeed(s: number): void {
    this.speed = s;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }
}

function productOf(c: CargoKind, r: () => number) {
  const p = product(c, r);
  return { sku: p.sku, desc: p.desc, kg: p.kg };
}

function pickN<T>(arr: T[], n: number, r: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

void TRUCK_CARGO_SLOTS;

export const createSimulation: CreateSimulation = (deps) => new Sim(deps);
