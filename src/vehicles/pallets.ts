/**
 * Every pallet in the world in 7 draw calls: one InstancedMesh for the wooden bases and one per
 * cargo shape. Instances are kept densely packed (swap-remove), so hidden pallets cost nothing
 * and are never pickable; only the touched instance range is uploaded on commit.
 */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { PalletRenderer } from '../core/contracts';
import { PALLET } from '../core/constants';
import { P } from '../core/palette';
import type { CargoKind, EntityRef, V3 } from '../core/types';
import { GeoBuilder, mixHex } from './builder';
import { C } from './colors';

export const CARGO_KINDS: readonly CargoKind[] = ['cartons', 'wrapped', 'produce', 'frozen', 'parcels', 'drums'];

const B = PALLET.baseHeight; // 0.144
const HX = PALLET.width / 2; // 0.5
const HZ = PALLET.length / 2; // 0.6

// ---- geometry ----------------------------------------------------------------------------------

function palletBase(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const xs = [-0.43, 0, 0.43];
  const zs = [-0.53, 0, 0.53];
  // Bottom runners along Z.
  for (const x of xs) b.box(x - 0.07, 0, -HZ, x + 0.07, 0.022, HZ, { color: C.woodDark }, '-y');
  // Blocks.
  for (const x of xs) for (const z of zs) b.box(x - 0.07, 0.022, z - 0.07, x + 0.07, 0.1, z + 0.07, { color: C.woodDark }, '+y-y');
  // Cross boards along X on the blocks.
  for (const z of zs) b.box(-HX, 0.1, z - 0.07, HX, 0.122, z + 0.07, { color: C.wood }, '-y');
  // Top deck boards along Z.
  const tops = [-0.43, -0.215, 0, 0.215, 0.43];
  tops.forEach((x, i) => {
    b.box(x - 0.07, 0.122, -HZ, x + 0.07, B, HZ, { color: i % 2 ? C.woodLight : C.wood }, '-y');
  });
  return b.build();
}

const KRAFT = [0xc4935e, 0xb7834f, 0xcf9f68, 0xa97848];

function cartons(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const h = 0.5;
  let k = 0;
  for (let layer = 0; layer < 2; layer++) {
    const y0 = B + layer * h;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const jx = layer ? ((k * 37) % 5) * 0.004 - 0.008 : 0;
        const jz = layer ? ((k * 53) % 5) * 0.004 - 0.008 : 0;
        const x0 = sx < 0 ? -0.49 : 0.01;
        const z0 = sz < 0 ? -0.585 : 0.005;
        const col = KRAFT[k % KRAFT.length];
        const top = mixHex(col, 0xe2bd8a, 0.35);
        b.box(x0 + jx, y0, z0 + jz, x0 + 0.48 + jx, y0 + h, z0 + 0.58 + jz, { color: (_p, n) => (n.y > 0.5 ? top : col) }, layer ? '-y' : '-y+y');
        if (layer) {
          // Packing tape across the top and down the front.
          const cx = x0 + 0.24 + jx;
          b.box(cx - 0.04, y0 + h, z0 + jz, cx + 0.04, y0 + h + 0.008, z0 + 0.58 + jz, { color: 0xe8c99a }, '-y');
        }
        k++;
      }
    }
  }
  return b.build();
}

function wrapped(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const film = mixHex(P.sky, P.glacier, 0.5);
  const h = 1.0;
  b.add(new RoundedBoxGeometry(0.98, h, 1.18, 1, 0.045), { color: film, pos: [0, B + h / 2, 0] });
  // Film overlap bands.
  for (const y of [0.24, 0.55, 0.86]) {
    b.box(-0.495, B + y, -0.595, 0.495, B + y + 0.1, 0.595, { color: mixHex(film, P.cloud, 0.4) }, '+y-y');
  }
  // Shipping labels on both ends.
  b.box(-0.16, B + 0.66, 0.594, 0.16, B + 0.86, 0.6, { color: P.cloud }, '-z');
  b.box(-0.16, B + 0.66, -0.6, 0.16, B + 0.86, -0.594, { color: P.cloud }, '+z');
  return b.build();
}

