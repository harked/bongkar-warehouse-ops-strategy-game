/**
 * Warehouse site builder: building shell (with the "lift the lid" roof and lowering walls),
 * dock doors, interior racks and floor paint, yard furniture (fence, gate, lamps, sign).
 * Every coordinate comes from the SiteLayout so trucks, forklifts and pallets line up.
 */
import * as THREE from 'three';
import type { SiteView } from '../core/contracts';
import { DOCK_HEIGHT, RACK, RACK_LEVELS } from '../core/constants';
import { clamp, smoothstep } from '../core/geom';
import { P } from '../core/palette';
import type { DoorLayout, EntityRef, RoadSeg, SiteLayout, V2 } from '../core/types';
import { accentOf, createSiteAtlas, type UVRect } from './labels';
import { Y } from './roads';
import { Batch, clipOutside, decalMaterial, mix, noRaycast, type ORect, vcMaterial } from './util';

// ---- shell dimensions -------------------------------------------------------------------------
const T = 0.4; // wall thickness (inward from the footprint edge)
const DOOR_W = 3.3;
const DOOR_TOP = 4.2; // opening is DOCK_HEIGHT..DOOR_TOP
const LOW_TOP = 4.5; // walls stop here when the lid is open (coping sits on top)
const LID_LIFT = 18;
const CANOPY = { w: 4.2, d: 1.6, y0: 4.25, y1: 4.45 };
const FLOOR_PAINT_Y = DOCK_HEIGHT + 0.006;

const SIGNAL_COLORS: Record<'idle' | 'busy' | 'ready' | 'alert', number> = {
  idle: P.slate,
  busy: P.sunbeam,
  ready: P.mint,
  alert: P.coral,
};

interface Style {
  wall: number;
  rib: number;
  coping: number;
  copingH: number;
  plinth: number;
  roof: number;
  canopy: number;
  upright: number;
  beam: number;
}

function styleOf(kind: SiteLayout['def']['kind']): Style {
  switch (kind) {
    case 'cold':
      return { wall: 0xf2fbff, rib: 0xd3effc, coping: P.frost, copingH: 0.6, plinth: 0xd2deea, roof: 0xf0f8fd, canopy: P.frost, upright: P.azure, beam: 0xe9f6fd };
    case 'crossdock':
      return { wall: 0xffffff, rib: 0xe9f0f8, coping: P.sky, copingH: 0.45, plinth: 0xd5dde8, roof: 0xdceaf7, canopy: P.sky, upright: P.azure, beam: P.sunbeam };
    case 'hub':
      return { wall: 0xffffff, rib: 0xeaf1f7, coping: P.pine, copingH: 0.55, plinth: 0xd5dde8, roof: 0xf2f6fa, canopy: P.fern, upright: P.pine, beam: P.sunbeam };
    default:
      return { wall: 0xffffff, rib: 0xebf1f8, coping: P.cobalt, copingH: 0.7, plinth: 0xd5dde8, roof: 0xf3f7fb, canopy: P.cobalt, upright: P.cobalt, beam: P.sunbeam };
  }
}

export interface SiteShared {
  /** Global static decor (fences, lamps, gate, sign bodies). */
  decor: Batch;
  /** Global translucent fence panels. */
  fencePanels: Batch;
  /** Global ground paint layer. */
  paint: Batch;
  /** Global aprons layer (small extra pads). */
  apron: Batch;
  /** Every road footprint (for fence and decor clipping). */
  roadRects: ORect[];
  /** Highway roads (to find the gate exit). */
  highways: RoadSeg[];
  materials: SiteMaterials;
}

export interface SiteMaterials {
  solid: THREE.MeshStandardMaterial;
  floorPaint: THREE.MeshStandardMaterial;
  signal: THREE.MeshBasicMaterial;
}

export function createSiteMaterials(): SiteMaterials {
  return {
    solid: vcMaterial(),
    floorPaint: decalMaterial(2, { roughness: 0.75 }),
    signal: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
  };
}

// ---- tiny geometry helpers ------------------------------------------------------------------------

/** Textured quad from four 3D corners (TL, TR, BR, BL as seen from the front) into a uv batch. */
function texQuad(b: Batch, c: THREE.Vector3[], r: UVRect, normal: THREE.Vector3): void {
  const g = new THREE.BufferGeometry();
  const [tl, tr, br, bl] = c;
  const pos = [tl, bl, br, tl, br, tr].flatMap((v) => [v.x, v.y, v.z]);
  const uvs = [r.u0, r.v1, r.u0, r.v0, r.u1, r.v0, r.u0, r.v1, r.u1, r.v0, r.u1, r.v1];
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(Array.from({ length: 6 }, () => [normal.x, normal.y, normal.z]).flat(), 3));
  b.addRaw(g, 0xffffff);
}

/** Flat label lying on a horizontal surface. `up` is the reading-up direction on the ground. */
function groundLabel(b: Batch, c: V2, up: V2, w: number, h: number, y: number, r: UVRect): void {
  const rt = { x: -up.z, z: up.x };
  const P3 = (s: number, t: number) => new THREE.Vector3(c.x + rt.x * s + up.x * t, y, c.z + rt.z * s + up.z * t);
  texQuad(b, [P3(-w / 2, h / 2), P3(w / 2, h / 2), P3(w / 2, -h / 2), P3(-w / 2, -h / 2)], r, new THREE.Vector3(0, 1, 0));
}

/** Prism extruded along x from a (z, y) profile (convex, counter-clockwise seen from +x). */
function prismX(profile: [number, number][], x0: number, x1: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(-z, y)));
  const g = new THREE.ExtrudeGeometry(shape, { depth: x1 - x0, bevelEnabled: false });
  g.rotateY(Math.PI / 2);
  g.translate(x0, 0, 0);
  return g;
}

// ---------------------------------------------------------------------------------------------

