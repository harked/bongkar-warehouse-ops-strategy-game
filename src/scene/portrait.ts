/**
 * Live unit portrait: renders the selected entity close-up into a small render target and
 * copies it into the HUD's portrait canvas (async readback, so the GPU never stalls).
 */
import * as THREE from 'three';
import type { Simulation } from '../core/contracts';
import type { EntityRef } from '../core/types';

const SIZE = 224;

export class PortraitRenderer {
  private rt = new THREE.WebGLRenderTarget(SIZE, SIZE, { samples: 4 });
  private cam = new THREE.PerspectiveCamera(30, 1, 0.3, 900);
  private buf = new Uint8Array(SIZE * SIZE * 4);
  private img = new ImageData(SIZE, SIZE);
  private pending = false;
  private timer = 0;
  private pos = new THREE.Vector3();
  private look = new THREE.Vector3();

  constructor(
    private renderer: THREE.WebGLRenderer,
    private scene: THREE.Scene,
    private sim: Simulation,
  ) {
    this.rt.texture.colorSpace = THREE.SRGBColorSpace;
  }

  update(dt: number, time: number, ref: EntityRef | null, canvas: HTMLCanvasElement | null, hide: THREE.Object3D[]): void {
    this.timer -= dt;
    if (!ref || !canvas || this.pending || this.timer > 0) return;
    if (!this.sim.getEntityPosition(ref, this.pos)) return;
    this.timer = 1 / 15;
    const r = Math.max(1.2, this.sim.getEntityRadius(ref));
    const dist = ref.kind === 'site' ? r * 2.6 : r * 4.2 + 3;
    const a = time * 0.25 + 0.6;
    const lift = ref.kind === 'site' ? 0.55 : 0.42;
    this.look.set(this.pos.x, this.pos.y + (ref.kind === 'site' ? 0 : r * 0.35), this.pos.z);
    this.cam.position.set(
      this.look.x + Math.sin(a) * Math.cos(lift) * dist,
      this.look.y + Math.sin(lift) * dist,
      this.look.z + Math.cos(a) * Math.cos(lift) * dist,
    );
    this.cam.lookAt(this.look);
    this.cam.updateProjectionMatrix();

    const vis = hide.map((o) => o.visible);
    hide.forEach((o) => (o.visible = false));
    const prev = this.renderer.getRenderTarget();
    this.renderer.setRenderTarget(this.rt);
    this.renderer.render(this.scene, this.cam);
    this.renderer.setRenderTarget(prev);
    hide.forEach((o, i) => (o.visible = vis[i]));

    this.pending = true;
    this.renderer
      .readRenderTargetPixelsAsync(this.rt, 0, 0, SIZE, SIZE, this.buf)
      .then(() => {
        this.pending = false;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        // Flip rows: GL origin is bottom-left.
        const row = SIZE * 4;
        for (let y = 0; y < SIZE; y++) {
          this.img.data.set(this.buf.subarray((SIZE - 1 - y) * row, (SIZE - y) * row), y * row);
        }
        if (canvas.width !== SIZE) canvas.width = canvas.height = SIZE;
        ctx.putImageData(this.img, 0, 0);
      })
      .catch(() => {
        this.pending = false;
      });
  }
}
