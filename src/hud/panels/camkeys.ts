/** Camera keys: square icon keys for home, rotate and zoom, plus the keyboard hint card. */
import type { Ctx } from '../ctx';
import { el, toggle } from '../dom';
import { icon } from '../icons';

const HINTS: [string[], string][] = [
  [['Drag'], 'Pan the map'],
  [['Right drag'], 'Orbit'],
  [['W', 'A', 'S', 'D'], 'Pan'],
  [['Q', 'E'], 'Rotate'],
  [['Wheel'], 'Zoom to cursor'],
  [['Space'], 'Pause or resume'],
  [['1', '2', '3'], 'Speed 1x, 4x, 12x'],
  [['F'], 'Focus selection'],
  [['H'], 'Home view'],
  [['Esc'], 'Deselect'],
  [['[', ']'], 'Previous or next site'],
];

export class CamKeys {
  readonly el: HTMLElement;
  private hint: HTMLElement;
  private hintBtn: HTMLButtonElement;
  private pinned = false;

  constructor(private ctxRef: () => Ctx) {
    this.el = el('section', 'ym-cam');
    this.el.setAttribute('aria-label', 'Camera');

    this.hint = el('div', 'ym-panel ym-hints', this.el);
    this.hint.setAttribute('role', 'tooltip');
    el('div', 'ym-hints-title', this.hint, 'Controls');
    const grid = el('div', 'ym-hints-grid', this.hint);
    for (const [keys, what] of HINTS) {
      const k = el('span', 'ym-hints-keys', grid);
      keys.forEach((key) => el('kbd', 'ym-kbd', k, key));
      el('span', 'ym-hints-what', grid, what);
    }

    const pad = el('div', 'ym-panel ym-cam-pad', this.el);
    const key = (name: string, title: string, fn: () => void, cls = '') => {
      const b = el('button', `ym-key ${cls}`, pad);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      b.appendChild(icon(name, 18, 1.9));
      b.addEventListener('click', fn);
      return b;
    };
    const cmds = () => this.ctxRef().cmds;
    key('rotl', 'Rotate left (Q)', () => cmds().rotateCamera(-Math.PI / 8));
    key('home', 'Home view (H)', () => cmds().home(), 'ym-key--home');
    key('rotr', 'Rotate right (E)', () => cmds().rotateCamera(Math.PI / 8));
    key('zoomout', 'Zoom out (-)', () => cmds().zoomCamera(1.3));
    this.hintBtn = key('keyboard', 'Keyboard shortcuts', () => this.setPinned(!this.pinned), 'ym-key--hint');
    key('zoomin', 'Zoom in (+)', () => cmds().zoomCamera(1 / 1.3));
    this.hintBtn.setAttribute('aria-expanded', 'false');
    this.hintBtn.addEventListener('mouseenter', () => toggle(this.el, 'is-peek', true));
    this.hintBtn.addEventListener('mouseleave', () => toggle(this.el, 'is-peek', false));
    window.addEventListener('keydown', (e) => {
      if (e.key === '?' ) this.setPinned(!this.pinned);
    });
  }

  private setPinned(on: boolean): void {
    this.pinned = on;
    toggle(this.el, 'is-hints', on);
    toggle(this.hintBtn, 'is-on', on);
    this.hintBtn.setAttribute('aria-expanded', on ? 'true' : 'false');
  }
}
