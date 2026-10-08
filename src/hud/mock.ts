/**
 * Mock snapshot generator for HUD design work. Only used when the URL contains `?hudmock`.
 *
 * Everything is a deterministic function of sim time (taken from the real snapshot's clock, so
 * pause and 1x/4x/12x keep working), except the event feed, which is produced by diffing states
 * between calls. Cycles are deliberately short so the HUD visibly lives at 1x.
 */
import { SITE_DEFS, type SiteDef } from '../core/sites';
import type {
  CargoKind,
  DetailField,
  DockRow,
  DockState,
  EntityRef,
  FeedEvent,
  ForkliftRow,
  ForkliftState,
  HudSnapshot,
  SelectionDetail,
  ShipmentRow,
  ShipmentStage,
  SiteSummary,
  Tone,
  TruckRow,
  TruckState,
  TruckVariant,
} from '../core/types';
import { clockTime, duration, pct } from './format';

const hash = (s: string): number => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
};
const frac = (x: number): number => x - Math.floor(x);

const CARRIERS = ['Bluebird Freight', 'Harbor Line', 'Polar Express Co', 'Swift Meadow', 'Cobalt Haulage', 'Northwind Logistics'];
const CARGO: { kind: CargoKind; label: string }[] = [
  { kind: 'cartons', label: 'Mixed cartons' },
  { kind: 'wrapped', label: 'Wrapped goods' },
  { kind: 'produce', label: 'Fresh produce' },
  { kind: 'frozen', label: 'Frozen foods' },
  { kind: 'parcels', label: 'Parcels' },
  { kind: 'drums', label: 'Drums' },
];
const STAGES: ShipmentStage['key'][] = ['picking', 'loading', 'transit', 'arrived', 'unloading', 'putaway'];
const STAGE_LABEL: Record<ShipmentStage['key'], string> = {
  picking: 'Picking',
  loading: 'Loading',
  transit: 'Transit',
  arrived: 'Arrived',
  unloading: 'Unloading',
  putaway: 'Putaway',
};
const CAPACITY: Record<string, number> = { 'pasa-ateh': 1840, ambacang: 960, 'teluk-bayur': 0, 'stasiun-tabing': 640 };
const ROUTES: [string, string][] = [
  ['pasa-ateh', 'ambacang'],
  ['ambacang', 'stasiun-tabing'],
  ['teluk-bayur', 'pasa-ateh'],
  ['pasa-ateh', 'stasiun-tabing'],
  ['stasiun-tabing', 'teluk-bayur'],
  ['ambacang', 'teluk-bayur'],
  ['teluk-bayur', 'stasiun-tabing'],
  ['pasa-ateh', 'teluk-bayur'],
];

interface DockDef {
  id: string;
  site: SiteDef;
  label: string;
  role: 'inbound' | 'outbound';
  period: number;
  phase: number;
}
interface LiftDef {
  id: string;
  site: SiteDef;
  label: string;
  period: number;
  phase: number;
  battPeriod: number;
  battPhase: number;
}
interface HaulDef {
  idx: number;
  from: SiteDef;
  to: SiteDef;
  period: number;
  phase: number;
  variant: TruckVariant;
  carrier: string;
}

const siteById: Record<string, SiteDef> = Object.fromEntries(SITE_DEFS.map((s) => [s.id, s]));

export interface MockSource {
  snapshot(real: HudSnapshot, selection: EntityRef | null): HudSnapshot;
}

