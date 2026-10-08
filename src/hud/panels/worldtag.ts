/** Floating label above the selected unit. Positioned every frame by transform only. */
import { el } from '../dom';

export class WorldTag {
  readonly el: HTMLElement;
  private text: HTMLElement;
  private dot: HTMLElement;
  private lastText = '';
  private lastVisible = false;
  private lastX = NaN;
  private lastY = NaN;

  constructor() {
    this.el = el('div', 'ym-tag');
    this.el.setAttribute('aria-hidden', 'true');
    const pill = el('div', 'ym-tag-pill', this.el);
    this.dot = el('i', 'ym-tag-dot', pill);
    this.text = el('span', 'ym-tag-text', pill);
    el('i', 'ym-tag-stem', this.el);
    el('i', 'ym-tag-foot', this.el);
  }

  setTone(tone: string): void {
    if (this.dot.dataset.tone !== tone) this.dot.dataset.tone = tone;
  }

  set(x: number, y: number, text: string, visible: boolean): void {
    if (visible !== this.lastVisible) {
      this.lastVisible = visible;
      this.el.classList.toggle('is-visible', visible);
    }
    if (!visible) return;
    if (text !== this.lastText) {
      this.lastText = text;
      this.text.textContent = text;
    }
    const rx = Math.round(x * 2) / 2;
    const ry = Math.round(y * 2) / 2;
    if (rx !== this.lastX || ry !== this.lastY) {
      this.lastX = rx;
      this.lastY = ry;
      this.el.style.transform = `translate3d(${rx}px, ${ry}px, 0)`;
    }
  }
}
