/** Shipment rail: the headline shipment as a route track with a moving marker, plus tickets. */
import type { ShipmentRow } from '../../core/types';
import type { Ctx } from '../ctx';
import { el, KeyedList, setAttr, setStyle, setText, toggle } from '../dom';
import { clockTime } from '../format';
import { icon, setIcon } from '../icons';
import { STATUS_TEXT, STATUS_TONE } from './card';

/** Relative length of each stage segment on the rail (transit is the long road). */
const WEIGHTS = [1, 1, 2.4, 0.75, 1, 1];
const TOTAL = WEIGHTS.reduce((a, b) => a + b, 0);
const BOUNDS: number[] = [0];
for (const w of WEIGHTS) BOUNDS.push(BOUNDS[BOUNDS.length - 1] + w / TOTAL);
const DEFAULT_LABELS = ['Picking', 'Loading', 'Transit', 'Arrived', 'Unloading', 'Putaway'];
const SEVERITY: Record<ShipmentRow['status'], number> = { late: 0, 'at-risk': 1, 'on-time': 2, done: 3 };

/** Marker position 0..1 along the weighted rail. Assumes `progress` splits evenly across stages. */
export function railPos(s: ShipmentRow): number {
  const n = Math.max(1, s.stages.length || 6);
  if (s.stage >= n) return 1;
  const st = Math.max(0, Math.min(n - 1, s.stage));
  const within = Math.max(0, Math.min(1, s.progress * n - st));
  const a = BOUNDS[Math.min(st, 6)];
  const b = BOUNDS[Math.min(st + 1, 6)];
  return a + (b - a) * within;
}

class Ticket {
  el: HTMLButtonElement;
  private id: HTMLElement;
  private route: HTMLElement;
  private fill: HTMLElement;
  constructor(private rail: Rail, s: ShipmentRow) {
    this.el = el('button', 'ym-ticket');
    this.el.type = 'button';
    const top = el('span', 'ym-ticket-top', this.el);
    el('i', 'ym-ticket-dot', top);
    this.id = el('span', 'ym-ticket-id', top);
    this.route = el('span', 'ym-ticket-route', top);
    const tr = el('span', 'ym-ticket-track', this.el);
    this.fill = el('span', 'ym-ticket-fill', tr);
    const sid = s.id;
    this.el.addEventListener('click', () => this.rail.pick(sid));
    this.el.addEventListener('dblclick', () => this.rail.pick(sid, true));
    this.el.addEventListener('mouseenter', () => this.rail.hoverShipment(sid));
    this.el.addEventListener('mouseleave', () => this.rail.hoverShipment(null));
  }
  update(s: ShipmentRow): void {
    const c = this.rail.ctx;
    setText(this.id, s.id);
    const code = (id: string) => c.sites.get(id)?.code ?? id.slice(0, 2).toUpperCase();
    setText(this.route, `${code(s.fromSiteId)} to ${code(s.toSiteId)}`);
    setAttr(this.el, 'data-tone', STATUS_TONE[s.status]);
    setAttr(this.el, 'title', `${s.id} · ${s.cargoLabel} · ${STATUS_TEXT[s.status]}${s.truckId ? ' · click to select its truck' : ''}`);
    setStyle(this.fill, 'transform', `scaleX(${railPos(s).toFixed(3)})`);
    toggle(this.el, 'is-current', this.rail.currentId === s.id);
    toggle(this.el, 'is-selected', !!s.truckId && c.selKey === `truck:${s.truckId}`);
  }
}

export class Rail {
  readonly el: HTMLElement;
  ctx!: Ctx;
  currentId = '';
  private pinned = '';
  private body: HTMLElement;
  private empty: HTMLElement;
  private sid: HTMLElement;
  private cargo: HTMLElement;
  private chip: HTMLElement;
  private chipText: HTMLElement;
  private eta: HTMLElement;
  private etaDue: HTMLElement;
  private fromMedal: HTMLElement;
  private toMedal: HTMLElement;
  private fromName: HTMLElement;
  private toName: HTMLElement;
  private fill: HTMLElement;
  private marker: HTMLElement;
  private markerIcon: HTMLElement;
  private nodes: HTMLElement[] = [];
  private labels: HTMLElement[] = [];
  private tickets: KeyedList<ShipmentRow, Ticket>;
  private tray: HTMLElement;
  private more: HTMLElement;