export function buildSite(site: SiteLayout, shared: SiteShared, parent: THREE.Group): SiteView {
  const { def } = site;
  const st = styleOf(def.kind);
  const { x0, z0, x1, z1 } = site.building.rect;
  const h = site.building.h;
  const topY = h - st.copingH; // wall top under the coping when closed
  const cz = site.building.cz;
  const accent = accentOf(def.kind);
  const siteRef: EntityRef = { kind: 'site', id: site.id };
  const mats = shared.materials;

  const group = new THREE.Group();
  group.name = `site:${site.id}`;
  parent.add(group);

  const decor = shared.decor;
  const shell = new Batch(); // static, pick site
  const upper = new Batch(); // lowers with the lid (local y from 0)
  const coping = new Batch(); // rides on the wall top
  const roof = new Batch(); // floats and fades
  const interiorProps = new Batch();
  const floorPaint = new Batch();
  const atlasB = new Batch(true);
  const roofText = new Batch(true);
  const atlas = createSiteAtlas(site);

  // ---- slab with a clean plinth edge (not pickable: clicks on the open floor reach units) ------
  decor.boxMinMax(x0, 0, z0, x1, DOCK_HEIGHT, z1, 0xf4f8fc);
  const pl = 0.06;
  decor.boxMinMax(x0 - pl, 0, z1 - 0.02, x1 + pl, DOCK_HEIGHT - 0.04, z1 + pl, st.plinth);
  decor.boxMinMax(x0 - pl, 0, z0 - pl, x1 + pl, DOCK_HEIGHT - 0.04, z0 + 0.02, st.plinth);
  decor.boxMinMax(x0 - pl, 0, z0 + 0.02, x0 + 0.02, DOCK_HEIGHT - 0.04, z1 - 0.02, st.plinth);
  decor.boxMinMax(x1 - 0.02, 0, z0 + 0.02, x1 + pl, DOCK_HEIGHT - 0.04, z1 - 0.02, st.plinth);

  // ---- walls ---------------------------------------------------------------------------------------
  const doorsS = site.doors.filter((d) => d.side === 'S');
  const doorsN = site.doors.filter((d) => d.side === 'N');
  const wallH = topY - LOW_TOP;

  /** Lower wall along x at band [za, zb], with door openings. */
  const lowerWallX = (za: number, zb: number, doors: DoorLayout[]) => {
    const xs = doors.map((d) => d.pos.x).sort((a, b) => a - b);
    let cur = x0;
    for (const x of xs) {
      shell.boxMinMax(cur, DOCK_HEIGHT, za, x - DOOR_W / 2, LOW_TOP, zb, st.wall);
      shell.boxMinMax(x - DOOR_W / 2, DOOR_TOP, za, x + DOOR_W / 2, LOW_TOP, zb, st.wall);
      cur = x + DOOR_W / 2;
    }
    shell.boxMinMax(cur, DOCK_HEIGHT, za, x1, LOW_TOP, zb, st.wall);
  };
  lowerWallX(z1 - T, z1, doorsS);
  lowerWallX(z0, z0 + T, doorsN);
  shell.boxMinMax(x0, DOCK_HEIGHT, z0 + T, x0 + T, LOW_TOP, z1 - T, st.wall);
  shell.boxMinMax(x1 - T, DOCK_HEIGHT, z0 + T, x1, LOW_TOP, z1 - T, st.wall);
  // Upper walls (local y 0..wallH).
  upper.boxMinMax(x0, 0, z1 - T, x1, wallH, z1, st.wall);
  upper.boxMinMax(x0, 0, z0, x1, wallH, z0 + T, st.wall);
  upper.boxMinMax(x0, 0, z0 + T, x0 + T, wallH, z1 - T, st.wall);
  upper.boxMinMax(x1 - T, 0, z0 + T, x1, wallH, z1 - T, st.wall);

  // Exterior relief: vertical ribs (or horizontal insulated-panel seams for cold storage).
  const doorXs = site.doors.map((d) => ({ x: d.pos.x, side: d.side }));
  const nearDoor = (x: number, side: 'S' | 'N') => doorXs.some((d) => d.side === side && Math.abs(d.x - x) < CANOPY.w / 2 + 0.2);
  const ribOut = 0.05;
  if (def.kind === 'cold') {
    // Insulated panels: horizontal seams every 1.25 m, plus thin vertical joints.
    for (let y = DOCK_HEIGHT + 1.25; y < topY - 0.2; y += 1.25) {
      const tgt = y < LOW_TOP ? shell : upper;
      const yy = y < LOW_TOP ? y : y - LOW_TOP;
      if (y > LOW_TOP - 0.1 && y < LOW_TOP + 0.1) continue;
      // South and north faces (skip door openings on the lower part).
      for (const [zf, dir, side] of [[z1, 1, 'S'], [z0, -1, 'N']] as const) {
        const zA = dir > 0 ? zf : zf - ribOut, zB = dir > 0 ? zf + ribOut : zf;
        if (y < DOOR_TOP + 0.1) {
          const ds = side === 'S' ? doorsS : doorsN;
          let cur = x0 + 0.05;
          for (const d of [...ds].sort((a, b) => a.pos.x - b.pos.x)) {
            tgt.boxMinMax(cur, yy - 0.05, zA, d.pos.x - CANOPY.w / 2 - 0.1, yy + 0.05, zB, st.rib);
            cur = d.pos.x + CANOPY.w / 2 + 0.1;
          }
          tgt.boxMinMax(cur, yy - 0.05, zA, x1 - 0.05, yy + 0.05, zB, st.rib);
        } else tgt.boxMinMax(x0 + 0.05, yy - 0.05, zA, x1 - 0.05, yy + 0.05, zB, st.rib);
      }
      tgt.boxMinMax(x0 - ribOut, yy - 0.05, z0 + 0.05, x0, yy + 0.05, z1 - 0.05, st.rib);
      tgt.boxMinMax(x1, yy - 0.05, z0 + 0.05, x1 + ribOut, yy + 0.05, z1 - 0.05, st.rib);
    }
  } else {
    const ribEvery = 1.8;
    const ribX = (x: number, zA: number, zB: number, side: 'S' | 'N' | null) => {
      if (side && nearDoor(x, side)) {
        // Above the canopy only.
        upper.boxMinMax(x - 0.07, 0, zA, x + 0.07, wallH, zB, st.rib);
        return;
      }
      shell.boxMinMax(x - 0.07, DOCK_HEIGHT, zA, x + 0.07, LOW_TOP, zB, st.rib);
      upper.boxMinMax(x - 0.07, 0, zA, x + 0.07, wallH, zB, st.rib);
    };
    for (let x = x0 + 1.2; x < x1 - 1.0; x += ribEvery) {
      ribX(x, z1, z1 + ribOut, 'S');
      ribX(x, z0 - ribOut, z0, doorsN.length ? 'N' : null);
    }
    for (let z = z0 + 1.2; z < z1 - 1.0; z += ribEvery) {
      shell.boxMinMax(x0 - ribOut, DOCK_HEIGHT, z - 0.07, x0, LOW_TOP, z + 0.07, st.rib);
      upper.boxMinMax(x0 - ribOut, 0, z - 0.07, x0, wallH, z + 0.07, st.rib);
      shell.boxMinMax(x1, DOCK_HEIGHT, z - 0.07, x1 + ribOut, LOW_TOP, z + 0.07, st.rib);
      upper.boxMinMax(x1, 0, z - 0.07, x1 + ribOut, wallH, z + 0.07, st.rib);
    }
  }
  // Corner posts in the trim colour.
  for (const [px, pz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]]) {
    const sx = px === x0 ? -1 : 1, sz = pz === z0 ? -1 : 1;
    const ax = px + sx * 0.1, az = pz + sz * 0.1;
    shell.boxMinMax(Math.min(px - sx * 0.5, ax), DOCK_HEIGHT, Math.min(pz - sz * 0.5, az), Math.max(px - sx * 0.5, ax), LOW_TOP, Math.max(pz - sz * 0.5, az), mix(st.coping, 0xffffff, 0.15));
    upper.boxMinMax(Math.min(px - sx * 0.5, ax), 0, Math.min(pz - sz * 0.5, az), Math.max(px - sx * 0.5, ax), wallH, Math.max(pz - sz * 0.5, az), mix(st.coping, 0xffffff, 0.15));
  }
  // Clerestory window band on the cross-dock's long walls (upper part).
  if (def.kind === 'crossdock') {
    for (const [zA, zB] of [[z1, z1 + 0.07], [z0 - 0.07, z0]]) {
      for (let x = x0 + 3; x < x1 - 5; x += 7) upper.boxMinMax(x, wallH * 0.3, zA, x + 5, wallH * 0.75, zB, 0xbfe2fa);
    }
  }
  // Coping ring (trim band).
  const co = 0.1;
  coping.boxMinMax(x0 - co, topY, z1 - T - co, x1 + co, h, z1 + co, st.coping);
  coping.boxMinMax(x0 - co, topY, z0 - co, x1 + co, h, z0 + T + co, st.coping);
  coping.boxMinMax(x0 - co, topY, z0 + T + co, x0 + T + co, h, z1 - T - co, st.coping);
  coping.boxMinMax(x1 - T - co, topY, z0 + T + co, x1 + co, h, z1 - T - co, st.coping);

  // ---- per-kind exterior extras (static) ------------------------------------------------------
  if (def.kind === 'dc') buildOffice(shell, decor, shared.paint, site, st);
  if (def.kind === 'cold') buildEngineRoom(shell, site, st);
  // Personnel doors and small windows on the east wall.
  shell.boxMinMax(x1, DOCK_HEIGHT, cz - 1.2 - 6, x1 + 0.08, DOCK_HEIGHT + 2.3, cz + 1.2 - 6, accent);
  shell.boxMinMax(x1, DOCK_HEIGHT + 2.45, cz - 1.6 - 6, x1 + 1.0, DOCK_HEIGHT + 2.6, cz + 1.6 - 6, 0xffffff);
  decor.boxMinMax(x1 + 0.08, 0, cz - 1.4 - 6, x1 + 1.6, DOCK_HEIGHT, cz + 1.4 - 6, 0xe6ebf1);
  for (let i = 0; i < 3; i++) decor.boxMinMax(x1 + 1.6 + i * 0.35, 0, cz - 1.4 - 6, x1 + 1.95 + i * 0.35, DOCK_HEIGHT - (i + 1) * 0.3, cz + 1.4 - 6, 0xe6ebf1);

  // ---- roof --------------------------------------------------------------------------------------
  const fanSpots: THREE.Vector3[] = [];
  buildRoof(roof, roofText, site, st, topY, fanSpots, atlas.roof);

  // ---- docks ---------------------------------------------------------------------------------------
  const doorIndex = new Map<string, number>();
  site.doors.forEach((d, i) => doorIndex.set(d.id, i));
  const dockRef = (i: number): EntityRef | null => (site.doors[i] ? { kind: 'dock', id: site.doors[i].id } : null);

  // Canopy + seals + bumpers + leveler lip, built once in door-local space (+z = out of the wall).
  const unit = new Batch();
  unit.boxMinMax(-CANOPY.w / 2, CANOPY.y0, 0, CANOPY.w / 2, CANOPY.y1, CANOPY.d, st.canopy);
  unit.boxMinMax(-CANOPY.w / 2, CANOPY.y0 - 0.08, CANOPY.d - 0.12, CANOPY.w / 2, CANOPY.y0, CANOPY.d, mix(st.canopy, 0x13296e, 0.15));
  // Dock seal pads either side and over the head.
  const sealC = mix(P.slate, P.ink, 0.12);
  unit.boxMinMax(-DOOR_W / 2 - 0.42, DOCK_HEIGHT + 0.1, 0, -DOOR_W / 2 - 0.02, DOOR_TOP, 0.42, sealC);
  unit.boxMinMax(DOOR_W / 2 + 0.02, DOCK_HEIGHT + 0.1, 0, DOOR_W / 2 + 0.42, DOOR_TOP, 0.42, sealC);
  unit.boxMinMax(-DOOR_W / 2 - 0.42, DOOR_TOP - 0.02, 0, DOOR_W / 2 + 0.42, CANOPY.y0, 0.42, sealC);
  // Yellow guide stripes on the seals.
  unit.boxMinMax(-DOOR_W / 2 - 0.42, DOCK_HEIGHT + 1.4, 0.42, -DOOR_W / 2 - 0.02, DOCK_HEIGHT + 1.6, 0.44, P.sunbeam);
  unit.boxMinMax(DOOR_W / 2 + 0.02, DOCK_HEIGHT + 1.4, 0.42, DOOR_W / 2 + 0.42, DOCK_HEIGHT + 1.6, 0.44, P.sunbeam);
  // Bumpers.
  for (const sx of [-1.15, 1.15]) unit.boxMinMax(sx - 0.2, 0.62, 0, sx + 0.2, 1.1, 0.3, mix(P.ink, P.slate, 0.35));
  // Leveler lip and the frame around the opening.
  unit.boxMinMax(-1.05, DOCK_HEIGHT - 0.06, -T, 1.05, DOCK_HEIGHT + 0.012, 0.22, 0xb7c3d2);
  unit.boxMinMax(-1.05, DOCK_HEIGHT - 0.06, 0.16, 1.05, DOCK_HEIGHT + 0.014, 0.22, P.sunbeam);
  unit.boxMinMax(-DOOR_W / 2, DOCK_HEIGHT, -0.03, -DOOR_W / 2 + 0.12, DOOR_TOP, 0.02, 0xdbe3ec);
  unit.boxMinMax(DOOR_W / 2 - 0.12, DOCK_HEIGHT, -0.03, DOOR_W / 2, DOOR_TOP, 0.02, 0xdbe3ec);
  // Signal light housing on the canopy.
  unit.boxMinMax(1.25, CANOPY.y1, CANOPY.d - 0.75, 1.85, CANOPY.y1 + 0.08, CANOPY.d - 0.15, 0xffffff);
  const unitGeo = unit.geometry();

  const doorMatrices = site.doors.map((d) => {
    const m = new THREE.Matrix4();
    m.compose(new THREE.Vector3(d.pos.x, 0, d.pos.z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), d.side === 'S' ? 0 : Math.PI), new THREE.Vector3(1, 1, 1));
    return m;
  });
  const canopies = new THREE.InstancedMesh(unitGeo, mats.solid, site.doors.length);
  doorMatrices.forEach((m, i) => canopies.setMatrixAt(i, m));
  canopies.castShadow = true;
  canopies.receiveShadow = true;
  canopies.userData.pickInstance = dockRef;
  canopies.computeBoundingSphere();
  group.add(canopies);

  // Roll-up door panels: slatted, anchored at the header, scaled in y as they roll.
  const panel = new Batch();
  const slats = 9;
  for (let i = 0; i < slats; i++) {
    const y1 = -i / slats, y0 = -(i + 1) / slats;
    panel.boxMinMax(-DOOR_W / 2 + 0.06, y0, -T / 2 - 0.05, DOOR_W / 2 - 0.06, y1, -T / 2 + 0.05, i % 2 ? 0xf3f7fb : 0xffffff);
    panel.boxMinMax(-DOOR_W / 2 + 0.06, y0, -T / 2 + 0.05, DOOR_W / 2 - 0.06, y0 + 0.02, -T / 2 + 0.07, 0xd6e0ea);
  }
  // Window strip and a role-coloured kick band.
  panel.boxMinMax(-1.1, -0.42, -T / 2 + 0.05, 1.1, -0.34, -T / 2 + 0.072, 0xbfe2fa);
  const panelGeo = panel.geometry();
  const panels = new THREE.InstancedMesh(panelGeo, mats.solid, site.doors.length);
  panels.castShadow = true;
  panels.receiveShadow = true;
  panels.userData.pickInstance = dockRef;
  const doorOpen = new Float32Array(site.doors.length);
  const tmpM = new THREE.Matrix4();
  const scaleM = new THREE.Matrix4();
  const writePanel = (i: number) => {
    const t = doorOpen[i];
    const hgt = Math.max(0.12, (DOOR_TOP - DOCK_HEIGHT) * (1 - t));
    scaleM.makeScale(1, hgt, 1);
    scaleM.setPosition(0, DOOR_TOP, 0);
    tmpM.multiplyMatrices(doorMatrices[i], scaleM);
    panels.setMatrixAt(i, tmpM);
  };
  site.doors.forEach((_, i) => writePanel(i));
  panels.computeBoundingSphere();
  group.add(panels);
  // Roll drum housing just inside the header (static).
  const drum = new THREE.CylinderGeometry(0.28, 0.28, DOOR_W + 0.2, 12);
  for (const d of site.doors) {
    const zi = d.pos.z - d.normal.z * (T + 0.3);
    shell.add(drum, 0xf1f5f9, d.pos.x, DOOR_TOP + 0.02, zi, 0, 0, Math.PI / 2);
  }

  // Signal pucks.
  const signalGeo = new THREE.CylinderGeometry(0.2, 0.24, 0.22, 14);
  signalGeo.translate(0, 0.11, 0);
  const signals = new THREE.InstancedMesh(signalGeo, mats.signal, site.doors.length);
  signals.userData.pickInstance = dockRef;
  const signalState: ('idle' | 'busy' | 'ready' | 'alert')[] = site.doors.map(() => 'idle');
  const sc = new THREE.Color();
  site.doors.forEach((_, i) => {
    tmpM.makeTranslation(1.55, CANOPY.y1 + 0.08, CANOPY.d - 0.45);
    signals.setMatrixAt(i, new THREE.Matrix4().multiplyMatrices(doorMatrices[i], tmpM));
    signals.setColorAt(i, sc.setHex(SIGNAL_COLORS.idle));
  });
  signals.computeBoundingSphere();
  group.add(signals);

  // Labels: on the canopy top and big yard numbers.
  site.doors.forEach((d, i) => {
    const n = d.normal;
    const up = { x: -n.x, z: -n.z };
    const rt = { x: -up.z, z: up.x };
    const c = { x: d.pos.x + n.x * (CANOPY.d / 2) - rt.x * 0.35, z: d.pos.z + n.z * (CANOPY.d / 2) - rt.z * 0.35 };
    groundLabel(atlasB, c, up, 2.3, 1.15, CANOPY.y1 + 0.005, atlas.plate(i));
    groundLabel(atlasB, { x: d.pos.x, z: d.pos.z + n.z * 20.6 }, up, 4.2, 2.1, Y.paint + 0.01, atlas.ground(i));
  });
  site.queueSpots.forEach((q, i) => {
    const fx = Math.sin(q.heading), fz = Math.cos(q.heading);
    groundLabel(atlasB, { x: q.pos.x - fx * 6.8, z: q.pos.z - fz * 6.8 }, { x: 0, z: -1 }, 2.8, 1.4, Y.paint + 0.01, atlas.queue(i));
  });

  // ---- interior ----------------------------------------------------------------------------------
  const interior = new THREE.Group();
  interior.name = 'interior';
  group.add(interior);
  const racks = buildRacks(site, st);
  if (racks) interior.add(racks);
  buildFloorPaint(floorPaint, interiorProps, site);

  // ---- yard furniture ------------------------------------------------------------------------------
  buildYard(site, shared, atlasB, atlas.sign, accent);

  // ---- assemble meshes ----------------------------------------------------------------------------
  const shellMesh = shell.mesh(mats.solid, { cast: true, receive: true, pickable: true });
  shellMesh.userData.pick = siteRef;
  group.add(shellMesh);

  const upperMesh = upper.mesh(mats.solid, { cast: true, receive: true, pickable: true });
  upperMesh.matrixAutoUpdate = true;
  upperMesh.position.y = LOW_TOP;
  upperMesh.userData.pick = siteRef;
  group.add(upperMesh);

  const copingMesh = coping.mesh(mats.solid, { cast: true, receive: true, pickable: true });
  copingMesh.matrixAutoUpdate = true;
  copingMesh.userData.pick = siteRef;
  group.add(copingMesh);

  const roofMat = vcMaterial({ transparent: true, opacity: 1 });
  const roofGroup = new THREE.Group();
  const roofMesh = roof.mesh(roofMat, { cast: true, receive: true, pickable: true });
  roofMesh.userData.pick = siteRef;
  roofGroup.add(roofMesh);
  // Spinning condenser / HVAC fans.
  let fans: THREE.InstancedMesh | null = null;
  if (fanSpots.length) {
    const fb = new Batch();
    for (let k = 0; k < 4; k++) fb.box(0, 0, 0, 0.16, 0.05, 1.05, 0x8494ab, (k * Math.PI) / 4);
    fb.add(new THREE.CylinderGeometry(0.16, 0.16, 0.1, 10), 0x6b7c96);
    fans = new THREE.InstancedMesh(fb.geometry(), roofMat, fanSpots.length);
    noRaycast(fans);
    fans.castShadow = false;
    roofGroup.add(fans);
  }
  const atlasMat = new THREE.MeshStandardMaterial({
    map: atlas.texture,
    transparent: true,
    depthWrite: false,
    roughness: 0.7,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -8,
  });
  const roofTextMat = atlasMat.clone();
  const roofTextMesh = roofText.mesh(roofTextMat, { cast: false, receive: true });
  roofGroup.add(roofTextMesh);
  group.add(roofGroup);

  const atlasMesh = atlasB.mesh(atlasMat, { cast: false, receive: true });
  atlasMesh.renderOrder = 2;
  group.add(atlasMesh);

  const paintMesh = floorPaint.mesh(mats.floorPaint, { cast: false, receive: true });
  interior.add(paintMesh);
  if (!interiorProps.empty) {
    const pm = interiorProps.mesh(mats.solid, { cast: true, receive: true });
    interior.add(pm);
  }

  // ---- behaviour ----------------------------------------------------------------------------------
  let lid = -1;
  const fanQ = new THREE.Quaternion();
  const fanM = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  const upAxis = new THREE.Vector3(0, 1, 0);
  let fanAngle = 0;
  const writeFans = () => {
    if (!fans) return;
    fanSpots.forEach((p, i) => {
      fanQ.setFromAxisAngle(upAxis, fanAngle * (i % 2 ? 1 : -1.1) + i);
      fanM.compose(p, fanQ, one);
      fans!.setMatrixAt(i, fanM);
    });
    fans.instanceMatrix.needsUpdate = true;
  };
  writeFans();

  const view: SiteView = {
    siteId: site.id,
    layout: site,
    group,
    setLid(tIn) {
      const t = clamp(tIn, 0, 1);
      if (Math.abs(t - lid) < 1e-4) return;
      lid = t;
      // Walls sink first-ish, the roof floats and fades over the same stretch.
      upperMesh.scale.y = Math.max(0.001, 1 - t);
      upperMesh.visible = t < 0.995;
      copingMesh.position.y = -wallH * t;
      const lift = smoothstep(t) * LID_LIFT;
      roofGroup.position.y = lift;
      const op = 1 - smoothstep(t / 0.85);
      roofMat.opacity = op;
      roofTextMat.opacity = op;
      roofMat.depthWrite = op > 0.6;
      roofGroup.visible = op > 0.01;
      roofMesh.castShadow = op > 0.45;
      interior.visible = t > 0.02;
    },
    setDoorOpen(doorId, t) {
      const i = doorIndex.get(doorId);
      if (i === undefined) return;
      const v = clamp(t, 0, 1);
      if (Math.abs(doorOpen[i] - v) < 1e-4) return;
      doorOpen[i] = v;
      writePanel(i);
      panels.instanceMatrix.needsUpdate = true;
    },
    setDoorSignal(doorId, state) {
      const i = doorIndex.get(doorId);
      if (i === undefined || signalState[i] === state) return;
      signalState[i] = state;
      signals.setColorAt(i, sc.setHex(SIGNAL_COLORS[state]));
      signals.instanceColor!.needsUpdate = true;
    },
    update(dt, time) {
      if (fans && roofGroup.visible) {
        fanAngle += dt * 7;
        writeFans();
      }
      // Alert lights pulse gently.
      let any = false;
      for (let i = 0; i < signalState.length; i++) {
        if (signalState[i] !== 'alert') continue;
        any = true;
        const k = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(time * 6));
        sc.setHex(P.coral).multiplyScalar(k).lerp(new THREE.Color(0xffffff), (1 - k) * 0.3);
        signals.setColorAt(i, sc);
      }
      if (any) signals.instanceColor!.needsUpdate = true;
    },
  };
  view.setLid(0);
  return view;
}

