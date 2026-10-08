/**
 * Truck fleet: a fixed pool of liveried trucks that cycle on and off the map. Handles the
 * truck lifecycle (highway, gate, queue bay, reverse into the dock, work, pull out, leave) and
 * the per-site yard dispatcher that hands free doors to waiting trucks.
 */
import * as THREE from 'three';
import type { VehicleFactory } from '../core/contracts';
import type { TruckVariant } from '../core/types';
import type { SimCore } from './core';
import type { DoorState, Shipment } from './model';
import { CAB_COLORS, CARRIERS, COLD_CARRIERS, PARCEL_CARRIERS, pick } from './names';
import type { SiteOps } from './ops';
import type { Path } from './path';
import { Traffic, type ExplicitReq } from './traffic';
import { Truck, type TruckJob } from './truck';
import { K_REAR, concatRoutes, routePath, type QueueBay, type Route } from './yard';

export const variantFor = (cargo: string): TruckVariant => (cargo === 'frozen' || cargo === 'produce' ? 'reefer' : cargo === 'parcels' ? 'box' : 'dry');

export class Fleet {
  readonly trucks: Truck[] = [];
  readonly traffic: Traffic;
  private dispatchT = 0;
  private spawnQueue: { t: Truck; job: TruckJob; edge: 'west' | 'east' }[] = [];

  constructor(
    private sim: SimCore,
    vehicles: VehicleFactory,
    scene: THREE.Scene,
  ) {
    const r = sim.rand;
    const codes = sim.layout.sites.map((s) => s.def.code);
    const used = new Set<string>();
    const mk = (variant: TruckVariant, carriers: string[], n: number) => {
      for (let i = 0; i < n; i++) {
        let label = '';
        do label = `${pick(codes, r)}-${100 + Math.floor(r() * 880)}`;
        while (used.has(label));
        used.add(label);
        const carrier = pick(carriers, r);
        const cab = variant === 'reefer' ? pick([0x2147d9, 0x13296e, 0x6cb8f0], r) : pick(CAB_COLORS, r);
        const view = vehicles.createTruck({ variant, cabColor: cab, carrier, label, trailerColor: variant === 'reefer' ? 0xf4fbff : undefined });
        view.object.userData.pick = { kind: 'truck', id: label };
        view.object.visible = false;
        scene.add(view.object);
        this.trucks.push(new Truck(label, label, carrier, variant, cab, view));
      }
    };
    mk('dry', CARRIERS, 30);
    mk('reefer', COLD_CARRIERS, 14);
    mk('box', PARCEL_CARRIERS, 10);
    this.traffic = new Traffic(this.trucks, sim.yard.staticZones);
  }

  get(id: string): Truck | undefined {
    return this.trucks.find((t) => t.id === id);
  }

  free(variant: TruckVariant): Truck | null {
    const pool = this.trucks.filter((t) => t.phase === 'off' && t.variant === variant && !this.spawnQueue.some((q) => q.t === t));
    return pool.length ? pick(pool, this.sim.rand) : null;
  }

  // ---- spawning ------------------------------------------------------------------------------
  /** Bring a truck onto the map at an edge with a job (deliver or collect at a site). */
  spawn(t: Truck, job: TruckJob, edge: 'west' | 'east'): void {
    t.job = job;
    if (job.shipment && job.kind === 'deliver') job.shipment.truck = t;
    if (job.shipment && job.kind === 'collect') job.shipment.truck = t;
    this.spawnQueue.push({ t, job, edge });
    t.phase = 'off';
  }

  private trySpawn(): void {
    for (let i = 0; i < this.spawnQueue.length; i++) {
      const q = this.spawnQueue[i];
      const route = this.sim.yard.toHold(q.edge, q.job.dest);
      const start = route.pts[0];
      let clear = true;
      for (const o of this.trucks) {
        if (!o.active) continue;
        if (Math.hypot(o.x - start.x, o.z - start.z) < 30) {
          clear = false;
          break;
        }
      }
      if (!clear) continue;
      this.spawnQueue.splice(i--, 1);
      this.enter(q.t, route, 0);
    }
  }

