/**
 * Shipments: a steady flow between suppliers, sites and customers. Each moves through
 * picking -> loading -> transit -> arrived -> unloading -> putaway, with a due time, a live
 * ETA and an on-time / at-risk / late status.
 */
import type { CargoKind, ShipmentRow } from '../core/types';
import type { SimCore } from './core';
import { variantFor } from './fleet';
import type { DoorState, Endpoint, Shipment } from './model';
import { STAGE_KEYS, STAGE_LABELS } from './model';
import { CARGO_LABEL, CUSTOMERS, clock, pick, product, supplierFor } from './names';
import type { SiteOps, Task } from './ops';
import type { Pallet } from './pallets';
import type { Truck, TruckJob } from './truck';

const CARGO_BY_SITE: Record<string, CargoKind[]> = {
  'pasa-ateh': ['cartons', 'cartons', 'wrapped', 'drums'],
  ambacang: ['frozen', 'produce'],
  'stasiun-tabing': ['parcels', 'parcels', 'cartons'],
  'teluk-bayur': ['cartons', 'wrapped', 'parcels', 'drums'],
};

const EXT_EDGE = (name: string): 'west' | 'east' => (name.length % 2 ? 'west' : 'east');

export class ShipmentBook {
  readonly list: Shipment[] = [];
  readonly byId = new Map<string, Shipment>();
  private nextNo = 4810;
  private schedT = 0;
  private statusT = 0;
  doneToday = 0;
  /** Waiting for a truck: shipment -> time to call one. */
  readonly needTruck = new Map<Shipment, number>();

  constructor(private sim: SimCore) {}

  get open(): Shipment[] {
    return this.list.filter((s) => s.status !== 'done');
  }

  private ep(siteId: string): Endpoint {
    return { siteId, name: this.sim.layout.siteById[siteId].def.name, edge: null };
  }
  private ext(name: string): Endpoint {
    return { siteId: null, name, edge: EXT_EDGE(name) };
  }

  private make(from: Endpoint, to: Endpoint, cargo: CargoKind, plan: number, stage: number): Shipment {
    const r = this.sim.rand;
    const id = `SH-${this.nextNo}`;
    this.nextNo += 1 + Math.floor(r() * 3);
    const tight = r() < 0.2;
    const slack = tight ? -0.08 + r() * 0.14 : 0.25 + r() * 0.45;
    const t = this.sim.t;
    const doneAt: (number | undefined)[] = [undefined, undefined, undefined, undefined, undefined, undefined];
    for (let i = 0; i < stage; i++) doneAt[i] = t - (stage - i) * (300 + r() * 600);
    const sh: Shipment = {
      id,
      from,
      to,
      cargo,
      pallets: [],
      count: 0,
      done: 0,
      stage,
      doneAt,
      stageStart: t,
      createdAt: t,
      dueAt: t + plan * (1 + slack),
      etaAt: t + plan,
      status: 'on-time',
      truck: null,
      door: null,
      lateAnnounced: false,
      riskAnnounced: false,
      plan,
    };
    this.list.push(sh);
    this.byId.set(id, sh);
    return sh;
  }

  // ---- creation ---------------------------------------------------------------------------------
  /** Supplier (or another site) sends a loaded truck to `siteId`. Pallets ride in the trailer. */
  createInbound(siteId: string, opts: { seedOnRoute?: number; cargo?: CargoKind; count?: number } = {}): Shipment | null {
    const r = this.sim.rand;
    const cargo = opts.cargo ?? pick(CARGO_BY_SITE[siteId], r);
    const t = this.sim.fleet.free(variantFor(cargo));
    if (!t) return null;
    const supplier = supplierFor(cargo, r);
    const count = opts.count ?? 10 + Math.floor(r() * 11);
    const from = this.ext(supplier);
    const plan = 300 + count * 120 + 300;
    const sh = this.make(from, this.ep(siteId), cargo, plan, 2);
    for (let i = 0; i < count; i++) {
      const p = this.sim.pallets.create(
        { cargo, ...strip(product(cargo, r)), origin: supplier, siteId: null, shipment: sh, loc: { t: 'trailer', truck: t, i }, receivedAt: 0 },
        r,
      );
      if (!p) break;
      t.cargo[i] = p;
      sh.pallets.push(p);
    }
    sh.count = sh.pallets.length;
    const job: TruckJob = { kind: 'deliver', shipment: sh, dest: siteId };
    sh.truck = t;
    if (opts.seedOnRoute !== undefined) {
      t.job = job;
      const route = this.sim.yard.toHold(from.edge!, siteId);
      this.sim.fleet.enter(t, route, opts.seedOnRoute);
    } else this.sim.fleet.spawn(t, job, from.edge!);
    return sh;
  }