// ---- roofs ---------------------------------------------------------------------------------------

function buildRoof(b: Batch, text: Batch, site: SiteLayout, st: Style, topY: number, fans: THREE.Vector3[], banner: UVRect): void {
  const { x0, z0, x1, z1 } = site.building.rect;
  const kind = site.def.kind;
  const ix0 = x0 + T, ix1 = x1 - T, iz0 = z0 + T, iz1 = z1 - T;
  const deck = topY + st.copingH - 0.18; // roof surface, a little below the coping top
  const cx = site.building.cx;
  const r = (seed: number) => {
    let a = seed;
    return () => ((a = (a * 16807) % 2147483647) / 2147483647);
  };

  if (kind === 'crossdock') {
    // Low gable roof, ridge along x, with standing seams and a ridge vent.
    const cz = site.building.cz;
    const rise = 2.4;
    const over = 0.6;
    b.add(prismX([[iz1, topY], [cz, topY + rise], [iz0, topY]], x0 + 0.02, x0 + T), st.wall);
    b.add(prismX([[iz1, topY], [cz, topY + rise], [iz0, topY]], x1 - T, x1 - 0.02), st.wall);
    for (const s of [1, -1]) {
      const zE = s > 0 ? z1 + over : z0 - over;
      const halfRun = Math.abs(zE - cz);
      const yE = topY + rise - (rise * halfRun) / Math.abs(iz1 - cz);
      const slope = Math.atan2(topY + rise - yE, halfRun);
      const len = Math.hypot(halfRun, topY + rise - yE);
      const mz = (zE + cz) / 2, my = (yE + topY + rise) / 2 + 0.14;
      b.add(new THREE.BoxGeometry(1, 1, 1), st.roof, cx, my, mz, s > 0 ? slope : -slope, 0, 0, x1 - x0 + over * 2, 0.26, len);
      for (let x = x0 - over + 1; x < x1 + over - 0.5; x += 2.2) {
        b.add(new THREE.BoxGeometry(1, 1, 1), mix(st.roof, 0x6cb8f0, 0.18), x, my + 0.15 * Math.cos(slope), mz - s * 0.15 * Math.sin(slope), s > 0 ? slope : -slope, 0, 0, 0.1, 0.06, len - 0.1);
      }
      // Banner on the south slope.
      if (s > 0) {
        const bw = Math.min(42, (x1 - x0) * 0.42), bh = bw / 4.85;
        const nrm = new THREE.Vector3(0, Math.cos(slope), Math.sin(slope));
        const along = new THREE.Vector3(0, -Math.sin(slope), Math.cos(slope)); // down-slope
        const ctr = new THREE.Vector3(cx, my, mz).addScaledVector(nrm, 0.27);
        const P3 = (u: number, v: number) => ctr.clone().add(new THREE.Vector3(u, 0, 0)).addScaledVector(along, -v);
        texQuad(text, [P3(-bw / 2, bh / 2), P3(bw / 2, bh / 2), P3(bw / 2, -bh / 2), P3(-bw / 2, -bh / 2)], banner, nrm);
      }
    }
    b.boxMinMax(x0 - over, topY + rise - 0.05, cz - 0.45, x1 + over, topY + rise + 0.35, cz + 0.45, P.sky);
    // Small roof vents along the ridge.
    for (let x = x0 + 8; x < x1 - 6; x += 14) b.add(new THREE.CylinderGeometry(0.45, 0.45, 0.9, 10), 0xe1eaf3, x, topY + rise + 0.7, cz);
    return;
  }

  // Flat deck for everything else.
  b.boxMinMax(ix0, topY, iz0, ix1, deck, iz1, st.roof);
  const rnd = r(site.def.name.length * 977 + 13);

  if (kind === 'hub') {
    // Sawtooth roof: vertical glazing faces north, solar panels on the south-facing slopes.
    const flatZ = iz1 - 13; // flat strip near the yard side for the banner
    const pitch = 8.4;
    const rise = 3.1;
    for (let zA = iz0 + 0.6; zA + pitch <= flatZ + 0.01; zA += pitch) {
      const zB = zA + pitch;
      b.add(prismX([[zB, deck], [zA, deck + rise], [zA, deck]], ix0 + 0.3, ix1 - 0.3), st.wall);
      b.boxMinMax(ix0 + 0.8, deck + 0.35, zA - 0.06, ix1 - 0.8, deck + rise - 0.3, zA + 0.01, 0xa9d6f7);
      for (let x = ix0 + 0.8; x < ix1 - 0.8; x += 0.0 + 6) b.boxMinMax(x, deck + 0.35, zA - 0.08, x + 0.12, deck + rise - 0.3, zA - 0.05, 0xffffff);
      const slope = Math.atan2(rise, pitch);
      const len = Math.hypot(rise, pitch);
      const rows = 3;
      for (let k = 0; k < rows; k++) {
        const t0 = 0.08 + (k / rows) * 0.86, t1 = t0 + 0.86 / rows - 0.03;
        const tm = (t0 + t1) / 2;
        const z = zA + pitch * tm, y = deck + rise * (1 - tm) + 0.1;
        for (let x = ix0 + 1.2; x + 1.9 < ix1 - 1.0; x += 2.05) {
          b.add(new THREE.BoxGeometry(1, 1, 1), 0x2a56e0, x + 0.95, y, z, slope, 0, 0, 1.9, 0.07, len * (t1 - t0));
        }
      }
    }
    // Banner on the flat strip.
    const bw = Math.min(40, (ix1 - ix0) * 0.62), bh = bw / 4.85;
    groundLabel(text, { x: cx, z: iz1 - 6.4 }, { x: 0, z: -1 }, bw, bh, deck + 0.012, banner);
    // A few vents.
    for (let i = 0; i < 4; i++) b.add(new THREE.CylinderGeometry(0.35, 0.35, 0.8, 10), 0xdfe7f0, ix0 + 4 + i * 3, deck + 0.4, iz1 - 2.2);
    return;
  }

  // Banner near the yard-side edge.
  const bw = Math.min(46, (ix1 - ix0) * 0.55), bh = bw / 4.85;
  const bz = iz1 - bh / 2 - 2.2;
  groundLabel(text, { x: cx - (kind === 'dc' ? 8 : 0), z: bz }, { x: 0, z: -1 }, bw, bh, deck + 0.012, banner);
  const bannerRect = { x0: cx - (kind === 'dc' ? 8 : 0) - bw / 2 - 1, x1: cx - (kind === 'dc' ? 8 : 0) + bw / 2 + 1, z0: bz - bh / 2 - 1, z1: bz + bh / 2 + 1 };
  const free = (ax: number, az: number, bx: number, bz2: number) => bx < bannerRect.x0 || ax > bannerRect.x1 || bz2 < bannerRect.z0 || az > bannerRect.z1;

  if (kind === 'dc') {
    // Skylight grid.
    for (let x = ix0 + 6; x < ix1 - 6; x += 9) {
      for (let z = iz0 + 5; z < iz1 - 4; z += 7) {
        if (!free(x - 1.4, z - 0.8, x + 1.4, z + 0.8)) continue;
        b.boxMinMax(x - 1.4, deck, z - 0.8, x + 1.4, deck + 0.22, z + 0.8, 0xffffff);
        b.boxMinMax(x - 1.25, deck + 0.22, z - 0.65, x + 1.25, deck + 0.3, z + 0.65, 0xb7defa);
      }
    }
    // HVAC units with fans.
    const units = [[ix0 + 12, iz0 + 9], [ix0 + 30, iz0 + 9], [ix1 - 20, iz0 + 9], [ix1 - 10, iz1 - 14]];
    for (const [ux, uz] of units) {
      b.boxMinMax(ux - 2.2, deck, uz - 1.4, ux + 2.2, deck + 1.5, uz + 1.4, 0xeef3f8);
      b.boxMinMax(ux - 2.25, deck + 1.5, uz - 1.45, ux + 2.25, deck + 1.6, uz + 1.45, 0xd5dee9);
      for (const fx of [-1.1, 1.1]) {
        b.add(new THREE.CylinderGeometry(0.75, 0.75, 0.16, 16), 0xc6d1df, ux + fx, deck + 1.66, uz);
        fans.push(new THREE.Vector3(ux + fx, deck + 1.76, uz));
      }
    }
    for (let i = 0; i < 10; i++) {
      const x = ix0 + 4 + rnd() * (ix1 - ix0 - 8), z = iz0 + 3 + rnd() * (iz1 - iz0 - 6);
      if (!free(x - 0.5, z - 0.5, x + 0.5, z + 0.5)) continue;
      b.add(new THREE.CylinderGeometry(0.28, 0.32, 0.7, 10), 0xdfe7f0, x, deck + 0.35, z);
      b.add(new THREE.CylinderGeometry(0.42, 0.42, 0.08, 10), 0xc8d3e0, x, deck + 0.74, z);
    }
    return;
  }

  if (kind === 'cold') {
    // Condenser banks with spinning fans, and a pipe rack to the engine room side.
    const rows = [iz0 + 6, iz0 + 15];
    for (const uz of rows) {
      for (let ux = ix0 + 10; ux < ix1 - 8; ux += 13) {
        b.boxMinMax(ux - 4, deck, uz - 1.6, ux + 4, deck + 0.35, uz + 1.6, 0xd2dde9);
        b.boxMinMax(ux - 3.8, deck + 0.35, uz - 1.4, ux + 3.8, deck + 1.7, uz + 1.4, 0xf7fbff);
        b.boxMinMax(ux - 3.85, deck + 0.7, uz + 1.4, ux + 3.85, deck + 0.85, uz + 1.43, P.frost);
        for (const fx of [-1.9, 1.9]) {
          b.add(new THREE.CylinderGeometry(1.05, 1.05, 0.22, 18), 0xbfcddd, ux + fx, deck + 1.8, uz);
          b.add(new THREE.CylinderGeometry(0.9, 0.9, 0.05, 18), 0x8fa0b6, ux + fx, deck + 1.81, uz);
          fans.push(new THREE.Vector3(ux + fx, deck + 1.86, uz));
        }
      }
    }
    for (const pz of [iz0 + 10.2, iz0 + 10.8]) {
      b.add(new THREE.CylinderGeometry(0.16, 0.16, ix1 - ix0 - 6, 8), 0xc8d6e5, cx, deck + 0.55, pz, 0, 0, Math.PI / 2);
    }
    for (let x = ix0 + 4; x < ix1 - 3; x += 6) b.boxMinMax(x - 0.08, deck, iz0 + 10, x + 0.08, deck + 0.55, iz0 + 11, 0xb4c3d5);
    return;
  }
}

