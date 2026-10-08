/** Sun dial: a day arc with the sun (or moon) riding it, the time, and the speed control. */
import type { Ctx } from '../ctx';
import { el, setAttr, setText, svgNode, toggle } from '../dom';
import { shiftName } from '../format';
import { setIcon } from '../icons';

const W = 208;
const H = 92;
const CX = W / 2;
const CY = 84;
const R = 74;
const SUNRISE = 6;
const SUNSET = 20;

/** Point on the arc for a 0..1 position (0 = left horizon, 1 = right horizon). */
function arcPoint(u: number): [number, number] {
  const a = Math.PI * (1 - u);
  return [CX + Math.cos(a) * R, CY - Math.sin(a) * R];
}

export class Clock {
  readonly el: HTMLElement;
  private time: HTMLElement;
  private day: HTMLElement;
  private shift: HTMLElement;
  private shiftIcon: HTMLElement;
  private done: SVGPathElement;
  private body: SVGGElement;
  private speedBtns = new Map<number, HTMLButtonElement>();
  private pauseBtn: HTMLButtonElement;
  private pauseIcon: HTMLElement;
  private lastU = -1;

  constructor(private ctxRef: () => Ctx) {
    this.el = el('section', 'ym-panel ym-dial');
    this.el.setAttribute('aria-label', 'Clock and speed');
    const face = el('div', 'ym-dial-face', this.el);
    const s = svgNode('svg', { class: 'ym-dial-svg', viewBox: `0 0 ${W} ${H}`, width: W, height: H }, face);
    const defs = svgNode('defs', {}, s);
    const g = svgNode('linearGradient', { id: 'ym-dial-done', x1: '0', x2: '1', y1: '0', y2: '0' }, defs);
    svgNode('stop', { offset: '0', 'stop-color': '#FFD47A' }, g);
    svgNode('stop', { offset: '1', 'stop-color': '#FFB21F' }, g);
    // Hour ticks every 2 h of daylight.
    for (let h = SUNRISE; h <= SUNSET; h += 2) {
      const u = (h - SUNRISE) / (SUNSET - SUNRISE);
      const a = Math.PI * (1 - u);
      const r0 = R + 6;
      const r1 = R + (h % 6 === 0 ? 11 : 9);
      svgNode(
        'line',
        {
          class: h % 6 === 0 ? 'ym-dial-tick is-major' : 'ym-dial-tick',
          x1: CX + Math.cos(a) * r0,
          y1: CY - Math.sin(a) * r0,
          x2: CX + Math.cos(a) * r1,
          y2: CY - Math.sin(a) * r1,
        },
        s,
      );
    }
    const [lx, ly] = arcPoint(0);
    const [rx, ry] = arcPoint(1);
    svgNode('path', { class: 'ym-dial-track', d: `M${lx},${ly} A${R},${R} 0 0 1 ${rx},${ry}` }, s);
    this.done = svgNode('path', { class: 'ym-dial-done' }, s);
    svgNode('line', { class: 'ym-dial-horizon', x1: 6, y1: CY + 0.5, x2: W - 6, y2: CY + 0.5 }, s);
    this.body = svgNode('g', { class: 'ym-dial-body' }, s);
    svgNode('circle', { class: 'ym-dial-halo', r: 11 }, this.body);
    svgNode('circle', { class: 'ym-dial-sun', r: 6.5 }, this.body);
    svgNode('circle', { class: 'ym-dial-mooncut', r: 5.2, cx: 3.2, cy: -2.4 }, this.body);

    const read = el('div', 'ym-dial-read', face);
    this.time = el('div', 'ym-dial-time', read);
    this.day = el('div', 'ym-dial-day', read);

    const meta = el('div', 'ym-dial-meta', this.el);
    this.shiftIcon = el('span', 'ym-dial-shift-i', meta);
    this.shift = el('span', 'ym-dial-shift', meta);

    const seg = el('div', 'ym-speed', this.el);
    seg.setAttribute('role', 'group');
    seg.setAttribute('aria-label', 'Simulation speed');
    this.pauseBtn = el('button', 'ym-speed-btn ym-speed-pause', seg);
    this.pauseBtn.type = 'button';
    this.pauseIcon = el('span', 'ym-speed-i', this.pauseBtn);
    this.pauseBtn.addEventListener('click', () => this.ctxRef().cmds.togglePause());
    for (const sp of [1, 4, 12]) {
      const b = el('button', 'ym-speed-btn', seg);
      b.type = 'button';
      el('span', '', b, `${sp}x`);
      b.title = `Speed ${sp}x (${sp === 1 ? 1 : sp === 4 ? 2 : 3})`;
      b.addEventListener('click', () => {
        const c = this.ctxRef();
        c.cmds.setSpeed(sp);
        if (c.snap.clock.paused) c.cmds.togglePause();
      });
      this.speedBtns.set(sp, b);
    }
  }

  update(ctx: Ctx): void {
    const c = ctx.snap.clock;
    setText(this.time, c.label);
    setText(this.day, c.dayLabel);
    const hrs = (((c.seconds / 3600) % 24) + 24) % 24;
    const isDay = hrs >= SUNRISE && hrs < SUNSET;
    let u: number;
    if (isDay) u = (hrs - SUNRISE) / (SUNSET - SUNRISE);
    else {
      const nightLen = 24 - (SUNSET - SUNRISE);
      const since = (hrs - SUNSET + 24) % 24;
      u = since / nightLen;
    }
    u = Math.round(u * 600) / 600;
    if (u !== this.lastU) {
      this.lastU = u;
      const [x, y] = arcPoint(u);
      setAttr(this.body, 'transform', `translate(${x.toFixed(2)} ${y.toFixed(2)})`);
      const [lx, ly] = arcPoint(0);
      setAttr(this.done, 'd', u > 0.002 ? `M${lx},${ly} A${R},${R} 0 0 1 ${x.toFixed(2)},${y.toFixed(2)}` : '');
    }
    toggle(this.el, 'is-night', !isDay);
    toggle(this.el, 'is-paused', c.paused);
    setText(this.shift, c.paused ? 'Paused' : `${shiftName(c.seconds)} · ${isDay ? 'daylight' : 'night'}`);
    setIcon(this.shiftIcon, c.paused ? 'pause' : isDay ? 'sun' : 'moon', 14, 2);
    setIcon(this.pauseIcon, c.paused ? 'play' : 'pause', 16);
    setAttr(this.pauseBtn, 'title', c.paused ? 'Resume (Space)' : 'Pause (Space)');
    setAttr(this.pauseBtn, 'aria-pressed', c.paused ? 'true' : 'false');
    toggle(this.pauseBtn, 'is-on', c.paused);
    for (const [sp, b] of this.speedBtns) {
      const on = Math.abs(c.speed - sp) < 0.01;
      toggle(b, 'is-on', on);
      setAttr(b, 'aria-pressed', on ? 'true' : 'false');
    }
  }
}
