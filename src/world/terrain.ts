/**
 * The diorama island: outline, height field (flat where sites and roads are, gentle low-poly
 * hills elsewhere), river near Riverside, chunky cliff with strata, Lagoon sea, trees, clouds.
 */
import * as THREE from 'three';
import { rng, smoothstep } from '../core/geom';
import { P } from '../core/palette';
import type { RoadSeg, V2, WorldLayout } from '../core/types';
import { Batch, distToPolyline, distToRect, mix, noRaycast, vcMaterial } from './util';

export const SEA_Y = -15;
export const WATER_Y = -0.45;
const RIVER_W = 16;

/** Island centre and half extents (polar superellipse). */
const IC = { x: 0, z: -45 };
const IA = 528;
const IB = 292;
const IN = 4.2;

export function islandRadius(phi: number): number {
  const c = Math.abs(Math.cos(phi)), s = Math.abs(Math.sin(phi));
  const base = 1 / Math.pow(Math.pow(c / IA, IN) + Math.pow(s / IB, IN), 1 / IN);
  const wob = 1 + 0.011 * Math.sin(3 * phi + 1.3) + 0.007 * Math.sin(7 * phi + 0.4) + 0.004 * Math.sin(17 * phi + 2.1);
  return base * wob;
}

export function islandPoint(phi: number, inset = 0): V2 {
  const r = islandRadius(phi) - inset;
  return { x: IC.x + Math.cos(phi) * r, z: IC.z + Math.sin(phi) * r };
}

/** Distance from p to the island edge (positive inside), measured along the radial ray. */
export function edgeDistance(p: V2): number {
  const dx = p.x - IC.x, dz = p.z - IC.z;
  return islandRadius(Math.atan2(dz, dx)) - Math.hypot(dx, dz);
}

