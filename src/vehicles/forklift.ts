/**
 * Counterbalance forklift with a toy driver. One shared merged body mesh (triplex mast stages and
 * the carriage lift in the vehicle shader, wheels spin there too) plus a unit plate: 2 draw calls.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { ForkliftOptions, ForkliftView } from '../core/contracts';
import { FORKLIFT } from '../core/constants';
import { P } from '../core/palette';
import { boxGeo, cylX, GeoBuilder, LAMP, MOVE, TAG, mixHex, type Vec4 } from './builder';
import { C } from './colors';
import { createVehicleMaterials, decalMaterial } from './material';
import { plateTexture } from './textures';

export const FORKLIFT_FRONT_WHEEL_RADIUS = 0.3;
export const FORKLIFT_REAR_WHEEL_RADIUS = 0.22;
/** Carriage height where the mast stages start to extend. */
const FREE_LIFT = 1.8;

const RF = FORKLIFT_FRONT_WHEEL_RADIUS;
const RR = FORKLIFT_REAR_WHEEL_RADIUS;
const ZF = 0.35;
const ZR = -0.85;

const LIFT_CARRIAGE: Vec4 = [MOVE.lift, 0, 0, 0];
const LIFT_MIDDLE: Vec4 = [MOVE.lift, 1, 0, 0];
const LIFT_INNER: Vec4 = [MOVE.lift, 2, 0, 0];

function wheel(b: GeoBuilder, x: number, w: number, r: number, z: number, out: 1 | -1): void {
  const move: Vec4 = [MOVE.spin, r, z, 1 / r];
  b.add(cylX(r, w - 0.05, 14, true), { color: C.tyreTread, tag: TAG.rubber, move, pos: [x, r, z] });
  b.add(cylX(r - 0.03, w, 14), { color: C.tyre, tag: TAG.rubber, move, pos: [x, r, z] });
  const face = x + (out * w) / 2;
  b.add(cylX(r * 0.6, 0.02, 12), { color: P.cloud, tag: TAG.chrome, move, pos: [face + out * 0.006, r, z] });
  b.add(cylX(r * 0.22, 0.04, 8), { color: C.chassis, move, pos: [face + out * 0.018, r, z] });
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.add(boxGeo(0.02, 0.035, 0.035), {
      color: C.chassis,
      move,
      pos: [face + out * 0.018, r + Math.sin(a) * r * 0.38, z + Math.cos(a) * r * 0.38],
      rot: [a, 0, 0],
    });
  }
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
/** Box of thickness t stretched between two points (arms, legs, steering column). */
function limb(b: GeoBuilder, a: [number, number, number], c: [number, number, number], t: number, color: number, tag = TAG.plain): void {
  _a.set(...a);
  _b.set(...c);
  const len = _a.distanceTo(_b);
  const g = new RoundedBoxGeometry(t, t, len + t * 0.6, 1, t * 0.35);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), _b.clone().sub(_a).normalize());
  const m = new THREE.Matrix4().compose(_a.clone().add(_b).multiplyScalar(0.5), q, new THREE.Vector3(1, 1, 1));
  b.add(g, { color, tag, matrix: m });
}