export function createMock(): MockSource {
  const docks: DockDef[] = [];
  const lifts: LiftDef[] = [];
  for (const s of SITE_DEFS) {
    const n = s.doorsS + s.doorsN;
    for (let i = 0; i < n; i++) {
      const label = `D${String(i + 1).padStart(2, '0')}`;
      const id = `${s.id}:${label}`;
      docks.push({
        id,
        site: s,
        label,
        role: i < s.inboundS ? 'inbound' : 'outbound',
        period: 150 + hash(id) * 140,
        phase: hash(id + 'p'),
      });
    }
    for (let i = 0; i < s.forklifts; i++) {
      const label = `FL-${String(i + 1).padStart(2, '0')}`;
      const id = `${s.id}:${label}`;
      lifts.push({
        id,
        site: s,
        label,
        period: 70 + hash(id) * 60,
        phase: hash(id + 'p'),
        battPeriod: 900 + hash(id + 'b') * 700,
        battPhase: hash(id + 'bp'),
      });
    }
  }
  const hauls: HaulDef[] = ROUTES.map(([a, b], i) => {
    const id = `haul${i}`;
    const to = siteById[b];
    return {
      idx: i,
      from: siteById[a],
      to,
      period: 520 + hash(id) * 420,
      phase: hash(id + 'p'),
      variant: to.kind === 'cold' || siteById[a].kind === 'cold' ? 'reefer' : i % 3 === 0 ? 'box' : 'dry',
      carrier: CARRIERS[i % CARRIERS.length],
    };
  });

  const events: FeedEvent[] = [];
  let eventId = 1;
  const prev = new Map<string, string>();
  let seeded = false;
  const throughputBase: Record<string, number> = { 'pasa-ateh': 412, ambacang: 186, 'teluk-bayur': 538, 'stasiun-tabing': 244 };

  function push(t: number, text: string, tone: Tone, siteId?: string, ref?: EntityRef): void {
    events.unshift({ id: eventId++, t, text, tone, siteId, ref });
    if (events.length > 40) events.length = 40;
  }

  function dockState(d: DockDef, t: number): { state: DockState; progress: number; cycle: number } {
    const x = t / d.period + d.phase;
    const u = frac(x);
    const cycle = Math.floor(x);
    if (u < 0.16) return { state: 'idle', progress: 0, cycle };
    if (u < 0.24) return { state: 'reserved', progress: 0, cycle };
    if (u < 0.32) return { state: 'docking', progress: 0, cycle };
    if (u < 0.88) return { state: d.role === 'inbound' ? 'unloading' : 'loading', progress: (u - 0.32) / 0.56, cycle };
    if (u < 0.95) return { state: 'departing', progress: 1, cycle };
    return { state: 'idle', progress: 0, cycle };
  }
  const dockTruckLabel = (d: DockDef, cycle: number): string =>
    `${d.site.code}-${100 + Math.floor(frac(hash(d.id) + cycle * 0.371) * 880)}`;

  function haulState(h: HaulDef, t: number) {
    const x = t / h.period + h.phase;
    const cycle = Math.floor(x);
    const u = frac(x);
    // Stage weights: transit takes the longest.
    const w = [0.12, 0.12, 0.42, 0.06, 0.16, 0.12];
    let acc = 0;
    let stage = 0;
    let within = 0;
    for (let i = 0; i < w.length; i++) {
      if (u < acc + w[i] || i === w.length - 1) {
        stage = i;
        within = Math.min(1, (u - acc) / w[i]);
        break;
      }
      acc += w[i];
    }
    const roll = hash(`${h.idx}:${cycle}`);
    const status: ShipmentRow['status'] = roll < 0.62 ? 'on-time' : roll < 0.86 ? 'at-risk' : 'late';
    const start = (cycle - h.phase) * h.period;
    const slack = status === 'on-time' ? 0.12 : status === 'at-risk' ? 0.01 : -0.09;
    const dueAt = start + h.period * (1 + slack);
    const etaAt = start + h.period + (status === 'late' ? h.period * 0.04 : 0);
    const pallets = 12 + Math.floor(hash(`${h.idx}:${cycle}:n`) * 14);
    const cargo = h.variant === 'reefer' ? CARGO[hash(`${h.idx}:${cycle}:c`) < 0.5 ? 3 : 2] : CARGO[Math.floor(hash(`${h.idx}:${cycle}:c`) * 6) % 6];
    const progress = (stage + within) / 6;
    const stagesDone = stage;
    let palletsDone = 0;
    if (stage === 0 || stage === 1) palletsDone = Math.floor(pallets * (stage === 0 ? within * 0.5 : 0.5 + within * 0.5));
    else if (stage === 4) palletsDone = Math.floor(pallets * within);
    else palletsDone = pallets;
    return {
      cycle,
      stage,
      within,
      status,
      dueAt,
      etaAt,
      pallets,
      palletsDone,
      cargo,
      progress,
      stagesDone,
      start,
      id: `SH-${4800 + h.idx * 37 + cycle}`,
      truckId: `haul-${h.idx}`,
      label: `${h.from.code}-${700 + h.idx * 11}`,
      transitLeft: stage === 2 ? (1 - within) * h.period * 0.42 : stage < 2 ? h.period * 0.42 : 0,
    };
  }

  function liftState(l: LiftDef, t: number): { state: ForkliftState; battery: number; task: string; moved: number } {
    const bu = frac(t / l.battPeriod + l.battPhase);
    let battery: number;
    let state: ForkliftState;
    let task: string;
    const docksHere = l.site.doorsS + l.site.doorsN;
    const door = `D${String(1 + Math.floor(frac(t / l.period + l.phase * 7) * docksHere)).padStart(2, '0')}`;
    const aisle = `A${String(1 + Math.floor(hash(l.id + Math.floor(t / l.period)) * 14)).padStart(2, '0')}`;
    if (bu < 0.84) {
      battery = 1 - (bu / 0.84) * 0.86;
      const u = frac(t / l.period + l.phase);
      if (u < 0.14) {
        state = 'idle';
        task = 'Waiting for a task';
      } else if (u < 0.42) {
        state = 'to-pick';
        task = l.site.kind === 'crossdock' ? `To ${door} for pickup` : `To ${aisle} pick face`;
      } else if (u < 0.92) {
        state = 'carrying';
        task = l.site.kind === 'crossdock' ? `${door} to outbound stage` : u < 0.67 ? `${door} to ${aisle}-L${1 + (Math.floor(u * 40) % 4)}` : `${aisle} to ${door}`;
      } else {
        state = 'idle';
        task = 'Waiting for a task';
      }
    } else if (bu < 0.87) {
      battery = 0.14;
      state = 'to-charge';
      task = 'Low battery, heading to charger';
    } else {
      battery = 0.14 + ((bu - 0.87) / 0.13) * 0.86;
      state = 'charging';
      task = `Charging, full in ${duration(((1 - bu) / 0.13) * l.battPeriod * 0.13)}`;
    }
    const moved = Math.max(0, Math.floor((t - 6 * 3600) / (l.period * 0.9) + hash(l.id) * 20));
    return { state, battery, task, moved };
  }

  function snapshot(real: HudSnapshot, selection: EntityRef | null): HudSnapshot {
    const t = real.clock.seconds;

    // ---- docks + trucks at docks ----------------------------------------------------------------
    const dockRows: DockRow[] = [];
    const truckRows: TruckRow[] = [];
    for (const d of docks) {
      const ds = dockState(d, t);
      const occupied = ds.state !== 'idle';
      const tl = occupied ? dockTruckLabel(d, ds.cycle) : undefined;
      const truckId = tl ? `dock-${d.id}-${ds.cycle}` : undefined;
      dockRows.push({
        id: d.id,
        siteId: d.site.id,
        label: d.label,
        role: d.role,
        state: ds.state,
        truckId,
        truckLabel: tl,
        progress: ds.progress,
      });
      if (tl && truckId) {
        const ts: TruckState =
          ds.state === 'reserved' ? 'queued' : ds.state === 'docking' ? 'docking' : ds.state === 'departing' ? 'departing' : 'at-dock';
        const variant: TruckVariant = d.site.kind === 'cold' ? 'reefer' : d.site.kind === 'hub' ? 'box' : 'dry';
        const load = d.role === 'inbound' ? 1 - ds.progress : ds.progress;
        truckRows.push({
          id: truckId,
          label: tl,
          carrier: CARRIERS[Math.floor(hash(truckId) * CARRIERS.length)],
          variant,
          state: ts,
          siteId: d.site.id,
          doorLabel: d.label,
          where:
            ts === 'queued'
              ? `Queued for ${d.label}`
              : ts === 'docking'
                ? `Backing into ${d.label}`
                : ts === 'departing'
                  ? `Pulling out of ${d.label}`
                  : `Docked at ${d.label}`,
          load: ts === 'queued' || ts === 'docking' ? (d.role === 'inbound' ? 1 : 0) : load,
        });
      }
      // events
      const key = `dock:${d.id}`;
      const before = prev.get(key);
      if (seeded && before !== ds.state) {
        const ref: EntityRef = { kind: 'dock', id: d.id };
        if (ds.state === 'docking') push(t, `${tl} backing into ${d.site.code} ${d.label}`, 'active', d.site.id, truckId ? { kind: 'truck', id: truckId } : ref);
        else if (ds.state === 'departing')
          push(t, `${d.site.code} ${d.label} ${d.role === 'inbound' ? 'unloaded' : 'loaded'} · ${14 + Math.floor(hash(d.id + ds.cycle) * 12)} pallets`, 'good', d.site.id, ref);
      }
      prev.set(key, ds.state);
    }

    // ---- network hauls (shipments) ---------------------------------------------------------------
    const shipments: ShipmentRow[] = [];
    for (const h of hauls) {
      const hs = haulState(h, t);
      const stages: ShipmentStage[] = STAGES.map((k, i) => ({
        key: k,
        label: STAGE_LABEL[k],
        doneAt: i < hs.stage ? hs.start + (i + 1) * h.period * 0.14 : undefined,
      }));
      shipments.push({
        id: hs.id,
        fromSiteId: h.from.id,
        toSiteId: h.to.id,
        cargo: hs.cargo.kind,
        cargoLabel: hs.cargo.label,
        pallets: hs.pallets,
        palletsDone: hs.palletsDone,
        stage: hs.stage,
        stages,
        dueAt: hs.dueAt,
        etaAt: hs.etaAt,
        status: hs.status,
        truckId: hs.stage >= 1 ? hs.truckId : undefined,
        progress: hs.progress,
      });
      if (hs.stage >= 1) {
        const ts: TruckState = hs.stage === 1 ? 'at-dock' : hs.stage === 2 ? 'en-route' : hs.stage === 3 ? 'queued' : hs.stage === 4 ? 'at-dock' : 'leaving';
        const site = hs.stage === 1 ? h.from : h.to;
        truckRows.push({
          id: hs.truckId,
          label: hs.label,
          carrier: h.carrier,
          variant: h.variant,
          state: ts,
          siteId: ts === 'leaving' ? undefined : site.id,
          doorLabel: ts === 'at-dock' ? `D0${1 + (h.idx % 4)}` : undefined,
          where:
            ts === 'en-route'
              ? `${duration(hs.transitLeft)} to ${h.to.short}`
              : ts === 'queued'
                ? `In the yard at ${h.to.short}`
                : ts === 'leaving'
                  ? 'Heading off the map'
                  : `Docked at D0${1 + (h.idx % 4)}`,
          etaSec: ts === 'en-route' ? hs.transitLeft : undefined,
          load: hs.stage === 1 ? hs.within : hs.stage <= 3 ? 1 : hs.stage === 4 ? 1 - hs.within : 0,
          shipmentId: hs.id,
        });
      }
      const key = `haul:${h.idx}`;
      const sig = `${hs.cycle}:${hs.stage}`;
      if (seeded && prev.get(key) !== sig) {
        const ref: EntityRef = { kind: 'truck', id: hs.truckId };
        if (hs.stage === 2) push(t, `${hs.id} left ${h.from.name} for ${h.to.short}`, 'active', h.from.id, ref);
        else if (hs.stage === 3)
          push(t, `${hs.id} arrived at ${h.to.name}${hs.status === 'late' ? ', late' : ''}`, hs.status === 'late' ? 'alert' : 'good', h.to.id, ref);
        else if (hs.stage === 0) push(t, `${hs.id} picking started at ${h.from.name}`, 'neutral', h.from.id);
        if (hs.stage === 2 && hs.status === 'late') push(t, `${hs.id} running late, ETA ${clockTime(hs.etaAt)}`, 'alert', h.to.id, ref);
      }
      prev.set(key, sig);
    }

    // ---- forklifts -------------------------------------------------------------------------------
    const forklifts: ForkliftRow[] = lifts.map((l) => {
      const ls = liftState(l, t);
      const key = `lift:${l.id}`;
      if (seeded && prev.get(key) !== ls.state) {
        const ref: EntityRef = { kind: 'forklift', id: l.id };
        if (ls.state === 'to-charge') push(t, `${l.site.code} ${l.label} low battery, heading to charger`, 'warn', l.site.id, ref);
        else if (ls.state === 'charging' && prev.get(key) === 'to-charge') push(t, `${l.site.code} ${l.label} plugged in`, 'cold', l.site.id, ref);
      }
      prev.set(key, ls.state);
      return { id: l.id, siteId: l.site.id, label: l.label, state: ls.state, battery: ls.battery, task: ls.task, movedToday: ls.moved };
    });

    if (!seeded) {
      seeded = true;
      const s = t - 600;
      push(s, 'Early shift started at all four sites', 'neutral');
      push(s + 80, 'Ambacang freezer holding at -18.6 °C', 'cold', 'ambacang', { kind: 'site', id: 'ambacang' });
      push(s + 180, 'Teluk Bayur D04 cleared 22 pallets in 9 min', 'good', 'teluk-bayur', { kind: 'dock', id: 'teluk-bayur:D04' });
      push(s + 320, `${shipments[1].id} at risk, picking behind plan`, 'warn', 'ambacang');
      push(s + 470, 'Pasa Ateh FL-03 finished charging', 'good', 'pasa-ateh', { kind: 'forklift', id: 'pasa-ateh:FL-03' });
    }

    // ---- KPIs -------------------------------------------------------------------------------------
    const sites: SiteSummary[] = SITE_DEFS.map((s) => {
      const ds = dockRows.filter((d) => d.siteId === s.id);
      const fs = forklifts.filter((f) => f.siteId === s.id);
      const ships = shipments.filter((x) => x.toSiteId === s.id || x.fromSiteId === s.id);
      const late = ships.filter((x) => x.status === 'late').length;
      const risk = ships.filter((x) => x.status === 'at-risk').length;
      const lowBatt = fs.filter((f) => f.battery < 0.2).length;
      const cap = CAPACITY[s.id];
      const base = throughputBase[s.id];
      return {
        id: s.id,
        name: s.name,
        short: s.short,
        code: s.code,
        kind: s.kind,
        blurb: s.blurb,
        alerts: late + lowBatt,
        kpis: {
          throughputPerHour: Math.round(base * (1 + 0.12 * Math.sin(t / 400 + hash(s.id) * 6) + 0.05 * Math.sin(t / 61))),
          docksBusy: ds.filter((d) => d.state !== 'idle').length,
          docksTotal: ds.length,
          onTime: ships.length ? Math.max(0, 1 - (late * 1 + risk * 0.35) / (ships.length * 2.2)) : 1,
          palletsStored: Math.round(cap * (0.64 + 0.12 * Math.sin(t / 900 + hash(s.id) * 4))),
          capacity: cap,
          tempC: s.kind === 'cold' ? -18.4 + 0.7 * Math.sin(t / 160) : undefined,
          forkliftsActive: fs.filter((f) => f.state === 'to-pick' || f.state === 'carrying').length,
          forkliftsTotal: fs.length,
          trucksOnSite: truckRows.filter((x) => x.siteId === s.id && x.state !== 'en-route').length,
        },
      };
    });
    const open = shipments.filter((x) => x.status !== 'done');
    const network = {
      trucksInTransit: truckRows.filter((x) => x.state === 'en-route').length,
      shipmentsOpen: open.length,
      shipmentsDoneToday: Math.floor((t - 6 * 3600) / 300) + 14,
      onTime: open.length ? open.filter((x) => x.status === 'on-time').length / open.length : 1,
      palletsMovedToday: Math.floor((t - 6 * 3600) * 0.42) + 1260,
    };

    // ---- selection --------------------------------------------------------------------------------
    let detail: SelectionDetail | null = null;
    if (selection) detail = describe(selection, { dockRows, truckRows, forklifts, shipments, sites, t });

    return {
      clock: real.clock,
      activeSiteId: real.activeSiteId,
      network,
      sites,
      docks: dockRows,
      forklifts,
      trucks: truckRows,
      shipments,
      events: events.slice(0, 30),
      selection: detail,
    };
  }

  return { snapshot };
}