function produce(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const crate = mixHex(P.azure, P.sky, 0.35);
  const crateTop = mixHex(crate, P.cloud, 0.3);
  const h = 0.33;
  const fruit = [0xe8485a, 0x7cc455, 0xff8f3a, 0x9bd162];
  let k = 0;
  for (let layer = 0; layer < 3; layer++) {
    const y0 = B + layer * h;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx < 0 ? -0.49 : 0.01;
        const z0 = sz < 0 ? -0.585 : 0.005;
        const top = layer === 2;
        // Crate with a pale top rim band and darker slot band.
        b.box(x0, y0, z0, x0 + 0.48, y0 + h - 0.05, z0 + 0.58, { color: crate }, '-y+y');
        b.box(x0, y0 + h - 0.05, z0, x0 + 0.48, y0 + h, z0 + 0.58, { color: (_p, n) => (n.y > 0.5 ? mixHex(crate, P.midnight, 0.35) : crateTop) }, top ? '-y' : '-y+y');
        b.box(x0 - 0.002, y0 + 0.12, z0 + 0.12, x0 + 0.482, y0 + 0.18, z0 + 0.46, { color: mixHex(crate, P.midnight, 0.4) }, '+y-y+z-z');
        if (top) {
          const fc = fruit[k % fruit.length];
          // Heaped fruit: a lumpy low dome, speckled light and dark.
          const dome = new THREE.SphereGeometry(0.2, 9, 3, 0, Math.PI * 2, 0, Math.PI / 2);
          const dp = dome.getAttribute('position');
          const key = (x: number, y: number, z: number) => Math.round(x * 1000) * 7 + Math.round(y * 1000) * 13 + Math.round(z * 1000) * 29;
          for (let i = 0; i < dp.count; i++) {
            const x = dp.getX(i);
            const y = dp.getY(i);
            const z = dp.getZ(i);
            const j = y > 0.01 ? 1 + (hash01(key(x, y, z), 5 + k) - 0.5) * 0.22 : 1;
            dp.setXYZ(i, x * j, y * j, z * j);
          }
          dome.computeVertexNormals();
          dome.scale(1.1, 0.55, 1.32);
          b.add(dome, {
            color: (p) => {
              const r = hash01(key(p.x, p.y, p.z), 11 + k);
              return r < 0.3 ? mixHex(fc, P.cloud, 0.3) : r > 0.8 ? mixHex(fc, P.midnight, 0.2) : fc;
            },
            pos: [x0 + 0.24, y0 + h - 0.04, z0 + 0.29],
          });
        }
        k++;
      }
    }
  }
  return b.build();
}

function frozen(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const side = mixHex(P.cloud, P.glacier, 0.35);
  const top = mixHex(P.frost, P.cloud, 0.45);
  const h = 0.5;
  for (let layer = 0; layer < 2; layer++) {
    const y0 = B + layer * h;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const x0 = sx < 0 ? -0.49 : 0.01;
        const z0 = sz < 0 ? -0.585 : 0.005;
        b.box(x0, y0, z0, x0 + 0.48, y0 + h, z0 + 0.58, { color: (_p, n) => (n.y > 0.5 ? top : side) }, layer ? '-y' : '-y+y');
        // Frost-blue cold chain band on each box.
        b.box(x0 - 0.003, y0 + 0.3, z0 - 0.003, x0 + 0.483, y0 + 0.36, z0 + 0.583, { color: mixHex(P.frost, P.sky, 0.35) }, '+y-y');
      }
    }
  }
  return b.build();
}

function parcels(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const tones = [0xc69a66, 0xb5844f, 0xd2a774, 0xa87545, 0xeef3f8, 0xbf8c58];
  const layers: { h: number; boxes: [number, number, number, number][] }[] = [
    { h: 0.42, boxes: [[-0.49, 0.0, -0.59, -0.02], [0.01, 0.49, -0.59, -0.15], [0.01, 0.49, -0.14, 0.59], [-0.49, 0.0, -0.01, 0.59]] },
    {
      h: 0.36,
      boxes: [[-0.48, -0.08, -0.58, -0.18], [-0.07, 0.48, -0.58, 0.05], [-0.48, -0.08, -0.17, 0.3], [-0.07, 0.3, 0.06, 0.58], [0.31, 0.48, 0.06, 0.58], [-0.48, -0.08, 0.31, 0.58]],
    },
    { h: 0.27, boxes: [[-0.45, 0.04, -0.52, 0.0], [0.08, 0.44, -0.3, 0.22], [-0.4, -0.02, 0.1, 0.5]] },
  ];
  let y = B;
  let k = 0;
  for (const L of layers) {
    for (const [x0, x1, z0, z1] of L.boxes) {
      const col = tones[k++ % tones.length];
      const top = mixHex(col, P.cloud, 0.18);
      b.box(x0, y, z0, x1, y + L.h, z1, { color: (_p, n) => (n.y > 0.5 ? top : col) }, '-y');
    }
    y += L.h;
  }
  return b.build();
}

