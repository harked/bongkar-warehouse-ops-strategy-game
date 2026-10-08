/**
 * Module contracts. Each module folder implements its part; main.ts wires them together.
 * Changing a signature here is a cross-team change: coordinate with the lead.
 */
import type * as THREE from 'three';
import type {
  AppCommands,
  CargoKind,
  EntityRef,
  HudSnapshot,
  SiteLayout,
  TruckVariant,
  V3,
  WorldLayout,
} from './types';

// ---------------------------------------------------------------------------------------------
// Picking convention (all modules):
//   object.userData.pick = EntityRef                         -> any ancestor of a hit mesh
//   instancedMesh.userData.pickInstance = (id: number) => EntityRef | null   -> instanced hits
// Meshes that must never be picked (ground, decor) simply carry neither.
// ---------------------------------------------------------------------------------------------

// ---- world (src/world) ----------------------------------------------------------------------

export interface SiteView {
  siteId: string;
  layout: SiteLayout;
  group: THREE.Group;
  /**
   * Signature "lift the lid". 0 = closed diorama (roof on, walls full), 1 = open (roof floated
   * up and faded out, near/yard-facing walls lowered so the interior reads from above).
   */
  setLid(t: number): void;
  /** Roll-up door 0 = closed, 1 = fully open. */
  setDoorOpen(doorId: string, t: number): void;
  /** Dock signal light above each door. */
  setDoorSignal(doorId: string, state: 'idle' | 'busy' | 'ready' | 'alert'): void;
  /** Per-frame animation (fans, flags, blinkers). */
  update(dt: number, time: number): void;
}

export interface Environment {
  sun: THREE.DirectionalLight;
  /** Keep the shadow camera centred on what the user is looking at. `dayFraction` 0..1 over 24 h. */
  update(dt: number, focus: THREE.Vector3, viewDistance: number, dayFraction: number): void;
}

export interface WorldView {
  group: THREE.Group;
  env: Environment;
  sites: Map<string, SiteView>;
  update(dt: number, time: number): void;
}

/** Implemented in src/world/index.ts */
export type BuildWorld = (layout: WorldLayout, scene: THREE.Scene, renderer: THREE.WebGLRenderer) => WorldView;

// ---- vehicles (src/vehicles) ------------------------------------------------------------------

export interface TruckOptions {
  variant: TruckVariant;
  /** Cab paint. */
  cabColor: number;
  /** Trailer body colour (defaults to white-ish). */
  trailerColor?: number;
  /** Carrier name painted on the trailer side, e.g. "Bluebird Freight". */
  carrier?: string;
  /** Plate / unit label, e.g. "NG-204". */
  label?: string;
}

export interface TruckView {
  /** Root. Origin = footprint centre on the ground, forward +Z. Put userData.pick here. */
  object: THREE.Group;
  /** Distance travelled (m), signed. Drives wheel rotation. */
  setWheelTravel(meters: number): void;
  setBrakeLights(on: boolean): void;
  setReversing(on: boolean): void;
  /** Trailer rear doors 0 = shut, 1 = swung fully open against the trailer sides. */
  setRearDoors(t: number): void;
  /** Reefer unit / hazard blinkers etc. */
  update(dt: number, time: number): void;
  dispose(): void;
}

export interface ForkliftOptions {
  /** Body paint, default Sunbeam. */
  color?: number;
  label?: string;
}

export interface ForkliftView {
  /** Root. Origin = chassis centre on the floor, forward +Z (forks). */
  object: THREE.Group;
  /** Fork carriage height above the floor (0..FORKLIFT.maxForkHeight). Mast extends past ~2 m. */
  setForkHeight(h: number): void;
  setWheelTravel(meters: number): void;
  /** Amber beacon on the overhead guard; on while moving. */
  setBeacon(on: boolean): void;
  /** Charging indicator (green glow) when parked at a charger. */
  setCharging(on: boolean): void;
  update(dt: number, time: number): void;
  dispose(): void;
}

/**
 * Every pallet in the world (stored, staged, on forks, in trailers) is drawn by this one
 * instanced renderer. The sim owns indices: one per pallet, stable for the pallet's life.
 */
export interface PalletRenderer {
  object: THREE.Object3D;
  readonly capacity: number;
  /** Place a pallet. `pos` is pallet bottom centre in world space; heading is rotation.y. */
  set(index: number, pos: V3, heading: number, cargo: CargoKind): void;
  hide(index: number): void;
  /** Upload dirty instance data. Call once per frame after all set/hide calls. */
  commit(): void;
  /** Called for instanced picking hits; return the sim's ref for that index. */
  setPickResolver(fn: (index: number) => EntityRef | null): void;
}

export interface VehicleFactory {
  createTruck(opts: TruckOptions): TruckView;
  createForklift(opts?: ForkliftOptions): ForkliftView;
  createPalletRenderer(capacity: number): PalletRenderer;
}

// ---- sim (src/sim) ----------------------------------------------------------------------------

export interface SimDeps {
  layout: WorldLayout;
  world: WorldView;
  vehicles: VehicleFactory;
  scene: THREE.Scene;
}

export interface Simulation {
  /** Advance by real dt seconds (the sim applies its own speed / pause). */
  update(dt: number): void;
  /** Cheap, allocation-light snapshot for the HUD. Called ~4 Hz. */
  snapshot(activeSiteId: string, selection: EntityRef | null): HudSnapshot;
  /** World position for selection rings, labels, camera follow. False if unknown. */
  getEntityPosition(ref: EntityRef, out: THREE.Vector3): boolean;
  /** Footprint radius in metres, for sizing the selection ring. */
  getEntityRadius(ref: EntityRef): number;
  /** Remaining planned path (world points, y = surface height) for route threads. Null when none. */
  getEntityRoute(ref: EntityRef): V3[] | null;
  /** Short label for the floating world tag. */
  getEntityLabel(ref: EntityRef): string;
  /** Sim time of day 0..1 (sun) */
  dayFraction(): number;
  setSpeed(speed: number): void;
  togglePause(): void;
  readonly speed: number;
  readonly paused: boolean;
}

export type CreateSimulation = (deps: SimDeps) => Simulation;

// ---- hud (src/hud) ----------------------------------------------------------------------------

export interface Hud {
  /** Render the latest snapshot. Must be cheap: diff, don't rebuild. */
  render(snap: HudSnapshot): void;
  /** Canvas for the live unit portrait (inside the unit card). Null when no selection is shown. */
  portraitCanvas(): HTMLCanvasElement | null;
  /** Screen-space tag following the selected entity. Called every frame by the scene layer. */
  setWorldTag(tag: { x: number; y: number; text: string; visible: boolean }): void;
}

export type CreateHud = (root: HTMLElement, commands: AppCommands) => Hud;