  /** Put a truck on a highway route at fraction `frac` (used by the start-up seeding). */
  enter(t: Truck, route: Route, s: number): boolean {
    if (s < 0) {
      // a clear spot somewhere along the route (start-up seeding)
      const p = routePath(route);
      const pose = { x: 0, z: 0, h: 0 };
      let ok = -1;
      for (let i = 0; i < 12 && ok < 0; i++) {
        const cand = p.length * (0.12 + this.sim.rand() * 0.7);
        p.pose(cand, pose);
        if (this.trucks.every((o) => !o.active || Math.hypot(o.x - pose.x, o.z - pose.z) > 40)) ok = cand;
      }
      s = ok < 0 ? 0 : ok;
    }
    t.phase = 'highway';
    t.site = this.sim.sites.get(t.job.dest) ?? null;
    t.decided = false;
    t.route = route;
    t.door = null;
    t.bay = -1;
    t.waitSince = this.sim.t;
    const path = routePath(route);
    t.s = s;
    this.traffic.setPath(t, path, 1, 0, [], true);
    t.v = Math.min(path.speedAt(s), 12);
    t.onArrive = () => this.arriveHold(t);
    t.yardS = path.length;
    t.trips++;
    return true;
  }

  // ---- per step -------------------------------------------------------------------------------
  step(dt: number): void {
    this.trySpawn();
    for (const t of this.trucks) {
      if (!t.active) continue;
      if (t.phase === 'docked' || t.phase === 'bay' || t.phase === 'conn' || t.phase === 'hold') {
        t.v = 0;
        t.braking = true;
        continue;
      }
      if (t.phase === 'highway' && t.site && !t.decided && t.path && t.path.length - t.s < 110) this.maybeDecide(t);
      const arrived = this.traffic.step(t, dt);
      if (t.phase === 'pullout' && t.door && t.s >= t.door.geo.pullRelease) this.leaveDoor(t);
      if (arrived && t.onArrive) {
        const f = t.onArrive;
        t.onArrive = null;
        f();
      }
    }
    this.dispatchT -= dt;
    if (this.dispatchT <= 0) {
      this.dispatchT = 0.5;
      for (const ops of this.sim.sites.values()) this.dispatch(ops);
    }
  }

  // ---- arrival decisions ------------------------------------------------------------------------
  private isFront(t: Truck, ops: SiteOps): boolean {
    if (ops.holdLine.length && ops.holdLine[0] !== t) return false;
    const rem = t.path ? t.path.length - t.s : 0;
    for (const o of this.trucks) {
      if (o === t || !o.active || o.site !== ops) continue;
      if (o.phase === 'highway' && !o.decided && o.path && o.path.length - o.s < rem) return false;
    }
    return true;
  }

  private role(t: Truck): 'inbound' | 'outbound' {
    return t.job.kind === 'collect' ? 'outbound' : 'inbound';
  }

  /** Doors this truck may use right now. */
  private doorsFor(t: Truck, ops: SiteOps): DoorState[] {
    const role = this.role(t);
    const sh = t.job.shipment;
    if (role === 'outbound' && sh && sh.door && sh.door.siteId === ops.id) return !sh.door.truck ? [sh.door] : [];
    return ops.doors.filter((d) => d.L.role === role && !d.truck && !(role === 'outbound' && d.shipment && d.shipment !== sh));
  }

  private doorsAllFor(t: Truck, ops: SiteOps): DoorState[] {
    const role = this.role(t);
    const sh = t.job.shipment;
    if (role === 'outbound' && sh && sh.door && sh.door.siteId === ops.id) return [sh.door];
    return ops.doors.filter((d) => d.L.role === role);
  }

  private maybeDecide(t: Truck): void {
    const ops = t.site!;
    if (!this.isFront(t, ops)) return;
    t.decided = true;
    if (t.job.shipment && t.job.shipment.stage === 2) this.sim.shipments.arrived(t.job.shipment);
    this.sim.event(`${t.carrier} ${t.label} arrived at ${ops.L.def.name}`, 'neutral', ops.id, { kind: 'truck', id: t.id });
    if (this.routeFromHold(t, ops, true)) return;
    // keep the path ending at the hold point
    t.onArrive = () => this.arriveHold(t);
  }

