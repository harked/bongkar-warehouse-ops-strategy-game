/**
 * Physical constants shared by world, vehicles and sim. 1 unit = 1 metre. Y is up.
 *
 * Heading convention everywhere: an object's local +Z axis is its "forward".
 * `rotation.y = heading` where heading = Math.atan2(dir.x, dir.z) for a world direction dir.
 */

/** Warehouse floors sit at truck bed height, so forklifts drive straight into trailers. */
export const DOCK_HEIGHT = 1.2;

/**
 * Truck (tractor + trailer as one rigid unit). Origin: footprint centre on the ground.
 * Forward +Z. Cab at the front (+Z), trailer rear doors at z = -length/2.
 */
export const TRUCK = {
  length: 16.5,
  width: 2.55,
  trailerLength: 13.6,
  trailerHeight: 4.0,
  /** Trailer floor height above ground (== DOCK_HEIGHT). */
  floorY: DOCK_HEIGHT,
  /** Local z of the trailer rear edge. */
  rearZ: -16.5 / 2,
  /** Local z where the trailer box ends / cab gap starts. */
  trailerFrontZ: -16.5 / 2 + 13.6,
};

/** Pallet footprint. Origin: bottom centre. Long side (length) runs along local Z. */
export const PALLET = {
  width: 1.0,
  length: 1.2,
  baseHeight: 0.144,
  /** Typical cargo stack height above the base. */
  loadHeight: 1.05,
};

/** Pallet positions inside a trailer, in truck-local coordinates (pallet bottom centre). */
export const TRUCK_CARGO_SLOTS: { x: number; y: number; z: number }[] = (() => {
  const slots: { x: number; y: number; z: number }[] = [];
  // Row 0 is nearest the rear doors, so forklifts unload rear-first and load front-first.
  for (let row = 0; row < 10; row++) {
    for (const x of [-0.62, 0.62]) {
      slots.push({ x, y: TRUCK.floorY, z: TRUCK.rearZ + 0.9 + row * 1.25 });
    }
  }
  return slots;
})();

/** Counterbalance forklift. Origin: chassis centre on its floor. Forward +Z (forks at the front). */
export const FORKLIFT = {
  length: 3.3,
  width: 1.2,
  /** Distance from forklift origin to the centre of a carried pallet, along forward. */
  forkOffset: 1.55,
  maxForkHeight: 4.6,
  /** Fork height used while driving with a load. */
  travelForkHeight: 0.15,
  speed: 2.8,
};

/** Rack beam levels relative to floor (pallet bottom sits on the beam). */
export const RACK_LEVELS = [0, 1.8, 3.6];
/** Rack depth (along x) and slot pitch along the aisle (z). */
export const RACK = { depth: 1.1, slotPitch: 1.4, uprightEvery: 2 };

export const SPEED = {
  truckYard: 6,
  truckHighway: 18,
  truckReverse: 1.8,
};
