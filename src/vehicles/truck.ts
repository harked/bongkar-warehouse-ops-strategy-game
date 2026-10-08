/**
 * Tractor + trailer as one rigid unit. One merged body mesh per variant (shared by every truck
 * of that variant) driven by a per-truck material: cab / trailer paint, lamps, wheel spin and
 * the two rear door leaves all live in the vehicle shader. Plus a carrier livery decal (cached
 * per carrier) and a unit plate. 2-3 draw calls per truck.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { TruckOptions, TruckView } from '../core/contracts';
import { TRUCK } from '../core/constants';
import { P } from '../core/palette';
import type { TruckVariant } from '../core/types';
import { boxGeo, cylX, cylZ, discX, GeoBuilder, LAMP, MOVE, TAG, mixHex, type Vec4 } from './builder';
import { C } from './colors';
import { createVehicleMaterials, decalMaterial } from './material';
import { LIVERY_H, LIVERY_W, liveryTexture, plateTexture } from './textures';

/** Wheel radius for every truck wheel (tractor and trailer). */
export const TRUCK_WHEEL_RADIUS = 0.5;

const HW = TRUCK.width / 2; // 1.275
const REAR = TRUCK.rearZ; // -8.25
const TF = TRUCK.trailerFrontZ; // 5.35
const TOP = TRUCK.trailerHeight; // 4.0
const FLOOR = TRUCK.floorY; // 1.2
const R = TRUCK_WHEEL_RADIUS;

/** Rear door leaves. Pivot sits just outside the rear corner so the leaf clears the side wall. */
const DOOR_T = 0.045;
const DOOR_PIVOT_X = HW + 0.035;
const DOOR_PIVOT_Z = REAR + 0.03;
const DOOR_OPEN = (Math.PI * 3) / 2;

const AXLES_TRACTOR = [7.15, 4.1, 2.75];
const AXLES_TRAILER = [-4.3, -5.6, -6.9];

// ---- geometry ----------------------------------------------------------------------------------

function wheel(b: GeoBuilder, x: number, width: number, z: number, outward: 1 | -1, showFace: boolean): void {
  const move: Vec4 = [MOVE.spin, R, z, 1 / R];
  const rub = { color: C.tyre, tag: TAG.rubber, move };
  // Tread with slightly smaller sidewalls for a soft, chunky toy tyre.
  b.add(cylX(R, width - 0.07, 16, true), { ...rub, color: C.tyreTread, pos: [x, R, z] });
  b.add(cylX(R - 0.035, width, 16, !showFace), { ...rub, pos: [x, R, z] });
  if (!showFace) return;
  const face = x + (outward * width) / 2;
  b.add(cylX(0.31, 0.03, 14, true), { color: C.rim, tag: TAG.chrome, move, pos: [face + outward * 0.005, R, z] });
  b.add(discX(0.31, 14, outward), { color: mixHex(C.rim, P.slate, 0.3), tag: TAG.chrome, move, pos: [face + outward * 0.02, R, z] });
  b.add(cylX(0.11, 0.06, 10), { color: C.hub, tag: TAG.chrome, move, pos: [face + outward * 0.03, R, z] });
  // Lug nuts / vent holes so rotation reads.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2;
    b.add(boxGeo(0.03, 0.055, 0.055, outward > 0 ? '-x' : '+x'), {
      color: C.chassis,
      move,
      pos: [face + outward * 0.03, R + Math.sin(a) * 0.19, z + Math.cos(a) * 0.19],
      rot: [a, 0, 0],
    });
  }
}

/** Two-colour box helper: faces whose normal points along `inner` get the liner colour. */
function lined(outer: number, liner: number, inner: THREE.Vector3) {
  return (_p: THREE.Vector3, n: THREE.Vector3) => (n.dot(inner) > 0.5 ? liner : outer);
}
/** Interior faces sit on the interior-light lamp channel so the open box reads bright. */
const INTERIOR = TAG.lamp + LAMP.interior;
function linedTag(paintTag: number, inner: THREE.Vector3) {
  return (_p: THREE.Vector3, n: THREE.Vector3) => (n.dot(inner) > 0.5 ? INTERIOR : paintTag);
}

/** Glass with a soft sky reflection toward the top edge. */
function glassFn(y0: number, y1: number) {
  return (p: THREE.Vector3) => mixHex(C.glass, C.glassSheen, Math.min(1, Math.max(0, (p.y - y0) / (y1 - y0))) * 0.85);
}

