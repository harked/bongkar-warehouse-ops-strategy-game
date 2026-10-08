/**
 * Selection feedback in the world: a breathing cobalt ring under the selected unit, a lighter
 * ring for hover, and the "route thread" ribbon showing where the unit is headed.
 */
import * as THREE from 'three';
import type { Simulation } from '../core/contracts';
import { P } from '../core/palette';
import type { EntityRef, V3 } from '../core/types';
import { sameRef } from '../core/types';

function ringTexture(): THREE.CanvasTexture {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const mid = s / 2;
  // Soft inner fill, crisp outer band, then four bracket ticks like an RTS order marker.
  const grad = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
  grad.addColorStop(0, 'rgba(255,255,255,0.0)');
  grad.addColorStop(0.62, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.8, 'rgba(255,255,255,0.32)');
  grad.addColorStop(0.86, 'rgba(255,255,255,1)');
  grad.addColorStop(0.93, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  g.strokeStyle = 'rgba(255,255,255,1)';
  g.lineWidth = 10;
  g.lineCap = 'round';
  for (let i = 0; i < 4; i++) {
    const a0 = i * (Math.PI / 2) - 0.32;
    g.beginPath();
    g.arc(mid, mid, mid * 0.97 - 6, a0, a0 + 0.64);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function dashTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 32;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, 128, 32);
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.fillRect(0, 8, 128, 16);
  // Chevron pointing along +u (direction of travel).
  g.fillStyle = 'rgba(255,255,255,1)';
  g.beginPath();
  g.moveTo(40, 2);
  g.lineTo(78, 16);
  g.lineTo(40, 30);
  g.lineTo(54, 16);
  g.closePath();
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class SelectionLayer {
  readonly group = new THREE.Group();
  private ring: THREE.Mesh;
  private hoverRing: THREE.Mesh;
  private thread: THREE.Mesh;
  private threadMat: THREE.MeshBasicMaterial;
  private threadTimer = 0;
  private pos = new THREE.Vector3();
  selected: EntityRef | null = null;
  hovered: EntityRef | null = null;

  constructor(private sim: Simulation) {
    const tex = ringTexture();
    const mk = (color: number, opacity: number) =>
      new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({
          map: tex,
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -4,
          toneMapped: false,
        }),
      );
    this.ring = mk(P.cobalt, 0.95);
    this.ring.renderOrder = 20;
    this.hoverRing = mk(P.azure, 0.55);
    this.hoverRing.renderOrder = 19;
    this.threadMat = new THREE.MeshBasicMaterial({
      map: dashTexture(),
      color: P.cobalt,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -3,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    this.thread = new THREE.Mesh(new THREE.BufferGeometry(), this.threadMat);
    this.thread.renderOrder = 18;
    this.thread.frustumCulled = false;
    this.group.add(this.thread, this.hoverRing, this.ring);
    this.ring.visible = this.hoverRing.visible = this.thread.visible = false;
  }

  select(ref: EntityRef | null): void {
    this.selected = ref;
    this.threadTimer = 0;
  }

  hover(ref: EntityRef | null): void {
    this.hovered = ref;
  }

  update(dt: number, time: number): void {
    this.place(this.ring, this.selected, 1 + Math.sin(time * 3.2) * 0.04);
    this.ring.rotation.y = time * 0.6;
    this.place(this.hoverRing, sameRef(this.hovered, this.selected) ? null : this.hovered, 1);

    this.threadTimer -= dt;
    if (this.threadTimer <= 0) {
      this.threadTimer = 0.2;
      const route = this.selected && this.selected.kind !== 'site' ? this.sim.getEntityRoute(this.selected) : null;
      if (route && route.length >= 2) {
        this.buildRibbon(route, this.selected!.kind === 'truck' ? 1.4 : 0.7);
        this.thread.visible = true;
      } else {
        this.thread.visible = false;
      }
    }
    if (this.threadMat.map) this.threadMat.map.offset.x = -time * 1.2;
  }

  private place(mesh: THREE.Mesh, ref: EntityRef | null, pulse: number): void {
    if (!ref || !this.sim.getEntityPosition(ref, this.pos)) {
      mesh.visible = false;
      return;
    }
    const r = this.sim.getEntityRadius(ref) * 1.35;
    mesh.visible = true;
    mesh.position.set(this.pos.x, this.pos.y + 0.06, this.pos.z);
    mesh.scale.setScalar(r * 2 * pulse);
  }

  private buildRibbon(pts: V3[], width: number): void {
    // Flat ribbon on the floor, UVs in metres along the path so chevrons keep their spacing.
    const n = pts.length;
    const positions = new Float32Array(n * 2 * 3);
    const uvs = new Float32Array(n * 2 * 2);
    const idx: number[] = [];
    let u = 0;
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let tx = b.x - a.x;
      let tz = b.z - a.z;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      if (i > 0) u += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      const nx = -tz * width * 0.5;
      const nz = tx * width * 0.5;
      const y = pts[i].y + 0.08;
      positions.set([pts[i].x + nx, y, pts[i].z + nz, pts[i].x - nx, y, pts[i].z - nz], i * 6);
      const uu = u / (width * 3.2);
      uvs.set([uu, 0, uu, 1], i * 4);
      if (i < n - 1) {
        const k = i * 2;
        idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(idx);
    this.thread.geometry.dispose();
    this.thread.geometry = geo;
  }
}

/** Resolve a raycast hit to an entity ref using the picking convention in core/contracts.ts. */
export function resolvePick(hit: THREE.Intersection): EntityRef | null {
  if (hit.instanceId != null && typeof hit.object.userData.pickInstance === 'function') {
    const r = hit.object.userData.pickInstance(hit.instanceId) as EntityRef | null;
    if (r) return r;
  }
  for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
    if (o.userData.pick) return o.userData.pick as EntityRef;
  }
  return null;
}