function drums(): THREE.BufferGeometry {
  const b = new GeoBuilder(false);
  const body = mixHex(P.cobalt, P.azure, 0.45);
  const rib = mixHex(body, P.midnight, 0.3);
  const lid = mixHex(body, P.cloud, 0.25);
  const r = 0.235;
  const h = 0.88;
  for (const x of [-0.25, 0.25]) {
    for (const z of [-0.3, 0.3]) {
      b.add(new THREE.CylinderGeometry(r, r, h, 14, 1, true), { color: body, pos: [x, B + h / 2, z] });
      const cap = new THREE.CircleGeometry(r, 14);
      cap.rotateX(-Math.PI / 2);
      b.add(cap, { color: lid, pos: [x, B + h, z] });
      for (const t of [0.33, 0.66]) {
        b.add(new THREE.CylinderGeometry(r + 0.008, r + 0.008, 0.035, 14, 1, true), { color: rib, pos: [x, B + h * t, z] });
      }
      b.add(new THREE.CylinderGeometry(r + 0.006, r + 0.006, 0.03, 14, 1, true), { color: rib, pos: [x, B + h - 0.015, z] });
      b.add(new THREE.CylinderGeometry(0.035, 0.035, 0.02, 6, 1), { color: P.cloud, pos: [x + 0.12, B + h + 0.01, z - 0.06] });
    }
  }
  return b.build();
}

// ---- renderer ----------------------------------------------------------------------------------

