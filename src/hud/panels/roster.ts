/** Roster drawer: tabbed live readouts of docks, forklifts and trucks. */
import type { DockRow, DockState, EntityRef, ForkliftRow, ForkliftState, TruckRow, TruckState } from '../../core/types';
import type { Ctx } from '../ctx';
import { el, KeyedList, setAttr, setStyle, setText, toggle } from '../dom';
import { duration, pct } from '../format';
import { icon, setIcon } from '../icons';

type Tab = 'dock' | 'forklift' | 'truck';

const DOCK_STATE: Record<DockState, [string, string]> = {
  idle: ['Idle', 'neutral'],
  reserved: ['Reserved', 'cold'],
  docking: ['Truck docking', 'active'],
  unloading: ['Unloading', 'active'],
  loading: ['Loading', 'active'],
  departing: ['Departing', 'good'],
};
const LIFT_STATE: Record<ForkliftState, [string, string]> = {
  idle: ['Idle', 'neutral'],
  'to-pick': ['To pick', 'active'],
  carrying: ['Carrying', 'active'],
  'to-charge': ['To charger', 'warn'],
  charging: ['Charging', 'cold'],
};
const TRUCK_STATE: Record<TruckState, [string, string]> = {
  'en-route': ['En route', 'cold'],
  queued: ['Queued', 'neutral'],
  docking: ['Docking', 'active'],
  'at-dock': ['At dock', 'active'],
  departing: ['Departing', 'good'],
  leaving: ['Leaving', 'neutral'],
};

type Item = { kind: Tab; key: string; ref: EntityRef; dock?: DockRow; lift?: ForkliftRow; truck?: TruckRow };

/** One row element whose inner layout depends on the kind. Built once, updated by diff. */
class Row {
  el: HTMLElement;
  ref: EntityRef;
  private badge: HTMLElement;
  private title: HTMLElement;
  private site: HTMLElement;
  private state: HTMLElement;
  private sub: HTMLElement;
  private aside: HTMLElement;
  private bar?: HTMLElement;
  private barVal?: HTMLElement;
  private batt?: HTMLElement;
  private battFill?: HTMLElement;
  private battVal?: HTMLElement;
  private eta?: HTMLElement;