  /** Outbound from a storage site: pick stock to a stage lane, then a truck collects it. */
  createOutbound(siteId: string, toSite: string | null, opts: { truckIn?: number } = {}): Shipment | null {
    const ops = this.sim.sites.get(siteId)!;
    const r = this.sim.rand;
    const door = ops.doors.find((d) => d.L.role === 'outbound' && !d.shipment && !d.truck && !d.stage.some((s) => s) && !d.stageRes.some((x) => x));
    if (!door) return null;
    const cargo = pick(CARGO_BY_SITE[siteId], r);
    const want = 8 + Math.floor(r() * 11);
    const stock: Pallet[] = [];
    for (const p of ops.slotPallet) {
      if (p && !p.busy && !p.shipment && p.cargo === cargo) stock.push(p);
    }
    if (stock.length < 6) return null;
    // take a cluster near the door, with some spread
    stock.sort((a, b) => dist(a, door) - dist(b, door) + (r() - 0.5) * 30);
    const pallets = stock.slice(0, Math.min(want, stock.length));
    const to = toSite ? this.ep(toSite) : this.ext(pick(CUSTOMERS, r));
    const plan = pallets.length * 85 + 300 + 360 + (toSite ? pallets.length * 110 : 0);
    const sh = this.make(this.ep(siteId), to, cargo, plan, 0);
    for (const p of pallets) p.shipment = sh;
    sh.pallets = pallets;
    sh.count = pallets.length;
    sh.door = door;
    door.shipment = sh;
    this.needTruck.set(sh, this.sim.t + (opts.truckIn ?? 90 + r() * 200));
    this.sim.event(`Picking started for ${sh.id} at ${ops.L.def.name}, ${sh.count} pallets`, 'neutral', siteId);
    return sh;
  }

  /** Cross-dock: pallets that just landed on the Teluk Bayur floor go straight back out. */
  crossDock(ops: SiteOps, pallets: Pallet[], cargo: CargoKind, truckIn?: number): Shipment {
    const r = this.sim.rand;
    const toSite = r() < 0.35 ? pick(['pasa-ateh', 'stasiun-tabing'], r) : null;
    const to = toSite ? this.ep(toSite) : this.ext(pick(CUSTOMERS, r));
    const plan = pallets.length * 95 + 900;
    const sh = this.make(this.ep(ops.id), to, cargo, plan, 1);
    for (const p of pallets) p.shipment = sh;
    sh.pallets = pallets;
    sh.count = pallets.length;
    this.needTruck.set(sh, this.sim.t + (truckIn ?? 30 + r() * 120));
    return sh;
  }

  // ---- lifecycle hooks -----------------------------------------------------------------------------
  private advance(sh: Shipment, to: number): void {
    const t = this.sim.t;
    while (sh.stage < to) {
      if (sh.doneAt[sh.stage] === undefined) sh.doneAt[sh.stage] = t;
      sh.stage++;
    }
    sh.stageStart = t;
    if (sh.stage >= 6) this.complete(sh);
  }

  private complete(sh: Shipment): void {
    if (sh.status === 'done') return;
    sh.status = 'done';
    sh.stage = 6;
    this.doneToday++;
    for (const p of sh.pallets) if (p.shipment === sh) p.shipment = null;
    const late = this.sim.t > sh.dueAt;
    const where = sh.to.siteId ? `put away at ${sh.to.name}` : `delivered to ${sh.to.name}`;
    this.sim.event(`${sh.id} ${where}${late ? ', late' : ''}`, late ? 'warn' : 'good', sh.to.siteId ?? sh.from.siteId ?? undefined);
    if (sh.door && sh.door.shipment === sh) sh.door.shipment = null;
  }

  workStart(sh: Shipment, t: Truck): void {
    if (t.job.kind === 'deliver') this.advance(sh, 4);
    else this.advance(sh, 1);
  }

  workDone(sh: Shipment, t: Truck): void {
    const ops = t.site!;
    if (t.job.kind === 'deliver') {
      this.advance(sh, 5);
      for (const p of sh.pallets) p.receivedAt = this.sim.t;
      if (ops.floor) {
        const pallets = sh.pallets.slice();
        this.advance(sh, 6);
        this.crossDock(ops, pallets, sh.cargo);
      } else this.checkPutaway(sh);
    } else {
      this.advance(sh, 1);
    }
  }

  departed(sh: Shipment, t: Truck): void {
    this.advance(sh, 2);
    if (sh.door && sh.door.shipment === sh) sh.door.shipment = null;
    sh.door = null;
    sh.truck = t;
    this.sim.event(`${sh.id} left ${sh.from.name} for ${sh.to.siteId ? sh.to.name : sh.to.name}`, 'active', sh.from.siteId ?? undefined, { kind: 'truck', id: t.id });
  }

  arrived(sh: Shipment): void {
    this.advance(sh, 3);
  }