/** One densely packed InstancedMesh. Slot = instance id; ids[slot] = pallet index. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly ids: Int32Array;
  n = 0;
  private lo = Infinity;
  private hi = -1;
  private mat: Float32Array;
  private col: Float32Array;

  constructor(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    private slotOf: Int32Array,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, material, capacity);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    // Pallets span the whole world: skip culling, and give raycasts a sphere that always passes.
    this.mesh.frustumCulled = false;
    this.mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);
    this.ids = new Int32Array(capacity);
    this.mat = this.mesh.instanceMatrix.array as Float32Array;
    this.col = this.mesh.instanceColor!.array as Float32Array;
  }

  private touch(slot: number): void {
    if (slot < this.lo) this.lo = slot;
    if (slot > this.hi) this.hi = slot;
  }

  add(index: number, m: Float32Array, mo: number, r: number, g: number, bl: number): void {
    const s = this.n++;
    this.ids[s] = index;
    this.slotOf[index] = s;
    this.mat.set(m.subarray(mo, mo + 16), s * 16);
    this.col[s * 3] = r;
    this.col[s * 3 + 1] = g;
    this.col[s * 3 + 2] = bl;
    this.touch(s);
  }

  writeMatrix(index: number, m: Float32Array, mo: number): void {
    const s = this.slotOf[index];
    this.mat.set(m.subarray(mo, mo + 16), s * 16);
    this.touch(s);
  }

  remove(index: number): void {
    const s = this.slotOf[index];
    const last = --this.n;
    if (s !== last) {
      const moved = this.ids[last];
      this.ids[s] = moved;
      this.slotOf[moved] = s;
      this.mat.copyWithin(s * 16, last * 16, last * 16 + 16);
      this.col.copyWithin(s * 3, last * 3, last * 3 + 3);
      this.touch(s);
    }
    this.slotOf[index] = -1;
  }

  commit(): void {
    this.mesh.count = this.n;
    if (this.hi < this.lo) return;
    const hi = Math.min(this.hi, Math.max(this.n - 1, 0));
    if (hi >= this.lo) {
      const im = this.mesh.instanceMatrix;
      im.clearUpdateRanges();
      im.addUpdateRange(this.lo * 16, (hi - this.lo + 1) * 16);
      im.needsUpdate = true;
      const ic = this.mesh.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(this.lo * 3, (hi - this.lo + 1) * 3);
      ic.needsUpdate = true;
    }
    this.lo = Infinity;
    this.hi = -1;
  }
}

let sharedGeo: { base: THREE.BufferGeometry; cargo: THREE.BufferGeometry[] } | null = null;
function geometries() {
  sharedGeo ??= { base: palletBase(), cargo: [cartons(), wrapped(), produce(), frozen(), parcels(), drums()] };
  return sharedGeo;
}

function hash01(i: number, salt: number): number {
  let h = Math.imul(i ^ salt, 2654435761) ^ 0x5bd1e995;
  h = Math.imul(h ^ (h >>> 15), 2246822519);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967295;
}

export function createPalletRenderer(capacity: number): PalletRenderer {
  const geo = geometries();
  const object = new THREE.Group();
  object.name = 'pallets';

  const baseSlot = new Int32Array(capacity).fill(-1);
  const cargoSlot = new Int32Array(capacity).fill(-1);
  const kindOf = new Int8Array(capacity).fill(-1);
  /** Last placement per pallet: x, y, z, heading (skip no-op updates). */
  const last = new Float32Array(capacity * 4);
  const m = new Float32Array(16);

  const woodMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.86, metalness: 0 });
  const cargoMats = [
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.2, metalness: 0.02 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 }),
    new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.32 }),
  ];

  let resolver: (i: number) => EntityRef | null = () => null;
  const base = new Pool(geo.base, woodMat, capacity, baseSlot);
  base.mesh.name = 'pallet-bases';
  const pools = geo.cargo.map((g, k) => {
    const p = new Pool(g, cargoMats[k], capacity, cargoSlot);
    p.mesh.name = `pallet-${CARGO_KINDS[k]}`;
    return p;
  });
  for (const p of [base, ...pools]) {
    p.mesh.userData.pickInstance = (id: number) => (id < p.n ? resolver(p.ids[id]) : null);
    object.add(p.mesh);
  }

  /** Per-pallet colour jitter, stable for the pallet's life. */
  function tint(index: number, k: number, out: number[]): void {
    const a = hash01(index, 17 + k);
    const bb = hash01(index, 91 + k);
    switch (CARGO_KINDS[k]) {
      case 'cartons':
      case 'parcels': {
        const l = 0.86 + a * 0.2;
        out[0] = l * (1.0 + (bb - 0.5) * 0.06);
        out[1] = l;
        out[2] = l * (0.97 - (bb - 0.5) * 0.06);
        break;
      }
      case 'drums': {
        // Mostly blue, a few teal / deep cobalt.
        const v = bb < 0.2 ? [0.72, 1.12, 1.0] : bb < 0.35 ? [0.82, 0.86, 1.05] : [1, 1, 1];
        const l = 0.92 + a * 0.12;
        out[0] = v[0] * l;
        out[1] = v[1] * l;
        out[2] = v[2] * l;
        break;
      }
      default: {
        const l = 0.94 + a * 0.08;
        out[0] = out[1] = out[2] = l;
      }
    }
  }
  const t3 = [1, 1, 1];

  return {
    object,
    capacity,
    set(index: number, pos: V3, heading: number, cargo: CargoKind) {
      if (index < 0 || index >= capacity) return;
      const k = CARGO_KINDS.indexOf(cargo);
      if (k < 0) return;
      const o = index * 4;
      const prev = kindOf[index];
      if (prev === k && last[o] === Math.fround(pos.x) && last[o + 1] === Math.fround(pos.y) && last[o + 2] === Math.fround(pos.z) && last[o + 3] === Math.fround(heading)) {
        return;
      }
      last[o] = pos.x;
      last[o + 1] = pos.y;
      last[o + 2] = pos.z;
      last[o + 3] = heading;
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      m[0] = c;
      m[2] = -s;
      m[5] = 1;
      m[8] = s;
      m[10] = c;
      m[12] = pos.x;
      m[13] = pos.y;
      m[14] = pos.z;
      m[15] = 1;
      if (prev < 0) {
        const w = 0.9 + hash01(index, 3) * 0.16;
        base.add(index, m, 0, w * 1.02, w, w * 0.97);
      } else {
        base.writeMatrix(index, m, 0);
      }
      if (prev === k) {
        pools[k].writeMatrix(index, m, 0);
      } else {
        if (prev >= 0) pools[prev].remove(index);
        tint(index, k, t3);
        pools[k].add(index, m, 0, t3[0], t3[1], t3[2]);
        kindOf[index] = k;
      }
    },
    hide(index: number) {
      if (index < 0 || index >= capacity) return;
      const prev = kindOf[index];
      if (prev < 0) return;
      base.remove(index);
      pools[prev].remove(index);
      kindOf[index] = -1;
    },
    commit() {
      base.commit();
      for (const p of pools) p.commit();
    },
    setPickResolver(fn) {
      resolver = fn;
    },
  };
}

/** For debugging / the showroom. */
export function palletGeometryStats(): Record<string, number> {
  const g = geometries();
  const out: Record<string, number> = { base: g.base.index!.count / 3 };
  CARGO_KINDS.forEach((k, i) => (out[k] = g.cargo[i].index!.count / 3));
  return out;
}