function buildTractor(b: GeoBuilder): void {
  const paint = { color: P.cloud, tag: TAG.paintA };
  const ch = { color: C.chassis };
  // Chassis rails.
  b.boxX(0.38, 0.72, 1.95, 0.5, 1.0, 8.0, ch);
  b.box(-0.9, 0.62, 1.95, 0.9, 0.98, 2.08, ch); // rear crossmember
  // Fifth wheel.
  b.box(-0.55, 0.98, 3.0, 0.55, 1.08, 3.9, ch);
  b.box(-0.5, 1.08, 3.05, 0.5, 1.12, 3.85, { color: C.chassisLight }, '-y');
  // Drive-axle fenders under the trailer floor.
  b.boxX(0.66, 1.02, 2.15, 1.24, 1.07, 4.7, ch);
  // Mudflaps behind the rear drive axle.
  b.boxX(0.68, 0.2, 2.0, 1.24, 0.9, 2.04, { color: C.tyre, tag: TAG.rubber });

  // Cab body.
  const cab = new RoundedBoxGeometry(2.45, 2.15, 2.3, 3, 0.2);
  b.add(cab, { ...paint, pos: [0, 1.05 + 1.075, 5.85 + 1.15] });
  // Roof fairing: side profile extruded across the cab.
  const prof = new THREE.Shape();
  prof.moveTo(5.92, 3.16);
  prof.lineTo(7.98, 3.16);
  prof.lineTo(7.28, 3.9);
  prof.lineTo(5.92, 3.9);
  prof.closePath();
  const fair = new THREE.ExtrudeGeometry(prof, { depth: 2.34, bevelEnabled: false });
  // Shape is drawn in (z, y); rotateY(-90deg) maps (a, b, c) -> (-c, b, a), so the extrusion runs along -x.
  fair.rotateY(-Math.PI / 2);
  fair.translate(1.17, 0, 0);
  b.add(fair, paint);
  // Roof marker lamps on the fairing's front edge.
  for (let i = -2; i <= 2; i++) {
    b.box(i * 0.3 - 0.035, 3.9, 7.2, i * 0.3 + 0.035, 3.935, 7.27, { color: C.amber, tag: TAG.lamp + LAMP.marker }, '-y');
  }
  // Windscreen, side windows.
  b.box(-1.02, 2.02, 8.125, 1.02, 2.98, 8.168, { color: C.grille });
  b.box(-0.98, 2.06, 8.13, 0.98, 2.94, 8.178, { color: glassFn(2.06, 2.94), tag: TAG.glass });
  b.boxX(1.2, 2.05, 7.12, 1.245, 2.86, 7.92, { color: glassFn(2.05, 2.86), tag: TAG.glass });
  // Small rear quarter window.
  b.boxX(1.2, 2.3, 6.15, 1.245, 2.86, 6.75, { color: glassFn(2.3, 2.86), tag: TAG.glass });
  // Wipers.
  for (const s of [-1, 1]) {
    b.add(boxGeo(0.62, 0.025, 0.02), { color: C.grille, pos: [s * 0.38, 2.12, 8.185], rot: [0, 0, s * 0.18] });
  }
  // Sun visor.
  b.box(-1.1, 3.0, 8.02, 1.1, 3.06, 8.29, { color: 0xd9dee6, tag: TAG.paintA });
  // Grille + slats + badge.
  b.box(-0.8, 1.28, 8.12, 0.8, 1.95, 8.17, { color: C.grille });
  for (let i = 0; i < 4; i++) {
    const y = 1.36 + i * 0.16;
    b.box(-0.78, y, 8.17, 0.78, y + 0.06, 8.19, { color: C.chrome, tag: TAG.chrome }, '-z');
  }
  b.box(-0.14, 1.98, 8.15, 0.14, 2.02, 8.18, { color: C.chrome, tag: TAG.chrome });
  // Bumper.
  const bump = new RoundedBoxGeometry(2.45, 0.56, 0.32, 2, 0.08);
  b.add(bump, { color: mixHex(P.asphalt, P.concrete, 0.35), pos: [0, 0.72, 8.09] });
  // Headlights and indicators on the bumper.
  b.boxX(0.66, 0.76, 8.22, 1.0, 0.9, 8.262, { color: C.headlamp, tag: TAG.lamp + LAMP.head });
  b.box(1.03, 0.76, 8.22, 1.16, 0.9, 8.262, { color: C.amber, tag: TAG.lamp + LAMP.blinkLeft });
  b.box(-1.16, 0.76, 8.22, -1.03, 0.9, 8.262, { color: C.amber, tag: TAG.lamp + LAMP.blinkRight });
  // Fog lamps.
  b.boxX(0.3, 0.52, 8.23, 0.48, 0.6, 8.258, { color: C.headlamp, tag: TAG.chrome });
  // Mirrors: arm, housing, glass.
  for (const s of [-1, 1]) {
    b.box(s > 0 ? 1.2 : -1.42, 2.6, 7.97, s > 0 ? 1.42 : -1.2, 2.65, 8.02, ch);
    b.box(s > 0 ? 1.38 : -1.47, 2.26, 7.94, s > 0 ? 1.47 : -1.38, 2.8, 8.08, { color: C.chassis });
    b.box(s > 0 ? 1.386 : -1.464, 2.3, 7.925, s > 0 ? 1.464 : -1.386, 2.76, 7.94, { color: C.glass, tag: TAG.glass });
  }
  // Door handles and side amber repeaters.
  b.boxX(1.225, 1.92, 6.95, 1.25, 1.97, 7.15, { color: C.chrome, tag: TAG.chrome });
  b.box(1.225, 1.5, 7.75, 1.245, 1.56, 7.9, { color: C.amber, tag: TAG.lamp + LAMP.blinkLeft });
  b.box(-1.245, 1.5, 7.75, -1.225, 1.56, 7.9, { color: C.amber, tag: TAG.lamp + LAMP.blinkRight });
  // Steps behind the front wheels.
  for (const s of [-1, 1]) {
    const xi = s > 0 ? 0.9 : -1.2;
    const xo = s > 0 ? 1.2 : -0.9;
    b.box(xi, 0.5, 5.95, xo, 0.55, 6.5, { color: C.chrome, tag: TAG.chrome });
    b.box(xi, 0.8, 5.95, xo, 0.85, 6.5, { color: C.chrome, tag: TAG.chrome });
    b.box(s > 0 ? 1.16 : -1.21, 0.45, 5.95, s > 0 ? 1.21 : -1.16, 1.06, 6.5, { ...paint, color: 0xe8edf3 });
  }
  // Under-cab skirt between the front wheels.
  b.box(-0.6, 0.75, 5.95, 0.6, 1.05, 7.9, ch, '-y');

  // Fuel tank (right side, -x) with straps.
  b.add(cylZ(0.28, 1.1, 18), { color: C.chrome, tag: TAG.chrome, pos: [-0.95, 0.62, 5.25] });
  for (const z of [4.9, 5.6]) b.add(cylZ(0.29, 0.05, 18, true), { color: C.chassis, pos: [-0.95, 0.62, z] });
  b.add(cylX(0.07, 0.06, 10), { color: C.chassis, pos: [-0.95, 0.88, 5.0], rot: [0, 0, Math.PI / 2] }); // filler cap
  // Battery / toolbox (left side, +x).
  b.box(0.62, 0.4, 4.75, 1.15, 0.95, 5.75, ch);
  b.box(0.63, 0.95, 4.78, 1.14, 0.99, 5.72, { color: C.chassisLight });
  // Exhaust stacks + brackets.
  for (const s of [-1, 1]) {
    b.add(new THREE.CylinderGeometry(0.075, 0.075, 2.9, 12), { color: C.chrome, tag: TAG.chrome, pos: [s * 1.08, 0.85 + 1.45, 5.62] });
    b.add(new THREE.CylinderGeometry(0.095, 0.095, 0.7, 12, 1, true), { color: C.chassisLight, pos: [s * 1.08, 2.45, 5.62] });
    b.add(new THREE.CylinderGeometry(0.06, 0.08, 0.08, 12), { color: C.chassis, pos: [s * 1.08, 3.79, 5.62] });
    b.box(s > 0 ? 1.0 : -1.12, 2.0, 5.62, s > 0 ? 1.12 : -1.0, 2.06, 5.86, ch);
    b.box(s > 0 ? 1.0 : -1.12, 3.2, 5.62, s > 0 ? 1.12 : -1.0, 3.26, 5.86, ch);
  }

  // Wheels: steer axle singles, two drive axles with duals.
  wheel(b, 1.07, 0.32, AXLES_TRACTOR[0], 1, true);
  wheel(b, -1.07, 0.32, AXLES_TRACTOR[0], -1, true);
  for (const z of AXLES_TRACTOR.slice(1)) {
    for (const s of [-1, 1] as const) {
      wheel(b, s * 0.83, 0.27, z, s, false);
      wheel(b, s * 1.105, 0.27, z, s, true);
    }
  }
  for (const z of AXLES_TRACTOR) b.add(cylX(0.075, 1.5, 10), { ...ch, pos: [0, R, z] });
}