function buildForklift(): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const paint = { color: P.cloud, tag: TAG.paintA };
  const ch = { color: C.chassis };
  const guard = { color: mixHex(P.slate, P.ink, 0.45) };

  // ---- chassis --------------------------------------------------------------------------------
  b.box(-0.32, 0.1, -0.62, 0.32, 0.62, 0.66, ch, '-y');
  b.boxX(0.32, 0.16, -0.6, 0.56, 0.62, -0.02, paint, '-y');
  // Front fenders over the drive wheels.
  b.add(new RoundedBoxGeometry(0.3, 0.08, 0.72, 1, 0.03), { ...paint, pos: [0.47, 0.66, 0.33] });
  b.add(new RoundedBoxGeometry(0.3, 0.08, 0.72, 1, 0.03), { ...paint, pos: [-0.47, 0.66, 0.33] });
  // Battery hood (seat base).
  b.add(new RoundedBoxGeometry(1.12, 0.4, 0.66, 2, 0.07), { ...paint, pos: [0, 0.8, -0.29] });
  // Floor plate.
  b.box(-0.32, 0.6, 0.02, 0.32, 0.645, 0.62, { color: C.tyre, tag: TAG.rubber }, '-y');
  // Dash cowl with display and charging lamp.
  b.add(new RoundedBoxGeometry(0.6, 0.5, 0.2, 2, 0.05), { ...paint, pos: [0, 0.89, 0.57] });
  b.box(-0.14, 1.135, 0.49, 0.14, 1.155, 0.63, { color: C.glassDark }, '-y');
  b.box(-0.11, 1.155, 0.52, 0.11, 1.165, 0.58, { color: C.mint, tag: TAG.lamp + LAMP.status }, '-y');
  // Steering column + wheel.
  limb(b, [0, 1.05, 0.5], [0, 1.3, 0.33], 0.06, C.chassis);
  const sw = new THREE.TorusGeometry(0.15, 0.022, 6, 16);
  sw.rotateX(Math.PI / 2 - 0.55);
  b.add(sw, { color: C.grille, tag: TAG.rubber, pos: [0, 1.32, 0.31] });
  b.add(boxGeo(0.28, 0.02, 0.03), { color: C.grille, pos: [0, 1.32, 0.31], rot: [-0.55, 0, 0] });

  // Seat.
  b.add(new RoundedBoxGeometry(0.5, 0.12, 0.44, 1, 0.04), { color: C.grille, pos: [0, 1.04, -0.34] });
  b.add(new RoundedBoxGeometry(0.5, 0.5, 0.1, 1, 0.04), { color: C.grille, pos: [0, 1.32, -0.6], rot: [-0.12, 0, 0] });

  // Counterweight: rounded block over the rear wheels, dark lower band behind them.
  b.add(new RoundedBoxGeometry(1.16, 0.78, 0.66, 3, 0.16), { ...paint, pos: [0, 0.84, -0.88] });
  b.box(-0.29, 0.1, -1.16, 0.29, 0.46, -0.6, ch, '-y');
  b.add(new RoundedBoxGeometry(1.1, 0.34, 0.12, 2, 0.05), { color: C.chassis, pos: [0, 0.3, -1.13] });
  b.box(-0.4, 0.86, -1.215, 0.4, 0.89, -1.18, { color: mixHex(P.ink, P.slate, 0.3) }, '+z');
  // Tail lamps.
  b.boxX(0.26, 0.94, -1.218, 0.4, 1.02, -1.19, { color: C.red, tag: TAG.lamp + LAMP.brake }, '+z');

  // ---- overhead guard -------------------------------------------------------------------------
  b.boxX(0.48, 0.66, 0.5, 0.54, 2.12, 0.56, guard);
  b.boxX(0.44, 1.16, -0.98, 0.5, 2.12, -0.92, guard);
  b.boxX(0.44, 2.08, -1.02, 0.55, 2.16, 0.6, guard);
  b.box(-0.55, 2.08, 0.52, 0.55, 2.16, 0.6, guard);
  b.box(-0.55, 2.08, -1.02, 0.55, 2.16, -0.94, guard);
  for (let i = -2; i <= 2; i++) b.box(i * 0.15 - 0.02, 2.1, -0.94, i * 0.15 + 0.02, 2.14, 0.52, guard);
  // Beacon on the rear rail.
  b.add(new THREE.CylinderGeometry(0.06, 0.07, 0.04, 14), { color: C.chassis, pos: [0, 2.18, -0.98] });
  b.add(new THREE.CylinderGeometry(0.052, 0.058, 0.09, 14), { color: C.amber, tag: TAG.lamp + LAMP.beacon, pos: [0, 2.245, -0.98] });
  const dome = new THREE.SphereGeometry(0.052, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(dome, { color: C.amber, tag: TAG.lamp + LAMP.beacon, pos: [0, 2.29, -0.98] });
  // Work lights on the front posts.
  b.boxX(0.47, 1.84, 0.56, 0.55, 1.94, 0.6, { color: C.headlamp, tag: TAG.lamp + LAMP.head });

  // ---- driver ---------------------------------------------------------------------------------
  const vest = mixHex(P.coral, P.sunbeam, 0.3);
  const trousers = P.midnight;
  b.boxX(0.03, 1.08, -0.42, 0.15, 1.2, 0.12, { color: trousers });
  b.boxX(0.04, 0.66, 0.06, 0.14, 1.15, 0.18, { color: trousers });
  b.boxX(0.035, 0.645, 0.04, 0.145, 0.72, 0.27, { color: C.grille });
  b.add(new RoundedBoxGeometry(0.36, 0.5, 0.26, 2, 0.08), { color: vest, pos: [0, 1.38, -0.33] });
  for (const y of [1.3, 1.47]) {
    b.box(-0.183, y, -0.465, 0.183, y + 0.035, -0.195, { color: P.cloud, tag: TAG.chrome }, '-y+y');
  }
  for (const s of [-1, 1]) {
    limb(b, [s * 0.2, 1.56, -0.32], [s * 0.21, 1.36, -0.1], 0.085, vest);
    limb(b, [s * 0.21, 1.36, -0.1], [s * 0.14, 1.33, 0.22], 0.075, C.skin);
  }
  b.add(new THREE.CylinderGeometry(0.05, 0.05, 0.08, 10), { color: C.skin, pos: [0, 1.66, -0.32] });
  b.add(new THREE.SphereGeometry(0.11, 12, 8), { color: C.skin, pos: [0, 1.77, -0.32] });
  for (const s of [-1, 1]) b.add(boxGeo(0.02, 0.025, 0.01), { color: P.midnight, pos: [s * 0.04, 1.78, -0.212] });
  const helmet = new THREE.SphereGeometry(0.125, 12, 4, 0, Math.PI * 2, 0, Math.PI / 2);
  b.add(helmet, { color: P.cloud, pos: [0, 1.8, -0.32] });
  b.add(new THREE.CylinderGeometry(0.14, 0.14, 0.015, 16), { color: P.cloud, pos: [0, 1.8, -0.31] });
  b.box(-0.01, 1.8, -0.45, 0.01, 1.92, -0.19, { color: P.cobalt }, '-y');

  // ---- wheels ---------------------------------------------------------------------------------
  for (const s of [-1, 1] as const) {
    wheel(b, s * 0.47, 0.26, RF, ZF, s);
    wheel(b, s * 0.4, 0.18, RR, ZR, s);
  }

  // ---- mast (triplex: outer fixed, middle and inner extend past free lift) -----------------------
  const mast = { color: mixHex(P.slate, P.ink, 0.5) };
  b.boxX(0.335, 0.1, 0.68, 0.4, 2.5, 0.84, mast);
  b.box(-0.4, 0.1, 0.63, 0.4, 0.2, 0.68, mast);
  b.box(-0.4, 2.42, 0.63, 0.4, 2.5, 0.68, mast);
  // Tilt cylinders.
  b.boxX(0.36, 0.66, 0.6, 0.4, 0.74, 0.68, { color: C.chrome, tag: TAG.chrome });
  const mid = { color: mixHex(P.slate, P.ink, 0.4), move: LIFT_MIDDLE };
  b.boxX(0.27, 0.12, 0.7, 0.33, 2.47, 0.84, mid);
  b.box(-0.33, 2.2, 0.84, 0.33, 2.27, 0.862, mid);
  const inner = { color: mixHex(P.slate, P.ink, 0.3), move: LIFT_INNER };
  b.boxX(0.205, 0.14, 0.72, 0.265, 2.44, 0.84, inner);
  b.box(-0.265, 2.36, 0.84, 0.265, 2.44, 0.855, inner);
  // Chain rollers on the inner stage head.
  b.add(cylX(0.04, 0.5, 10), { color: C.chrome, tag: TAG.chrome, move: LIFT_INNER, pos: [0, 2.4, 0.78] });

  // ---- carriage, backrest, forks ----------------------------------------------------------------
  const car = { color: mixHex(P.slate, P.ink, 0.55), move: LIFT_CARRIAGE };
  b.box(-0.44, 0.05, 0.865, 0.44, 0.17, 0.92, car);
  b.box(-0.44, 0.42, 0.865, 0.44, 0.54, 0.92, car);
  b.boxX(0.38, 0.05, 0.865, 0.44, 0.54, 0.92, car);
  for (let i = -2; i <= 2; i++) b.box(i * 0.19 - 0.018, 0.54, 0.88, i * 0.19 + 0.018, 1.24, 0.91, car);
  b.box(-0.44, 1.2, 0.875, 0.44, 1.25, 0.915, car);
  const fork = { color: mixHex(P.ink, P.slate, 0.2), move: LIFT_CARRIAGE };
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? 0.16 : -0.28;
    const x1 = s > 0 ? 0.28 : -0.16;
    b.box(x0, 0.03, 0.92, x1, 0.6, 0.95, fork);
    b.box(x0, 0.03, 0.95, x1, 0.09, 2.02, fork);
    // Tapered tip.
    b.add(wedge(x1 - x0, 0.06, 0.08), { ...fork, pos: [(x0 + x1) / 2, 0.03, 2.02] });
  }

  const g = b.build();
  // Cover the raised mast as well, so frustum culling never clips a lifted load.
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 2.4, 0.4), 4.2);
  return g;
}