// ---- racks ----------------------------------------------------------------------------------------

function buildRacks(site: SiteLayout, st: Style): THREE.InstancedMesh | null {
  if (!site.racks.length) return null;
  const items: { p: [number, number, number]; s: [number, number, number]; c: number }[] = [];
  const top = DOCK_HEIGHT + RACK_LEVELS[RACK_LEVELS.length - 1] + 1.55;
  const frameStep = RACK.slotPitch * RACK.uprightEvery;
  for (const r of site.racks) {
    const zHi = Math.max(r.z0, r.z1), zLo = Math.min(r.z0, r.z1);
    const len = zHi - zLo;
    const n = Math.max(1, Math.round(len / frameStep));
    const step = len / n;
    const hd = RACK.depth / 2;
    for (let k = 0; k <= n; k++) {
      const z = zHi - k * step;
      for (const sx of [-1, 1]) items.push({ p: [r.x + sx * (hd - 0.05), (DOCK_HEIGHT + top) / 2, z], s: [0.1, top - DOCK_HEIGHT, 0.1], c: st.upright });
      // Frame ties between front and back uprights.
      for (const y of [0.35, 2.4, 4.4]) items.push({ p: [r.x, DOCK_HEIGHT + y, z], s: [RACK.depth - 0.1, 0.05, 0.05], c: st.upright });
      // Floor foot plates.
      for (const sx of [-1, 1]) items.push({ p: [r.x + sx * (hd - 0.05), DOCK_HEIGHT + 0.02, z], s: [0.2, 0.04, 0.2], c: mix(st.upright, 0xffffff, 0.3) });
    }
    // Beams under each raised level (pallet bottom sits on the beam top).
    for (const lv of r.levels) {
      if (lv <= 0) continue;
      for (const sx of [-1, 1]) items.push({ p: [r.x + sx * (hd - 0.05), DOCK_HEIGHT + lv - 0.07, (zHi + zLo) / 2], s: [0.08, 0.14, len], c: st.beam });
    }
    // Top beams.
    for (const sx of [-1, 1]) items.push({ p: [r.x + sx * (hd - 0.05), top - 0.06, (zHi + zLo) / 2], s: [0.08, 0.12, len], c: st.beam });
  }
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6 });
  const im = new THREE.InstancedMesh(geo, mat, items.length);
  const m = new THREE.Matrix4();
  const c = new THREE.Color();
  const q = new THREE.Quaternion();
  items.forEach((it, i) => {
    m.compose(new THREE.Vector3(...it.p), q, new THREE.Vector3(...it.s));
    im.setMatrixAt(i, m);
    im.setColorAt(i, c.setHex(it.c));
  });
  im.castShadow = true;
  im.receiveShadow = true;
  im.computeBoundingSphere();
  noRaycast(im);
  return im;
}