  delivered(sh: Shipment, t: Truck): void {
    void t;
    this.advance(sh, 6);
  }

  onMove(ops: SiteOps, k: Task): void {
    const sh = k.pallet.shipment;
    if (!sh) return;
    if (k.kind === 'putaway' || (k.kind === 'unload' && k.dst.t === 'slot' && !ops.floor)) this.checkPutaway(sh);
  }

  private checkPutaway(sh: Shipment): void {
    if (sh.stage !== 5) return;
    for (const p of sh.pallets) if (p.loc.t !== 'slot') return;
    this.advance(sh, 6);
  }

  /** A truck just finished at `ops`: is there a load waiting elsewhere? */
  nextJobFor(t: Truck, ops: SiteOps): TruckJob | null {
    for (const [sh, at] of this.needTruck) {
      if (sh.truck || at > this.sim.t + 900) continue;
      if (sh.from.siteId === ops.id) continue;
      if (variantFor(sh.cargo) !== t.variant) continue;
      this.needTruck.delete(sh);
      return { kind: 'collect', shipment: sh, dest: sh.from.siteId! };
    }
    return null;
  }

  // ---- scheduler + status ---------------------------------------------------------------------------
  step(dt: number): void {
    const t = this.sim.t;
    for (const [sh, at] of this.needTruck) {
      if (sh.truck) {
        this.needTruck.delete(sh);
        continue;
      }
      if (t >= at) {
        this.sim.fleet.shipmentNeedsTruck(sh);
        if (sh.truck) this.needTruck.delete(sh);
        else this.needTruck.set(sh, t + 30);
      }
    }
    this.schedT -= dt;
    if (this.schedT <= 0) {
      this.schedT = 20;
      this.schedule();
    }
    this.statusT -= dt;
    if (this.statusT <= 0) {
      this.statusT = 2;
      for (const sh of this.list) this.updateStatus(sh);
      // forget old completed shipments
      for (let i = 0; i < this.list.length; i++) {
        const sh = this.list[i];
        if (sh.status === 'done' && t - (sh.doneAt[5] ?? t) > 1800) {
          this.list.splice(i--, 1);
          this.byId.delete(sh.id);
        }
      }
    }
  }

  private schedule(): void {
    const r = this.sim.rand;
    const open = this.open.length;
    if (open >= 20) return;
    for (const ops of this.sim.sites.values()) {
      const id = ops.id;
      const inOpen = this.list.filter((s) => s.to.siteId === id && s.status !== 'done' && s.stage <= 4).length;
      const outOpen = this.list.filter((s) => s.from.siteId === id && s.status !== 'done' && s.stage <= 1).length;
      const inDoors = ops.doors.filter((d) => d.L.role === 'inbound').length;
      const outDoors = ops.doors.filter((d) => d.L.role === 'outbound').length;
      if (ops.floor) {
        const freeFloor = ops.L.slots.length - ops.slotPallet.filter((p) => p).length;
        if (inOpen < Math.min(3, inDoors) && freeFloor > 34 && r() < 0.6) this.createInbound(id);
        continue;
      }
      const fill = ops.stored / Math.max(1, ops.L.slots.length);
      let inT = fill > 0.72 ? 1 : fill > 0.66 ? inDoors - 1 : inDoors + 1;
      let outT = Math.max(1, Math.round(outDoors * (fill > 0.66 ? 0.9 : 0.6)));
      if (fill < 0.48) outT--;
      if (inOpen < inT && r() < 0.55) {
        // some inbound comes as a transfer from another site
        const others = ['pasa-ateh', 'stasiun-tabing', 'ambacang'].filter((s) => s !== id && CARGO_BY_SITE[s].some((c) => CARGO_BY_SITE[id].includes(c)));
        if (others.length && r() < 0.25) this.createOutbound(pick(others, r), id);
        else this.createInbound(id);
      }
      if (outOpen < outT && r() < 0.55) this.createOutbound(id, r() < 0.2 ? 'teluk-bayur' : null);
    }
  }

  private estimate(sh: Shipment): number {
    let est = 0;
    const n = sh.count;
    let staged = 0;
    let inTrailer = 0;
    let inSlot = 0;
    for (const p of sh.pallets) {
      if (p.loc.t === 'stage') staged++;
      else if (p.loc.t === 'trailer') inTrailer++;
      else if (p.loc.t === 'slot') inSlot++;
    }
    const fleet = this.sim.fleet;
    const tr = sh.truck;
    if (sh.stage === 0) est += Math.max(0, Math.min(n, 6) - staged) * 35;
    if (sh.stage <= 1) {
      est += (n - inTrailer) * 40;
      if (!tr) est += 420;
      else if (tr.phase === 'highway' || tr.phase === 'hold' || tr.phase === 'bay') est += fleet.remaining(tr) / 12 + 120;
    }
    if (sh.stage <= 2) {
      if (sh.stage === 2 && tr) est += fleet.remaining(tr) / 13 + 30;
      else est += sh.to.siteId ? 160 : 90;
    }
    if (sh.to.siteId) {
      if (sh.stage <= 3) est += tr && (tr.phase === 'hold' || tr.phase === 'bay' || tr.phase === 'conn') ? 300 : 120;
      if (sh.stage <= 4) est += (sh.stage === 4 ? inTrailer : n) * 38;
      if (sh.stage <= 5 && !this.sim.sites.get(sh.to.siteId)?.floor) est += (n - inSlot) * 30;
    }
    return est;
  }

