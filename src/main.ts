import '@fontsource-variable/manrope';
import '@fontsource-variable/outfit';
import * as THREE from 'three';
import { clamp, damp, smoothstep } from './core/geom';
import { WORLD } from './core/layout';
import type { AppCommands, EntityRef } from './core/types';
import { sameRef } from './core/types';
import { createHud } from './hud';
import { CameraRig, type CameraPose } from './scene/camera';
import { PortraitRenderer } from './scene/portrait';
import { resolvePick, SelectionLayer } from './scene/selection';
import { createSimulation } from './sim';
import { vehicles } from './vehicles';
import { buildWorld } from './world';

const canvas = document.getElementById('world') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const world = buildWorld(WORLD, scene, renderer);
const sim = createSimulation({ layout: WORLD, world, vehicles, scene });

// ---- camera poses ----------------------------------------------------------------------------
const NETWORK_POSE: CameraPose = { target: new THREE.Vector3(-10, 0, -50), distance: 780, yaw: 0.22, pitch: 1.02 };
function sitePose(id: string): CameraPose {
  const s = WORLD.siteById[id];
  const b = s.building;
  return {
    target: new THREE.Vector3(b.cx + b.w * 0.04, 0, b.cz + b.d * 0.32),
    distance: Math.max(b.w, b.d * 1.6) * 1.35 + 70,
    yaw: 0.5,
    pitch: 0.82,
  };
}
const FOCUS_DIST: Record<EntityRef['kind'], number> = { site: 0, truck: 55, forklift: 30, pallet: 24, dock: 40 };

const rig = new CameraRig(canvas, { x0: -480, z0: -320, x1: 480, z1: 240 }, sitePose('pasa-ateh'));
scene.add(rig.camera);

// ---- selection -------------------------------------------------------------------------------
const selection = new SelectionLayer(sim);
scene.add(selection.group);
const portrait = new PortraitRenderer(renderer, scene, sim);

let selected: EntityRef | null = null;
let activeSiteId = 'pasa-ateh';
let snapDirty = true;

const tmp = new THREE.Vector3();
const followPos = new THREE.Vector3();

function select(ref: EntityRef | null): void {
  if (sameRef(ref, selected)) return;
  selected = ref;
  selection.select(ref);
  rig.setFollow(null);
  snapDirty = true;
}

function focusSelection(): void {
  if (!selected) return;
  if (selected.kind === 'site') {
    rig.flyTo(sitePose(selected.id));
    return;
  }
  if (!sim.getEntityPosition(selected, tmp)) return;
  const ref = selected;
  rig.flyTo({ target: new THREE.Vector3(tmp.x, 0, tmp.z), distance: FOCUS_DIST[ref.kind], pitch: 0.78 });
  if (ref.kind === 'truck' || ref.kind === 'forklift' || ref.kind === 'pallet') {
    rig.setFollow(() => (selected && sameRef(selected, ref) && sim.getEntityPosition(ref, followPos) ? followPos : null));
  }
}

const commands: AppCommands = {
  selectSite(id) {
    if (id === 'network') {
      rig.flyTo(NETWORK_POSE);
      activeSiteId = 'network';
    } else if (WORLD.siteById[id]) {
      rig.flyTo(sitePose(id));
      activeSiteId = id;
    }
    snapDirty = true;
  },
  select,
  focusSelection,
  hover(ref) {
    selection.hover(ref);
  },
  home() {
    commands.selectSite(activeSiteId === 'network' ? 'network' : activeSiteId);
  },
  rotateCamera(d) {
    rig.rotate(d);
  },
  zoomCamera(f) {
    rig.zoom(f);
  },
  setSpeed(s) {
    sim.setSpeed(s);
    snapDirty = true;
  },
  togglePause() {
    sim.togglePause();
    snapDirty = true;
  },
};

const hud = createHud(hudRoot, commands);

// ---- picking ---------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function pickAt(clientX: number, clientY: number): EntityRef | null {
  const r = canvas.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, rig.camera);
  const hits = raycaster.intersectObjects(scene.children, true);
  for (const h of hits) {
    if (!h.object.visible || h.object.userData.noPick) continue;
    if (isHiddenByAncestor(h.object)) continue;
    const ref = resolvePick(h);
    if (ref) return ref;
    if (h.object.userData.pickBlocker) return null;
  }
  return null;
}
function isHiddenByAncestor(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return true;
  return false;
}

let lastClick = { t: 0, ref: null as EntityRef | null };
rig.onClick = (x, y) => {
  const ref = pickAt(x, y);
  const now = performance.now();
  if (ref && sameRef(ref, lastClick.ref) && now - lastClick.t < 380) {
    select(ref);
    focusSelection();
  } else {
    select(ref);
  }
  lastClick = { t: now, ref };
};
rig.onManual = () => (snapDirty = true);

let hoverTimer = 0;
let lastPointer: { x: number; y: number } | null = null;
canvas.addEventListener('pointermove', (e) => (lastPointer = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerleave', () => {
  lastPointer = null;
  selection.hover(null);
  canvas.style.cursor = '';
});

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    commands.togglePause();
  } else if (e.code === 'Escape') select(null);
  else if (e.code === 'KeyF') focusSelection();
  else if (e.code === 'KeyH') commands.home();
  else if (e.code === 'Digit1') commands.setSpeed(1);
  else if (e.code === 'Digit2') commands.setSpeed(4);
  else if (e.code === 'Digit3') commands.setSpeed(12);
  else if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
    const ids = ['network', ...WORLD.sites.map((s) => s.id)];
    const i = ids.indexOf(activeSiteId);
    const n = (i + (e.code === 'BracketRight' ? 1 : -1) + ids.length) % ids.length;
    commands.selectSite(ids[n]);
  }
});

