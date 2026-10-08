/** Pulse strip: one segmented bar of live KPIs for the active site or the whole network. */
import type { Tone } from '../../core/types';
import type { Ctx } from '../ctx';
import { el, KeyedList, setAttr, setStyle, setText, svgNode, toggle } from '../dom';
import { int, pct } from '../format';
import { icon } from '../icons';

type Viz = { type: 'bar'; v: number } | { type: 'pips'; n: number; of: number } | { type: 'spark'; key: string; v: number } | { type: 'temp'; c: number };

interface Seg {
  key: string;
  icon: string;
  value: string;
  unit?: string;
  label: string;
  tone: Tone | 'primary';
  viz: Viz;
  title: string;
}

const SPARK_N = 28;
const SPARK_W = 72;
const SPARK_H = 16;

class SegRow {
  el: HTMLElement;
  private value: HTMLElement;
  private unit: HTMLElement;
  private label: HTMLElement;
  private viz: HTMLElement;
  private vizType = '';
  private bar?: HTMLElement;
  private pips?: HTMLElement;
  private line?: SVGPolylineElement;
  private area?: SVGPathElement;

  constructor(
    s: Seg,
    private history: Map<string, number[]>,
  ) {
    this.el = el('div', 'ym-seg');
    const top = el('div', 'ym-seg-top', this.el);
    const ic = el('span', 'ym-seg-icon', top);
    ic.appendChild(icon(s.icon, 15, 1.9));
    const val = el('div', 'ym-seg-val', top);
    this.value = el('span', 'ym-seg-num', val);
    this.unit = el('span', 'ym-seg-unit', val);
    this.label = el('div', 'ym-seg-label', this.el);
    this.viz = el('div', 'ym-seg-viz', this.el);
  }

  update(s: Seg): void {
    setAttr(this.el, 'data-tone', s.tone);
    setAttr(this.el, 'title', s.title);
    setText(this.value, s.value);
    setText(this.unit, s.unit ?? '');
    setText(this.label, s.label);
    if (this.vizType !== s.viz.type) {
      this.vizType = s.viz.type;
      this.viz.replaceChildren();
      this.bar = this.pips = undefined;
      this.line = this.area = undefined;
      if (s.viz.type === 'bar' || s.viz.type === 'temp') {
        const track = el('div', 'ym-seg-track', this.viz);
        this.bar = el('div', 'ym-seg-fill', track);
      } else if (s.viz.type === 'pips') {
        this.pips = el('div', 'ym-pips', this.viz);
      } else {
        const sv = svgNode('svg', { class: 'ym-spark', viewBox: `0 0 ${SPARK_W} ${SPARK_H}`, preserveAspectRatio: 'none' }, this.viz);
        this.area = svgNode('path', { class: 'ym-spark-area' }, sv);
        this.line = svgNode('polyline', { class: 'ym-spark-line' }, sv);
      }
    }
    const v = s.viz;
    if ((v.type === 'bar' || v.type === 'temp') && this.bar) {
      const f = v.type === 'bar' ? v.v : Math.min(1, Math.max(0, (v.c + 30) / 30));
      setStyle(this.bar, 'transform', `scaleX(${Math.max(0, Math.min(1, f)).toFixed(3)})`);
    } else if (v.type === 'pips' && this.pips) {
      const of = Math.min(v.of, 24);
      while (this.pips.childElementCount < of) el('i', '', this.pips);
      while (this.pips.childElementCount > of) this.pips.lastElementChild!.remove();
      const n = Math.round((v.n / Math.max(1, v.of)) * of);
      for (let i = 0; i < of; i++) toggle(this.pips.children[i], 'on', i < n);
    } else if (v.type === 'spark' && this.line && this.area) {
      const h = this.history.get(v.key) ?? [];
      if (h.length < 2) {
        setAttr(this.line, 'points', '');
        setAttr(this.area, 'd', '');
        return;
      }
      let lo = Infinity;
      let hi = -Infinity;
      for (const x of h) {
        lo = Math.min(lo, x);
        hi = Math.max(hi, x);
      }
      const span = Math.max(hi - lo, Math.max(1, hi * 0.08));
      const mid = (hi + lo) / 2;
      const pts: string[] = [];
      const step = SPARK_W / (h.length - 1);
      const x0 = 0;
      h.forEach((val, i) => {
        const y = SPARK_H / 2 - ((val - mid) / span) * (SPARK_H - 4);
        pts.push(`${(x0 + i * step).toFixed(1)},${y.toFixed(1)}`);
      });
      const p = pts.join(' ');
      setAttr(this.line, 'points', p);
      setAttr(this.area, 'd', `M${x0.toFixed(1)},${SPARK_H} L${p.replace(/ /g, ' L')} L${SPARK_W},${SPARK_H} Z`);
    }
  }
}

export class Pulse {
  readonly el: HTMLElement;
  private list: KeyedList<Seg, SegRow>;
  private history = new Map<string, number[]>();
  private lastSample = 0;

  constructor() {
    this.el = el('section', 'ym-panel ym-pulse');
    this.el.setAttribute('aria-label', 'Key figures');
    const inner = el('div', 'ym-pulse-inner', this.el);
    this.list = new KeyedList<Seg, SegRow>(inner, (s) => s.key, (s) => new SegRow(s, this.history));
  }