  /** Try to send a truck at (or approaching) the hold point to a door, bay or the connector. */
  private routeFromHold(t: Truck, ops: SiteOps, extend: boolean): boolean {
    const y = this.sim.yard;
    const free = this.doorsFor(t, ops);
    const base = extend && t.route ? t.route : null;
    const doorOK = free.filter((d) => this.doorAllowed(t, ops, d));
    if (doorOK.length) {
      const d = pick(doorOK, this.sim.rand);
      const r = y.holdToDoor(ops.id, d.L.id);
      this.goDoor(t, ops, d, base ? concatRoutes(base, r) : r, !!base);
      return true;
    }
    const north = this.doorsAllFor(t, ops).some((d) => d.L.side === 'N');
    if (north && ops.yard.connHold) {
      if (ops.connLine.length < 3) {
        const r = y.holdToConnector(ops.id);
        this.drive(t, base ? concatRoutes(base, r) : r, !!base, []);
        t.phase = 'toConn';
        ops.connLine.push(t);
        t.onArrive = () => {
          t.phase = 'conn';
          t.waitSince = this.sim.t;
        };
        return true;
      }
      return false;
    }
    const bi = this.freeBay(t, ops);
    if (bi >= 0) {
      const bay = ops.yard.bays[bi];
      ops.bays[bi] = t;
      t.bay = bi;
      const r = y.holdToBay(ops.id, bay);
      const zone = y.bayEntryZone(ops.id, bay);
      const full = base ? concatRoutes(base, r) : r;
      this.drive(t, full, !!base, zone ? [{ zone, sRelease: Infinity }] : []);
      t.phase = 'toBay';
      t.onArrive = () => {
        t.phase = 'bay';
        t.waitSince = this.sim.t;
        this.traffic.releaseAll(t);
        this.sim.event(`${t.label} waiting in the yard at ${ops.L.def.name} for a door`, 'neutral', ops.id, { kind: 'truck', id: t.id });
      };
      return true;
    }
    return false;
  }

  private doorAllowed(t: Truck, ops: SiteOps, d: DoorState): boolean {
    void t;
    void ops;
    return !d.truck;
  }

  private freeBay(t: Truck, ops: SiteOps): number {
    const doors = this.doorsAllFor(t, ops);
    for (let i = 0; i < ops.bays.length; i++) {
      if (ops.bays[i]) continue;
      const bay = ops.yard.bays[i];
      if (!doors.some((d) => d.L.pos.x <= bay.reachX)) continue;
      // lane-entry bays need the bay just east of them empty for the S-curve
      return i;
    }
    return -1;
  }

  private drive(t: Truck, route: Route, keepS: boolean, explicit: ExplicitReq[], endSpeed = 0): Path {
    const path = routePath(route, endSpeed);
    if (!keepS) t.s = 0;
    t.route = route;
    this.traffic.setPath(t, path, 1, 0, explicit, keepS);
    return path;
  }

  private goDoor(t: Truck, ops: SiteOps, d: DoorState, route: Route, keepS: boolean): void {
    d.truck = t;
    d.state = 'reserved';
    t.door = d;
    if (!keepS) t.yardS = 0;
    this.drive(t, route, keepS, [{ zone: d.geo.dockZone, sRelease: Infinity }]);
    t.phase = 'toDoor';
    t.onArrive = () => this.startReverse(t);
    void ops;
  }

  private arriveHold(t: Truck): void {
    const ops = t.site;
    if (!ops) return;
    t.phase = 'hold';
    t.waitSince = this.sim.t;
    if (!ops.holdLine.includes(t)) ops.holdLine.push(t);
    if (!t.decided) {
      t.decided = true;
      if (t.job.shipment && t.job.shipment.stage === 2) this.sim.shipments.arrived(t.job.shipment);
    }
    this.sim.event(`${t.label} holding at the ${ops.L.def.name} gate, yard is full`, 'warn', ops.id, { kind: 'truck', id: t.id });
  }