  constructor(private ctxRef: () => Ctx) {
    this.el = el('section', 'ym-panel ym-rail');
    this.el.setAttribute('aria-label', 'Shipment tracker');

    this.body = el('div', 'ym-rail-body', this.el);
    const head = el('div', 'ym-rail-head', this.body);
    const ht = el('div', 'ym-rail-title', head);
    this.sid = el('span', 'ym-rail-id', ht);
    this.cargo = el('span', 'ym-rail-cargo', ht);
    const hr = el('div', 'ym-rail-status', head);
    this.eta = el('span', 'ym-rail-eta', hr);
    this.etaDue = el('span', 'ym-rail-due', hr);
    this.chip = el('span', 'ym-chip ym-chip--sm', hr);
    el('i', 'ym-chip-dot', this.chip);
    this.chipText = el('span', '', this.chip);

    const line = el('div', 'ym-rail-line', this.body);
    const from = el('div', 'ym-rail-end', line);
    this.fromMedal = el('div', 'ym-medal ym-medal--sm', from);
    this.fromName = el('div', 'ym-rail-end-name', from);
    const track = el('div', 'ym-rail-track', line);
    const road = el('div', 'ym-rail-road', track);
    this.fill = el('div', 'ym-rail-fill', road);
    for (let i = 1; i < BOUNDS.length - 1; i++) {
      const n = el('i', 'ym-rail-node', track);
      setStyle(n, 'left', `${(BOUNDS[i] * 100).toFixed(2)}%`);
      this.nodes.push(n);
    }
    for (let i = 0; i < WEIGHTS.length; i++) {
      const l = el('span', 'ym-rail-stage', track, DEFAULT_LABELS[i]);
      setStyle(l, 'left', `${(((BOUNDS[i] + BOUNDS[i + 1]) / 2) * 100).toFixed(2)}%`);
      this.labels.push(l);
    }
    this.marker = el('div', 'ym-rail-marker', track);
    this.markerIcon = el('span', 'ym-rail-marker-i', this.marker);
    const to = el('div', 'ym-rail-end', line);
    this.toMedal = el('div', 'ym-medal ym-medal--sm', to);
    this.toName = el('div', 'ym-rail-end-name', to);

    this.tray = el('div', 'ym-rail-tickets', this.el);
    const tlist = el('div', 'ym-rail-tlist', this.tray);
    this.tickets = new KeyedList<ShipmentRow, Ticket>(tlist, (s) => s.id, (s) => new Ticket(this, s));
    this.more = el('span', 'ym-rail-more', this.tray);

    this.empty = el('div', 'ym-empty ym-empty--row', this.el);
    const ei = el('span', 'ym-empty-icon', this.empty);
    ei.appendChild(icon('route', 20, 1.7));
    const et = el('div', 'ym-empty-text', this.empty);
    el('strong', '', et, 'No shipments on the road');
    el('span', '', et, 'Transfers between sites will be tracked here, stage by stage.');
  }

  pick(id: string, focus = false): void {
    const c = this.ctxRef();
    const s = c.snap.shipments.find((x) => x.id === id);
    this.pinned = id;
    if (s?.truckId) {
      c.cmds.select({ kind: 'truck', id: s.truckId });
      if (focus) c.cmds.focusSelection();
    } else this.update(c);
  }

  hoverShipment(id: string | null): void {
    const c = this.ctxRef();
    const s = id ? c.snap.shipments.find((x) => x.id === id) : undefined;
    c.cmds.hover(s?.truckId ? { kind: 'truck', id: s.truckId } : null);
  }

  private choose(ctx: Ctx, list: ShipmentRow[]): ShipmentRow | undefined {
    const sel = ctx.snap.selection;
    if (sel?.shipmentId) {
      const s = list.find((x) => x.id === sel.shipmentId) ?? ctx.snap.shipments.find((x) => x.id === sel.shipmentId);
      if (s) return s;
    }
    if (ctx.selected?.kind === 'truck') {
      const s = ctx.snap.shipments.find((x) => x.truckId === ctx.selected!.id);
      if (s) return s;
    }
    if (this.pinned) {
      const s = ctx.snap.shipments.find((x) => x.id === this.pinned);
      if (s) return s;
      this.pinned = '';
    }
    return list[0];
  }