function buildTrailer(b: GeoBuilder, variant: TruckVariant): void {
  const paint = { color: P.cloud, tag: TAG.paintB };
  const ch = { color: C.chassis };
  const inX = new THREE.Vector3(-1, 0, 0);
  const outX = new THREE.Vector3(1, 0, 0);
  const wallIn = variant === 'reefer' ? 0.095 : variant === 'box' ? 0.045 : 0.055;

  // Floor and main beams.
  b.box(-(HW - 0.055), FLOOR - 0.08, REAR + 0.35, HW - 0.055, FLOOR, TF - 0.06, {
    color: (_p, n) => (n.y > 0.5 ? C.linerFloor : C.chassis),
    tag: (_p, n) => (n.y > 0.5 ? INTERIOR : TAG.plain),
  });
  b.boxX(0.38, 0.92, REAR + 0.35, 0.5, FLOOR - 0.08, 1.5, ch, '+y');
  // Cross members under the floor, visible between beams and rails.
  for (let z = REAR + 1.2; z < 1.2; z += 1.6) b.box(-1.2, 1.0, z, 1.2, FLOOR - 0.08, z + 0.1, ch, '+y');

  // Side rails (top and bottom), front corner posts, roof, front wall.
  for (const s of [-1, 1]) {
    const x0 = s > 0 ? HW - 0.06 : -HW;
    const x1 = s > 0 ? HW : -(HW - 0.06);
    b.box(x0, 1.0, REAR + 0.3, x1, FLOOR, TF - 0.1, paint);
    b.box(x0, 3.86, REAR + 0.3, x1, TOP, TF - 0.1, paint);
    b.box(s > 0 ? HW - 0.07 : -HW, 1.0, TF - 0.1, s > 0 ? HW : -(HW - 0.07), TOP, TF, paint);
  }
  b.box(-(HW - 0.06), 3.93, REAR + 0.3, HW - 0.06, TOP, TF - 0.06, {
    color: (_p, n) => (n.y < -0.5 ? C.liner : P.cloud),
    tag: (_p, n) => (n.y < -0.5 ? INTERIOR : TAG.paintB),
  });
  // Roof bows: faint ribs on top so roofs read from high above.
  for (let z = REAR + 1.0; z < TF - 0.3; z += 1.1) {
    b.box(-(HW - 0.06), TOP, z, HW - 0.06, TOP + 0.012, z + 0.05, { color: 0xdfe5ec, tag: TAG.paintB }, '-y');
  }
  const front = new THREE.Vector3(0, 0, -1);
  b.box(-(HW - 0.07), FLOOR - 0.08, TF - 0.06, HW - 0.07, 3.93, TF, {
    color: lined(P.cloud, C.liner, front),
    tag: linedTag(TAG.paintB, front),
  });

  // Side walls per variant.
  for (const s of [-1, 1]) {
    const inner = s > 0 ? inX : outX;
    const xo = HW - 0.015;
    const xi = HW - wallIn;
    const x0 = s > 0 ? xi : -xo;
    const x1 = s > 0 ? xo : -xi;
    const z0 = REAR + 0.3;
    const z1 = TF - 0.1;
    if (variant === 'reefer') {
      b.box(x0, FLOOR, z0, x1, 1.5, z1, { color: lined(C.frost, C.liner, inner), tag: linedTag(TAG.plain, inner) });
      b.box(x0, 1.5, z0, x1, 1.56, z1, { color: lined(P.cobalt, C.liner, inner) });
      b.box(x0, 1.56, z0, x1, 3.86, z1, { color: lined(P.cloud, C.liner, inner), tag: linedTag(TAG.paintB, inner) });
    } else {
      b.box(x0, FLOOR, z0, x1, 3.86, z1, { color: lined(P.cloud, C.liner, inner), tag: linedTag(TAG.paintB, inner) });
    }
    if (variant === 'box') {
      // Curtain straps with buckles.
      const sx0 = s > 0 ? HW - 0.015 : -(HW + 0.004);
      const sx1 = s > 0 ? HW + 0.004 : -(HW - 0.015);
      for (let z = REAR + 0.62; z < TF - 0.3; z += 0.62) {
        b.box(sx0, FLOOR + 0.02, z - 0.025, sx1, 3.84, z + 0.025, { color: 0xc4ccd8, tag: TAG.paintB }, '-y+y');
        const bx0 = s > 0 ? HW + 0.004 : -(HW + 0.014);
        const bx1 = s > 0 ? HW + 0.014 : -(HW + 0.004);
        b.box(bx0, FLOOR + 0.04, z - 0.03, bx1, FLOOR + 0.16, z + 0.03, { color: C.chrome, tag: TAG.chrome });
      }
    }
    // Amber side markers along the bottom rail, red at the rear end.
    const mx0 = s > 0 ? HW : -(HW + 0.012);
    const mx1 = s > 0 ? HW + 0.012 : -HW;
    for (let z = REAR + 2.0; z < TF - 0.5; z += 2.4) {
      b.box(mx0, 1.04, z, mx1, 1.1, z + 0.12, { color: C.amber, tag: TAG.lamp + LAMP.marker });
    }
    b.box(mx0, 1.04, REAR + 0.36, mx1, 1.1, REAR + 0.48, { color: C.red, tag: TAG.lamp + LAMP.marker });
    // Top clearance lamps at the front corners.
    b.box(s > 0 ? HW - 0.05 : -(HW - 0.01), TOP - 0.1, TF, s > 0 ? HW - 0.01 : -(HW - 0.05), TOP - 0.03, TF + 0.015, {
      color: C.amber,
      tag: TAG.lamp + LAMP.marker,
    });
  }

  // Reefer unit on the front wall.
  if (variant === 'reefer') {
    const unit = new RoundedBoxGeometry(1.9, 1.34, 0.36, 2, 0.06);
    b.add(unit, { color: mixHex(P.concrete, P.asphalt, 0.35), pos: [0, 3.05, TF + 0.14] });
    b.box(-0.94, 2.4, TF + 0.3, 0.94, 2.62, TF + 0.325, { color: C.grille });
    for (const x of [-0.45, 0.45]) {
      b.add(new THREE.CircleGeometry(0.29, 20), { color: C.grille, pos: [x, 3.16, TF + 0.322] });
      for (const r of [0.29, 0.2, 0.11]) {
        b.add(cylZ(r, 0.025, 20, true), { color: C.chrome, tag: TAG.chrome, pos: [x, 3.16, TF + 0.33] });
      }
      b.add(boxGeo(0.58, 0.025, 0.02), { color: C.chrome, tag: TAG.chrome, pos: [x, 3.16, TF + 0.335] });
      b.add(boxGeo(0.025, 0.58, 0.02), { color: C.chrome, tag: TAG.chrome, pos: [x, 3.16, TF + 0.335] });
    }
    // Top vent with slats.
    b.box(-0.7, 3.72, TF + 0.03, 0.7, 3.735, TF + 0.27, { color: C.grille }, '-y');
    for (let i = 0; i < 6; i++) {
      const x = -0.6 + i * 0.24;
      b.box(x - 0.03, 3.735, TF + 0.04, x + 0.03, 3.75, TF + 0.26, { color: C.chrome, tag: TAG.chrome }, '-y');
    }
    // Blinking status lamps on both sides and the control panel face.
    b.box(0.95, 3.38, TF + 0.06, 0.968, 3.5, TF + 0.2, { color: C.mint, tag: TAG.lamp + LAMP.status });
    b.box(-0.968, 3.38, TF + 0.06, -0.95, 3.5, TF + 0.2, { color: C.mint, tag: TAG.lamp + LAMP.status });
    b.box(0.6, 2.66, TF + 0.3, 0.8, 2.78, TF + 0.33, { color: C.glassDark });
    b.box(0.64, 2.69, TF + 0.33, 0.7, 2.75, TF + 0.338, { color: C.mint, tag: TAG.lamp + LAMP.status });
    b.box(-0.08, 3.71, TF + 0.4, 0.08, 3.73, TF + 0.42, { color: C.frost });
  }

  // Rear frame: posts, header, sill.
  b.boxX(1.2, FLOOR - 0.08, REAR + 0.08, HW, 3.72, REAR + 0.3, {
    color: (_p, n) => (Math.abs(n.x) > 0.5 ? P.cloud : 0xe2e8ef),
    tag: TAG.paintB,
  });
  b.box(-HW, 3.72, REAR + 0.08, HW, TOP, REAR + 0.3, { color: 0xe2e8ef, tag: TAG.paintB });
  b.box(-HW, 0.95, REAR + 0.08, HW, FLOOR, REAR + 0.35, {
    color: (_p, n) => (n.y > 0.5 ? C.chrome : C.chassis),
    tag: (_p, n) => (n.y > 0.5 ? TAG.chrome : TAG.plain),
  });
  // Rear light clusters on the sill face: amber (outer), red, white reverse (inner).
  for (const s of [-1, 1]) {
    const lz0 = REAR + 0.035;
    const lz1 = REAR + 0.08;
    const seg = (a: number, c: number, color: number, tag: number) =>
      b.box(s > 0 ? a : -c, 0.97, lz0, s > 0 ? c : -a, 1.1, lz1, { color, tag }, '+z');
    seg(1.06, 1.22, C.amber, TAG.lamp + (s > 0 ? LAMP.blinkLeft : LAMP.blinkRight));
    seg(0.82, 1.04, C.red, TAG.lamp + LAMP.brake);
    seg(0.64, 0.8, C.white, TAG.lamp + LAMP.reverse);
  }
  // Red rear clearance lamps on the header.
  b.boxX(0.9, 3.86, REAR + 0.06, 1.1, 3.94, REAR + 0.08, { color: C.red, tag: TAG.lamp + LAMP.brake });
  // Underride bar with posts.
  b.box(-1.15, 0.42, REAR + 0.12, 1.15, 0.58, REAR + 0.26, { color: (_p, n) => (n.z < -0.5 ? 0xe9eef4 : C.chassis) });
  b.boxX(0.55, 0.58, REAR + 0.14, 0.66, 0.95, REAR + 0.24, ch);
  // Red / white contour stripes on the underride bar.
  for (let i = 0; i < 6; i++) {
    const x = -1.1 + i * 0.4;
    b.box(x, 0.45, REAR + 0.115, x + 0.2, 0.55, REAR + 0.12, { color: C.red }, '+z');
  }

  // Trailer bogie: three axles with super-single tyres, hangers, axles.
  for (const z of AXLES_TRAILER) {
    for (const s of [-1, 1] as const) wheel(b, s * 1.05, 0.38, z, s, true);
    b.add(cylX(0.075, 1.74, 10), { ...ch, pos: [0, R, z] });
    b.boxX(0.62, 0.42, z - 0.36, 0.74, 0.6, z + 0.36, ch);
    b.boxX(0.62, 0.6, z - 0.08, 0.74, FLOOR - 0.08, z + 0.08, ch, '+y');
  }
  // Mudflaps behind the last trailer axle.
  b.boxX(0.85, 0.2, AXLES_TRAILER[2] - 0.62, 1.25, 1.0, AXLES_TRAILER[2] - 0.58, { color: C.tyre, tag: TAG.rubber });

  // Landing gear (raised for travel).
  b.boxX(0.8, 0.32, 1.15, 0.92, FLOOR - 0.08, 1.27, ch, '+y');
  b.boxX(0.74, 0.26, 1.06, 0.98, 0.32, 1.36, { color: C.chassisLight });
  b.box(-0.8, 0.6, 1.18, 0.8, 0.66, 1.24, ch);
  b.box(0.92, 0.82, 1.18, 1.08, 0.86, 1.24, { color: C.chassisLight });
  b.box(1.04, 0.7, 1.18, 1.08, 0.86, 1.24, { color: C.chassisLight });

  // Side underrun guards.
  for (const s of [-1, 1]) {
    const gx0 = s > 0 ? 1.2 : -1.24;
    const gx1 = s > 0 ? 1.24 : -1.2;
    b.box(gx0, 0.48, -3.7, gx1, 0.58, 0.95, { color: P.asphalt, tag: TAG.chrome });
    b.box(gx0, 0.78, -3.7, gx1, 0.88, 0.95, { color: P.asphalt, tag: TAG.chrome });
    for (const z of [-3.45, -1.35, 0.75]) {
      b.box(s > 0 ? 1.16 : -1.2, 0.48, z - 0.05, s > 0 ? 1.2 : -1.16, 1.0, z + 0.05, ch);
    }
  }

  // Rear door leaves (hinged at the rear corners).
  for (const s of [-1, 1] as const) {
    const px = s * DOOR_PIVOT_X;
    // Left leaf (+x) swings through -270 deg, right leaf (-x) through +270 deg.
    const move: Vec4 = [MOVE.hinge, px, DOOR_PIVOT_Z, -s];
    const x0 = s > 0 ? 0.004 : -DOOR_PIVOT_X;
    const x1 = s > 0 ? DOOR_PIVOT_X : -0.004;
    const back = new THREE.Vector3(0, 0, 1);
    b.box(x0, FLOOR - 0.08, DOOR_PIVOT_Z, x1, 3.96, DOOR_PIVOT_Z + DOOR_T, {
      color: lined(P.cloud, C.liner, back),
      tag: linedTag(TAG.paintB, back),
      move,
    });
    // Panel seams on the outside face.
    b.box(x0 + 0.06, 2.5, DOOR_PIVOT_Z - 0.004, x1 - 0.06, 2.53, DOOR_PIVOT_Z, { color: 0xd5dce5, tag: TAG.paintB, move }, '+z');
    // Lock rods with handles.
    for (const rx of [0.36, 0.96]) {
      const x = s * rx;
      b.add(new THREE.CylinderGeometry(0.018, 0.018, 2.7, 8), { color: C.chrome, tag: TAG.chrome, move, pos: [x, 2.55, DOOR_PIVOT_Z - 0.016] });
      b.box(x - 0.025, 1.18, DOOR_PIVOT_Z - 0.03, x + 0.025, 1.24, DOOR_PIVOT_Z, { color: C.chrome, tag: TAG.chrome, move });
      b.box(x - 0.025, 3.86, DOOR_PIVOT_Z - 0.03, x + 0.025, 3.92, DOOR_PIVOT_Z, { color: C.chrome, tag: TAG.chrome, move });
      b.box(x - 0.02, 1.62, DOOR_PIVOT_Z - 0.028, x + s * 0.24, 1.66, DOOR_PIVOT_Z - 0.01, { color: C.chassis, move });
    }
    // Hinges.
    for (const y of [1.45, 2.25, 3.05, 3.7]) {
      b.box(s > 0 ? 1.18 : -DOOR_PIVOT_X, y, DOOR_PIVOT_Z - 0.012, s > 0 ? DOOR_PIVOT_X : -1.18, y + 0.09, DOOR_PIVOT_Z, {
        color: C.chassis,
        move,
      });
    }
  }
}