  // ---- dispatcher -----------------------------------------------------------------------------------
  private dispatch(ops: SiteOps): void {
    const y = this.sim.yard;
    // trucks waiting in bays, in arrival order
    const waiting: Truck[] = [];
    for (const t of ops.bays) if (t && t.phase === 'bay') waiting.push(t);
    waiting.sort((a, b) => a.waitSince - b.waitSince);
    for (const t of waiting) {
      const bay = ops.yard.bays[t.bay];
      const free = this.doorsFor(t, ops).filter((d) => d.L.pos.x <= bay.reachX);
      if (!free.length) continue;
      const d = free.reduce((a, b) => (Math.abs(a.L.pos.x - bay.reachX) < Math.abs(b.L.pos.x - bay.reachX) ? a : b));
      const r = y.bayToDoor(ops.id, bay, d.L.id);
      d.truck = t;
      t.door = d;
      this.drive(t, r, false, [
        { zone: y.bayExitZone(ops.id, bay, d.L.id), sEnter: 0, sRelease: 24 },
        { zone: d.geo.dockZone, sRelease: Infinity },
      ]);
      t.yardS = 0;
      ops.bays[t.bay] = null;
      t.bay = -1;
      t.phase = 'toDoor';
      t.onArrive = () => this.startReverse(t);
    }
    // connector line (north docks): only the front truck can move
    const front = ops.connLine[0];
    if (front && front.phase === 'conn') {
      const free = this.doorsFor(front, ops);
      if (free.length) {
        const d = pick(free, this.sim.rand);
        ops.connLine.shift();
        d.truck = front;
        front.door = d;
        this.drive(front, y.connectorToDoor(ops.id, d.L.id), false, [{ zone: d.geo.dockZone, sRelease: Infinity }]);
        front.yardS = 0;
        front.phase = 'toDoor';
        front.onArrive = () => this.startReverse(front);
      }
    }
    // the truck holding at the gate
    const h = ops.holdLine[0];
    if (h && h.phase === 'hold') {
      if (this.routeFromHold(h, ops, false)) ops.holdLine.shift();
    }
  }

  // ---- docking ----------------------------------------------------------------------------------------
  private startReverse(t: Truck): void {
    const d = t.door!;
    t.phase = 'reversing';
    const path = routePath(d.geo.reverse);
    t.s = 0;
    this.traffic.setPath(t, path, -1, K_REAR, [{ zone: d.geo.dockZone, sEnter: 0, sRelease: Infinity }]);
    t.onArrive = () => this.docked(t);
  }

  private docked(t: Truck): void {
    const d = t.door!;
    this.traffic.releaseAll(t);
    t.phase = 'docked';
    t.dockStep = 'opening';
    t.arrivedAt = this.sim.t;
    t.path = null;
    t.v = 0;
    // settle exactly on the dock pose
    t.placeAt(d.L.dockPos.x, d.L.dockPos.z, d.L.dockHeading);
    d.turns++;
    d.lastTruck = t.label;
    this.sim.event(`${t.carrier} ${t.label} docked at ${d.L.label}`, 'active', t.site?.id, { kind: 'truck', id: t.id });
  }

  onWorkStart(t: Truck): void {
    const sh = t.job.shipment;
    if (sh) this.sim.shipments.workStart(sh, t);
  }

  onWorkDone(t: Truck): void {
    const sh = t.job.shipment;
    if (sh) this.sim.shipments.workDone(sh, t);
  }

  /** Doors are shut: plan the next leg and pull out. */
  depart(t: Truck): void {
    const d = t.door!;
    const ops = t.site!;
    const sh = t.job.shipment;
    let job: TruckJob;
    if (t.job.kind === 'collect' && sh) {
      job = { kind: 'deliver', shipment: sh, dest: sh.to.siteId ?? sh.to.edge ?? 'east' };
      this.sim.shipments.departed(sh, t);
    } else {
      job = this.sim.shipments.nextJobFor(t, ops) ?? { kind: 'leave', shipment: null, dest: ops.L.building.cx < 0 ? 'west' : 'east' };
      if (job.shipment) job.shipment.truck = t;
    }
    t.lastSiteId = ops.id;
    t.job = job;
    const dep = this.sim.yard.departure(ops.id, d.L.id, job.dest);
    t.s = 0;
    t.phase = 'pullout';
    if (dep.pull) {
      // swing out led by the trailer axles, then carry on along the route without stopping
      const path = routePath(dep.pull, 2);
      t.route = dep.pull;
      this.traffic.setPath(t, path, 1, K_REAR, [{ zone: d.geo.pullZone, sEnter: 0, sRelease: Infinity }]);
      t.onArrive = () => {
        const v = t.v;
        this.drive(t, dep.route, false, []);
        t.v = v;
        this.leaveDoor(t);
        t.onArrive = () => this.arriveEnd(t);
      };
    } else {
      this.drive(t, dep.route, false, [{ zone: d.geo.pullZone, sEnter: 0, sRelease: d.geo.pullRelease }]);
      t.onArrive = () => this.arriveEnd(t);
    }
    const where = job.dest === 'west' || job.dest === 'east' ? 'the highway' : this.sim.layout.siteById[job.dest].def.name;
    this.sim.event(`${t.label} pulled out of ${d.L.label}, heading to ${where}`, 'good', ops.id, { kind: 'truck', id: t.id });
  }