  update(ctx: Ctx): void {
    this.ctx = ctx;
    const all = ctx.snap.shipments.filter((s) => s.status !== 'done' || s.stage < (s.stages.length || 6));
    let list = all;
    if (ctx.site) {
      const here = all.filter((s) => s.fromSiteId === ctx.site!.id || s.toSiteId === ctx.site!.id);
      if (here.length) list = here;
    }
    list = [...list].sort((a, b) => SEVERITY[a.status] - SEVERITY[b.status] || a.etaAt - a.dueAt - (b.etaAt - b.dueAt) || a.id.localeCompare(b.id));
    const cur = this.choose(ctx, list);
    toggle(this.el, 'is-empty', !cur);
    if (!cur) {
      this.currentId = '';
      this.tickets.sync([]);
      return;
    }
    this.currentId = cur.id;
    const from = ctx.sites.get(cur.fromSiteId);
    const to = ctx.sites.get(cur.toSiteId);
    setText(this.sid, cur.id);
    setText(this.cargo, `${cur.cargoLabel} · ${cur.palletsDone} of ${cur.pallets} pallets`);
    const tone = STATUS_TONE[cur.status];
    setAttr(this.el, 'data-tone', tone);
    setAttr(this.chip, 'data-tone', tone);
    setText(this.chipText, cap1(STATUS_TEXT[cur.status]));
    setText(this.eta, `ETA ${clockTime(cur.etaAt)}`);
    setText(this.etaDue, `due ${clockTime(cur.dueAt)}`);
    setAttr(this.fromMedal, 'data-kind', from?.kind ?? 'dc');
    setIcon(this.fromMedal, from?.kind ?? 'dc', 15, 1.9);
    setAttr(this.toMedal, 'data-kind', to?.kind ?? 'dc');
    setIcon(this.toMedal, to?.kind ?? 'dc', 15, 1.9);
    setText(this.fromName, from ? from.name.split(' ')[0] : cur.fromSiteId);
    setText(this.toName, to ? to.name.split(' ')[0] : cur.toSiteId);
    setAttr(this.fromMedal, 'title', from?.name ?? cur.fromSiteId);
    setAttr(this.toMedal, 'title', to?.name ?? cur.toSiteId);

    const pos = railPos(cur);
    setStyle(this.fill, 'transform', `scaleX(${pos.toFixed(4)})`);
    setStyle(this.marker, 'left', `${(pos * 100).toFixed(3)}%`);
    const st = cur.stage;
    setIcon(this.markerIcon, st <= 1 ? 'pallet' : st >= 5 ? 'forklift' : 'truck', 14, 2);
    for (let i = 0; i < this.nodes.length; i++) {
      toggle(this.nodes[i], 'is-done', i < st);
    }
    for (let i = 0; i < this.labels.length; i++) {
      const stg = cur.stages[i];
      setText(this.labels[i], stg?.label ?? DEFAULT_LABELS[i]);
      toggle(this.labels[i], 'is-done', i < st);
      toggle(this.labels[i], 'is-now', i === st);
      setAttr(this.labels[i], 'title', stg?.doneAt !== undefined ? `${stg.label} done at ${clockTime(stg.doneAt)}` : (stg?.label ?? ''));
    }
    toggle(this.el, 'is-selected', !!cur.truckId && ctx.selKey === `truck:${cur.truckId}`);
    toggle(this.marker, 'is-clickable', !!cur.truckId);
    this.marker.onclick = cur.truckId ? () => this.pick(cur.id) : null;
    setAttr(this.marker, 'title', cur.truckId ? 'Select this truck' : '');

    const tix = list.slice(0, 8);
    this.tickets.sync(tix);
    const extra = list.length - tix.length;
    setText(this.more, extra > 0 ? `+${extra}` : '');
    toggle(this.more, 'is-on', extra > 0);
  }
}

const cap1 = (s: string): string => s[0].toUpperCase() + s.slice(1);
