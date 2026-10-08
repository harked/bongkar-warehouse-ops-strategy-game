/**
 * Dev-only showroom (`?showroom`): a lineup of every truck variant, forklifts at several fork
 * heights carrying pallets, and a grid of every cargo kind, parked on the Northgate yard apron.
 *
 * Capture helpers on window:
 *   __showroomView(x, z, yaw, pitch, dist)  camera override aimed at world (x, 0, z); null clears
 *   __showroom.doors(t) / .forks(h) / .roll(on)
 */
import * as THREE from 'three';
import type { ForkliftView, TruckView, VehicleFactory } from '../core/contracts';
import { FORKLIFT, TRUCK_CARGO_SLOTS } from '../core/constants';
import { P } from '../core/palette';
import type { CargoKind, TruckVariant } from '../core/types';
import { CARGO_KINDS } from './pallets';

declare global {
  interface Window {
    __showroomView?: (x: number, z: number, yaw: number, pitch: number, dist: number) => void;
    __showroom?: unknown;
  }
}

export function mountShowroomWhenReady(vehicles: VehicleFactory): void {
  const tryMount = () => {
    const y = (window as unknown as { __yard?: { scene?: THREE.Scene } }).__yard;
    if (y?.scene) mountShowroom(y.scene, vehicles);
    else setTimeout(tryMount, 50);
  };
  tryMount();
}

