/**
 * Truck agent motion core: follows a Path with a tracked point (origin or near the rear axles
 * when reversing), keeps its distance from other trucks by probing its own future footprint,
 * and reserves zones (junctions, manoeuvre sweeps) before entering them.
 */
import type { TruckView } from '../core/contracts';
import { clamp, damp } from '../core/geom';
import type { TruckState, TruckVariant } from '../core/types';
import type { Path } from './path';
import type { DoorState, Shipment, SiteOps } from './model';
import type { Pallet } from './pallets';
import { HALF_L, HALF_W } from './yard';
import { Zone, makeObb, setObb, type OBB } from './zones';

export interface ZoneReq {
  zone: Zone;
  /** Path distance where the body first touches the zone. */
  sEnter: number;
  /** Release once s passes this (Infinity = released explicitly). */
  sRelease: number;
  /** Body pose just after leaving (for the keep-the-box-clear rule); NaN if none. */
  sExit: number;
}

export type TruckPhase =
  | 'off' // off the map
  | 'highway' // driving toward a site hold point, or to a map edge
  | 'hold' // stopped at the hold point outside the gate
  | 'toBay'
  | 'bay'
  | 'toConn'
  | 'conn'
  | 'toDoor'
  | 'reversing'
  | 'docked'
  | 'pullout'
  | 'leaving';

export type DockStep = 'opening' | 'working' | 'closing' | 'ready';

export interface TruckJob {
  kind: 'deliver' | 'collect' | 'leave';
  shipment: Shipment | null;
  /** Site id, or 'west' / 'east'. */
  dest: string;
}

export class Truck {
  // ---- identity
  view: TruckView;
  // ---- motion
  path: Path | null = null;
  s = 0;
  v = 0;
  dir = 1;
  k = 0;
  reqs: ZoneReq[] = [];
  x = 0;
  z = 0;
  h = 0;
  body: OBB = makeObb();
  wheel = 0;
  blockedT = 0;
  blockedBy: Truck | null = null;
  zoneWhy = '';
  zoneBy: Truck | null = null;
  ghost = 0;
  braking = false;
  // ---- plan
  phase: TruckPhase = 'off';
  job: TruckJob = { kind: 'leave', shipment: null, dest: 'east' };
  site: SiteOps | null = null;
  door: DoorState | null = null;
  bay: number = -1;
  dockStep: DockStep = 'opening';
  dockT = 0;
  rearDoors = 0;
  /** Time the truck started waiting (queue, hold, at dock). */
  waitSince = 0;
  arrivedAt = 0;
  decided = false;
  /** Trailer contents by cargo slot. */
  cargo: (Pallet | null)[] = new Array(20).fill(null);
  cargoRes: boolean[] = new Array(20).fill(false);
  /** Pallets planned for this trip (deliver) or to load (collect). */
  planned = 0;
  moved = 0;
  /** Distance travelled on the current route since the last route change (for ETA). */
  route: import('./yard').Route | null = null;
  onArrive: (() => void) | null = null;
  lastSiteId: string | null = null;
  /** Path distance where the current route enters the destination yard (0 = already in it). */
  yardS = 0;
  trips = 0;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly carrier: string,
    readonly variant: TruckVariant,
    readonly cabColor: number,
    view: TruckView,
  ) {
    this.view = view;
  }

  get active(): boolean {
    return this.phase !== 'off';
  }

  get loadFraction(): number {
    let n = 0;
    for (const c of this.cargo) if (c) n++;
    return n / 20;
  }

  get cargoCount(): number {
    let n = 0;
    for (const c of this.cargo) if (c) n++;
    return n;
  }

  hudState(): TruckState {
    switch (this.phase) {
      case 'highway':
        return this.job.kind === 'leave' && !this.site ? 'leaving' : 'en-route';
      case 'leaving':
        return 'leaving';
      case 'hold':
      case 'bay':
      case 'conn':
      case 'toBay':
      case 'toConn':
        return 'queued';
      case 'toDoor':
      case 'reversing':
        return 'docking';
      case 'docked':
        return this.dockStep === 'ready' ? 'departing' : 'at-dock';
      case 'pullout':
        return 'departing';
      default:
        return 'en-route';
    }
  }

  /** Place the truck at a pose with no path. */
  placeAt(x: number, z: number, h: number): void {
    this.x = x;
    this.z = z;
    this.h = h;
    this.path = null;
    this.v = 0;
    this.updateBody();
  }

  updateBody(): void {
    setObb(this.body, this.x, this.z, this.h, HALF_L, HALF_L, HALF_W);
  }

  /** Recompute pose from the path. */
  poseFromPath(): void {
    if (!this.path) return;
    const p = this.path.pose(this.s, TMP);
    const h = this.dir > 0 ? p.h : p.h + Math.PI;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    this.x = p.x - fx * this.k;
    this.z = p.z - fz * this.k;
    this.h = h;
    this.updateBody();
  }

  /** Body box for the truck at path distance s (inflated for probing). */
  probeBody(s: number, out: OBB, inflateL: number, inflateW: number): OBB {
    const p = this.path!.pose(s, TMP2);
    const h = this.dir > 0 ? p.h : p.h + Math.PI;
    const fx = Math.sin(h);
    const fz = Math.cos(h);
    return setObb(out, p.x - fx * this.k, p.z - fz * this.k, h, HALF_L + inflateL, HALF_L + inflateL, HALF_W + inflateW);
  }

  syncView(dt: number, time: number, visible: boolean): void {
    const o = this.view.object;
    if (o.visible !== visible) o.visible = visible;
    if (!visible) return;
    o.position.set(this.x, 0, this.z);
    o.rotation.y = this.h;
    this.view.setWheelTravel(this.wheel);
    const moving = Math.abs(this.v) > 0.05;
    const reversing = this.dir < 0 && (this.phase === 'reversing' || moving);
    this.view.setReversing(reversing);
    this.view.setBrakeLights(this.braking || (!moving && this.phase !== 'off'));
    this.view.setRearDoors(this.rearDoors);
    this.view.update(dt, time);
  }

  dampRear(target: number, dt: number): boolean {
    this.rearDoors += clamp(target - this.rearDoors, -dt / 2.5, dt / 2.5);
    void damp;
    return Math.abs(this.rearDoors - target) < 1e-3;
  }
}

const TMP = { x: 0, z: 0, h: 0 };
const TMP2 = { x: 0, z: 0, h: 0 };
