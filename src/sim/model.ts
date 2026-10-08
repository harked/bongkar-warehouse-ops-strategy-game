/** Shared data model for the simulation. */
import type { CargoKind, DockState, DoorLayout, ShipmentStage, SlotLayout } from '../core/types';
import type { Forklift } from './forklift';
import type { Pallet } from './pallets';
import type { Truck } from './truck';
import type { DoorGeo } from './yard';
export type { SiteOps } from './ops';

export interface Endpoint {
  /** Site id, or an external partner. */
  siteId: string | null;
  /** Display name: site name or "Coastline Foods". */
  name: string;
  /** Map edge for external partners. */
  edge: 'west' | 'east' | null;
}

export interface Shipment {
  id: string;
  from: Endpoint;
  to: Endpoint;
  cargo: CargoKind;
  pallets: Pallet[];
  count: number;
  /** Pallets moved in the current handling stage. */
  done: number;
  stage: number;
  doneAt: (number | undefined)[];
  stageStart: number;
  createdAt: number;
  dueAt: number;
  etaAt: number;
  status: 'on-time' | 'at-risk' | 'late' | 'done';
  truck: Truck | null;
  /** Outbound: door whose stage lanes it uses at the origin site. */
  door: DoorState | null;
  lateAnnounced: boolean;
  riskAnnounced: boolean;
  /** Planned total duration, for rail progress. */
  plan: number;
}

export const STAGE_KEYS: ShipmentStage['key'][] = ['picking', 'loading', 'transit', 'arrived', 'unloading', 'putaway'];
export const STAGE_LABELS: Record<ShipmentStage['key'], string> = {
  picking: 'Picking',
  loading: 'Loading',
  transit: 'Transit',
  arrived: 'Arrived',
  unloading: 'Unloading',
  putaway: 'Putaway',
};

export interface DoorState {
  L: DoorLayout;
  geo: DoorGeo;
  siteId: string;
  state: DockState;
  truck: Truck | null;
  open: number;
  signal: 'idle' | 'busy' | 'ready' | 'alert';
  stage: (Pallet | null)[];
  stageRes: boolean[];
  /** Outbound shipment staging here. */
  shipment: Shipment | null;
  turns: number;
  lastTruck: string | null;
  /** Forklift lock for the door lane (stage rows + trailer). */
  lock: Forklift | null;
}

export type Loc =
  | { t: 'slot'; slot: SlotLayout }
  | { t: 'stage'; door: DoorState; i: number }
  | { t: 'trailer'; truck: Truck; i: number }
  | { t: 'forks'; fl: Forklift }
  | { t: 'gone' };