interface World {
  dockRows: DockRow[];
  truckRows: TruckRow[];
  forklifts: ForkliftRow[];
  shipments: ShipmentRow[];
  sites: SiteSummary[];
  t: number;
}

const DOCK_TONE: Record<DockState, Tone> = {
  idle: 'neutral',
  reserved: 'cold',
  docking: 'active',
  unloading: 'active',
  loading: 'active',
  departing: 'good',
};
const LIFT_TONE: Record<ForkliftState, Tone> = { idle: 'neutral', 'to-pick': 'active', carrying: 'active', 'to-charge': 'warn', charging: 'cold' };
const TRUCK_TONE: Record<TruckState, Tone> = {
  'en-route': 'cold',
  queued: 'neutral',
  docking: 'active',
  'at-dock': 'active',
  departing: 'good',
  leaving: 'neutral',
};
const LIFT_STATUS: Record<ForkliftState, string> = {
  idle: 'Idle',
  'to-pick': 'Driving to pick',
  carrying: 'Carrying',
  'to-charge': 'To charger',
  charging: 'Charging',
};
const TRUCK_STATUS: Record<TruckState, string> = {
  'en-route': 'En route',
  queued: 'Queued',
  docking: 'Docking',
  'at-dock': 'At dock',
  departing: 'Departing',
  leaving: 'Leaving',
};

