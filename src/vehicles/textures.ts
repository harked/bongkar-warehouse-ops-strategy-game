/**
 * Canvas-drawn textures: carrier livery (cached per carrier) and unit plates (per unit).
 * Both redraw once the web fonts finish loading so text never sticks in a fallback face.
 */
import * as THREE from 'three';
import { css, P } from '../core/palette';

const DISPLAY = '"Outfit Variable", "Manrope Variable", system-ui, sans-serif';

type Redraw = () => void;
const redraws = new Set<Redraw>();
let fontsReady = false;

function onFonts(fn: Redraw): void {
  if (fontsReady) return;
  redraws.add(fn);
}

if (typeof document !== 'undefined' && document.fonts) {
  Promise.all([document.fonts.load(`700 64px "Outfit Variable"`), document.fonts.load(`600 64px "Outfit Variable"`)])
    .catch(() => undefined)
    .then(() => document.fonts.ready)
    .then(() => {
      fontsReady = true;
      for (const r of redraws) r();
      redraws.clear();
    });
}

function makeTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Stable small hash for picking accent colours per carrier. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const ACCENTS = [P.cobalt, P.azure, P.sky, P.mint, P.coral, P.sunbeam, P.midnight];

/** Accent colour of a carrier (also used for the stripe). */
export function carrierAccent(carrier: string): number {
  return ACCENTS[hashString(carrier) % ACCENTS.length];
}

// ---- livery ----------------------------------------------------------------------------------

export const LIVERY_W = 1024;
export const LIVERY_H = 232;
const liveryCache = new Map<string, THREE.CanvasTexture>();

function drawLivery(ctx: CanvasRenderingContext2D, carrier: string): void {
  const w = LIVERY_W;
  const h = LIVERY_H;
  const accent = carrierAccent(carrier);
  ctx.clearRect(0, 0, w, h);
  // Sweeping stripe along the bottom: a long band that kicks up towards the cab end (u = 1).
  ctx.fillStyle = css(accent);
  ctx.beginPath();
  ctx.moveTo(0, h * 0.86);
  ctx.lineTo(w * 0.62, h * 0.86);
  ctx.bezierCurveTo(w * 0.8, h * 0.86, w * 0.86, h * 0.5, w, h * 0.42);
  ctx.lineTo(w, h * 0.6);
  ctx.bezierCurveTo(w * 0.9, h * 0.66, w * 0.84, h * 0.96, w * 0.66, h * 0.96);
  ctx.lineTo(0, h * 0.96);
  ctx.closePath();
  ctx.fill();
  // Thin companion pinstripe.
  ctx.fillStyle = css(accent === P.midnight ? P.sky : P.midnight);
  ctx.globalAlpha = 0.85;
  ctx.fillRect(0, h * 0.8, w * 0.6, h * 0.025);
  ctx.globalAlpha = 1;
  // Carrier name.
  const words = carrier.trim();
  let size = 92;
  ctx.font = `700 ${size}px ${DISPLAY}`;
  const maxW = w * 0.84;
  const tw = ctx.measureText(words).width;
  if (tw > maxW) {
    size = Math.floor((size * maxW) / tw);
    ctx.font = `700 ${size}px ${DISPLAY}`;
  }
  ctx.fillStyle = css(P.midnight);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(words, w * 0.06, h * 0.56);
  // Little cobalt chevron mark before the name.
  ctx.fillStyle = css(accent === P.midnight ? P.cobalt : accent);
  const cx = w * 0.035;
  const cy = h * 0.45;
  ctx.beginPath();
  ctx.moveTo(cx - 14, cy - 26);
  ctx.lineTo(cx + 10, cy);
  ctx.lineTo(cx - 14, cy + 26);
  ctx.lineTo(cx - 4, cy);
  ctx.closePath();
  ctx.fill();
}

export function liveryTexture(carrier: string): THREE.CanvasTexture {
  let t = liveryCache.get(carrier);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = LIVERY_W;
  c.height = LIVERY_H;
  const ctx = c.getContext('2d')!;
  drawLivery(ctx, carrier);
  t = makeTexture(c);
  const tex = t;
  onFonts(() => {
    drawLivery(ctx, carrier);
    tex.needsUpdate = true;
  });
  liveryCache.set(carrier, t);
  return t;
}

// ---- plates ----------------------------------------------------------------------------------

export interface PlateStyle {
  bg: number;
  fg: number;
  border?: number;
}

function drawPlate(ctx: CanvasRenderingContext2D, w: number, h: number, text: string, s: PlateStyle): void {
  ctx.clearRect(0, 0, w, h);
  const r = h * 0.22;
  ctx.fillStyle = css(s.border ?? s.bg);
  roundRect(ctx, 0, 0, w, h, r);
  ctx.fill();
  if (s.border !== undefined) {
    const b = h * 0.08;
    ctx.fillStyle = css(s.bg);
    roundRect(ctx, b, b, w - 2 * b, h - 2 * b, r - b);
    ctx.fill();
  }
  let size = Math.floor(h * 0.68);
  ctx.font = `700 ${size}px ${DISPLAY}`;
  const tw = ctx.measureText(text).width;
  const maxW = w * 0.86;
  if (tw > maxW) {
    size = Math.floor((size * maxW) / tw);
    ctx.font = `700 ${size}px ${DISPLAY}`;
  }
  ctx.fillStyle = css(s.fg);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, w / 2, h * 0.54);
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Per-unit plate texture (owned by the caller, dispose with the unit). */
export function plateTexture(text: string, style: PlateStyle, w = 256, h = 64): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  drawPlate(ctx, w, h, text, style);
  const t = makeTexture(c);
  let alive = true;
  t.addEventListener('dispose', () => (alive = false));
  onFonts(() => {
    if (!alive) return;
    drawPlate(ctx, w, h, text, style);
    t.needsUpdate = true;
  });
  return t;
}