// ---- floor paint -------------------------------------------------------------------------------

function buildFloorPaint(b: Batch, props: Batch, site: SiteLayout): void {
  const { x0, z0, x1, z1 } = site.building.rect;
  const y = FLOOR_PAINT_Y;
  const ix0 = x0 + T + 0.05, ix1 = x1 - T - 0.05;
  const kind = site.def.kind;

  // Zone tints first (lowest), then lines on top (same layer, separated by tiny y steps).
  if (kind === 'cold') {
    const frozen = site.slots.filter((s) => s.zone === 'frozen');
    const chill = site.slots.filter((s) => s.zone === 'chill' && s.kind === 'rack');
    const zoneRect = (list: typeof frozen) => {
      const xs = list.map((s) => s.pos.x), zs = list.map((s) => s.pos.z);
      return { ax: Math.min(...xs) - 0.8, bx: Math.max(...xs) + 0.8, az: Math.min(...zs) - 1.1, bz: Math.max(...zs) + 1.1 };
    };
    if (frozen.length) {
      const f = zoneRect(frozen);
      b.rect(f.ax, Math.max(z0 + T + 0.05, f.az - 1.6), f.bx, f.bz + 1.2, y, 0xcdeefe);
      // Frost border.
      b.outline((f.ax + f.bx) / 2, (Math.max(z0 + T + 0.05, f.az - 1.6) + f.bz + 1.2) / 2, f.bx - f.ax, f.bz + 1.2 - Math.max(z0 + T + 0.05, f.az - 1.6), 0.18, y + 0.002, P.frost);
      // Strip-curtain style partition posts at the zone edge (small 3D accents).
      for (let z = f.az; z < f.bz; z += 6) props.boxMinMax(f.bx + 0.15, DOCK_HEIGHT, z, f.bx + 0.3, DOCK_HEIGHT + 0.12, z + 0.15, P.frost);
    }
    if (chill.length) {
      const c = zoneRect(chill);
      b.rect(c.ax, Math.max(z0 + T + 0.05, c.az - 1.6), c.bx, c.bz + 1.2, y, 0xe6f4fd);
    }
  }

  // Cross aisles: a soft band with Sunbeam edge lines.
  for (const zc of site.crossAisles) {
    b.rect(ix0, zc - 2.2, ix1, zc + 2.2, y + 0.001, 0xe6f0fa);
    b.rect(ix0, zc - 2.2, ix1, zc - 2.05, y + 0.003, P.sunbeam);
    b.rect(ix0, zc + 2.05, ix1, zc + 2.2, y + 0.003, P.sunbeam);
  }

  // Aisles.
  for (const a of site.aisles) {
    const za = Math.min(a.z0, a.z1), zb = Math.max(a.z0, a.z1);
    if (kind === 'crossdock') {
      // Flow lanes: lane edges and chevrons pointing from the south (inbound) to the north doors.
      for (const sx of [-1, 1]) b.rect(a.x + sx * 0.95 - 0.06, za, a.x + sx * 0.95 + 0.06, zb, y + 0.003, P.sky);
      for (let z = zb - 1.2; z > za + 0.8; z -= 2.6) {
        b.strip({ x: a.x - 0.5, z: z + 0.35 }, { x: a.x, z: z - 0.15 }, 0.16, y + 0.004, P.azure);
        b.strip({ x: a.x + 0.5, z: z + 0.35 }, { x: a.x, z: z - 0.15 }, 0.16, y + 0.004, P.azure);
      }
    } else {
      for (const sx of [-1, 1]) b.rect(a.x + sx * 1.75 - 0.06, za, a.x + sx * 1.75 + 0.06, zb, y + 0.003, P.sunbeam);
    }
  }

  // Floor storage boxes (cross-dock lanes).
  for (const s of site.slots) {
    if (s.kind !== 'floor') continue;
    b.outline(s.pos.x, s.pos.z, 1.4, 1.35, 0.07, y + 0.004, 0xa9c4e2);
  }

  // Staging boxes per door: inbound Sky, outbound Mint.
  for (const d of site.doors) {
    const col = d.role === 'inbound' ? P.sky : P.mint;
    const tint = d.role === 'inbound' ? 0xe0f0fc : 0xdcf6ec;
    const zs = d.stageSlots.map((s) => s.pos.z);
    const za = Math.min(...zs) - 0.75, zb = Math.max(...zs) + 0.75;
    b.rect(d.pos.x - 3.1, za, d.pos.x + 3.1, zb, y + 0.001, tint);
    for (const s of d.stageSlots) b.outline(s.pos.x, s.pos.z, 1.4, 1.3, 0.08, y + 0.004, col);
    // Dock leveler plate inside the door.
    const zi = d.pos.z - d.normal.z * T;
    b.rect(d.pos.x - 1.05, Math.min(zi, zi - d.normal.z * 2.2), d.pos.x + 1.05, Math.max(zi, zi - d.normal.z * 2.2), y + 0.004, 0xc3cedb);
    b.rect(d.pos.x - 1.05, Math.min(zi - d.normal.z * 2.2, zi - d.normal.z * 2.05), d.pos.x + 1.05, Math.max(zi - d.normal.z * 2.2, zi - d.normal.z * 2.05), y + 0.005, P.sunbeam);
  }

  // Chargers along the west wall: parking box, cabinet with a mint status light.
  for (const c of site.chargers) {
    b.outline(c.pos.x, c.pos.z, 3.7, 1.7, 0.08, y + 0.004, P.mint);
    const zc = c.pos.z + 1.3;
    props.boxMinMax(x0 + T, DOCK_HEIGHT, zc - 0.32, x0 + T + 0.55, DOCK_HEIGHT + 1.45, zc + 0.32, 0xffffff);
    props.boxMinMax(x0 + T + 0.55, DOCK_HEIGHT + 0.95, zc - 0.22, x0 + T + 0.58, DOCK_HEIGHT + 1.3, zc + 0.22, P.mint);
    props.boxMinMax(x0 + T + 0.55, DOCK_HEIGHT + 0.5, zc - 0.22, x0 + T + 0.58, DOCK_HEIGHT + 0.8, zc + 0.22, 0xc5d3e2);
    props.boxMinMax(x0 + T, DOCK_HEIGHT + 1.45, zc - 0.34, x0 + T + 0.6, DOCK_HEIGHT + 1.52, zc + 0.34, P.mint);
  }
  void z1;
}

