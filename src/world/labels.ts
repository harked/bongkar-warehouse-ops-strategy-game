/**
 * One canvas texture atlas per site: the gate sign, the roof banner, door fascia plates and the
 * big door numbers painted on the yard. Redrawn once the web fonts are ready.
 */
import * as THREE from 'three';
import { css, P } from '../core/palette';
import type { SiteLayout } from '../core/types';

const W = 2048;
const H = 1024;
const CELL_W = 128;
const CELL_H = 64;

export interface UVRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export interface SiteAtlas {
  texture: THREE.CanvasTexture;
  sign: UVRect;
  roof: UVRect;
  plate(i: number): UVRect;
  ground(i: number): UVRect;
  queue(i: number): UVRect;
}

const uv = (x: number, y: number, w: number, h: number): UVRect => ({ u0: x / W, v0: 1 - (y + h) / H, u1: (x + w) / W, v1: 1 - y / H });

const DISPLAY = '"Outfit Variable", "Outfit", system-ui, sans-serif';
const UI = '"Manrope Variable", "Manrope", system-ui, sans-serif';

let fontsReady: Promise<unknown> | null = null;
function whenFonts(): Promise<unknown> {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load(`700 64px ${DISPLAY}`),
      document.fonts.load(`600 32px ${UI}`),
      document.fonts.load(`800 64px ${DISPLAY}`),
    ]).catch(() => undefined);
  }
  return fontsReady;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

export function accentOf(kind: SiteLayout['def']['kind']): number {
  return kind === 'cold' ? P.azure : kind === 'crossdock' ? P.midnight : kind === 'hub' ? P.pine : P.cobalt;
}

export function createSiteAtlas(site: SiteLayout): SiteAtlas {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;

  const accent = css(accentOf(site.def.kind));
  const draw = () => {
    const g = canvas.getContext('2d')!;
    g.clearRect(0, 0, W, H);
    // ---- gate sign: white panel, coloured medallion with the code, name and blurb ---------------
    g.save();
    g.fillStyle = '#ffffff';
    roundRect(g, 8, 8, 1008, 240, 36);
    g.fill();
    g.fillStyle = accent;
    g.beginPath();
    g.arc(128, 128, 88, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = `800 76px ${DISPLAY}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(site.def.code, 128, 134);
    g.textAlign = 'left';
    g.fillStyle = css(P.midnight);
    g.font = `700 84px ${DISPLAY}`;
    fitText(g, site.def.name, 250, 118, 740);
    g.fillStyle = css(P.slate);
    g.font = `600 44px ${UI}`;
    fitText(g, site.def.blurb, 252, 192, 740);
    g.restore();

    // ---- roof banner: accent plate with white lettering ------------------------------------------
    g.save();
    g.fillStyle = accent;
    roundRect(g, 1032, 24, 1008, 208, 40);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = `800 120px ${DISPLAY}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    fitText(g, site.def.name, 1536, 136, 940, 'center');
    g.restore();

    // ---- door plates and yard numbers -------------------------------------------------------------
    site.doors.forEach((d, i) => {
      const [px, py] = cellXY(i, 256);
      g.fillStyle = d.role === 'inbound' ? css(P.azure) : css(P.midnight);
      roundRect(g, px + 6, py + 6, CELL_W - 12, CELL_H - 12, 12);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = `700 40px ${DISPLAY}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(d.label, px + CELL_W / 2, py + CELL_H / 2 + 2);

      const [gx, gy] = cellXY(i, 384);
      g.fillStyle = 'rgba(255,255,255,0.96)';
      g.font = `800 54px ${DISPLAY}`;
      g.fillText(d.label, gx + CELL_W / 2, gy + CELL_H / 2 + 3);
    });
    site.queueSpots.forEach((_, i) => {
      const [qx, qy] = cellXY(i, 512);
      g.fillStyle = 'rgba(255,255,255,0.96)';
      g.font = `800 50px ${DISPLAY}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('P' + (i + 1), qx + CELL_W / 2, qy + CELL_H / 2 + 3);
    });
    tex.needsUpdate = true;
  };
  draw();
  void whenFonts().then(draw);

  return {
    texture: tex,
    sign: uv(8, 8, 1008, 240),
    roof: uv(1032, 24, 1008, 208),
    plate: (i) => uv(...cellXY(i, 256), CELL_W, CELL_H),
    ground: (i) => uv(...cellXY(i, 384), CELL_W, CELL_H),
    queue: (i) => uv(...cellXY(i, 512), CELL_W, CELL_H),
  };
}

function cellXY(i: number, y0: number): [number, number] {
  return [(i % 16) * CELL_W, y0 + Math.floor(i / 16) * CELL_H];
}

function fitText(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, align: CanvasTextAlign = 'left'): void {
  g.textAlign = align;
  g.textBaseline = 'middle';
  const w = g.measureText(text).width;
  if (w > maxW) {
    const m = /(\d+)px/.exec(g.font);
    if (m) g.font = g.font.replace(`${m[1]}px`, `${Math.floor((+m[1] * maxW) / w)}px`);
  }
  g.fillText(text, x, y);
}