/** x where a horizontal line at z leaves the island on the east (+1) or west (-1). */
export function islandEdgeX(z: number, side: 1 | -1): number {
  let lo = 0, hi = 700 * side;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (edgeDistance({ x: mid, z }) > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** River centreline near Riverside, north pond to south waterfall. */
export const RIVER: V2[] = [
  { x: 400, z: -262 },
  { x: 394, z: -238 },
  { x: 382, z: -200 },
  { x: 392, z: -150 },
  { x: 407, z: -100 },
  { x: 398, z: -45 },
  { x: 384, z: 10 },
  { x: 390, z: 70 },
  { x: 400, z: 115 },
  { x: 398, z: 165 },
  { x: 386, z: 210 },
  { x: 384, z: 280 },
];
const POND = { x: 401, z: -258, r: 22 };

export interface TerrainCtx {
  height(x: number, z: number): number;
  flatDist(x: number, z: number): number;
  riverDist(x: number, z: number): number;
}

export function makeTerrainCtx(layout: WorldLayout): TerrainCtx {
  const roads: RoadSeg[] = [...layout.roads, ...layout.sites.flatMap((s) => s.roads)];
  const siteRects = layout.sites.map((s) => s.bounds);
  const r = rng(7);
  // Deterministic hills, only accepted in free land.
  const hills: { x: number; z: number; r: number; h: number }[] = [];
  const pre = (x: number, z: number) => {
    let d = Infinity;
    for (const b of siteRects) d = Math.min(d, distToRect({ x, z }, b));
    for (const rd of roads) d = Math.min(d, distToPolyline({ x, z }, rd.points) - rd.width / 2);
    return d;
  };
  for (let tries = 0; hills.length < 46 && tries < 3000; tries++) {
    const x = -500 + r() * 1000, z = -330 + r() * 570;
    const rad = 28 + r() * 46;
    const p = { x, z };
    if (edgeDistance(p) < rad * 0.6 + 20) continue;
    if (pre(x, z) < rad * 0.7 + 18) continue;
    if (distToPolyline(p, RIVER) < rad * 0.6 + 26) continue;
    hills.push({ x, z, r: rad * 1.15, h: 6 + r() * 14 + (z < -150 ? 8 : 0) });
  }

  const flatDist = (x: number, z: number) => pre(x, z);
  const riverDist = (x: number, z: number) => {
    const p = { x, z };
    return Math.min(distToPolyline(p, RIVER), Math.hypot(x - POND.x, z - POND.z) - POND.r + RIVER_W / 2);
  };
  const height = (x: number, z: number) => {
    let h = 0;
    for (const hl of hills) {
      const d2 = ((x - hl.x) ** 2 + (z - hl.z) ** 2) / (hl.r * hl.r);
      if (d2 < 4) h += hl.h * Math.exp(-d2 * 1.6);
    }
    h += 0.8 * Math.sin(x * 0.031 + 1.1) * Math.sin(z * 0.027 + 0.4) + 0.5 * Math.sin(x * 0.07 + z * 0.05);
    const fd = flatDist(x, z);
    const rd = riverDist(x, z);
    const mask = smoothstep((fd - 6) / 42) * smoothstep((rd - RIVER_W / 2 - 6) / 30) * smoothstep((edgeDistance({ x, z }) - 8) / 45);
    h = Math.max(0, h);
    h = 26 * Math.tanh(h / 26);
    h *= mask;
    // River channel.
    const half = RIVER_W / 2;
    if (rd < half + 7) {
      const carve = -1.7 + 1.7 * smoothstep((rd - half + 2) / 8);
      h = Math.min(h, carve);
    }
    return h;
  };
  return { height, flatDist, riverDist };
}

// ---------------------------------------------------------------------------------------------

export function buildTerrain(layout: WorldLayout, ctx: TerrainCtx, group: THREE.Group): void {
  const mat = vcMaterial({ flatShading: true, roughness: 0.95 });

  // ---- top surface: grid projected onto the outline -------------------------------------------
  const cell = 5;
  const x0 = IC.x - IA - 30, x1 = IC.x + IA + 30, z0 = IC.z - IB - 30, z1 = IC.z + IB + 30;
  const nx = Math.ceil((x1 - x0) / cell), nz = Math.ceil((z1 - z0) / cell);
  const vx: number[] = [], vy: number[] = [], vz: number[] = [], vin: boolean[] = [];
  for (let j = 0; j <= nz; j++) {
    for (let i = 0; i <= nx; i++) {
      let x = x0 + i * cell, z = z0 + j * cell;
      const dx = x - IC.x, dz = z - IC.z;
      const phi = Math.atan2(dz, dx);
      const R = islandRadius(phi) - 1.5;
      const rho = Math.hypot(dx, dz);
      const inside = rho <= R;
      if (!inside) {
        x = IC.x + Math.cos(phi) * R;
        z = IC.z + Math.sin(phi) * R;
      }
      vx.push(x);
      vz.push(z);
      vy.push(inside ? ctx.height(x, z) : Math.min(0, ctx.height(x, z)));
      vin.push(inside);
    }
  }
  const noise = rng(11);
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const tint = (x: number, y: number, z: number): number => {
    // Gentle patchwork of meadow tones, lighter on hill tops, fern on the river banks.
    const n = 0.5 + 0.5 * Math.sin(x * 0.045 + Math.sin(z * 0.03) * 2) * Math.cos(z * 0.05 + x * 0.01);
    let hex = mix(P.meadow, 0xbde6a3, n * 0.55);
    if (y > 4) hex = mix(hex, 0xc4e9ab, Math.min(1, (y - 4) / 16));
    if (y < -0.05) hex = mix(hex, y < -1.0 ? 0x9fcbe0 : P.fern, Math.min(1, -y / 0.6));
    return hex;
  };
  const W = nx + 1;
  for (let j = 0; j < nz; j++) {
    for (let i = 0; i < nx; i++) {
      const a = j * W + i, b = a + 1, d = a + W, e = d + 1;
      if (!vin[a] && !vin[b] && !vin[d] && !vin[e]) continue;
      const flip = (i + j) % 2 === 0;
      const tris = flip ? [[a, d, b], [b, d, e]] : [[a, d, e], [a, e, b]];
      for (const t of tris) {
        // Skip degenerate triangles (all projected onto the outline).
        const ax = vx[t[0]], az = vz[t[0]], bx = vx[t[1]], bz = vz[t[1]], cx = vx[t[2]], cz = vz[t[2]];
        const area = (bx - ax) * (cz - az) - (cx - ax) * (bz - az);
        if (Math.abs(area) < 0.05) continue;
        const my = (vy[t[0]] + vy[t[1]] + vy[t[2]]) / 3;
        c.setHex(tint((ax + bx + cx) / 3, my, (az + bz + cz) / 3));
        const jitter = (noise() - 0.5) * 0.025;
        for (const k of t) {
          pos.push(vx[k], vy[k], vz[k]);
          col.push(c.r * (1 + jitter), c.g * (1 + jitter), c.b * (1 + jitter));
        }
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.computeVertexNormals();
  const ground = new THREE.Mesh(g, mat);
  ground.receiveShadow = true;
  ground.castShadow = true;
  ground.matrixAutoUpdate = false;
  noRaycast(ground);
  group.add(ground);

  // ---- cliff with strata bands, and a raised turf rim that hides the grid seam ----------------
  const trunk = layout.roads.find((r) => r.kind === 'trunk')!;
  const N = 720;
  const bands: { y: number; out: number; color: number }[] = [
    { y: 0, out: 0, color: 0x8fca78 },
    { y: -0.8, out: 0.55, color: 0x8fca78 },
    { y: -0.8, out: 0.55, color: 0xa08f99 },
    { y: -3.8, out: 0.0, color: 0xa08f99 },
    { y: -3.8, out: 0.0, color: 0xb9c2d3 },
    { y: -6.8, out: 0.8, color: 0xb9c2d3 },
    { y: -6.8, out: 0.8, color: 0x93a1b8 },
    { y: -11, out: 0.1, color: 0x93a1b8 },
    { y: -11, out: 0.1, color: 0x7d8ca6 },
    { y: -18, out: 1.2, color: 0x7d8ca6 },
  ];
  const jr = rng(21);
  const jit: number[][] = bands.map(() => Array.from({ length: N }, () => (jr() - 0.5) * 1.4));
  const jid = bands.map((bd) => bands.findIndex((o) => o.y === bd.y));
  const cpos: number[] = [];
  const ccol: number[] = [];
  const rimTop: number[] = [];
  const pts: V2[] = [];
  const outs: V2[] = [];
  for (let i = 0; i < N; i++) {
    const phi = (i / N) * Math.PI * 2;
    pts.push(islandPoint(phi, 0));
    outs.push({ x: Math.cos(phi), z: Math.sin(phi) });
    const p = pts[i];
    const onRoad = Math.abs(p.z - trunk.points[0].z) < trunk.width / 2 + 3;
    rimTop.push(onRoad ? 0.02 : Math.min(0, ctx.height(p.x, p.z)) + 0.32);
  }
  const push = (x: number, y: number, z: number, hex: number) => {
    c.setHex(hex);
    cpos.push(x, y, z);
    ccol.push(c.r, c.g, c.b);
  };
  for (let i = 0; i < N; i++) {
    const k = (i + 1) % N;
    for (let b = 0; b < bands.length - 1; b++) {
      const A = bands[b], B = bands[b + 1];
      if (A.y === B.y) continue;
      const ya = b === 0 ? rimTop : null;
      const ja = jit[jid[b]], jb = jit[jid[b + 1]];
      const yA0 = ya ? ya[i] : A.y + ja[i] * 0.25;
      const yA1 = ya ? ya[k] : A.y + ja[k] * 0.25;
      const lastB = b + 1 === bands.length - 1;
      const yB0 = B.y + (lastB ? 0 : jb[i] * 0.25);
      const yB1 = B.y + (lastB ? 0 : jb[k] * 0.25);
      const oa0 = A.out + (b > 0 ? ja[i] * 0.6 : 0), oa1 = A.out + (b > 0 ? ja[k] * 0.6 : 0);
      const ob0 = B.out + jb[i] * 0.6, ob1 = B.out + jb[k] * 0.6;
      const p0 = pts[i], p1 = pts[k], n0 = outs[i], n1 = outs[k];
      const a0 = [p0.x + n0.x * oa0, yA0, p0.z + n0.z * oa0];
      const a1 = [p1.x + n1.x * oa1, yA1, p1.z + n1.z * oa1];
      const b0 = [p0.x + n0.x * ob0, yB0, p0.z + n0.z * ob0];
      const b1 = [p1.x + n1.x * ob1, yB1, p1.z + n1.z * ob1];
      const colr = A.color;
      // Outward facing: a0, b0, a1 / a1, b0, b1 (counter-clockwise seen from outside).
      push(a0[0], a0[1], a0[2], colr);
      push(a1[0], a1[1], a1[2], colr);
      push(b0[0], b0[1], b0[2], colr);
      push(a1[0], a1[1], a1[2], colr);
      push(b1[0], b1[1], b1[2], colr);
      push(b0[0], b0[1], b0[2], colr);
    }
    // Rim cap: 3.5 m strip inward at rim height, plus the little inner step.
    const p0 = pts[i], p1 = pts[k];
    const q0 = islandPoint((i / N) * Math.PI * 2, 3.5), q1 = islandPoint((k / N) * Math.PI * 2, 3.5);
    const rc = 0x9ad283;
    push(p0.x, rimTop[i], p0.z, rc);
    push(q0.x, rimTop[i], q0.z, rc);
    push(p1.x, rimTop[k], p1.z, rc);
    push(p1.x, rimTop[k], p1.z, rc);
    push(q0.x, rimTop[i], q0.z, rc);
    push(q1.x, rimTop[k], q1.z, rc);
    const yb0 = Math.min(0, ctx.height(q0.x, q0.z)) - 0.05, yb1 = Math.min(0, ctx.height(q1.x, q1.z)) - 0.05;
    push(q0.x, rimTop[i], q0.z, rc);
    push(q0.x, yb0, q0.z, rc);
    push(q1.x, rimTop[k], q1.z, rc);
    push(q1.x, rimTop[k], q1.z, rc);
    push(q0.x, yb0, q0.z, rc);
    push(q1.x, yb1, q1.z, rc);
  }
  const cg = new THREE.BufferGeometry();
  cg.setAttribute('position', new THREE.Float32BufferAttribute(cpos, 3));
  cg.setAttribute('color', new THREE.Float32BufferAttribute(ccol, 3));
  cg.computeVertexNormals();
  const cliff = new THREE.Mesh(cg, mat);
  cliff.receiveShadow = true;
  cliff.matrixAutoUpdate = false;
  noRaycast(cliff);
  group.add(cliff);

  buildSea(group);
  buildRiver(ctx, group);
}

// ---- sea ---------------------------------------------------------------------------------------

function buildSea(group: THREE.Group): void {
  // Rings of the island outline pushed outwards: shallow bright water near the cliff,
  // a soft foam line right at the base, Lagoon further out.
  const rings: { off: number; color: number }[] = [
    { off: -6, color: 0xf4fbff },
    { off: 1.5, color: 0xf4fbff },
    { off: 5, color: 0xc4ecfb },
    { off: 30, color: 0xa6e0f8 },
    { off: 120, color: P.lagoon },
    { off: 600, color: P.lagoon },
    { off: 5000, color: 0x9bd8f5 },
  ];
  const N = 360;
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  const ringPt = (i: number, off: number) => {
    const phi = (i / N) * Math.PI * 2;
    const r = islandRadius(phi) + off;
    return [IC.x + Math.cos(phi) * r, IC.z + Math.sin(phi) * r];
  };
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < N; i++) {
      const k = (i + 1) % N;
      const a0 = ringPt(i, rings[r].off), a1 = ringPt(k, rings[r].off);
      const b0 = ringPt(i, rings[r + 1].off), b1 = ringPt(k, rings[r + 1].off);
      const ca = rings[r].color, cb = rings[r + 1].color;
      const v = (p: number[], hex: number) => {
        c.setHex(hex);
        pos.push(p[0], SEA_Y, p[1]);
        col.push(c.r, c.g, c.b);
      };
      // Up-facing winding: phi increases counter-clockwise in x/z which is clockwise seen from +y.
      v(a0, ca);
      v(a1, ca);
      v(b0, cb);
      v(a1, ca);
      v(b1, cb);
      v(b0, cb);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  const sea = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0, side: THREE.DoubleSide }));
  sea.receiveShadow = true;
  sea.matrixAutoUpdate = false;
  noRaycast(sea);
  group.add(sea);
}

// ---- river -------------------------------------------------------------------------------------

let riverTex: THREE.CanvasTexture | null = null;

function rippleTexture(): THREE.CanvasTexture {
  const cv = document.createElement('canvas');
  cv.width = 64;
  cv.height = 256;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#9edcf6';
  g.fillRect(0, 0, 64, 256);
  const r = rng(5);
  for (let i = 0; i < 14; i++) {
    const x = 6 + r() * 52, y = r() * 256, len = 10 + r() * 26;
    g.strokeStyle = `rgba(255,255,255,${0.22 + r() * 0.25})`;
    g.lineWidth = 1.5 + r() * 1.5;
    g.lineCap = 'round';
    for (const off of [0, 256, -256]) {
      g.beginPath();
      g.moveTo(x, y + off);
      g.lineTo(x + (r() - 0.5) * 2, y + len + off);
      g.stroke();
    }
  }
  const t = new THREE.CanvasTexture(cv);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function buildRiver(ctx: TerrainCtx, group: THREE.Group): void {
  // Densify centreline, cut at the island edge, then extend into a waterfall to the sea.
  const pts: V2[] = [];
  for (let i = 1; i < RIVER.length; i++) {
    const a = RIVER[i - 1], b = RIVER[i];
    const n = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 4);
    for (let k = 0; k < n; k++) pts.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  // Smooth with a simple moving average.
  const sm = pts.map((_p, i) => {
    let sx = 0, sz = 0, n = 0;
    for (let k = -3; k <= 3; k++) {
      const q = pts[Math.min(pts.length - 1, Math.max(0, i + k))];
      sx += q.x;
      sz += q.z;
      n++;
    }
    return { x: sx / n, z: sz / n };
  });
  const inside = sm.filter((p) => edgeDistance(p) > 1.2);
  const last = inside[inside.length - 1];
  const prev = inside[inside.length - 2];
  const dir = { x: last.x - prev.x, z: last.z - prev.z };
  const dl = Math.hypot(dir.x, dir.z);
  dir.x /= dl;
  dir.z /= dl;
  // Step to the actual outline.
  let lip = { ...last };
  for (let s = 0; s < 30 && edgeDistance(lip) > -0.6; s += 0.2) lip = { x: last.x + dir.x * s, z: last.z + dir.z * s };
  inside.push(lip);

  const w = RIVER_W + 9;
  const pos: number[] = [];
  const uv: number[] = [];
  let v = 0;
  const side = (i: number) => {
    const a = inside[Math.max(0, i - 1)], b = inside[Math.min(inside.length - 1, i + 1)];
    let tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    tx /= l;
    tz /= l;
    return { x: -tz, z: tx };
  };
  for (let i = 0; i < inside.length - 1; i++) {
    const a = inside[i], b = inside[i + 1];
    const sa = side(i), sb = side(i + 1);
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    const v1 = v + seg / 24;
    const hw = w / 2;
    const L0 = [a.x - sa.x * hw, a.z - sa.z * hw], R0 = [a.x + sa.x * hw, a.z + sa.z * hw];
    const L1 = [b.x - sb.x * hw, b.z - sb.z * hw], R1 = [b.x + sb.x * hw, b.z + sb.z * hw];
    const quad = [
      [L0, 0, v],
      [R0, 1, v],
      [L1, 0, v1],
      [R0, 1, v],
      [R1, 1, v1],
      [L1, 0, v1],
    ] as const;
    for (const [p, u, vv] of quad) {
      pos.push(p[0], WATER_Y, p[1]);
      uv.push(u, vv);
    }
    v = v1;
  }
  // Fix winding to face up.
  for (let i = 0; i < pos.length; i += 9) {
    const ux = pos[i + 3] - pos[i], uz = pos[i + 5] - pos[i + 2];
    const vx2 = pos[i + 6] - pos[i], vz2 = pos[i + 8] - pos[i + 2];
    if (uz * vx2 - ux * vz2 < 0) {
      for (let k = 0; k < 3; k++) [pos[i + 3 + k], pos[i + 6 + k]] = [pos[i + 6 + k], pos[i + 3 + k]];
      [uv[(i / 3) * 2 + 2], uv[(i / 3) * 2 + 4]] = [uv[(i / 3) * 2 + 4], uv[(i / 3) * 2 + 2]];
      [uv[(i / 3) * 2 + 3], uv[(i / 3) * 2 + 5]] = [uv[(i / 3) * 2 + 5], uv[(i / 3) * 2 + 3]];
    }
  }
  // Pond.
  const pc = { x: POND.x, z: POND.z };
  const PN = 28;
  for (let i = 0; i < PN; i++) {
    const a0 = (i / PN) * Math.PI * 2, a1 = ((i + 1) / PN) * Math.PI * 2;
    const r0 = POND.r * (1 + 0.08 * Math.sin(a0 * 3)), r1 = POND.r * (1 + 0.08 * Math.sin(a1 * 3));
    pos.push(pc.x, WATER_Y, pc.z, pc.x + Math.cos(a1) * r1, WATER_Y, pc.z + Math.sin(a1) * r1, pc.x + Math.cos(a0) * r0, WATER_Y, pc.z + Math.sin(a0) * r0);
    uv.push(0.5, 0.5, 0.5 + Math.cos(a1) * 0.5, 0.5 + Math.sin(a1) * 0.5, 0.5 + Math.cos(a0) * 0.5, 0.5 + Math.sin(a0) * 0.5);
  }
  // Waterfall: a curtain from the lip down to the sea.
  const s = side(inside.length - 1);
  const hw = RIVER_W / 2 + 1;
  const fall: [number, number, number][] = [];
  const steps = [
    [0, WATER_Y],
    [1.0, WATER_Y - 0.35],
    [1.9, WATER_Y - 1.6],
    [2.3, -6],
    [2.6, SEA_Y + 0.1],
  ];
  for (let i = 0; i < steps.length - 1; i++) {
    const [o0, y0] = steps[i], [o1, y1] = steps[i + 1];
    const A = [lip.x + dir.x * o0, lip.z + dir.z * o0], B = [lip.x + dir.x * o1, lip.z + dir.z * o1];
    const l0 = [A[0] - s.x * hw, y0, A[1] - s.z * hw], r0 = [A[0] + s.x * hw, y0, A[1] + s.z * hw];
    const l1 = [B[0] - s.x * hw, y1, B[1] - s.z * hw], r1 = [B[0] + s.x * hw, y1, B[1] + s.z * hw];
    fall.push(l0 as [number, number, number], r0 as [number, number, number], l1 as [number, number, number]);
    fall.push(r0 as [number, number, number], r1 as [number, number, number], l1 as [number, number, number]);
  }
  for (let i = 0; i < fall.length; i++) {
    pos.push(...fall[i]);
    uv.push(i % 3 === 1 || (i % 6 === 4) ? 1 : 0, v + (fall[i][1] - WATER_Y) * -0.08);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  riverTex = rippleTexture();
  const mat = new THREE.MeshStandardMaterial({
    map: riverTex,
    color: 0xffffff,
    roughness: 0.3,
    metalness: 0,
    transparent: true,
    opacity: 0.95,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  // Foam where the falls meet the sea.
  const foam = new Batch();
  const fr = rng(31);
  for (let i = 0; i < 9; i++) {
    const u = (fr() - 0.5) * (RIVER_W + 2), o = 2.6 + fr() * 3.5;
    const sz = 0.9 + fr() * 1.3;
    foam.add(new THREE.IcosahedronGeometry(sz, 0), 0xffffff, lip.x + dir.x * o + s.x * u, SEA_Y + 0.1, lip.z + dir.z * o + s.z * u, fr(), fr(), 0, 1, 0.45, 1);
  }
  group.add(foam.mesh(vcMaterial({ flatShading: true, roughness: 1 }), { receive: false }));
  const m = new THREE.Mesh(g, mat);
  m.receiveShadow = true;
  m.renderOrder = 1;
  m.matrixAutoUpdate = false;
  noRaycast(m);
  group.add(m);
  void ctx;
}

export function updateWater(dt: number): void {
  if (riverTex) riverTex.offset.y -= dt * 0.18;
}

// ---- trees -------------------------------------------------------------------------------------

function roundTree(): THREE.BufferGeometry {
  const b = new Batch();
  b.add(new THREE.CylinderGeometry(0.28, 0.38, 2.2, 6), 0xb59a8c, 0, 1.1, 0);
  b.add(new THREE.IcosahedronGeometry(2.3, 0), P.fern, 0, 3.6, 0, 0.3, 0.2, 0, 1, 0.95, 1);
  b.add(new THREE.IcosahedronGeometry(1.5, 0), 0x86c878, 0.7, 4.9, 0.3, 0.6, 0.1, 0.2);
  return b.geometry();
}

function pineTree(): THREE.BufferGeometry {
  const b = new Batch();
  b.add(new THREE.CylinderGeometry(0.22, 0.32, 1.6, 6), 0xb59a8c, 0, 0.8, 0);
  b.add(new THREE.ConeGeometry(2.1, 3.4, 7), P.pine, 0, 2.9, 0);
  b.add(new THREE.ConeGeometry(1.6, 2.8, 7), 0x4a9c69, 0, 4.4, 0, 0, 0.4, 0);
  b.add(new THREE.ConeGeometry(1.0, 2.0, 7), 0x57a874, 0, 5.8, 0, 0, 0.9, 0);
  return b.geometry();
}

export function buildTrees(ctx: TerrainCtx, group: THREE.Group): void {
  const r = rng(99);
  const round: THREE.Matrix4[] = [];
  const pine: THREE.Matrix4[] = [];
  const tints: { round: number[]; pine: number[] } = { round: [], pine: [] };
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const tryPlace = (x: number, z: number, preferPine: boolean): boolean => {
    const p = { x, z };
    if (edgeDistance(p) < 9) return false;
    if (ctx.flatDist(x, z) < 7) return false;
    if (ctx.riverDist(x, z) < 13) return false;
    const y = ctx.height(x, z);
    const s = 0.8 + r() * 0.65;
    q.setFromAxisAngle(up, r() * Math.PI * 2);
    m.compose(new THREE.Vector3(x, y - 0.15, z), q, new THREE.Vector3(s, s * (0.9 + r() * 0.25), s));
    const isPine = preferPine ? r() < 0.8 : r() < 0.25;
    (isPine ? pine : round).push(m.clone());
    (isPine ? tints.pine : tints.round).push(r());
    return true;
  };
  // Clusters.
  for (let c = 0; c < 70; c++) {
    const cx = -510 + r() * 1020, cz = -330 + r() * 570;
    if (edgeDistance({ x: cx, z: cz }) < 16) continue;
    const n = 6 + Math.floor(r() * 16);
    const spread = 10 + r() * 22;
    const preferPine = cz < -120 || r() < 0.3;
    for (let k = 0; k < n; k++) {
      const a = r() * Math.PI * 2, d = Math.sqrt(r()) * spread;
      tryPlace(cx + Math.cos(a) * d, cz + Math.sin(a) * d, preferPine);
    }
  }
  // Rows along the river banks and a few loners.
  for (let k = 0; k < 160; k++) tryPlace(-510 + r() * 1020, -330 + r() * 570, false);
  for (let i = 0; i < RIVER.length - 1; i++) {
    for (let k = 0; k < 4; k++) {
      const t = r();
      const a = RIVER[i], b = RIVER[i + 1];
      const sx = a.x + (b.x - a.x) * t, sz = a.z + (b.z - a.z) * t;
      const side = r() < 0.5 ? -1 : 1;
      tryPlace(sx + side * (16 + r() * 8), sz, false);
    }
  }
  const mat = vcMaterial({ flatShading: true, roughness: 0.9 });
  const make = (geo: THREE.BufferGeometry, list: THREE.Matrix4[], tl: number[]) => {
    const im = new THREE.InstancedMesh(geo, mat, list.length);
    const col = new THREE.Color();
    list.forEach((mm, i) => {
      im.setMatrixAt(i, mm);
      col.setRGB(0.92 + tl[i] * 0.12, 0.95 + tl[i] * 0.08, 0.92 + tl[i] * 0.1);
      im.setColorAt(i, col);
    });
    im.castShadow = true;
    im.receiveShadow = true;
    im.computeBoundingSphere();
    noRaycast(im);
    group.add(im);
  };
  make(roundTree(), round, tints.round);
  make(pineTree(), pine, tints.pine);
}

// ---- clouds ------------------------------------------------------------------------------------

export interface Clouds {
  update(dt: number, viewDistance: number): void;
}

export function buildClouds(group: THREE.Group): Clouds {
  const b = new Batch();
  const puffs = [
    [0, 0, 0, 7],
    [7, -1, 1, 5.5],
    [-7, -1.5, -1, 5],
    [3, 2.5, -1, 5],
    [-3, 1.8, 2, 4.5],
    [11, -2.5, 0, 3.5],
  ];
  for (const [x, y, z, s] of puffs) b.add(new THREE.IcosahedronGeometry(s, 1), 0xffffff, x, y, z, 0, 0, 0, 1, 0.72, 1);
  const geo = b.geometry();
  const mat = new THREE.MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: 1,
    transparent: true,
    opacity: 0.9,
    emissive: 0xeef6fd,
    emissiveIntensity: 0.35,
    depthWrite: false,
  });
  const n = 12;
  const im = new THREE.InstancedMesh(geo, mat, n);
  im.frustumCulled = false;
  noRaycast(im);
  const r = rng(404);
  // Clouds drift slowly around the rim of the island so they frame the diorama and never sit
  // over a site.
  const data = Array.from({ length: n }, (_, i) => ({
    a: (i / n) * Math.PI * 2 + r() * 0.3,
    k: 1.07 + r() * 0.22,
    y: 60 + r() * 45,
    s: 1.3 + r() * 1.5,
    rot: r() * Math.PI,
    v: 0.0035 + r() * 0.002,
    x: 0,
    z: 0,
  }));
  const place = () => {
    for (const d of data) {
      const rr = islandRadius(d.a) * d.k;
      d.x = IC.x + Math.cos(d.a) * rr;
      d.z = IC.z + Math.sin(d.a) * rr;
    }
  };
  place();
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const pos = new THREE.Vector3();
  const sc = new THREE.Vector3();
  const write = () => {
    data.forEach((d, i) => {
      q.setFromAxisAngle(up, d.rot);
      m.compose(pos.set(d.x, d.y, d.z), q, sc.set(d.s, d.s, d.s));
      im.setMatrixAt(i, m);
    });
    im.instanceMatrix.needsUpdate = true;
  };
  write();
  group.add(im);
  return {
    update(dt, viewDistance) {
      const o = smoothstep((viewDistance - 300) / 260) * 0.88;
      mat.opacity = o;
      im.visible = o > 0.01;
      if (!im.visible) return;
      for (const d of data) d.a += d.v * dt;
      place();
      write();
    },
  };
}