function describe(ref: EntityRef, w: World): SelectionDetail | null {
  const siteName = (id?: string) => w.sites.find((s) => s.id === id)?.name ?? 'Off map';
  if (ref.kind === 'dock') {
    const d = w.dockRows.find((x) => x.id === ref.id);
    if (!d) return null;
    const fields: DetailField[] = [
      { label: 'Role', value: d.role === 'inbound' ? 'Inbound' : 'Outbound' },
      { label: 'Truck', value: d.truckLabel ?? 'None' },
      { label: 'Site', value: siteName(d.siteId) },
      { label: 'Turns today', value: String(6 + Math.floor(hash(d.id) * 9)) },
    ];
    return {
      ref,
      title: `Dock ${d.label}`,
      subtitle: `${siteName(d.siteId)} · ${d.role} door`,
      status: d.state[0].toUpperCase() + d.state.slice(1),
      statusTone: DOCK_TONE[d.state],
      fields,
      progress: d.state === 'unloading' || d.state === 'loading' ? { label: d.state === 'unloading' ? 'Unloaded' : 'Loaded', value: d.progress } : undefined,
      siteId: d.siteId,
    };
  }
  if (ref.kind === 'forklift') {
    const f = w.forklifts.find((x) => x.id === ref.id);
    if (!f) return null;
    return {
      ref,
      title: f.label,
      subtitle: `Reach truck · ${siteName(f.siteId)}`,
      status: LIFT_STATUS[f.state],
      statusTone: LIFT_TONE[f.state],
      fields: [
        { label: 'Task', value: f.task },
        { label: 'Moved today', value: `${f.movedToday} pallets` },
        { label: 'Fork height', value: f.state === 'carrying' ? '2.4 m' : '0.1 m' },
        { label: 'Operator', value: ['Ana R.', 'Theo K.', 'Mina S.', 'Jonas P.'][Math.floor(hash(f.id) * 4)] },
      ],
      meter: { label: 'Battery', value: f.battery, tone: f.battery < 0.2 ? 'alert' : f.battery < 0.45 ? 'warn' : 'good' },
      siteId: f.siteId,
    };
  }
  if (ref.kind === 'truck') {
    const tr = w.truckRows.find((x) => x.id === ref.id);
    if (!tr) return null;
    const sh = tr.shipmentId ? w.shipments.find((s) => s.id === tr.shipmentId) : undefined;
    const fields: DetailField[] = [
      { label: 'Where', value: tr.where },
      { label: 'Carrier', value: tr.carrier },
    ];
    if (sh) {
      fields.push({ label: 'Cargo', value: `${sh.cargoLabel} · ${sh.pallets} pal` });
      fields.push({
        label: 'ETA vs due',
        value: `${clockTime(sh.etaAt)} / ${clockTime(sh.dueAt)}`,
        tone: sh.status === 'late' ? 'alert' : sh.status === 'at-risk' ? 'warn' : 'good',
      });
    } else {
      fields.push({ label: 'Door', value: tr.doorLabel ?? '-' });
      fields.push({ label: 'Trailer', value: tr.variant === 'reefer' ? 'Reefer, -20 °C' : tr.variant === 'box' ? 'Box truck' : 'Dry van' });
    }
    return {
      ref,
      title: tr.label,
      subtitle: `${tr.variant === 'reefer' ? 'Reefer' : tr.variant === 'box' ? 'Box truck' : 'Dry van'} · ${tr.carrier}`,
      status: TRUCK_STATUS[tr.state],
      statusTone: TRUCK_TONE[tr.state],
      fields,
      meter: { label: 'Trailer load', value: tr.load, tone: 'active' },
      progress: sh ? { label: `Journey · ${sh.stages[Math.min(sh.stage, 5)].label.toLowerCase()}`, value: sh.progress } : undefined,
      shipmentId: tr.shipmentId,
      siteId: tr.siteId,
    };
  }
  if (ref.kind === 'site') {
    const s = w.sites.find((x) => x.id === ref.id);
    if (!s) return null;
    const k = s.kpis;
    return {
      ref,
      title: s.name,
      subtitle: s.blurb,
      status: s.alerts ? `${s.alerts} alert${s.alerts > 1 ? 's' : ''}` : 'Running smoothly',
      statusTone: s.alerts ? 'warn' : 'good',
      fields: [
        { label: 'Throughput', value: `${k.throughputPerHour} pal/h` },
        { label: 'Docks busy', value: `${k.docksBusy} of ${k.docksTotal}` },
        { label: 'On time', value: pct(k.onTime), tone: k.onTime > 0.9 ? 'good' : 'warn' },
        { label: 'Trucks on site', value: String(k.trucksOnSite) },
      ],
      meter: k.capacity ? { label: 'Storage fill', value: k.palletsStored / k.capacity, tone: 'active' } : undefined,
      siteId: s.id,
    };
  }
  if (ref.kind === 'pallet') {
    return {
      ref,
      title: `Pallet ${ref.id}`,
      subtitle: 'Wrapped goods · 640 kg',
      status: 'In storage',
      statusTone: 'neutral',
      fields: [
        { label: 'Location', value: 'A07 · level 3' },
        { label: 'Received', value: clockTime(w.t - 2400) },
      ],
    };
  }
  return null;
}
