/** Unit card hanging under a round portrait lens. */
import type { DetailField, SelectionDetail } from '../../core/types';
import type { Ctx } from '../ctx';
import { el, KeyedList, setAttr, setStyle, setText, toggle } from '../dom';
import { cap, pct } from '../format';
import { icon, setIcon } from '../icons';

const PORTRAIT = 224;
const KIND_LABEL: Record<string, string> = { truck: 'Truck', forklift: 'Forklift', pallet: 'Pallet', dock: 'Dock door', site: 'Site' };

class FieldRow {
  el: HTMLElement;
  private label: HTMLElement;
  private value: HTMLElement;
  constructor() {
    this.el = el('div', 'ym-field');
    this.label = el('div', 'ym-field-label', this.el);
    this.value = el('div', 'ym-field-value', this.el);
  }
  update(f: DetailField): void {
    setText(this.label, f.label);
    setText(this.value, f.value);
    setAttr(this.value, 'title', f.value);
    setAttr(this.value, 'data-tone', f.tone ?? null);
    toggle(this.el, 'is-wide', f.value.length > 18);
  }
}

export class UnitCard {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private lens: HTMLElement;
  private placeholder: HTMLElement;
  private badge: HTMLElement;
  private card: HTMLElement;
  private kind: HTMLElement;
  private title: HTMLElement;
  private subtitle: HTMLElement;
  private chip: HTMLElement;
  private chipText: HTMLElement;
  private reads: HTMLElement;
  private meter: HTMLElement;
  private meterIcon: HTMLElement;
  private meterLabel: HTMLElement;
  private meterValue: HTMLElement;
  private meterTrack: HTMLElement;
  private meterFill: HTMLElement;
  private cells: HTMLElement;
  private progress: HTMLElement;
  private progLabel: HTMLElement;
  private progValue: HTMLElement;
  private progFill: HTMLElement;
  private fields: KeyedList<DetailField, FieldRow>;
  private shown = false;
  private refKey = '';

  constructor(private ctxRef: () => Ctx) {
    this.el = el('section', 'ym-unit');
    this.el.setAttribute('aria-label', 'Selection');
    this.el.setAttribute('aria-live', 'polite');

    this.lens = el('div', 'ym-lens', this.el);
    const glass = el('div', 'ym-lens-glass', this.lens);
    this.placeholder = el('div', 'ym-lens-ph', glass);
    this.canvas = el('canvas', 'ym-lens-canvas', glass);
    this.canvas.width = this.canvas.height = PORTRAIT;
    el('div', 'ym-lens-shine', glass);
    this.badge = el('div', 'ym-lens-badge', this.lens);

    this.card = el('div', 'ym-panel ym-card', this.el);
    const close = el('button', 'ym-card-close', this.card);
    close.type = 'button';
    close.title = 'Deselect (Esc)';
    close.setAttribute('aria-label', 'Deselect');
    close.appendChild(icon('close', 16, 2));
    close.addEventListener('click', () => this.ctxRef().cmds.select(null));

    const head = el('div', 'ym-card-head', this.card);
    this.kind = el('div', 'ym-card-kind', head);
    this.title = el('h2', 'ym-card-title', head);
    this.subtitle = el('div', 'ym-card-sub', head);
    this.chip = el('div', 'ym-chip', head);
    el('i', 'ym-chip-dot', this.chip);
    this.chipText = el('span', '', this.chip);

    const body = el('div', 'ym-card-body', this.card);
    this.reads = el('div', 'ym-reads', body);
    this.meter = el('div', 'ym-meter', this.reads);
    const mh = el('div', 'ym-meter-head', this.meter);
    this.meterIcon = el('span', 'ym-meter-icon', mh);
    this.meterLabel = el('span', 'ym-meter-label', mh);
    this.meterValue = el('span', 'ym-meter-value', mh);
    this.meterTrack = el('div', 'ym-meter-track', this.meter);
    this.meterFill = el('div', 'ym-meter-fill', this.meterTrack);
    this.cells = el('div', 'ym-meter-cells', this.meter);
    for (let i = 0; i < 10; i++) el('i', '', this.cells);

    this.progress = el('div', 'ym-prog', this.reads);
    const ph = el('div', 'ym-meter-head', this.progress);
    this.progLabel = el('span', 'ym-meter-label', ph);
    this.progValue = el('span', 'ym-meter-value', ph);
    const pt = el('div', 'ym-prog-track', this.progress);
    this.progFill = el('div', 'ym-prog-fill', pt);

    const grid = el('div', 'ym-fields', body);
    this.fields = new KeyedList<DetailField, FieldRow>(grid, (f) => f.label, () => new FieldRow());


    const actions = el('div', 'ym-card-actions', this.card);
    const focus = el('button', 'ym-btn ym-btn--primary', actions);
    focus.type = 'button';
    focus.appendChild(icon('focus', 17, 1.9));
    el('span', '', focus, 'Focus camera');
    el('kbd', 'ym-kbd ym-kbd--on-primary', focus, 'F');
    focus.addEventListener('click', () => this.ctxRef().cmds.focusSelection());
  }