const geoCache = new Map<TruckVariant, THREE.BufferGeometry>();
function truckGeometry(variant: TruckVariant): THREE.BufferGeometry {
  let g = geoCache.get(variant);
  if (g) return g;
  const b = new GeoBuilder();
  buildTractor(b);
  buildTrailer(b, variant);
  g = b.build();
  // Open doors reach a little past the side walls; the sphere already covers the whole length.
  geoCache.set(variant, g);
  return g;
}

// ---- livery decal + plate ------------------------------------------------------------------------

let liveryGeo: THREE.BufferGeometry | null = null;
function liveryGeometry(): THREE.BufferGeometry {
  if (liveryGeo) return liveryGeo;
  const h = 3.84 - FLOOR - 0.02;
  const w = (h * LIVERY_W) / LIVERY_H;
  const z0 = REAR + 1.45;
  const zc = z0 + w / 2;
  const yc = FLOOR + 0.01 + h / 2;
  const xo = HW - 0.015 + 0.006;
  const a = new THREE.PlaneGeometry(w, h);
  a.rotateY(Math.PI / 2);
  a.translate(xo, yc, zc);
  const bb = new THREE.PlaneGeometry(w, h);
  bb.rotateY(-Math.PI / 2);
  bb.translate(-xo, yc, zc);
  liveryGeo = mergeGeometries([a, bb])!;
  liveryGeo.computeBoundingSphere();
  return liveryGeo;
}
const liveryMats = new Map<string, THREE.MeshStandardMaterial>();
function liveryMaterial(carrier: string): THREE.MeshStandardMaterial {
  let m = liveryMats.get(carrier);
  if (!m) {
    m = decalMaterial(liveryTexture(carrier), true);
    liveryMats.set(carrier, m);
  }
  return m;
}