  constructor(
    private roster: Roster,
    it: Item,
  ) {
    this.ref = it.ref;
    this.el = el('div', `ym-row ym-row--${it.kind}`);
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'option');
    this.badge = el('span', 'ym-row-badge', this.el);
    const main = el('div', 'ym-row-main', this.el);
    const l1 = el('div', 'ym-row-l1', main);
    this.title = el('span', 'ym-row-title', l1);
    this.site = el('span', 'ym-row-site', l1);
    this.state = el('span', 'ym-row-state', l1);
    this.sub = el('div', 'ym-row-sub', main);
    this.aside = el('div', 'ym-row-aside', this.el);
    if (it.kind === 'dock') {
      const t = el('div', 'ym-row-bar', this.aside);
      this.bar = el('div', 'ym-row-bar-fill', t);
      this.barVal = el('span', 'ym-row-num', this.aside);
    } else if (it.kind === 'forklift') {
      this.batt = el('span', 'ym-batt', this.aside);
      this.battFill = el('i', 'ym-batt-fill', this.batt);
      el('i', 'ym-batt-cap', this.batt);
      this.battVal = el('span', 'ym-row-num', this.aside);
    } else {
      this.eta = el('span', 'ym-row-eta', this.aside);
      const t = el('div', 'ym-row-bar ym-row-bar--load', this.aside);
      this.bar = el('div', 'ym-row-bar-fill', t);
    }
    this.el.addEventListener('click', () => roster.ctx.cmds.select(this.ref));
    this.el.addEventListener('dblclick', () => {
      roster.ctx.cmds.select(this.ref);
      roster.ctx.cmds.focusSelection();
    });
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        roster.ctx.cmds.select(this.ref);
        if (e.shiftKey) roster.ctx.cmds.focusSelection();
      }
    });
    this.el.addEventListener('mouseenter', () => roster.ctx.cmds.hover(this.ref));
    this.el.addEventListener('mouseleave', () => roster.ctx.cmds.hover(null));
  }

  update(it: Item): void {
    const ctx = this.roster.ctx;
    toggle(this.el, 'is-selected', ctx.selKey === it.key);
    setAttr(this.el, 'aria-selected', ctx.selKey === it.key ? 'true' : 'false');
    const siteCode = (id?: string) => (id ? (ctx.sites.get(id)?.code ?? '') : '');
    if (it.dock) {
      const d = it.dock;
      const [label, tone] = DOCK_STATE[d.state];
      setText(this.badge, d.label.replace(/^D/, ''));
      setAttr(this.badge, 'data-role', d.role);
      setAttr(this.badge, 'title', `${d.label} · ${d.role}`);
      setText(this.title, d.label);
      setText(this.site, ctx.network ? siteCode(d.siteId) : '');
      setText(this.state, label);
      setAttr(this.el, 'data-tone', tone);
      setText(this.sub, d.truckLabel ? `${d.truckLabel} · ${d.role}` : d.role === 'inbound' ? 'Inbound door, free' : 'Outbound door, free');
      const working = d.state === 'unloading' || d.state === 'loading';
      const v = d.state === 'idle' || d.state === 'reserved' || d.state === 'docking' ? 0 : working ? d.progress : 1;
      setStyle(this.bar!, 'transform', `scaleX(${v.toFixed(3)})`);
      setText(this.barVal!, working || d.state === 'departing' ? pct(v) : '');
    } else if (it.lift) {
      const f = it.lift;
      const [label, tone] = LIFT_STATE[f.state];
      setIcon(this.badge, 'forklift', 16, 1.9);
      setText(this.title, f.label);
      setText(this.site, ctx.network ? siteCode(f.siteId) : '');
      setText(this.state, label);
      setAttr(this.el, 'data-tone', tone);
      setText(this.sub, f.task || `${f.movedToday} pallets moved today`);
      const b = Math.max(0, Math.min(1, f.battery));
      setStyle(this.battFill!, 'transform', `scaleX(${b.toFixed(3)})`);
      setAttr(this.batt!, 'data-level', f.state === 'charging' ? 'charging' : b < 0.2 ? 'low' : b < 0.45 ? 'mid' : 'ok');
      setText(this.battVal!, pct(b));
    } else if (it.truck) {
      const t = it.truck;
      const [label, tone] = TRUCK_STATE[t.state];
      setIcon(this.badge, 'truck', 16, 1.9);
      setAttr(this.badge, 'data-variant', t.variant);
      setText(this.title, t.label);
      setText(this.site, ctx.network ? siteCode(t.siteId) : '');
      setText(this.state, label);
      setAttr(this.el, 'data-tone', tone);
      setText(this.sub, `${t.where}${t.carrier ? ` · ${t.carrier}` : ''}`);
      setText(this.eta!, t.state === 'en-route' && t.etaSec !== undefined ? duration(t.etaSec) : t.doorLabel ?? '');
      setStyle(this.bar!, 'transform', `scaleX(${Math.max(0, Math.min(1, t.load)).toFixed(3)})`);
      setAttr(this.aside, 'title', `Trailer ${pct(t.load)} full`);
    }
  }
}

const EMPTY: Record<Tab, [string, string, string]> = {
  dock: ['dock', 'No docks reporting', 'Dock doors show up here once the yard is scheduled.'],
  forklift: ['forklift', 'No forklifts on shift', 'Lifts appear here as soon as operators sign in.'],
  truck: ['truck', 'No trucks nearby', 'Inbound and outbound trucks will be listed here.'],
};

export class Roster {
  readonly el: HTMLElement;
  ctx!: Ctx;
  private tab: Tab = 'dock';
  private open = false;
  private tabs = new Map<Tab, { btn: HTMLButtonElement; count: HTMLElement }>();
  private list: HTMLElement;
  private rows: KeyedList<Item, Row>;
  private empty: HTMLElement;
  private emptyIcon: HTMLElement;
  private emptyTitle: HTMLElement;
  private emptyText: HTMLElement;
  private summary: HTMLElement;
  private lastSel = '';

  constructor(private ctxRef: () => Ctx) {
    this.el = el('section', 'ym-panel ym-roster');
    this.el.setAttribute('aria-label', 'Roster');
    const tabs = el('div', 'ym-tabs', this.el);
    tabs.setAttribute('role', 'tablist');
    const names: [Tab, string][] = [
      ['dock', 'Docks'],
      ['forklift', 'Forklifts'],
      ['truck', 'Trucks'],
    ];
    for (const [t, label] of names) {
      const b = el('button', 'ym-tab', tabs);
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.appendChild(icon(t, 15, 1.9));
      el('span', 'ym-tab-label', b, label);
      const count = el('span', 'ym-tab-count', b);
      b.addEventListener('click', () => this.setTab(t, true));
      this.tabs.set(t, { btn: b, count });
    }
    this.summary = el('div', 'ym-roster-summary', this.el);
    const scroller = el('div', 'ym-roster-scroll', this.el);
    this.list = el('div', 'ym-roster-list', scroller);
    this.list.setAttribute('role', 'listbox');
    this.rows = new KeyedList<Item, Row>(this.list, (i) => i.key, (i) => new Row(this, i));
    this.empty = el('div', 'ym-empty', scroller);
    this.emptyIcon = el('span', 'ym-empty-icon', this.empty);
    const et = el('div', 'ym-empty-text', this.empty);
    this.emptyTitle = el('strong', '', et);
    this.emptyText = el('span', '', et);
    this.el.addEventListener('mouseleave', () => this.ctx?.cmds.hover(null));
  }