/** Wedge: full height at z=0, tapering to a thin edge at z=len (fork tips). */
function wedge(w: number, h: number, len: number): THREE.BufferGeometry {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.lineTo(len, 0);
  s.lineTo(len, h * 0.25);
  s.lineTo(0, h);
  s.closePath();
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: false });
  // (a, b, c) -> (-c, b, a): shape x runs along +z, extrusion along -x.
  g.rotateY(-Math.PI / 2);
  g.translate(w / 2, 0, 0);
  return g;
}

let forkGeo: THREE.BufferGeometry | null = null;

let plateGeo: THREE.BufferGeometry | null = null;
function plateGeometry(): THREE.BufferGeometry {
  if (plateGeo) return plateGeo;
  const back = new THREE.PlaneGeometry(0.5, 0.17);
  back.rotateY(Math.PI);
  back.translate(0, 0.71, -1.213);
  const top = new THREE.PlaneGeometry(0.56, 0.2);
  top.rotateX(-Math.PI / 2);
  // Reads upright from behind the forklift, like a number plate.
  top.rotateY(Math.PI);
  top.translate(0, 1.232, -0.86);
  plateGeo = mergeGeometries([back, top])!;
  plateGeo.computeBoundingSphere();
  return plateGeo;
}

export function createForklift(opts: ForkliftOptions = {}): ForkliftView {
  forkGeo ??= buildForklift();
  const object = new THREE.Group();
  object.name = `forklift:${opts.label ?? ''}`;
  const mats = createVehicleMaterials(opts.color ?? P.sunbeam, P.cloud);
  const body = new THREE.Mesh(forkGeo, mats.body);
  body.customDepthMaterial = mats.depth;
  body.castShadow = true;
  body.receiveShadow = true;
  object.add(body);

  let plateTex: THREE.CanvasTexture | null = null;
  let plateMat: THREE.MeshStandardMaterial | null = null;
  if (opts.label) {
    plateTex = plateTexture(opts.label, { bg: P.midnight, fg: P.cloud }, 192, 64);
    plateMat = decalMaterial(plateTex, false);
    const plate = new THREE.Mesh(plateGeometry(), plateMat);
    plate.receiveShadow = true;
    object.add(plate);
  }

  const lamp = mats.u.uLamp.value;
  lamp[LAMP.head] = 0.6;
  lamp[LAMP.brake] = 0.2;
  let beacon = false;
  let charging = false;
  const phase = Math.random() * 10;
  const lift = mats.u.uLift.value;

  return {
    object,
    setForkHeight(h) {
      const c = Math.min(FORKLIFT.maxForkHeight, Math.max(0, h));
      const d = Math.max(0, c - FREE_LIFT);
      lift.set(c, d * 0.5, d);
    },
    setWheelTravel(m) {
      mats.u.uTravel.value = m;
    },
    setBeacon(on) {
      beacon = on;
      if (!on) lamp[LAMP.beacon] = 0;
    },
    setCharging(on) {
      charging = on;
      if (!on) lamp[LAMP.status] = 0;
    },
    update(_dt, time) {
      const t = time + phase;
      if (beacon) {
        // Rotating-beacon feel: a quick bright pulse then a soft tail.
        const p = (t * 1.6) % 1;
        lamp[LAMP.beacon] = p < 0.18 ? 1.3 : 0.25 + 0.25 * Math.max(0, 1 - (p - 0.18) * 3);
      }
      if (charging) lamp[LAMP.status] = 0.45 + 0.45 * (0.5 + 0.5 * Math.sin(t * 2.2));
    },
    dispose() {
      mats.body.dispose();
      mats.depth.dispose();
      plateMat?.dispose();
      plateTex?.dispose();
      object.removeFromParent();
    },
  };
}
