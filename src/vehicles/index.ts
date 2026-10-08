/**
 * Vehicles: trucks, forklifts and the instanced pallet renderer. All geometry is built in code
 * and shared; per-unit state lives in tiny per-unit materials (see material.ts).
 */
import type { VehicleFactory } from '../core/contracts';
import { createForklift } from './forklift';
import { createPalletRenderer } from './pallets';
import { createTruck } from './truck';

export { FORKLIFT_FRONT_WHEEL_RADIUS, FORKLIFT_REAR_WHEEL_RADIUS } from './forklift';
export { TRUCK_WHEEL_RADIUS } from './truck';

export const vehicles: VehicleFactory = {
  createTruck,
  createForklift,
  createPalletRenderer,
};

// Dev showroom: `?showroom` in the URL mounts a lineup of every vehicle next to Northgate.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('showroom')) {
  void import('./showroom').then((m) => m.mountShowroomWhenReady(vehicles));
}
