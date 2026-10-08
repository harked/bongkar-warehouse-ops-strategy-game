/**
 * RTS-style camera rig: drag to pan (ground stays glued to the cursor), right-drag to rotate
 * and tilt, wheel zooms toward the cursor, WASD / arrows pan, Q / E rotate. Every value is
 * eased so nothing snaps, and fly-to arcs up and over on long trips.
 */
import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/geom';
import type { Rect } from '../core/types';

export interface CameraPose {
  target: THREE.Vector3;
  distance: number;
  yaw: number;
  pitch: number;
}

const LIMITS = { minDist: 14, maxDist: 900, minPitch: 0.32, maxPitch: 1.36 };

const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  /** Where we want to be (input writes here). */
  private goal: CameraPose;
  /** Where we are (eases toward goal). */
  private cur: CameraPose;
  private flight: { from: CameraPose; to: CameraPose; t: number; dur: number; arc: number } | null = null;
  private follow: (() => THREE.Vector3 | null) | null = null;
  private keys = new Set<string>();
  private drag: { mode: 'pan' | 'rotate'; x: number; y: number; ground: THREE.Vector3 | null; moved: number } | null = null;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private ndc = new THREE.Vector2();
  /** Fired on a click that was not a drag. */
  onClick: ((x: number, y: number) => void) | null = null;
  /** Fired when the user takes manual control (cancels follow). */
  onManual: (() => void) | null = null;

  constructor(
    private dom: HTMLElement,
    private bounds: Rect,
    initial: CameraPose,
  ) {
    this.camera = new THREE.PerspectiveCamera(32, 1, 1, 4000);
    this.goal = clonePose(initial);
    this.cur = clonePose(initial);
    this.apply();
    this.bind();
  }

  get pose(): Readonly<CameraPose> {
    return this.cur;
  }
  get target(): THREE.Vector3 {
    return this.cur.target;
  }
  get distance(): number {
    return this.cur.distance;
  }
  get isFlying(): boolean {
    return !!this.flight;
  }

  resize(w: number, h: number): void {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  flyTo(to: Partial<CameraPose> & { target: THREE.Vector3 }, duration?: number): void {
    const dest: CameraPose = {
      target: to.target.clone(),
      distance: clamp(to.distance ?? this.goal.distance, LIMITS.minDist, LIMITS.maxDist),
      yaw: to.yaw ?? this.goal.yaw,
      pitch: clamp(to.pitch ?? this.goal.pitch, LIMITS.minPitch, LIMITS.maxPitch),
    };
    // Unwrap yaw so we take the short way round.
    let dy = (dest.yaw - this.cur.yaw) % (Math.PI * 2);
    if (dy > Math.PI) dy -= Math.PI * 2;
    if (dy < -Math.PI) dy += Math.PI * 2;
    dest.yaw = this.cur.yaw + dy;
    const travel = this.cur.target.distanceTo(dest.target);
    const dur = duration ?? clamp(0.9 + travel / 320, 1.0, 2.2);
    const arc = travel > 60 ? Math.min(travel * 0.45, 260) : 0;
    this.flight = { from: clonePose(this.cur), to: dest, t: 0, dur, arc };
    this.goal = clonePose(dest);
  }

  /** Keep the target glued to a moving thing until the user takes over. */
  setFollow(fn: (() => THREE.Vector3 | null) | null): void {
    this.follow = fn;
  }

  update(dt: number): void {
    // Keyboard pan / rotate / zoom.
    const k = this.keys;
    const panSpeed = this.goal.distance * 0.9 * dt;
    let px = 0;
    let pz = 0;
    if (k.has('KeyW') || k.has('ArrowUp')) pz -= 1;
    if (k.has('KeyS') || k.has('ArrowDown')) pz += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) px -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) px += 1;
    if (px || pz) {
      this.manual();
      const s = Math.sin(this.goal.yaw);
      const c = Math.cos(this.goal.yaw);
      this.goal.target.x += (px * c + pz * s) * panSpeed;
      this.goal.target.z += (-px * s + pz * c) * panSpeed;
    }
    if (k.has('KeyQ')) this.rotate(-1.4 * dt);
    if (k.has('KeyE')) this.rotate(1.4 * dt);
    if (k.has('Equal') || k.has('NumpadAdd')) this.zoom(1 - 1.6 * dt);
    if (k.has('Minus') || k.has('NumpadSubtract')) this.zoom(1 + 1.6 * dt);

    if (this.flight) {
      const f = this.flight;
      f.t += dt / f.dur;
      const t = easeInOut(Math.min(1, f.t));
      this.cur.target.lerpVectors(f.from.target, f.to.target, t);
      this.cur.distance = lerp(f.from.distance, f.to.distance, t) + Math.sin(Math.PI * t) * f.arc;
      this.cur.yaw = lerp(f.from.yaw, f.to.yaw, t);
      this.cur.pitch = lerp(f.from.pitch, f.to.pitch, t);
      if (f.t >= 1) this.flight = null;
    } else {
      if (this.follow) {
        const p = this.follow();
        if (p) this.goal.target.set(p.x, 0, p.z);
      }
      this.clampGoal();
      const a = damp(9, dt);
      const az = damp(7, dt);
      this.cur.target.lerp(this.goal.target, a);
      this.cur.distance = lerp(this.cur.distance, this.goal.distance, az);
      this.cur.yaw = lerp(this.cur.yaw, this.goal.yaw, a);
      this.cur.pitch = lerp(this.cur.pitch, this.goal.pitch, a);
    }
    this.apply();
  }

  rotate(d: number): void {
    this.manualRotate();
    this.goal.yaw += d;
  }

  zoom(factor: number, anchor?: THREE.Vector3 | null): void {
    this.cancelFlight();
    const before = this.goal.distance;
    this.goal.distance = clamp(before * factor, LIMITS.minDist, LIMITS.maxDist);
    if (anchor) {
      // Zoom toward the cursor: move the target along the anchor direction by the same ratio.
      const r = 1 - this.goal.distance / before;
      this.goal.target.x += (anchor.x - this.goal.target.x) * r;
      this.goal.target.z += (anchor.z - this.goal.target.z) * r;
      if (r !== 0) this.manual();
    }
  }

  /** Ground point (y=0) under a screen position. */
  groundAt(clientX: number, clientY: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  private apply(): void {
    const { target, distance, yaw, pitch } = this.cur;
    const cp = Math.cos(pitch);
    this.camera.position.set(
      target.x + Math.sin(yaw) * cp * distance,
      target.y + Math.sin(pitch) * distance,
      target.z + Math.cos(yaw) * cp * distance,
    );
    this.camera.lookAt(target);
    this.camera.near = Math.max(0.5, distance * 0.02);
    this.camera.far = distance * 6 + 1500;
    this.camera.updateProjectionMatrix();
  }

  private clampGoal(): void {
    const b = this.bounds;
    this.goal.target.x = clamp(this.goal.target.x, b.x0, b.x1);
    this.goal.target.z = clamp(this.goal.target.z, b.z0, b.z1);
    this.goal.pitch = clamp(this.goal.pitch, LIMITS.minPitch, LIMITS.maxPitch);
  }

  private cancelFlight(): void {
    if (this.flight) {
      this.goal = clonePose(this.cur);
      this.flight = null;
    }
  }

  private manual(): void {
    this.cancelFlight();
    if (this.follow) {
      this.follow = null;
      this.onManual?.();
    }
  }

  /** Rotating keeps following; only panning breaks it. */
  private manualRotate(): void {
    this.cancelFlight();
  }

  private bind(): void {
    const el = this.dom;
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      const mode = e.button === 0 && !e.shiftKey ? 'pan' : 'rotate';
      this.drag = { mode, x: e.clientX, y: e.clientY, ground: this.groundAt(e.clientX, e.clientY), moved: 0 };
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x;
      const dy = e.clientY - d.y;
      d.moved += Math.abs(dx) + Math.abs(dy);
      d.x = e.clientX;
      d.y = e.clientY;
      if (d.moved < 4) return;
      if (d.mode === 'pan' && d.ground) {
        const now = this.groundAt(e.clientX, e.clientY);
        if (now) {
          this.manual();
          // Move the goal and current target together so the ground stays under the cursor.
          const ox = d.ground.x - now.x;
          const oz = d.ground.z - now.z;
          this.goal.target.x += ox;
          this.goal.target.z += oz;
          this.cur.target.x += ox;
          this.cur.target.z += oz;
          this.apply();
        }
      } else if (d.mode === 'rotate') {
        this.manualRotate();
        this.goal.yaw -= dx * 0.006;
        this.goal.pitch = clamp(this.goal.pitch + dy * 0.004, LIMITS.minPitch, LIMITS.maxPitch);
      }
    });
    const end = (e: PointerEvent) => {
      const d = this.drag;
      this.drag = null;
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (d && d.moved < 4 && e.button === 0) this.onClick?.(e.clientX, e.clientY);
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const factor = Math.exp(clamp(e.deltaY, -120, 120) * (e.ctrlKey ? 0.01 : 0.0022));
        this.zoom(factor, this.groundAt(e.clientX, e.clientY));
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }
}

const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
};

function clonePose(p: CameraPose): CameraPose {
  return { target: p.target.clone(), distance: p.distance, yaw: p.yaw, pitch: p.pitch };
}