let plateGeo: THREE.BufferGeometry | null = null;
function plateGeometry(): THREE.BufferGeometry {
  if (plateGeo) return plateGeo;
  // Slanted front of the roof fairing: from (z 7.98, y 3.16) to (z 7.28, y 3.9).
  const dz = 7.28 - 7.98;
  const dy = 3.9 - 3.16;
  const len = Math.hypot(dz, dy);
  const nz = dy / len;
  const ny = -dz / len;
  const front = new THREE.PlaneGeometry(1.2, 0.3);
  front.rotateX(-Math.atan2(ny, nz));
  front.translate(0, (3.16 + 3.9) / 2 + ny * 0.008, (7.98 + 7.28) / 2 + nz * 0.008);
  // Roof top. Text runs across the cab with its top toward the trailer, so it reads upright from
  // the default camera, which looks north at trucks docked cab-south.
  const top = new THREE.PlaneGeometry(1.36, 0.34);
  top.rotateX(-Math.PI / 2);
  top.translate(0, 3.906, 6.45);
  plateGeo = mergeGeometries([front, top])!;
  plateGeo.computeBoundingSphere();
  return plateGeo;
}

// ---- view ------------------------------------------------------------------------------------------

export function createTruck(opts: TruckOptions): TruckView {
  const object = new THREE.Group();
  object.name = `truck:${opts.label ?? ''}`;
  const mats = createVehicleMaterials(opts.cabColor, opts.trailerColor ?? P.cloud);
  const body = new THREE.Mesh(truckGeometry(opts.variant), mats.body);
  body.customDepthMaterial = mats.depth;
  body.castShadow = true;
  body.receiveShadow = true;
  object.add(body);

  if (opts.carrier && opts.variant !== 'reefer') {
    const livery = new THREE.Mesh(liveryGeometry(), liveryMaterial(opts.carrier));
    livery.receiveShadow = true;
    livery.renderOrder = 1;
    object.add(livery);
  }

  let plateTex: THREE.CanvasTexture | null = null;
  let plateMat: THREE.MeshStandardMaterial | null = null;
  if (opts.label) {
    plateTex = plateTexture(opts.label, { bg: P.cloud, fg: P.midnight, border: P.cobalt }, 256, 64);
    plateMat = decalMaterial(plateTex, false);
    const plate = new THREE.Mesh(plateGeometry(), plateMat);
    plate.receiveShadow = true;
    object.add(plate);
  }

  const lamp = mats.u.uLamp.value;
  lamp[LAMP.marker] = 0.5;
  lamp[LAMP.head] = 0.55;
  lamp[LAMP.brake] = 0.12;
  let brake = false;
  let reversing = false;
  const reefer = opts.variant === 'reefer';
  const phase = Math.random() * 10;

  return {
    object,
    setWheelTravel(m) {
      mats.u.uTravel.value = m;
    },
    setBrakeLights(on) {
      brake = on;
      lamp[LAMP.brake] = on ? 1 : 0.12;
    },
    setReversing(on) {
      reversing = on;
      lamp[LAMP.reverse] = on ? 1 : 0;
      if (!on) lamp[LAMP.blinkLeft] = lamp[LAMP.blinkRight] = 0;
    },
    setRearDoors(t) {
      const c = Math.min(1, Math.max(0, t));
      // Ease so the leaves start and settle gently.
      const e = c * c * (3 - 2 * c);
      mats.u.uDoor.value = e * DOOR_OPEN;
      lamp[LAMP.interior] = 0.16 * Math.min(1, c * 3);
    },
    update(_dt, time) {
      // Hazards blink while reversing (warning on the yard).
      if (reversing) {
        const on = (time + phase) % 0.9 < 0.45 ? 1 : 0;
        lamp[LAMP.blinkLeft] = lamp[LAMP.blinkRight] = on;
      }
      if (reefer) {
        const t = (time + phase) % 2.4;
        lamp[LAMP.status] = t < 0.18 || (t > 0.36 && t < 0.54) ? 1 : 0.12;
      }
      if (brake) lamp[LAMP.brake] = 1;
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
