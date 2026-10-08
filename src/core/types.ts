/**
 * Shared data types. Pure data, no three.js imports here (see contracts.ts for module APIs).
 */
import type { SiteDef } from './sites';

export interface V2 {
  x: number;
  z: number;
}
export interface V3 {
  x: number;
  y: number;
  z: number;
}
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

// ---------------------------------------------------------------------------------------------
// Layout (computed once from SITE_DEFS by core/layout.ts). All coordinates are WORLD space.
// ---------------------------------------------------------------------------------------------

export type DoorSide = 'S' | 'N';
export type DoorRole = 'inbound' | 'outbound';

export interface DoorLayout {
  id: string; // e.g. "northgate:D03"
  siteId: string;
  label: string; // "D03"
  index: number;
  side: DoorSide;
  role: DoorRole;
  /** Door centre on the wall line, at ground level (x,z). Door opening sits on the floor at DOCK_HEIGHT. */
  pos: V2;
  /** Unit vector pointing out of the building into the yard. */
  normal: V2;
  /** Truck origin when docked (trailer rear touching the bumpers). */
  dockPos: V2;
  /** Truck heading when docked (cab points away from the wall). */
  dockHeading: number;
  /** Nav node on the wall line, inside the door. Forklifts leave the graph here to enter the trailer. */
  doorNode: string;
  /** Floor staging spots just inside the door, pallet bottom centre (y = DOCK_HEIGHT). */
  stageSlots: SlotLayout[];
}

export interface SlotLayout {
  id: string; // "northgate:A03:L:12:1" or "northgate:D03:stage:2"
  index: number; // index into SiteLayout.slots (stage slots have their own numbering per door)
  kind: 'rack' | 'floor' | 'stage';
  /** Pallet bottom centre. */
  pos: V3;
  /** Where the forklift origin stands to engage this slot (on its floor). */
  access: V2;
  /** Forklift heading when engaging (facing the slot). */
  heading: number;
  /** Rotation.y for the pallet when resting here (long side faces the forklift). */
  palletHeading: number;
  /** Nav node the forklift drives to before the final straight approach to `access`. */
  node: string;
  level: number;
  zone: 'ambient' | 'chill' | 'frozen';
}

export interface RackRow {
  /** Rack centre line x, z extent, which side of its aisle it is on. */
  x: number;
  z0: number;
  z1: number;
  levels: number[];
  zone: 'ambient' | 'chill' | 'frozen';
}

export interface NavNode {
  id: string;
  x: number;
  z: number;
}
export interface NavGraph {
  nodes: Record<string, NavNode>;
  adj: Record<string, string[]>;
}

export interface Charger {
  id: string;
  pos: V2;
  heading: number;
  node: string;
}

export interface YardLane {
  side: DoorSide;
  /** Centreline z of the two-way lane in front of the doors. */
  z: number;
  xWest: number;
  xEast: number;
  /** Path from the site gate to the lane's east end (inclusive of both). */
  entry: V2[];
}

export interface QueueSpot {
  id: string;
  pos: V2;
  heading: number;
}

export interface RoadSeg {
  points: V2[];
  width: number;
  kind: 'yard' | 'connector' | 'spur' | 'trunk';
}

export interface SiteLayout {
  def: SiteDef;
  id: string;
  building: { cx: number; cz: number; w: number; d: number; h: number; floorY: number; rect: Rect };
  /** Fence line. */
  bounds: Rect;
  /** Concrete apron rects (yards). */
  aprons: Rect[];
  gate: V2;
  doors: DoorLayout[];
  /** Storage slots (rack or floor). */
  slots: SlotLayout[];
  racks: RackRow[];
  /** Aisle centre lines, for floor paint. */
  aisles: { x: number; z0: number; z1: number }[];
  /** Cross aisle centre z values (south, and north for cross-docks). */
  crossAisles: number[];
  chargers: Charger[];
  nav: NavGraph;
  lanes: YardLane[];
  queueSpots: QueueSpot[];
  /** Yard roads inside the site (lanes, connectors). Highways live on WorldLayout. */
  roads: RoadSeg[];
}

export interface WorldLayout {
  sites: SiteLayout[];
  siteById: Record<string, SiteLayout>;
  /** Highways between sites and off-map edges. */
  roads: RoadSeg[];
  /** Off-map entry/exit points for regional trucks. */
  edges: { west: V2; east: V2 };
  /** Rough extent of the playable world. */
  extent: Rect;
}

// ---------------------------------------------------------------------------------------------
// Entities and selection
// ---------------------------------------------------------------------------------------------

export type EntityKind = 'site' | 'truck' | 'forklift' | 'pallet' | 'dock';
export interface EntityRef {
  kind: EntityKind;
  id: string;
}
export const refKey = (r: EntityRef): string => `${r.kind}:${r.id}`;
export const sameRef = (a: EntityRef | null | undefined, b: EntityRef | null | undefined): boolean =>
  !!a && !!b && a.kind === b.kind && a.id === b.id;

export type CargoKind = 'cartons' | 'wrapped' | 'produce' | 'frozen' | 'parcels' | 'drums';

export type TruckVariant = 'dry' | 'reefer' | 'box';

