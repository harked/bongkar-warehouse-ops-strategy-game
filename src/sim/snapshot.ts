/** HUD snapshot: rosters, KPIs, shipments, feed and the selection card. */
import type {
  DetailField,
  DockRow,
  DockState,
  EntityRef,
  ForkliftRow,
  ForkliftState,
  HudSnapshot,
  SelectionDetail,
  SiteSummary,
  Tone,
  TruckRow,
  TruckState,
} from '../core/types';
import type { Sim } from './index';
import { CARGO_LABEL, cap, clock, mins } from './names';
import type { Truck } from './truck';

const DOCK_TONE: Record<DockState, Tone> = { idle: 'neutral', reserved: 'cold', docking: 'active', unloading: 'active', loading: 'active', departing: 'good' };
const LIFT_TONE: Record<ForkliftState, Tone> = { idle: 'neutral', 'to-pick': 'active', carrying: 'active', 'to-charge': 'warn', charging: 'cold' };
const LIFT_STATUS: Record<ForkliftState, string> = { idle: 'Idle', 'to-pick': 'Driving to pick', carrying: 'Carrying', 'to-charge': 'To charger', charging: 'Charging' };
const TRUCK_TONE: Record<TruckState, Tone> = { 'en-route': 'cold', queued: 'neutral', docking: 'active', 'at-dock': 'active', departing: 'good', leaving: 'neutral' };
const TRUCK_STATUS: Record<TruckState, string> = { 'en-route': 'En route', queued: 'Queued', docking: 'Docking', 'at-dock': 'At dock', departing: 'Departing', leaving: 'Leaving' };
const TRUCK_ORDER: Record<TruckState, number> = { 'at-dock': 0, docking: 1, departing: 2, queued: 3, 'en-route': 4, leaving: 5 };
const VARIANT: Record<string, string> = { dry: 'Dry van', reefer: 'Reefer', box: 'Box trailer' };
const DAYS = ['Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue', 'Wed'];

export function truckState(t: Truck): TruckState {
  const s = t.hudState();
  if ((t.phase === 'toDoor' || t.phase === 'toBay' || t.phase === 'toConn') && t.yardS > 0 && t.s < t.yardS) return 'en-route';
  return s;
}

export function truckWhere(sim: Sim, t: Truck): { where: string; eta?: number } {
  const site = t.site ? t.site.L.def.name : null;
  const st = truckState(t);
  switch (st) {
    case 'en-route': {
      const rem = sim.fleet.remaining(t) - (t.yardS > 0 && t.path ? Math.max(0, t.path.length - t.yardS) : 0);
      const eta = Math.max(0, rem / 13);
      return { where: site ? `${mins(eta)} to ${site}` : 'On the highway', eta };
    }
    case 'queued':
      if (t.phase === 'hold') return { where: `Holding at the ${site} gate` };
      if (t.phase === 'conn') return { where: `Waiting for a north door at ${site}` };
      return { where: `Waiting in the ${site} yard` };
    case 'docking':
      return { where: t.phase === 'reversing' ? `Backing into ${t.door?.L.label}` : `Heading to ${t.door?.L.label}` };
    case 'at-dock':
      return { where: `Docked at ${t.door?.L.label}` };
    case 'departing':
      return { where: `Pulling out of ${t.door?.L.label ?? 'the dock'}` };
    default:
      return { where: 'Heading off the map' };
  }
}

function dockProgress(t: Truck | null): number {
  if (!t || t.phase !== 'docked') return 0;
  const n = Math.max(1, t.job.shipment?.count ?? t.planned ?? 1);
  return t.job.kind === 'collect' ? Math.min(1, t.cargoCount / n) : Math.min(1, 1 - t.cargoCount / n);
}