// ---- per-kind annexes ---------------------------------------------------------------------------

function buildOffice(shell: Batch, decor: Batch, paint: Batch, site: SiteLayout, st: Style): void {
  const { x1, z0 } = site.building.rect;
  // Two-storey office wrapped in glass on the north-east corner.
  const ox0 = x1, ox1 = x1 + 13, oz0 = z0 + 2, oz1 = z0 + 22;
  const top = 8.6;
  shell.boxMinMax(ox0, 0, oz0, ox1, 0.3, oz1, 0xe6ebf1);
  shell.boxMinMax(ox0, 0.3, oz0 + 0.2, ox1 - 0.2, top, oz1 - 0.2, 0xa9d5f6);
  // Floor bands and parapet.
  for (const y of [0.3, 4.3]) shell.boxMinMax(ox0, y, oz0, ox1, y + 0.6, oz1, 0xffffff);
  shell.boxMinMax(ox0, top, oz0, ox1, top + 0.8, oz0 + 0.4, st.coping);
  shell.boxMinMax(ox0, top, oz1 - 0.4, ox1, top + 0.8, oz1, st.coping);
  shell.boxMinMax(ox1 - 0.4, top, oz0 + 0.4, ox1, top + 0.8, oz1 - 0.4, st.coping);
  shell.boxMinMax(ox0, top, oz0 + 0.4, ox1 - 0.4, top + 0.6, oz1 - 0.4, 0xf3f7fb);
  // Mullions.
  for (let x = ox0 + 1.6; x < ox1 - 0.3; x += 1.6) {
    shell.boxMinMax(x - 0.06, 0.3, oz0 + 0.12, x + 0.06, top, oz0 + 0.22, 0xffffff);
    shell.boxMinMax(x - 0.06, 0.3, oz1 - 0.22, x + 0.06, top, oz1 - 0.12, 0xffffff);
  }
  for (let z = oz0 + 1.6; z < oz1 - 0.3; z += 1.6) shell.boxMinMax(ox1 - 0.22, 0.3, z - 0.06, ox1 - 0.12, top, z + 0.06, 0xffffff);
  // Entrance canopy on the east face.
  const ez = (oz0 + oz1) / 2 + 3;
  shell.boxMinMax(ox1, 3.2, ez - 2.2, ox1 + 2.4, 3.45, ez + 2.2, st.coping);
  decor.add(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8), 0xffffff, ox1 + 2.2, 1.6, ez - 2.0);
  decor.add(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8), 0xffffff, ox1 + 2.2, 1.6, ez + 2.0);
  // Rooftop unit.
  shell.boxMinMax(ox0 + 3, top + 0.65, oz0 + 6, ox0 + 7, top + 1.8, oz0 + 9, 0xe9eff5);
  // Small car park east of the office with painted stalls.
  const px0 = ox1 + 4, px1 = ox1 + 14;
  paint.rect(px0, oz0 - 2, px1, oz1 + 6, Y.road - 0.03, 0xe6ebf1);
  for (let z = oz0 - 1.5; z <= oz1 + 5.6; z += 2.8) paint.rect(px0 + 0.5, z - 0.06, px0 + 5.5, z + 0.06, Y.paint, 0xffffff);
  for (let z = oz0 - 1.5; z <= oz1 + 5.6; z += 2.8) paint.rect(px1 - 5.5, z - 0.06, px1 - 0.5, z + 0.06, Y.paint, 0xffffff);
  void st;
}