// ---------------------------------------------------------------------------------------------
// HUD snapshot: what the sim publishes for the HUD a few times per second.
// ---------------------------------------------------------------------------------------------

export type Tone = 'neutral' | 'good' | 'warn' | 'alert' | 'cold' | 'active';

export interface SiteKpis {
  /** Pallets moved per simulated hour (rolling). */
  throughputPerHour: number;
  /** Docks occupied / total. */
  docksBusy: number;
  docksTotal: number;
  /** Share of shipments completed or tracking on time, 0..1. */
  onTime: number;
  palletsStored: number;
  capacity: number;
  /** Cold chain only. */
  tempC?: number;
  forkliftsActive: number;
  forkliftsTotal: number;
  trucksOnSite: number;
}

export interface SiteSummary {
  id: string;
  name: string;
  code: string;
  kind: SiteDef['kind'];
  blurb: string;
  kpis: SiteKpis;
  alerts: number;
}

export type DockState = 'idle' | 'reserved' | 'docking' | 'unloading' | 'loading' | 'departing';
export interface DockRow {
  id: string;
  siteId: string;
  label: string;
  role: DoorRole;
  state: DockState;
  truckId?: string;
  truckLabel?: string;
  /** Unload/load progress 0..1 when a truck is docked. */
  progress: number;
}

export type ForkliftState = 'idle' | 'to-pick' | 'carrying' | 'to-charge' | 'charging';
export interface ForkliftRow {
  id: string;
  siteId: string;
  label: string;
  state: ForkliftState;
  /** 0..1 */
  battery: number;
  task: string;
  movedToday: number;
}

export type TruckState = 'en-route' | 'queued' | 'docking' | 'at-dock' | 'departing' | 'leaving';
export interface TruckRow {
  id: string;
  label: string;
  carrier: string;
  variant: TruckVariant;
  state: TruckState;
  /** Site it is heading to / at. Undefined when leaving the map. */
  siteId?: string;
  doorLabel?: string;
  /** Human text: "Docked at D03", "4 min to Frostline". */
  where: string;
  /** Simulated seconds until arrival when en-route. */
  etaSec?: number;
  /** Fraction of trailer filled 0..1. */
  load: number;
  shipmentId?: string;
}

export interface ShipmentStage {
  key: 'picking' | 'loading' | 'transit' | 'arrived' | 'unloading' | 'putaway';
  label: string;
  /** Sim time (seconds) the stage completed, if it did. */
  doneAt?: number;
}
export interface ShipmentRow {
  id: string; // "SH-4821"
  fromSiteId: string;
  toSiteId: string;
  cargo: CargoKind;
  cargoLabel: string;
  pallets: number;
  palletsDone: number;
  /** Index into stages of the current stage. stages.length means complete. */
  stage: number;
  stages: ShipmentStage[];
  /** Sim seconds-of-day the shipment is due. */
  dueAt: number;
  /** Sim seconds-of-day projected completion. */
  etaAt: number;
  status: 'on-time' | 'at-risk' | 'late' | 'done';
  truckId?: string;
  /** 0..1 progress across the whole journey, for a rail marker. */
  progress: number;
  /** 0..1 progress within the current stage (preferred by the rail marker when present). */
  stageProgress?: number;
}

export interface FeedEvent {
  id: number;
  /** Sim seconds-of-day. */
  t: number;
  siteId?: string;
  text: string;
  tone: Tone;
  ref?: EntityRef;
}

export interface DetailField {
  label: string;
  value: string;
  tone?: Tone;
}
export interface SelectionDetail {
  ref: EntityRef;
  title: string;
  subtitle: string;
  /** Chip text describing state: "Unloading", "Charging". */
  status: string;
  statusTone: Tone;
  fields: DetailField[];
  progress?: { label: string; value: number };
  /** 0..1, for battery/fill meters. */
  meter?: { label: string; value: number; tone: Tone };
  shipmentId?: string;
  siteId?: string;
}

export interface ClockInfo {
  /** Sim seconds since midnight. */
  seconds: number;
  /** "07:42" */
  label: string;
  /** "Tue 8 Oct" */
  dayLabel: string;
  speed: number;
  paused: boolean;
}

export interface NetworkKpis {
  trucksInTransit: number;
  shipmentsOpen: number;
  shipmentsDoneToday: number;
  onTime: number;
  palletsMovedToday: number;
}

export interface HudSnapshot {
  clock: ClockInfo;
  /** 'network' means the overview. */
  activeSiteId: string;
  network: NetworkKpis;
  sites: SiteSummary[];
  docks: DockRow[];
  forklifts: ForkliftRow[];
  trucks: TruckRow[];
  shipments: ShipmentRow[];
  events: FeedEvent[];
  selection: SelectionDetail | null;
}

/** Commands the HUD can issue. Implemented by the app (main.ts). */
export interface AppCommands {
  /** Site id or 'network'. Flies the camera. */
  selectSite(id: string): void;
  select(ref: EntityRef | null): void;
  /** Fly the camera to the current selection and follow it. */
  focusSelection(): void;
  /** Hover feedback from roster rows; null clears. */
  hover(ref: EntityRef | null): void;
  home(): void;
  rotateCamera(deltaRadians: number): void;
  zoomCamera(factor: number): void;
  setSpeed(speed: number): void;
  togglePause(): void;
}
