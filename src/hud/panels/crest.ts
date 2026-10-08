/** Site crest: banner with the active site's medallion and a tray of site tokens. */
import { SITE_DEFS } from '../../core/sites';
import type { Ctx } from '../ctx';
import { el, setAttr, setText, toggle } from '../dom';
import { icon, setIcon } from '../icons';

interface Token {
  btn: HTMLButtonElement;
  badge: HTMLElement;
  label: HTMLElement;
}


export class Crest {
  readonly el: HTMLElement;
  private medal: HTMLElement;
  private name: HTMLElement;
  private blurb: HTMLElement;
  private alerts: HTMLElement;
  private tray: HTMLElement;
  private tokens = new Map<string, Token>();

  constructor(private ctxRef: () => Ctx) {
    this.el = el('section', 'ym-panel ym-crest');
    this.el.setAttribute('aria-label', 'Site switcher');
    const head = el('div', 'ym-crest-head', this.el);
    this.medal = el('div', 'ym-medal ym-medal--lg', head);
    const titles = el('div', 'ym-crest-titles', head);
    this.name = el('h1', 'ym-crest-name', titles);
    const sub = el('div', 'ym-crest-sub', titles);
    this.blurb = el('span', 'ym-crest-blurb', sub);
    this.alerts = el('span', 'ym-crest-alerts', sub);
    this.tray = el('nav', 'ym-crest-tray', this.el);
    this.addToken('network', 'Network', 'network');
    for (const s of SITE_DEFS) this.addToken(s.id, s.short, s.kind);
  }

  private addToken(id: string, label: string, kind: string): void {
    const btn = el('button', 'ym-token', this.tray);
    btn.type = 'button';
    btn.dataset.kind = kind;
    const disc = el('span', 'ym-medal', btn);
    disc.dataset.kind = kind;
    disc.appendChild(icon(kind, 18, 1.8));
    const badge = el('span', 'ym-token-badge', disc);
    const lab = el('span', 'ym-token-label', btn, label);
    btn.addEventListener('click', () => this.ctxRef().cmds.selectSite(id));
    this.tokens.set(id, { btn, badge, label: lab });
  }

  update(ctx: Ctx): void {
    const s = ctx.site;
    const kind = s ? s.kind : 'network';
    setAttr(this.medal, 'data-kind', kind);
    setIcon(this.medal, kind, 26, 1.7);
    if (s) {
      setText(this.name, s.name);
      setText(this.blurb, s.blurb);
    } else {
      setText(this.name, 'Network overview');
      const n = ctx.snap.network;
      setText(this.blurb, `${ctx.snap.sites.length || 4} sites · ${n.trucksInTransit} trucks on the road`);
    }
    const alerts = s ? s.alerts : ctx.snap.sites.reduce((a, x) => a + x.alerts, 0);
    setText(this.alerts, alerts ? `${alerts} alert${alerts > 1 ? 's' : ''}` : '');
    toggle(this.alerts, 'is-on', alerts > 0);

    const active = ctx.snap.activeSiteId;
    for (const [id, t] of this.tokens) {
      const on = id === active;
      toggle(t.btn, 'is-active', on);
      setAttr(t.btn, 'aria-pressed', on ? 'true' : 'false');
      const sum = ctx.sites.get(id);
      const a = id === 'network' ? 0 : (sum?.alerts ?? 0);
      setText(t.badge, a ? String(a) : '');
      toggle(t.badge, 'is-on', a > 0);
      setAttr(t.btn, 'title', id === 'network' ? 'Network overview' : (sum?.name ?? id));
    }
  }
}