  private updateStatus(sh: Shipment): void {
    if (sh.status === 'done') return;
    const t = this.sim.t;
    const eta = t + this.estimate(sh);
    // smooth so the ETA does not jitter
    sh.etaAt = sh.etaAt + (eta - sh.etaAt) * 0.35;
    const prev = sh.status;
    if (sh.etaAt > sh.dueAt + 60) sh.status = 'late';
    else if (sh.etaAt > sh.dueAt - 420) sh.status = 'at-risk';
    else sh.status = 'on-time';
    const site = sh.to.siteId ?? sh.from.siteId ?? undefined;
    const ref = sh.truck ? { kind: 'truck' as const, id: sh.truck.id } : undefined;
    if (sh.status === 'late' && prev !== 'late' && !sh.lateAnnounced) {
      sh.lateAnnounced = true;
      this.sim.event(`Shipment ${sh.id} is running late, ETA ${clock(sh.etaAt)}`, 'alert', site, ref);
    } else if (sh.status === 'at-risk' && prev === 'on-time' && !sh.riskAnnounced) {
      sh.riskAnnounced = true;
      this.sim.event(`Shipment ${sh.id} is at risk, due ${clock(sh.dueAt)}`, 'warn', site, ref);
    }
  }

  stageProgress(sh: Shipment): number {
    if (sh.status === 'done') return 1;
    const n = Math.max(1, sh.count);
    let staged = 0;
    let inTrailer = 0;
    let inSlot = 0;
    for (const p of sh.pallets) {
      if (p.loc.t === 'stage') staged++;
      else if (p.loc.t === 'trailer') inTrailer++;
      else if (p.loc.t === 'slot') inSlot++;
    }
    switch (sh.stage) {
      case 0:
        return Math.min(1, staged / Math.min(n, 6));
      case 1:
        return inTrailer / n;
      case 2: {
        const tr = sh.truck;
        if (!tr || !tr.path) return 0;
        return Math.min(1, tr.s / Math.max(1, tr.yardS || tr.path.length));
      }
      case 3:
        return 0.5;
      case 4:
        return 1 - inTrailer / n;
      case 5:
        return inSlot / n;
      default:
        return 1;
    }
  }

  row(sh: Shipment): ShipmentRow {
    const sp = this.stageProgress(sh);
    return {
      id: sh.id,
      fromSiteId: sh.from.siteId ?? sh.from.name,
      toSiteId: sh.to.siteId ?? sh.to.name,
      cargo: sh.cargo,
      cargoLabel: CARGO_LABEL[sh.cargo],
      pallets: sh.count,
      palletsDone: this.palletsDone(sh),
      stage: sh.stage,
      stages: STAGE_KEYS.map((key, i) => ({ key, label: STAGE_LABELS[key], doneAt: sh.doneAt[i] })),
      dueAt: sh.dueAt,
      etaAt: sh.status === 'done' ? (sh.doneAt[5] ?? sh.etaAt) : sh.etaAt,
      status: sh.status,
      truckId: sh.truck?.active ? sh.truck.id : undefined,
      progress: Math.min(1, (Math.min(sh.stage, 6) + (sh.stage >= 6 ? 0 : sp)) / 6),
      stageProgress: sp,
    };
  }

  palletsDone(sh: Shipment): number {
    if (sh.status === 'done') return sh.count;
    const sp = this.stageProgress(sh);
    return sh.stage === 2 || sh.stage === 3 ? sh.count : Math.round(sp * sh.count);
  }

  /** Doors staging for a shipment (for the dock card). */
  doorShipment(d: DoorState): Shipment | null {
    return d.truck?.job.shipment ?? d.shipment;
  }
}

function strip(p: { sku: string; desc: string; kg: number }) {
  return { sku: p.sku, desc: p.desc, kg: p.kg };
}

function dist(p: Pallet, d: DoorState): number {
  const l = p.loc;
  if (l.t !== 'slot') return 1e9;
  return Math.abs(l.slot.pos.x - d.L.pos.x) + Math.abs(l.slot.pos.z - d.L.pos.z);
}