  private leaveDoor(t: Truck): void {
    const d = t.door!;
    if (d.truck === t) {
      d.truck = null;
      d.state = 'idle';
    }
    t.door = null;
    const dest = this.sim.sites.get(t.job.dest) ?? null;
    t.site = dest;
    t.decided = false;
    t.phase = dest ? 'highway' : 'leaving';
    t.yardS = 0;
  }

  /** End of the current route: a site's hold point, or a map edge. */
  private arriveEnd(t: Truck): void {
    if (t.site) {
      this.arriveHold(t);
      return;
    }
    // off the map
    const sh = t.job.shipment;
    if (sh) this.sim.shipments.delivered(sh, t);
    for (let i = 0; i < 20; i++) {
      const p = t.cargo[i];
      if (p) this.sim.pallets.remove(p);
      t.cargo[i] = null;
      t.cargoRes[i] = false;
    }
    this.traffic.releaseAll(t);
    t.phase = 'off';
    t.path = null;
    t.site = null;
    t.view.object.visible = false;
  }

  // ---- seeding -------------------------------------------------------------------------------------
  /** Place a truck already docked and working at a door. */
  placeDocked(t: Truck, ops: SiteOps, d: DoorState, job: TruckJob): void {
    t.job = job;
    t.site = ops;
    t.door = d;
    d.truck = t;
    t.phase = 'docked';
    t.dockStep = 'working';
    t.rearDoors = 1;
    d.open = 1;
    t.arrivedAt = this.sim.t - 300 - this.sim.rand() * 900;
    t.dockT = t.arrivedAt + 60;
    t.decided = true;
    t.placeAt(d.L.dockPos.x, d.L.dockPos.z, d.L.dockHeading);
    d.turns++;
    d.lastTruck = t.label;
    if (job.shipment) job.shipment.truck = t;
  }

  /** Park a truck in a queue bay. */
  placeInBay(t: Truck, ops: SiteOps, bi: number, job: TruckJob): void {
    const bay: QueueBay = ops.yard.bays[bi];
    t.job = job;
    t.site = ops;
    t.decided = true;
    t.phase = 'bay';
    t.bay = bi;
    ops.bays[bi] = t;
    t.waitSince = this.sim.t - 120;
    t.placeAt(bay.pos.x, bay.pos.z, bay.heading);
    if (job.shipment) job.shipment.truck = t;
  }

  /** Remaining distance to the end of the current route, for ETAs. */
  remaining(t: Truck): number {
    return t.path ? Math.max(0, t.path.length - t.s) : 0;
  }

  shipmentNeedsTruck(sh: Shipment): void {
    const v = variantFor(sh.cargo);
    const t = this.free(v);
    if (!t) return;
    const site = this.sim.layout.siteById[sh.from.siteId!];
    const edge = site.building.cx + (this.sim.rand() - 0.5) * 400 < 0 ? 'west' : 'east';
    this.spawn(t, { kind: 'collect', shipment: sh, dest: sh.from.siteId! }, edge);
  }

  syncViews(dt: number, time: number): void {
    for (const t of this.trucks) {
      if (!t.active) {
        if (t.view.object.visible) t.view.object.visible = false;
        continue;
      }
      t.syncView(dt, time, true);
    }
  }
}