  private setTab(t: Tab, user: boolean): void {
    // In compact mode the drawer collapses to its tabs; clicking the active tab toggles it.
    if (user && t === this.tab) this.open = !this.open;
    else if (user) this.open = true;
    this.tab = t;
    this.render();
  }

  update(ctx: Ctx): void {
    this.ctx = ctx;
    // Follow the selection: picking a unit in the world opens its tab.
    if (ctx.selKey !== this.lastSel) {
      this.lastSel = ctx.selKey;
      const k = ctx.selected?.kind;
      if (k === 'dock' || k === 'forklift' || k === 'truck') {
        this.tab = k;
        requestAnimationFrame(() => this.reveal());
      }
    }
    this.render();
  }

  private reveal(): void {
    const r = this.rows.rows.get(this.ctx.selKey);
    r?.el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  private render(): void {
    const ctx = this.ctx ?? this.ctxRef();
    const site = ctx.site?.id;
    const docks = ctx.snap.docks.filter((d) => !site || d.siteId === site);
    const lifts = ctx.snap.forklifts.filter((f) => !site || f.siteId === site);
    const trucks = ctx.snap.trucks.filter((t) => !site || t.siteId === site);
    const busyDocks = docks.filter((d) => d.state !== 'idle').length;
    const activeLifts = lifts.filter((f) => f.state === 'to-pick' || f.state === 'carrying').length;
    const counts: Record<Tab, string> = {
      dock: docks.length ? `${busyDocks}/${docks.length}` : '0',
      forklift: lifts.length ? `${activeLifts}/${lifts.length}` : '0',
      truck: String(trucks.length),
    };
    for (const [t, v] of this.tabs) {
      toggle(v.btn, 'is-on', t === this.tab);
      setAttr(v.btn, 'aria-selected', t === this.tab ? 'true' : 'false');
      setText(v.count, counts[t]);
    }
    toggle(this.el, 'is-open', this.open);

    let items: Item[];
    let summary: string;
    if (this.tab === 'dock') {
      items = docks.map((d) => ({ kind: 'dock', key: `dock:${d.id}`, ref: { kind: 'dock', id: d.id }, dock: d }));
      const working = docks.filter((d) => d.state === 'unloading' || d.state === 'loading').length;
      summary = docks.length ? `${working} working · ${busyDocks - working} turning · ${docks.length - busyDocks} free` : '';
    } else if (this.tab === 'forklift') {
      items = lifts.map((f) => ({ kind: 'forklift', key: `forklift:${f.id}`, ref: { kind: 'forklift', id: f.id }, lift: f }));
      const charging = lifts.filter((f) => f.state === 'charging' || f.state === 'to-charge').length;
      const moved = lifts.reduce((a, f) => a + f.movedToday, 0);
      summary = lifts.length ? `${activeLifts} working · ${charging} charging · ${moved.toLocaleString('en-US')} moved today` : '';
    } else {
      const order: Record<TruckState, number> = { 'at-dock': 0, docking: 1, departing: 2, queued: 3, 'en-route': 4, leaving: 5 };
      const sorted = [...trucks].sort((a, b) => order[a.state] - order[b.state] || (a.etaSec ?? 0) - (b.etaSec ?? 0) || a.label.localeCompare(b.label));
      items = sorted.map((t) => ({ kind: 'truck', key: `truck:${t.id}`, ref: { kind: 'truck', id: t.id }, truck: t }));
      const road = trucks.filter((t) => t.state === 'en-route').length;
      summary = trucks.length ? `${trucks.length - road} on site · ${road} on the road` : '';
    }
    // Rows of a different kind never share keys, so switching tabs simply swaps the set.
    this.rows.sync(items);
    setText(this.summary, summary);
    toggle(this.summary, 'is-empty', !summary);
    const isEmpty = items.length === 0;
    toggle(this.el, 'is-empty', isEmpty);
    if (isEmpty) {
      const [ic, title, text] = EMPTY[this.tab];
      setIcon(this.emptyIcon, ic, 20, 1.7);
      setText(this.emptyTitle, title);
      setText(this.emptyText, text);
    }
  }
}