export function buildSnapshot(sim: Sim, activeSiteId: string, selection: EntityRef | null): HudSnapshot {
  const t = sim.t;
  const sod = ((t % 86400) + 86400) % 86400;
  const day = Math.floor(t / 86400);
  const clockInfo = {
    seconds: t,
    label: clock(sod),
    dayLabel: `${DAYS[day % 7]} ${8 + day} Oct`,
    speed: sim.speed,
    paused: sim.paused,
  };

  const docks: DockRow[] = [];
  const forklifts: ForkliftRow[] = [];
  for (const ops of sim.sites.values()) {
    for (const d of ops.doors) {
      const tr = d.truck;
      docks.push({
        id: d.L.id,
        siteId: ops.id,
        label: d.L.label,
        role: d.L.role,
        state: d.state,
        truckId: tr?.id,
        truckLabel: tr?.label,
        progress: tr && tr.door === d ? dockProgress(tr) : 0,
      });
    }
    for (const f of ops.forklifts) {
      forklifts.push({ id: f.id, siteId: ops.id, label: f.label, state: f.state, battery: f.battery, task: f.task, movedToday: f.moved });
    }
  }
  docks.sort((a, b) => (a.siteId === b.siteId ? a.label.localeCompare(b.label) : a.siteId.localeCompare(b.siteId)));

  const trucks: TruckRow[] = [];
  for (const tr of sim.fleet.trucks) {
    if (!tr.active) continue;
    const st = truckState(tr);
    const w = truckWhere(sim, tr);
    trucks.push({
      id: tr.id,
      label: tr.label,
      carrier: tr.carrier,
      variant: tr.variant,
      state: st,
      siteId: tr.site?.id,
      doorLabel: tr.door?.L.label,
      where: w.where,
      etaSec: st === 'en-route' ? w.eta : undefined,
      load: tr.loadFraction,
      shipmentId: tr.job.shipment?.id,
    });
  }
  trucks.sort((a, b) => TRUCK_ORDER[a.state] - TRUCK_ORDER[b.state] || (a.etaSec ?? 0) - (b.etaSec ?? 0) || a.label.localeCompare(b.label));
  if (trucks.length > 60) trucks.length = 60;

  const shipments = sim.shipments.list
    .filter((s) => s.status !== 'done' || t - (s.doneAt[5] ?? t) < 600)
    .map((s) => sim.shipments.row(s));
  const rank = { late: 0, 'at-risk': 1, 'on-time': 2, done: 3 } as const;
  shipments.sort((a, b) => rank[a.status] - rank[b.status] || a.etaAt - b.etaAt);

  // ---- KPIs
  const sites: SiteSummary[] = [];
  let palletsToday = 0;
  for (const ops of sim.sites.values()) {
    palletsToday += ops.movesToday;
    const ships = sim.shipments.list.filter((s) => s.from.siteId === ops.id || s.to.siteId === ops.id);
    const late = ships.filter((s) => s.status === 'late').length;
    const risk = ships.filter((s) => s.status === 'at-risk').length;
    const onTime = ships.length ? ships.filter((s) => s.status === 'on-time' || (s.status === 'done' && (s.doneAt[5] ?? 0) <= s.dueAt)).length / ships.length : 1;
    const alertsDocks = ops.doors.filter((d) => d.signal === 'alert').length;
    const lowBatt = ops.forklifts.filter((f) => f.battery < 0.2).length;
    sites.push({
      id: ops.id,
      name: ops.L.def.name,
      short: ops.L.def.short,
      code: ops.L.def.code,
      kind: ops.L.def.kind,
      blurb: ops.L.def.blurb,
      alerts: late + alertsDocks + lowBatt + (risk > 1 ? 1 : 0),
      kpis: {
        throughputPerHour: ops.throughputPerHour(),
        docksBusy: ops.doors.filter((d) => d.truck).length,
        docksTotal: ops.doors.length,
        onTime,
        palletsStored: ops.floor ? ops.slotPallet.filter((p) => p).length : ops.stored,
        capacity: ops.L.slots.length,
        tempC: ops.L.def.kind === 'cold' ? Math.round(ops.tempC * 10) / 10 : undefined,
        forkliftsActive: ops.forklifts.filter((f) => f.state === 'to-pick' || f.state === 'carrying').length,
        forkliftsTotal: ops.forklifts.length,
        trucksOnSite: sim.fleet.trucks.filter((x) => x.active && x.site === ops && x.phase !== 'highway' && truckState(x) !== 'en-route').length,
      },
    });
  }
  const open = sim.shipments.list.filter((s) => s.status !== 'done');
  const network = {
    trucksInTransit: sim.fleet.trucks.filter((x) => x.active && (x.phase === 'highway' || x.phase === 'leaving')).length,
    shipmentsOpen: open.length,
    shipmentsDoneToday: sim.shipments.doneToday,
    onTime: open.length ? open.filter((s) => s.status === 'on-time').length / open.length : 1,
    palletsMovedToday: palletsToday + sim.palletsBefore,
  };

  return {
    clock: clockInfo,
    activeSiteId,
    network,
    sites,
    docks,
    forklifts,
    trucks,
    shipments,
    events: sim.feed.events.slice(),
    selection: selection ? describe(sim, selection, sites) : null,
  };
}