  /** Canvas for the live portrait, or null while no selection is shown. */
  portrait(): HTMLCanvasElement | null {
    return this.shown ? this.canvas : null;
  }

  update(ctx: Ctx): void {
    const d = ctx.snap.selection;
    toggle(this.el, 'is-shown', !!d);
    this.shown = !!d;
    if (!d) {
      this.refKey = '';
      return;
    }
    const key = `${d.ref.kind}:${d.ref.id}`;
    if (key !== this.refKey) {
      this.refKey = key;
      // Fresh subject: wipe the previous portrait so it never flashes under a new card.
      this.canvas.getContext('2d')?.clearRect(0, 0, PORTRAIT, PORTRAIT);
    }
    const kind = d.ref.kind;
    const siteKind = kind === 'site' ? (ctx.sites.get(d.ref.id)?.kind ?? 'dc') : null;
    const glyph = siteKind ?? kind;
    setAttr(this.el, 'data-kind', kind);
    setIcon(this.placeholder, glyph, 44, 1.4);
    setIcon(this.badge, glyph, 16, 2);
    setAttr(this.badge, 'title', KIND_LABEL[kind] ?? cap(kind));
    setText(this.kind, KIND_LABEL[kind] ?? cap(kind));
    setText(this.title, d.title);
    setText(this.subtitle, d.subtitle);
    toggle(this.subtitle, 'is-empty', !d.subtitle);
    setText(this.chipText, d.status);
    setAttr(this.chip, 'data-tone', d.statusTone);

    this.updateMeter(d);
    const p = d.progress;
    toggle(this.progress, 'is-hidden', !p);
    if (p) {
      setText(this.progLabel, p.label);
      setText(this.progValue, pct(p.value));
      setStyle(this.progFill, 'transform', `scaleX(${clamp01(p.value).toFixed(3)})`);
    }
    toggle(this.reads, 'is-hidden', !p && !d.meter);
    this.fields.sync(d.fields);

  }

  private updateMeter(d: SelectionDetail): void {
    const m = d.meter;
    toggle(this.meter, 'is-hidden', !m);
    if (!m) return;
    const isBattery = d.ref.kind === 'forklift';
    const isTrailer = d.ref.kind === 'truck';
    toggle(this.meter, 'is-cells', isBattery);
    toggle(this.meter, 'is-trailer', isTrailer);
    setIcon(this.meterIcon, isBattery ? 'bolt' : isTrailer ? 'truck' : d.ref.kind === 'site' ? 'storage' : 'pallet', 14, 1.9);
    setText(this.meterLabel, m.label);
    setText(this.meterValue, pct(m.value));
    setAttr(this.meter, 'data-tone', m.tone);
    const v = clamp01(m.value);
    setStyle(this.meterFill, 'transform', `scaleX(${v.toFixed(3)})`);
    if (isBattery) {
      const n = Math.round(v * 10);
      for (let i = 0; i < 10; i++) toggle(this.cells.children[i], 'on', i < n);
    }
  }
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
export const STATUS_TEXT: Record<string, string> = { 'on-time': 'on time', 'at-risk': 'at risk', late: 'late', done: 'delivered' };
export const STATUS_TONE: Record<string, string> = { 'on-time': 'good', 'at-risk': 'warn', late: 'alert', done: 'good' };