export function mountShowroom(scene: THREE.Scene, vehicles: VehicleFactory): void {
  const root = new THREE.Group();
  root.name = 'showroom';
  scene.add(root);

  // Studio sun only when the world does not provide a shadow-casting light yet.
  let hasShadowSun = false;
  scene.traverse((o) => {
    if ((o as THREE.DirectionalLight).isDirectionalLight && (o as THREE.DirectionalLight).castShadow) hasShadowSun = true;
  });
  if (!hasShadowSun) {
    const sun = new THREE.DirectionalLight(0xffffff, 2.4);
    sun.position.set(40, 80, 90);
    sun.target.position.set(0, 0, 50);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const s = sun.shadow.camera;
    s.left = -60;
    s.right = 60;
    s.top = 60;
    s.bottom = -60;
    s.near = 1;
    s.far = 300;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    root.add(sun, sun.target);
  }

  const pallets = vehicles.createPalletRenderer(512);
  root.add(pallets.object);
  let pi = 0;
  pallets.setPickResolver((i) => ({ kind: 'pallet', id: `show-${i}` }));

  // ---- trucks: z = 62 row, cabs facing +z (south) ----------------------------------------------
  const trucks: { v: TruckView; open: boolean }[] = [];
  const variants: { variant: TruckVariant; cab: number; carrier: string; trailer?: number }[] = [
    { variant: 'dry', cab: P.cobalt, carrier: 'Bluebird Freight' },
    { variant: 'dry', cab: P.coral, carrier: 'Harbor Lines' },
    { variant: 'reefer', cab: P.sky, carrier: 'Polar Express' },
    { variant: 'reefer', cab: P.mint, carrier: 'Frostway' },
    { variant: 'box', cab: P.sunbeam, carrier: 'Meadow Haulage' },
    { variant: 'box', cab: P.midnight, carrier: 'Cobalt Cargo', trailer: P.glacier },
  ];
  variants.forEach((d, i) => {
    const v = vehicles.createTruck({ variant: d.variant, cabColor: d.cab, carrier: d.carrier, trailerColor: d.trailer, label: `NG-${201 + i}` });
    v.object.position.set(-18 + i * 5.2, 0, 62);
    v.object.userData.pick = { kind: 'truck', id: `show-${i}` };
    root.add(v.object);
    const open = i % 2 === 1;
    v.setRearDoors(open ? 1 : 0);
    v.setReversing(open);
    v.setBrakeLights(!open);
    trucks.push({ v, open });
    // Fill the open trucks' rear half with pallets on the trailer floor.
    if (open) {
      for (let s = 6; s < 20; s++) {
        const slot = TRUCK_CARGO_SLOTS[s];
        const k = CARGO_KINDS[(s + i) % CARGO_KINDS.length];
        pallets.set(pi++, { x: v.object.position.x + slot.x, y: slot.y, z: v.object.position.z + slot.z }, 0, k);
      }
    }
  });

  // ---- forklifts: z = 42 row --------------------------------------------------------------------
  const lifts: { v: ForkliftView; h: number; pallet: number; cargo: CargoKind }[] = [];
  const heights = [0, 0.15, 1.8, 3.6, 4.6];
  heights.forEach((h, i) => {
    const v = vehicles.createForklift({ label: `${i + 1}` });
    v.object.position.set(-16 + i * 3.4, 0, 40);
    v.object.userData.pick = { kind: 'forklift', id: `show-${i}` };
    root.add(v.object);
    v.setForkHeight(h);
    v.setBeacon(i === 1 || i === 3);
    v.setCharging(i === 0);
    const cargo = CARGO_KINDS[(i + 1) % CARGO_KINDS.length];
    const pallet = i === 0 ? -1 : pi++;
    lifts.push({ v, h, pallet, cargo });
  });
  // A forklift inside the open coral truck's trailer, at dock height.
  const inTruck = vehicles.createForklift({ label: '7', color: P.sunbeam });
  const t1 = trucks[1].v.object.position;
  inTruck.object.position.set(t1.x + 0.0, 1.2, t1.z - 8.25 + 0.9 + 2 * 1.25 - FORKLIFT.forkOffset);
  inTruck.object.rotation.y = 0;
  inTruck.setForkHeight(0.15);
  root.add(inTruck.object);
  const inTruckPallet = pi++;

  // ---- pallet grid: every cargo kind, three of each ---------------------------------------------
  CARGO_KINDS.forEach((k, ci) => {
    for (let r = 0; r < 3; r++) {
      pallets.set(pi++, { x: 4 + ci * 1.6, y: 0, z: 36 + r * 1.8 }, r === 1 ? Math.PI / 2 : 0, k);
    }
  });
  // A short "racked" stack showing pallets at height on bare beams.
  const beam = new THREE.MeshStandardMaterial({ color: P.cobalt, roughness: 0.5 });
  for (const lvl of [1.8, 3.6]) {
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.8, 0.1, 0.08), beam);
    bar.position.set(17, lvl - 0.05, 36.55);
    const bar2 = bar.clone();
    bar2.position.z = 37.65;
    root.add(bar, bar2);
  }
  for (const x of [15.55, 18.45]) {
    for (const z of [36.55, 37.65]) {
      const up = new THREE.Mesh(new THREE.BoxGeometry(0.08, 4.4, 0.08), beam);
      up.position.set(x, 2.2, z);
      root.add(up);
    }
  }
  [0, 1.8, 3.6].forEach((lvl, li) => {
    for (let j = 0; j < 2; j++) pallets.set(pi++, { x: 16.3 + j * 1.4, y: lvl, z: 37.1 }, Math.PI / 2, CARGO_KINDS[(li * 2 + j) % 6]);
  });

  // ---- stress mode (`?showroom&stress`): full-load fleet for frame-time checks --------------------
  const stress = new URLSearchParams(window.location.search).has('stress');
  const stressTrucks: TruckView[] = [];
  const stressLifts: ForkliftView[] = [];
  let stressPallets: ReturnType<VehicleFactory['createPalletRenderer']> | null = null;
  if (stress) {
    const vs: TruckVariant[] = ['dry', 'reefer', 'box'];
    const cabs = [P.cobalt, P.coral, P.sky, P.mint, P.sunbeam, P.midnight, P.azure];
    for (let i = 0; i < 40; i++) {
      const v = vehicles.createTruck({ variant: vs[i % 3], cabColor: cabs[i % cabs.length], carrier: ['Bluebird Freight', 'Harbor Lines', 'Meadow Haulage', 'Cobalt Cargo'][i % 4], label: `ST-${100 + i}` });
      v.object.position.set(-60 + (i % 20) * 6, 0, 90 + Math.floor(i / 20) * 20);
      root.add(v.object);
      v.setRearDoors(i % 4 === 0 ? 1 : 0);
      stressTrucks.push(v);
    }
    for (let i = 0; i < 25; i++) {
      const v = vehicles.createForklift({ label: `${i + 1}` });
      v.object.position.set(-60 + i * 4, 0, 130);
      v.setBeacon(true);
      root.add(v.object);
      stressLifts.push(v);
    }
    stressPallets = vehicles.createPalletRenderer(4600);
    root.add(stressPallets.object);
    for (let i = 0; i < 4500; i++) {
      stressPallets.set(i, { x: -60 + (i % 75) * 1.6, y: 0, z: 140 + Math.floor(i / 75) * 1.5 }, 0, CARGO_KINDS[i % 6]);
    }
  }

  // ---- animation --------------------------------------------------------------------------------
  let roll = false;
  let travel = 0;
  let last = performance.now();
  const placeLiftPallets = () => {
    for (const l of lifts) {
      if (l.pallet < 0) continue;
      const o = l.v.object;
      const fx = Math.sin(o.rotation.y) * FORKLIFT.forkOffset;
      const fz = Math.cos(o.rotation.y) * FORKLIFT.forkOffset;
      pallets.set(l.pallet, { x: o.position.x + fx, y: o.position.y + l.h, z: o.position.z + fz }, o.rotation.y, l.cargo);
    }
    const o = inTruck.object;
    pallets.set(inTruckPallet, { x: o.position.x, y: o.position.y + 0.15, z: o.position.z + FORKLIFT.forkOffset }, 0, 'wrapped');
  };
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const time = now / 1000;
    if (roll) travel += dt * 3;
    for (const t of trucks) {
      t.v.setWheelTravel(travel);
      t.v.update(dt, time);
    }
    for (const l of lifts) {
      l.v.setWheelTravel(travel);
      l.v.update(dt, time);
    }
    inTruck.update(dt, time);
    if (stress && stressPallets) {
      stressTrucks.forEach((v, i) => {
        v.setWheelTravel(time * 4 + i);
        v.update(dt, time);
      });
      stressLifts.forEach((v, i) => {
        v.setForkHeight(2.3 + 2.3 * Math.sin(time + i));
        v.setWheelTravel(time * 2);
        v.update(dt, time);
      });
      // 60 pallets in motion every frame, plus a few switching cargo kind.
      for (let j = 0; j < 60; j++) {
        const i = (j * 73) % 4500;
        stressPallets.set(i, { x: -60 + (i % 75) * 1.6, y: 0.5 + 0.5 * Math.sin(time * 2 + j), z: 140 + Math.floor(i / 75) * 1.5 }, time, CARGO_KINDS[(i + Math.floor(time)) % 6]);
      }
      stressPallets.commit();
    }
    placeLiftPallets();
    pallets.commit();
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- camera override --------------------------------------------------------------------------
  let view: { x: number; z: number; yaw: number; pitch: number; dist: number } | null = null;
  const prev = scene.onBeforeRender;
  scene.onBeforeRender = function (...args: Parameters<THREE.Object3D['onBeforeRender']>) {
    prev.apply(this, args);
    const camera = args[2];
    // The main rig camera lives in the scene; the portrait camera does not.
    if (!view || camera.parent !== scene) return;
    const { x, z, yaw, pitch, dist } = view;
    camera.position.set(x + Math.sin(yaw) * Math.cos(pitch) * dist, Math.sin(pitch) * dist, z + Math.cos(yaw) * Math.cos(pitch) * dist);
    camera.lookAt(x, 0, z);
    camera.updateMatrixWorld();
  };
  window.__showroomView = (x, z, yaw, pitch, dist) => {
    view = Number.isFinite(x) ? { x, z, yaw, pitch, dist } : null;
  };
  window.__showroom = {
    trucks,
    lifts,
    pallets,
    doors(t: number) {
      for (const tr of trucks) tr.v.setRearDoors(t);
    },
    forks(h: number) {
      for (const l of lifts) {
        l.h = h;
        l.v.setForkHeight(h);
      }
    },
    roll(on: boolean) {
      roll = on;
    },
    travel(m: number) {
      travel = m;
    },
  };
}