function buildEngineRoom(shell: Batch, site: SiteLayout, st: Style): void {
  const { x0, z0 } = site.building.rect;
  // Engine room annex on the north-west corner with pipes climbing to the roof.
  const ax0 = x0 - 9, ax1 = x0, az0 = z0 + 3, az1 = z0 + 19;
  shell.boxMinMax(ax0, 0, az0, ax1, 6.5, az1, st.wall);
  shell.boxMinMax(ax0 - 0.08, 6.5, az0 - 0.08, ax1, 7.0, az1 + 0.08, P.frost);
  for (let z = az0 + 1.5; z < az1 - 1; z += 3) shell.boxMinMax(ax0 - 0.06, 3.5, z, ax0, 4.6, z + 1.8, 0xbfe2fa);
  shell.boxMinMax(ax0 - 0.08, 0, az0 + 7, ax0, 2.4, az0 + 9, P.azure);
  // Pipes from the annex up the main wall.
  for (const dz of [5, 6, 7]) {
    shell.add(new THREE.CylinderGeometry(0.16, 0.16, site.building.h - 6.2, 8), 0xc8d6e5, x0 - 0.35, 6.5 + (site.building.h - 6.2) / 2 - 0.3, az0 + dz);
  }
  // Outdoor condenser bank beside the annex.
  shell.boxMinMax(ax0 - 1, 0, az1 + 2, ax0 + 6, 1.8, az1 + 5, 0xf3f9fe);
  for (const x of [ax0 + 0.8, ax0 + 3, ax0 + 5.2]) shell.add(new THREE.CylinderGeometry(0.85, 0.85, 0.1, 16), 0x9fb0c4, x, 1.85, az1 + 3.5);
}

// ---- yard: fence, gate, lamps, bollards, sign -----------------------------------------------