function describe(sim: Sim, ref: EntityRef, sites: SiteSummary[]): SelectionDetail | null {
  const t = sim.t;
  if (ref.kind === 'truck') {
    const tr = sim.fleet.get(ref.id);
    if (!tr || !tr.active) return null;
    const st = truckState(tr);
    const w = truckWhere(sim, tr);
    const sh = tr.job.shipment;
    const fields: DetailField[] = [
      { label: 'Where', value: w.where },
      { label: 'Carrier', value: tr.carrier },
    ];
    if (sh) {
      fields.push({ label: 'Shipment', value: `${sh.id} · ${CARGO_LABEL[sh.cargo]}` });
      fields.push({ label: 'Route', value: `${sh.from.name} to ${sh.to.name}` });
      fields.push({
        label: 'ETA vs due',
        value: `${clock(sh.etaAt)} / ${clock(sh.dueAt)}`,
        tone: sh.status === 'late' ? 'alert' : sh.status === 'at-risk' ? 'warn' : 'good',
      });
    } else {
      fields.push({ label: 'Job', value: tr.job.kind === 'leave' ? 'Empty, heading home' : 'Collecting a load' });
    }
    if (w.eta !== undefined) fields.push({ label: 'Arrives in', value: mins(w.eta) });
    if (tr.phase === 'docked') fields.push({ label: 'At dock for', value: mins(t - tr.arrivedAt) });
    fields.push({ label: 'Speed', value: `${Math.round(Math.abs(tr.v) * 3.6)} km/h` });
    const sp = sh ? sim.shipments.row(sh) : null;
    return {
      ref,
      title: tr.label,
      subtitle: `${VARIANT[tr.variant]} · ${tr.carrier}`,
      status: TRUCK_STATUS[st],
      statusTone: TRUCK_TONE[st],
      fields,
      meter: { label: 'Trailer load', value: tr.loadFraction, tone: 'active' },
      progress: sp ? { label: `Journey · ${sp.stages[Math.min(sp.stage, 5)].label.toLowerCase()}`, value: sp.progress } : undefined,
      shipmentId: sh?.id,
      siteId: tr.site?.id,
    };
  }
  if (ref.kind === 'forklift') {
    const ops = sim.sites.get(ref.id.split(':')[0]);
    const f = ops?.forklifts.find((x) => x.id === ref.id);
    if (!ops || !f) return null;
    const p = f.carrying;
    const fields: DetailField[] = [
      { label: 'Task', value: f.task },
      { label: 'Moved today', value: `${f.moved} pallets` },
      { label: 'Fork height', value: `${f.fork.toFixed(1)} m` },
    ];
    if (p) fields.push({ label: 'Load', value: `${p.id} · ${p.desc}`, tone: 'active' });
    const sh = p?.shipment;
    return {
      ref,
      title: f.label,
      subtitle: `Counterbalance forklift · ${ops.L.def.name}`,
      status: LIFT_STATUS[f.state],
      statusTone: LIFT_TONE[f.state],
      fields,
      meter: { label: 'Battery', value: f.battery, tone: f.battery < 0.25 ? 'alert' : f.battery < 0.45 ? 'warn' : 'good' },
      shipmentId: sh?.id,
      siteId: ops.id,
    };
  }
  if (ref.kind === 'pallet') {
    const p = sim.pallets.byId.get(ref.id);
    if (!p) return null;
    const l = p.loc;
    let where = 'In transit';
    let status = 'In storage';
    let tone: Tone = 'neutral';
    let siteId = p.siteId ?? undefined;
    if (l.t === 'slot') {
      const parts = l.slot.id.split(':');
      where = l.slot.kind === 'floor' ? `Floor lane ${parts[1]}, bay ${+parts[3] + 1}` : `Aisle ${parts[1]}, bay ${+parts[3] + 1}, level ${l.slot.level + 1}`;
      status = l.slot.kind === 'floor' ? 'On the floor' : 'In storage';
    } else if (l.t === 'stage') {
      where = `${l.door.L.label} staging lane`;
      status = 'Staged';
      tone = 'active';
      siteId = l.door.siteId;
    } else if (l.t === 'trailer') {
      where = `Trailer ${l.truck.label}${l.truck.door ? ` at ${l.truck.door.L.label}` : ''}`;
      status = l.truck.phase === 'docked' ? 'In a docked trailer' : 'On the road';
      tone = 'cold';
      siteId = l.truck.site?.id;
    } else if (l.t === 'forks') {
      where = `On ${l.fl.label}`;
      status = 'Moving';
      tone = 'active';
      siteId = l.fl.siteId;
    }
    const fields: DetailField[] = [
      { label: 'Cargo', value: `${CARGO_LABEL[p.cargo]} · ${p.desc}` },
      { label: 'SKU', value: p.sku },
      { label: 'Weight', value: `${p.kg} kg` },
      { label: 'Location', value: where },
      { label: 'Origin', value: p.origin },
    ];
    if (p.receivedAt > 0) fields.push({ label: 'Received', value: clock(p.receivedAt) });
    if (p.shipment) fields.push({ label: 'Shipment', value: `${p.shipment.id} to ${p.shipment.to.name}` });
    return {
      ref,
      title: `Pallet ${p.id}`,
      subtitle: `${CARGO_LABEL[p.cargo]} · ${p.kg} kg`,
      status,
      statusTone: tone,
      fields,
      shipmentId: p.shipment?.id,
      siteId,
    };
  }
  if (ref.kind === 'dock') {
    const siteId = ref.id.split(':')[0];
    const ops = sim.sites.get(siteId);
    const d = ops?.doorById.get(ref.id);
    if (!ops || !d) return null;
    const tr = d.truck;
    const sh = tr?.job.shipment ?? d.shipment;
    const staged = d.stage.filter((x) => x).length;
    const fields: DetailField[] = [
      { label: 'Role', value: d.L.role === 'inbound' ? 'Inbound' : 'Outbound' },
      { label: 'Truck', value: tr ? `${tr.label} · ${tr.carrier}` : 'None' },
      { label: 'Staging lane', value: `${staged} of ${d.stage.length} pallets` },
      { label: 'Turns today', value: String(d.turns) },
    ];
    if (sh) fields.push({ label: 'Shipment', value: `${sh.id} · ${sh.count} pallets` });
    if (tr && tr.phase === 'docked') fields.push({ label: 'Docked for', value: mins(t - tr.arrivedAt), tone: d.signal === 'alert' ? 'alert' : undefined });
    const working = d.state === 'unloading' || d.state === 'loading';
    return {
      ref,
      title: `Dock ${d.L.label}`,
      subtitle: `${ops.L.def.name} · ${d.L.role} door`,
      status: d.signal === 'alert' ? 'Truck waiting too long' : cap(d.state),
      statusTone: d.signal === 'alert' ? 'alert' : DOCK_TONE[d.state],
      fields,
      progress: working ? { label: d.state === 'unloading' ? 'Unloaded' : 'Loaded', value: dockProgress(tr) } : undefined,
      shipmentId: sh?.id,
      siteId,
    };
  }
  if (ref.kind === 'site') {
    const s = sites.find((x) => x.id === ref.id);
    const ops = sim.sites.get(ref.id);
    if (!s || !ops) return null;
    const k = s.kpis;
    const fields: DetailField[] = [
      { label: 'Throughput', value: `${k.throughputPerHour} pallets/h` },
      { label: 'Docks busy', value: `${k.docksBusy} of ${k.docksTotal}` },
      { label: 'On time', value: `${Math.round(k.onTime * 100)}%`, tone: k.onTime > 0.9 ? 'good' : k.onTime > 0.7 ? 'warn' : 'alert' },
      { label: 'Forklifts working', value: `${k.forkliftsActive} of ${k.forkliftsTotal}` },
      { label: 'Trucks on site', value: String(k.trucksOnSite) },
      { label: 'Moved today', value: `${ops.movesToday} pallets` },
    ];
    if (k.tempC !== undefined) fields.push({ label: 'Freezer', value: `${k.tempC.toFixed(1)} °C`, tone: 'cold' });
    return {
      ref,
      title: s.name,
      subtitle: s.blurb,
      status: s.alerts ? `${s.alerts} alert${s.alerts > 1 ? 's' : ''}` : 'Running smoothly',
      statusTone: s.alerts ? 'warn' : 'good',
      fields,
      meter: k.capacity ? { label: ops.floor ? 'Floor in use' : 'Storage fill', value: k.palletsStored / k.capacity, tone: 'active' } : undefined,
      siteId: s.id,
    };
  }
  return null;
}
