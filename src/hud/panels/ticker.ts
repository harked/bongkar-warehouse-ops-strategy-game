/** Event ticker: the last few things that happened, newest on top. */
import type { FeedEvent } from '../../core/types';
import type { Ctx } from '../ctx';
import { el, KeyedList, setAttr, setText, toggle } from '../dom';
import { clockTime } from '../format';
import { icon } from '../icons';

class EventRow {
  el: HTMLElement;
  private time: HTMLElement;
  private text: HTMLElement;
  private site: HTMLElement;
  private ev!: FeedEvent;
  constructor(private ticker: Ticker) {
    this.el = el('div', 'ym-event is-new');
    el('i', 'ym-event-dot', this.el);
    this.time = el('span', 'ym-event-time', this.el);
    const body = el('span', 'ym-event-body', this.el);
    this.site = el('span', 'ym-event-site', body);
    this.text = el('span', 'ym-event-text', body);
    requestAnimationFrame(() => requestAnimationFrame(() => this.el.classList.remove('is-new')));
    this.el.addEventListener('click', () => {
      if (this.ev.ref) this.ticker.ctx.cmds.select(this.ev.ref);
    });
    this.el.addEventListener('dblclick', () => {
      if (this.ev.ref) this.ticker.ctx.cmds.focusSelection();
    });
    this.el.addEventListener('mouseenter', () => this.ev.ref && this.ticker.ctx.cmds.hover(this.ev.ref));
    this.el.addEventListener('mouseleave', () => this.ev.ref && this.ticker.ctx.cmds.hover(null));
  }
  update(e: FeedEvent): void {
    this.ev = e;
    const c = this.ticker.ctx;
    setAttr(this.el, 'data-tone', e.tone);
    toggle(this.el, 'is-link', !!e.ref);
    toggle(this.el, 'is-selected', !!e.ref && c.selKey === `${e.ref.kind}:${e.ref.id}`);
    setText(this.time, clockTime(e.t));
    const code = e.siteId ? (c.sites.get(e.siteId)?.code ?? '') : '';
    setText(this.site, c.network && code ? code : '');
    setText(this.text, e.text);
    setAttr(this.el, 'title', e.ref ? `${e.text} · click to select` : e.text);
  }
}

export class Ticker {
  readonly el: HTMLElement;
  ctx!: Ctx;
  private list: KeyedList<FeedEvent, EventRow>;
  private empty: HTMLElement;

  constructor() {
    this.el = el('section', 'ym-panel ym-ticker');
    this.el.setAttribute('aria-label', 'Recent events');
    const head = el('div', 'ym-ticker-head', this.el);
    el('i', 'ym-live', head);
    el('span', 'ym-ticker-title', head, 'Happening now');
    const body = el('div', 'ym-ticker-body', this.el);
    const list = el('div', 'ym-ticker-list', body);
    this.list = new KeyedList<FeedEvent, EventRow>(list, (e) => String(e.id), () => new EventRow(this));
    this.empty = el('div', 'ym-empty ym-empty--row', body);
    const ei = el('span', 'ym-empty-icon', this.empty);
    ei.appendChild(icon('calm', 18, 1.8));
    const et = el('div', 'ym-empty-text', this.empty);
    el('strong', '', et, 'All quiet');
    el('span', '', et, 'Events appear here as the shift unfolds.');
  }

  update(ctx: Ctx): void {
    this.ctx = ctx;
    const site = ctx.site?.id;
    const evs = ctx.snap.events.filter((e) => !site || !e.siteId || e.siteId === site).slice(0, 5);
    this.list.sync(evs);
    toggle(this.el, 'is-empty', evs.length === 0);
  }
}