function buildYard(site: SiteLayout, shared: SiteShared, atlasB: Batch, signUV: UVRect, accent: number): void {
  const d = shared.decor;
  const { x0, z0, x1, z1 } = site.bounds;
  const b = site.building.rect;

  // Gate exit: walk the spur that starts at the gate until it leaves the fence rectangle.
  const spur = shared.highways.find((r) => r.kind === 'spur' && Math.hypot(r.points[0].x - site.gate.x, r.points[0].z - site.gate.z) < 0.5);
  let exit: V2 = { ...site.gate };
  let dir: V2 = { x: 1, z: 0 };
  let roadW = 9;
  if (spur) {
    roadW = spur.width;
    outer: for (let i = 1; i < spur.points.length; i++) {
      const a = spur.points[i - 1], c = spur.points[i];
      const len = Math.hypot(c.x - a.x, c.z - a.z);
      for (let s = 0; s <= len; s += 0.25) {
        const p = { x: a.x + ((c.x - a.x) * s) / len, z: a.z + ((c.z - a.z) * s) / len };
        if (p.x > x1 + 0.01 || p.x < x0 - 0.01 || p.z > z1 + 0.01 || p.z < z0 - 0.01) {
          dir = { x: (c.x - a.x) / len, z: (c.z - a.z) / len };
          exit = { x: Math.min(x1, Math.max(x0, p.x)), z: Math.min(z1, Math.max(z0, p.z)) };
          break outer;
        }
      }
    }
  }
  const left = { x: dir.z, z: -dir.x };

  // Fence with posts, two rails and translucent mesh panels; cut where roads pass.
  const sides: [V2, V2][] = [
    [{ x: x0, z: z0 }, { x: x1, z: z0 }],
    [{ x: x1, z: z0 }, { x: x1, z: z1 }],
    [{ x: x1, z: z1 }, { x: x0, z: z1 }],
    [{ x: x0, z: z1 }, { x: x0, z: z0 }],
  ];
  const postC = 0xd2dbe6;
  for (const [a, c] of sides) {
    for (const [p, q] of clipOutside(a, c, shared.roadRects, 1.6)) {
      const len = Math.hypot(q.x - p.x, q.z - p.z);
      const n = Math.max(1, Math.round(len / 3));
      for (let i = 0; i <= n; i++) {
        const x = p.x + ((q.x - p.x) * i) / n, z = p.z + ((q.z - p.z) * i) / n;
        d.box(x, 1.05, z, 0.14, 2.1, 0.14, i === 0 || i === n ? accent : postC);
      }
      d.segBox(p, q, 0.07, 1.93, 2.03, postC);
      d.segBox(p, q, 0.06, 0.18, 0.26, postC);
      shared.fencePanels.segBox(p, q, 0.03, 0.26, 1.93, 0xd6eafb);
    }
  }

  // Gate: boom barrier (raised) and a guard booth on the outside of the road.
  const hw = roadW / 2;
  const post = { x: exit.x + left.x * (hw + 0.6) + dir.x * 1.2, z: exit.z + left.z * (hw + 0.6) + dir.z * 1.2 };
  d.box(post.x, 0.6, post.z, 0.5, 1.2, 0.5, 0xffffff);
  d.box(post.x, 1.25, post.z, 0.56, 0.1, 0.56, accent);
  // Raised arm: pivot near the post top, angled up over the road side.
  const armLen = roadW - 0.6;
  const ang = 1.15;
  const ax = -left.x, az = -left.z; // arm points across the road
  const arm = new THREE.BoxGeometry(0.16, 0.16, armLen / 6);
  const segN = 6;
  const armQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(-ang, Math.atan2(ax, az), 0, 'YXZ'));
  for (let i = 0; i < segN; i++) {
    const tm = (i + 0.5) / segN;
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(post.x + ax * Math.cos(ang) * armLen * tm, 1.2 + Math.sin(ang) * armLen * tm, post.z + az * Math.cos(ang) * armLen * tm),
      armQ,
      new THREE.Vector3(1, 1, 1),
    );
    d.addMatrix(arm, i % 2 ? P.coral : 0xffffff, m);
  }
  const booth = { x: exit.x + left.x * (hw + 3.6) + dir.x * 2.5, z: exit.z + left.z * (hw + 3.6) + dir.z * 2.5 };
  d.box(booth.x, 0.15, booth.z, 3.4, 0.3, 3.4, 0xe6ebf1);
  d.box(booth.x, 1.6, booth.z, 2.6, 2.6, 2.6, 0xffffff);
  d.box(booth.x, 1.95, booth.z, 2.64, 1.0, 2.2, 0xa9d5f6);
  d.box(booth.x, 1.95, booth.z, 2.2, 1.0, 2.64, 0xa9d5f6);
  d.box(booth.x, 3.0, booth.z, 3.2, 0.25, 3.2, accent);
  for (const s of [-1, 1]) d.add(new THREE.CylinderGeometry(0.14, 0.14, 1.0, 10), P.sunbeam, booth.x + s * 1.9 * dir.x, 0.5, booth.z + s * 1.9 * dir.z);

  // Lamp posts along the yard fences and the building ends.
  const lamp = (x: number, z: number, armDir: V2) => {
    d.add(new THREE.CylinderGeometry(0.11, 0.16, 8.5, 8), 0xc9d3df, x, 4.25, z);
    d.box(x + armDir.x * 0.8, 8.4, z + armDir.z * 0.8, Math.abs(armDir.x) > 0.5 ? 1.7 : 0.1, 0.1, Math.abs(armDir.z) > 0.5 ? 1.7 : 0.1, 0xc9d3df);
    d.box(x + armDir.x * 1.6, 8.3, z + armDir.z * 1.6, Math.abs(armDir.x) > 0.5 ? 0.9 : 0.45, 0.2, Math.abs(armDir.z) > 0.5 ? 0.9 : 0.45, 0xffffff);
    d.box(x, 0.12, z, 0.5, 0.24, 0.5, 0xd2dbe6);
  };
  for (let x = x0 + 8; x < x1 - 14; x += 26) lamp(x, z1 - 1.6, { x: 0, z: -1 });
  const hasN = site.doors.some((dd) => dd.side === 'N');
  if (hasN) for (let x = x0 + 8; x < x1 - 14; x += 26) lamp(x, z0 + 1.6, { x: 0, z: 1 });
  lamp(x0 + 1.6, (b.z0 + b.z1) / 2, { x: 1, z: 0 });

  // Bollards guarding building corners on the dock sides.
  const bollard = (x: number, z: number) => {
    d.add(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 10), P.sunbeam, x, 0.55, z);
    d.add(new THREE.CylinderGeometry(0.165, 0.165, 0.12, 10), 0xffffff, x, 0.8, z);
  };
  for (const zEdge of hasN ? [b.z1 + 0.9, b.z0 - 0.9] : [b.z1 + 0.9]) {
    for (const xx of [b.x0 + 0.6, b.x0 + 1.6, b.x1 - 0.6, b.x1 - 1.6]) bollard(xx, zEdge);
  }

  // Gate sign: a white monument facing the main road, outside the fence near the gate.
  const sx = Math.max(x0 + 8, x1 - 24), sz = z1 + 3.2;
  const SW = 9, SH = SW / 4.2;
  d.box(sx, 0.25, sz, SW + 1.4, 0.5, 1.4, 0xe6ebf1);
  d.box(sx, 0.5 + 0.5 + SH / 2, sz, SW + 0.5, SH + 1.0, 0.5, 0xffffff);
  d.box(sx, 0.5 + 0.25, sz, SW + 0.5, 0.5, 0.52, accent);
  const fz = sz + 0.26;
  const yb = 1.0 + 0.5 - 0.25;
  texQuad(
    atlasB,
    [
      new THREE.Vector3(sx - SW / 2, yb + SH, fz),
      new THREE.Vector3(sx + SW / 2, yb + SH, fz),
      new THREE.Vector3(sx + SW / 2, yb, fz),
      new THREE.Vector3(sx - SW / 2, yb, fz),
    ],
    signUV,
    new THREE.Vector3(0, 0, 1),
  );
  // Little planter either side of the sign.
  for (const s of [-1, 1]) {
    d.box(sx + s * (SW / 2 + 1.6), 0.3, sz + 0.2, 1.4, 0.6, 1.4, 0xffffff);
    d.add(new THREE.IcosahedronGeometry(0.75, 0), P.fern, sx + s * (SW / 2 + 1.6), 1.05, sz + 0.2);
  }
}