  private sample(ctx: Ctx): void {
    const now = performance.now();
    if (now - this.lastSample < 900) return;
    this.lastSample = now;
    const add = (k: string, v: number) => {
      let h = this.history.get(k);
      if (!h) this.history.set(k, (h = []));
      h.push(v);
      if (h.length > SPARK_N) h.shift();
    };
    for (const s of ctx.snap.sites) add(`tp:${s.id}`, s.kpis.throughputPerHour);
    add('tp:network', ctx.snap.sites.reduce((a, s) => a + s.kpis.throughputPerHour, 0));
  }

  update(ctx: Ctx): void {
    this.sample(ctx);
    const segs: Seg[] = [];
    const s = ctx.site;
    const onTone = (v: number): Tone => (v >= 0.92 ? 'good' : v >= 0.8 ? 'warn' : 'alert');
    if (s) {
      const k = s.kpis;
      segs.push({
        key: 'tp',
        icon: 'throughput',
        value: int(k.throughputPerHour),
        unit: '/h',
        label: 'Pallets moved',
        tone: 'neutral',
        viz: { type: 'spark', key: `tp:${s.id}`, v: k.throughputPerHour },
        title: 'Pallets moved per hour, rolling',
      });
      segs.push({
        key: 'docks',
        icon: 'dock',
        value: `${k.docksBusy}`,
        unit: `/${k.docksTotal}`,
        label: 'Docks busy',
        tone: 'active',
        viz: { type: 'pips', n: k.docksBusy, of: k.docksTotal },
        title: `${k.docksBusy} of ${k.docksTotal} dock doors occupied`,
      });
      segs.push({
        key: 'ontime',
        icon: 'ontime',
        value: pct(k.onTime).replace('%', ''),
        unit: '%',
        label: 'On time',
        tone: onTone(k.onTime),
        viz: { type: 'bar', v: k.onTime },
        title: 'Shipments completed or tracking on time',
      });
      if (k.capacity > 0) {
        const fill = k.palletsStored / k.capacity;
        segs.push({
          key: 'fill',
          icon: 'storage',
          value: pct(fill).replace('%', ''),
          unit: '%',
          label: 'Storage fill',
          tone: fill > 0.92 ? 'alert' : fill > 0.82 ? 'warn' : 'primary',
          viz: { type: 'bar', v: fill },
          title: `${int(k.palletsStored)} of ${int(k.capacity)} pallet positions used`,
        });
      } else {
        segs.push({
          key: 'yard',
          icon: 'truck',
          value: String(k.trucksOnSite),
          label: 'Trucks on site',
          tone: 'primary',
          viz: { type: 'pips', n: k.trucksOnSite, of: Math.max(k.trucksOnSite, k.docksTotal) },
          title: 'Flow-through site: no storage, trucks in the yard and at doors',
        });
      }
      if (k.tempC !== undefined) {
        segs.push({
          key: 'temp',
          icon: 'temp',
          value: k.tempC.toFixed(1),
          unit: '°C',
          label: 'Freezer',
          tone: k.tempC > -15 ? 'alert' : 'cold',
          viz: { type: 'temp', c: k.tempC },
          title: 'Freezer zone air temperature',
        });
      }
      segs.push({
        key: 'lifts',
        icon: 'forklift',
        value: `${k.forkliftsActive}`,
        unit: `/${k.forkliftsTotal}`,
        label: 'Forklifts working',
        tone: 'active',
        viz: { type: 'pips', n: k.forkliftsActive, of: k.forkliftsTotal },
        title: `${k.forkliftsActive} of ${k.forkliftsTotal} forklifts on a task`,
      });
    } else {
      const n = ctx.snap.network;
      const tp = ctx.snap.sites.reduce((a, x) => a + x.kpis.throughputPerHour, 0);
      segs.push({
        key: 'tp',
        icon: 'throughput',
        value: int(tp),
        unit: '/h',
        label: 'Pallets moved',
        tone: 'neutral',
        viz: { type: 'spark', key: 'tp:network', v: tp },
        title: 'Pallets moved per hour across all sites',
      });
      segs.push({
        key: 'transit',
        icon: 'truck',
        value: String(n.trucksInTransit),
        label: 'Trucks on the road',
        tone: 'cold',
        viz: { type: 'pips', n: n.trucksInTransit, of: Math.max(8, n.trucksInTransit) },
        title: 'Trucks currently driving between sites',
      });
      segs.push({
        key: 'open',
        icon: 'route',
        value: String(n.shipmentsOpen),
        label: 'Open shipments',
        tone: 'primary',
        viz: { type: 'bar', v: n.shipmentsOpen / Math.max(1, n.shipmentsOpen + n.shipmentsDoneToday) },
        title: 'Shipments in progress',
      });
      segs.push({
        key: 'ontime',
        icon: 'ontime',
        value: pct(n.onTime).replace('%', ''),
        unit: '%',
        label: 'On time',
        tone: onTone(n.onTime),
        viz: { type: 'bar', v: n.onTime },
        title: 'Open shipments tracking on time',
      });
      segs.push({
        key: 'done',
        icon: 'check',
        value: int(n.shipmentsDoneToday),
        label: 'Delivered today',
        tone: 'good',
        viz: { type: 'bar', v: n.shipmentsDoneToday / Math.max(1, n.shipmentsOpen + n.shipmentsDoneToday) },
        title: `${int(n.palletsMovedToday)} pallets moved today`,
      });
    }
    this.list.sync(segs);
  }
}