// ---- resize ----------------------------------------------------------------------------------
function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  rig.resize(w, h);
}
window.addEventListener('resize', resize);
resize();

// ---- lid + active site -----------------------------------------------------------------------
const lids = new Map<string, number>();
function updateSites(dt: number): void {
  const target = rig.target;
  const dist = rig.distance;
  let nearest: string | null = null;
  for (const s of WORLD.sites) {
    const b = s.bounds;
    const inside = target.x > b.x0 - 40 && target.x < b.x1 + 40 && target.z > b.z0 - 40 && target.z < b.z1 + 40;
    if (inside && dist < 460) nearest = s.id;
    // Lift the lid as the camera comes in over this site.
    const goal = inside ? smoothstep((215 - dist) / 95) : 0;
    const cur = lids.get(s.id) ?? 0;
    const next = cur + (goal - cur) * damp(5, dt);
    lids.set(s.id, next);
    world.sites.get(s.id)?.setLid(next);
  }
  if (!rig.isFlying) {
    const next = nearest ?? 'network';
    if (next !== activeSiteId) {
      activeSiteId = next;
      snapDirty = true;
    }
  }
}

// ---- frame loop ------------------------------------------------------------------------------
const timer = new THREE.Timer();
timer.connect(document);
let elapsed = 0;
let snapTimer = 0;
const fps = { frames: 0, acc: 0, value: 0 };

function frame(ts: number): void {
  timer.update(ts);
  const dt = Math.min(timer.getDelta(), 0.1);
  elapsed += dt;
  fps.frames++;
  fps.acc += dt;
  if (fps.acc >= 1) {
    fps.value = fps.frames / fps.acc;
    fps.frames = 0;
    fps.acc = 0;
  }

  sim.update(dt);
  rig.update(dt);
  updateSites(dt);
  world.update(dt, elapsed);
  world.env.update(dt, rig.target, rig.distance, sim.dayFraction());
  selection.update(dt, elapsed);

  hoverTimer -= dt;
  if (hoverTimer <= 0 && lastPointer) {
    hoverTimer = 0.1;
    const h = pickAt(lastPointer.x, lastPointer.y);
    selection.hover(h);
    canvas.style.cursor = h ? 'pointer' : '';
  }

  // Floating tag above the selection.
  if (selected && sim.getEntityPosition(selected, tmp)) {
    const lift = selected.kind === 'site' ? WORLD.siteById[selected.id].building.h + 6 : sim.getEntityRadius(selected) * 1.2 + 2.2;
    tmp.y += lift;
    tmp.project(rig.camera);
    const onScreen = tmp.z < 1 && Math.abs(tmp.x) < 1.05 && Math.abs(tmp.y) < 1.05;
    hud.setWorldTag({
      x: (tmp.x * 0.5 + 0.5) * window.innerWidth,
      y: (-tmp.y * 0.5 + 0.5) * window.innerHeight,
      text: sim.getEntityLabel(selected),
      visible: onScreen,
    });
  } else {
    hud.setWorldTag({ x: 0, y: 0, text: '', visible: false });
  }

  renderer.render(scene, rig.camera);
  portrait.update(dt, elapsed, selected, hud.portraitCanvas(), [selection.group]);

  snapTimer -= dt;
  if (snapDirty || snapTimer <= 0) {
    snapTimer = 0.2;
    snapDirty = false;
    // Selection may have vanished (truck left the map).
    if (selected && selected.kind !== 'site' && !sim.getEntityPosition(selected, tmp)) select(null);
    hud.render(sim.snapshot(activeSiteId, selected));
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- debug / capture API ---------------------------------------------------------------------
declare global {
  interface Window {
    __yard: unknown;
  }
}
window.__yard = {
  fps: () => Math.round(fps.value),
  pose: () => ({ ...rig.pose, target: rig.pose.target.toArray() }),
  /** Instant camera placement for screenshots: site id, yaw, pitch, distance. */
  view(siteId: string, yaw?: number, pitch?: number, distance?: number, dur = 0.01) {
    const p = siteId === 'network' ? NETWORK_POSE : sitePose(siteId);
    rig.flyTo({ target: p.target, yaw: yaw ?? p.yaw, pitch: pitch ?? p.pitch, distance: distance ?? p.distance }, dur);
    activeSiteId = siteId;
    snapDirty = true;
  },
  /** Instant camera placement at an arbitrary ground point. */
  lookAt(x: number, z: number, yaw = 0.5, pitch = 0.8, distance = 120, dur = 0.01) {
    rig.flyTo({ target: new THREE.Vector3(x, 0, z), yaw, pitch, distance }, dur);
  },
  select: (kind: EntityRef['kind'], id: string) => select({ kind, id }),
  focus: focusSelection,
  speed: (s: number) => sim.setSpeed(s),
  info: () => renderer.info.render,
  sim,
  world,
  scene,
  layout: WORLD,
  clamp,
};
