/**
 * Computes the full world layout (doors, slots, racks, forklift nav graph, yard lanes,
 * highways) from SITE_DEFS. Pure data and deterministic: world, vehicles and sim all build on
 * the same numbers, so a truck the sim parks at `door.dockPos` lines up with the door the
 * world drew.
 */
import { DOCK_HEIGHT, FORKLIFT, RACK, RACK_LEVELS, TRUCK } from './constants';
import { headingOf } from './geom';
import { SITE_DEFS, type SiteDef } from './sites';
import type {
  Charger,
  DoorLayout,
  DoorSide,
  NavGraph,
  QueueSpot,
  RackRow,
  RoadSeg,
  SiteLayout,
  SlotLayout,
  V2,
  WorldLayout,
  YardLane,
} from './types';

/** Yard geometry offsets from the dock wall. */
export const YARD = {
  laneOffset: 31,
  laneWidth: 9,
  queueOffset: 40.5,
  fenceYard: 46,
  fenceBack: 14,
  fenceWest: 22,
  fenceEast: 30,
  connectorInset: 18,
};

export const TRUNK_Z = 140;
export const PINE_CONNECTOR_X = 128;

class NavBuilder {
  graph: NavGraph = { nodes: {}, adj: {} };
  constructor(private siteId: string) {}
  node(x: number, z: number): string {
    const id = `${this.siteId}:${x.toFixed(2)}:${z.toFixed(2)}`;
    if (!this.graph.nodes[id]) {
      this.graph.nodes[id] = { id, x, z };
      this.graph.adj[id] = [];
    }
    return id;
  }
  edge(a: string, b: string): void {
    if (a === b) return;
    if (!this.graph.adj[a].includes(b)) this.graph.adj[a].push(b);
    if (!this.graph.adj[b].includes(a)) this.graph.adj[b].push(a);
  }
  chain(ids: string[]): void {
    for (let i = 1; i < ids.length; i++) this.edge(ids[i - 1], ids[i]);
  }
}

function buildSite(def: SiteDef): SiteLayout {
  const c = def.center;
  const bW = c.x - def.w / 2;
  const bE = c.x + def.w / 2;
  const wallS = c.z + def.d / 2;
  const wallN = c.z - def.d / 2;
  const hasN = def.doorsN > 0;
  const floorStore = def.storage === 'floor';
  const nav = new NavBuilder(def.id);

  const bounds = {
    x0: bW - YARD.fenceWest,
    x1: bE + YARD.fenceEast,
    z0: hasN ? wallN - YARD.fenceYard : wallN - YARD.fenceBack,
    z1: wallS + YARD.fenceYard,
  };
  const gate: V2 = { x: bounds.x1, z: wallS + YARD.laneOffset };

  const crossS = wallS - (floorStore ? 7.5 : 10);
  const crossN = hasN ? wallN + 7.5 : NaN;
  const crossXs: { S: number[]; N: number[] } = { S: [], N: [] };

  // ---- doors -------------------------------------------------------------------------------
  const doors: DoorLayout[] = [];
  const makeDoors = (side: DoorSide, n: number, labelStart: number) => {
    const wallZ = side === 'S' ? wallS : wallN;
    const normal: V2 = { x: 0, z: side === 'S' ? 1 : -1 };
    const crossZ = side === 'S' ? crossS : crossN;
    for (let i = 0; i < n; i++) {
      const x = c.x + (i - (n - 1) / 2) * def.doorSpacing;
      const label = 'D' + String(labelStart + i).padStart(2, '0');
      const id = `${def.id}:${label}`;
      const inward = -normal.z;
      const doorNode = nav.node(x, wallZ + inward * 0.6);
      const rowNodes: string[] = [];
      const stageSlots: SlotLayout[] = [];
      [3, 4.5, 6].forEach((depth, r) => {
        const z = wallZ + inward * depth;
        const rn = nav.node(x, z);
        rowNodes.push(rn);
        for (const sgn of [-1, 1]) {
          const h = headingOf(sgn, 0);
          stageSlots.push({
            id: `${id}:stage:${stageSlots.length}`,
            index: stageSlots.length,
            kind: 'stage',
            pos: { x: x + sgn * 2.3, y: DOCK_HEIGHT, z },
            access: { x: x + sgn * (2.3 - FORKLIFT.forkOffset), z },
            heading: h,
            palletHeading: h,
            node: rn,
            level: 0,
            zone: def.kind === 'cold' ? 'chill' : 'ambient',
          });
        }
        void r;
      });
      const crossNode = nav.node(x, crossZ);
      nav.chain([doorNode, ...rowNodes, crossNode]);
      crossXs[side].push(x);
      doors.push({
        id,
        siteId: def.id,
        label,
        index: doors.length,
        side,
        role: side === 'N' ? 'outbound' : i < def.inboundS ? 'inbound' : 'outbound',
        pos: { x, z: wallZ },
        normal,
        dockPos: { x: x + normal.x * (0.3 + TRUCK.length / 2), z: wallZ + normal.z * (0.3 + TRUCK.length / 2) },
        dockHeading: headingOf(normal.x, normal.z),
        doorNode,
        stageSlots,
      });
    }
  };
  makeDoors('S', def.doorsS, 1);
  if (hasN) makeDoors('N', def.doorsN, def.doorsS + 1);

  // ---- storage aisles ------------------------------------------------------------------------
  const slots: SlotLayout[] = [];
  const racks: RackRow[] = [];
  const aisles: SiteLayout['aisles'] = [];
  let aisleXs: number[];
  let slotOffset: number;
  let levels: number[];
  let pitch: number;
  let zFront: number;
  let zBack: number;
  if (floorStore) {
    aisleXs = doors.filter((d) => d.side === 'S').map((d) => d.pos.x);
    slotOffset = 2.2;
    levels = [0];
    pitch = 1.5;
    zFront = crossS - 2.5;
    zBack = crossN + 2.5;
  } else {
    const n = Math.floor((def.w - 12) / 6);
    aisleXs = Array.from({ length: n }, (_, i) => c.x + (i - (n - 1) / 2) * 6);
    slotOffset = 2.4;
    levels = RACK_LEVELS;
    pitch = RACK.slotPitch;
    zFront = crossS - 3;
    zBack = wallN + 3;
  }
  aisleXs.forEach((ax, ai) => {
    const aisleLabel = 'A' + String(ai + 1).padStart(2, '0');
    const zone: SlotLayout['zone'] = def.kind === 'cold' ? (ax < c.x ? 'frozen' : 'chill') : 'ambient';
    const chain: string[] = [nav.node(ax, crossS)];
    let zLast = zFront;
    for (let k = 0; ; k++) {
      const z = zFront - pitch / 2 - k * pitch;
      if (z - pitch / 2 < zBack - 1e-6) break;
      zLast = z;
      const node = nav.node(ax, z);
      chain.push(node);
      for (const side of [-1, 1]) {
        const h = headingOf(side, 0);
        levels.forEach((lv, li) => {
          slots.push({
            id: `${def.id}:${aisleLabel}:${side < 0 ? 'L' : 'R'}:${k}:${li}`,
            index: slots.length,
            kind: floorStore ? 'floor' : 'rack',
            pos: { x: ax + side * slotOffset, y: DOCK_HEIGHT + lv, z },
            access: { x: ax + side * (slotOffset - FORKLIFT.forkOffset), z },
            heading: h,
            palletHeading: h,
            node,
            level: li,
            zone,
          });
        });
      }
    }
    if (hasN) chain.push(nav.node(ax, crossN));
    nav.chain(chain);
    crossXs.S.push(ax);
    if (hasN) crossXs.N.push(ax);
    aisles.push({ x: ax, z0: zFront, z1: floorStore ? zBack : zLast - pitch / 2 });
    if (!floorStore) {
      for (const side of [-1, 1]) {
        racks.push({ x: ax + side * slotOffset, z0: zFront, z1: zLast - pitch / 2, levels, zone });
      }
    }
  });

  // ---- chargers on a service lane along the west wall -------------------------------------------
  const svcX = bW + 3.2;
  const chargers: Charger[] = [];
  const svcNodes: { z: number; id: string }[] = [{ z: crossS, id: nav.node(svcX, crossS) }];
  crossXs.S.push(svcX);
  if (hasN) {
    svcNodes.push({ z: crossN, id: nav.node(svcX, crossN) });
    crossXs.N.push(svcX);
  }
  for (let k = 0; k < def.forklifts; k++) {
    const z = crossS - 3 - k * 2.6;
    const node = nav.node(svcX, z);
    svcNodes.push({ z, id: node });
    chargers.push({ id: `${def.id}:C${k + 1}`, pos: { x: svcX, z }, heading: headingOf(-1, 0), node });
  }
  svcNodes.sort((a, b) => b.z - a.z);
  nav.chain(svcNodes.map((n) => n.id));

  // ---- cross aisles ----------------------------------------------------------------------------
  const chainCross = (xs: number[], z: number) => {
    const uniq = [...new Set(xs.map((x) => +x.toFixed(2)))].sort((a, b) => a - b);
    nav.chain(uniq.map((x) => nav.node(x, z)));
  };
  chainCross(crossXs.S, crossS);
  if (hasN) chainCross(crossXs.N, crossN);

  // ---- yard ------------------------------------------------------------------------------------
  const lanes: YardLane[] = [];
  const roads: RoadSeg[] = [];
  const laneS = wallS + YARD.laneOffset;
  lanes.push({ side: 'S', z: laneS, xWest: bW - 12, xEast: gate.x, entry: [{ ...gate }] });
  roads.push({ points: [{ x: bW - 12, z: laneS }, { x: gate.x, z: laneS }], width: YARD.laneWidth, kind: 'yard' });
  const aprons = [{ x0: bounds.x0, z0: wallS, x1: bounds.x1, z1: bounds.z1 }];
  if (hasN) {
    const laneN = wallN - YARD.laneOffset;
    const connX = bE + YARD.connectorInset;
    lanes.push({
      side: 'N',
      z: laneN,
      xWest: bW - 12,
      xEast: connX,
      entry: [{ ...gate }, { x: connX, z: laneS }, { x: connX, z: laneN }],
    });
    roads.push({ points: [{ x: bW - 12, z: laneN }, { x: connX, z: laneN }], width: YARD.laneWidth, kind: 'yard' });
    roads.push({ points: [{ x: connX, z: laneS }, { x: connX, z: laneN }], width: 8, kind: 'connector' });
    aprons.push({ x0: bounds.x0, z0: bounds.z0, x1: bounds.x1, z1: wallN });
    aprons.push({ x0: bE, z0: wallN, x1: bounds.x1, z1: wallS });
  }
  const queueSpots: QueueSpot[] = [];
  for (let x = gate.x - 14, k = 0; x > bW + 6 && k < 6; x -= 19, k++) {
    queueSpots.push({ id: `${def.id}:Q${k + 1}`, pos: { x, z: wallS + YARD.queueOffset }, heading: headingOf(-1, 0) });
  }

  return {
    def,
    id: def.id,
    building: {
      cx: c.x,
      cz: c.z,
      w: def.w,
      d: def.d,
      h: def.h,
      floorY: DOCK_HEIGHT,
      rect: { x0: bW, z0: wallN, x1: bE, z1: wallS },
    },
    bounds,
    aprons,
    gate,
    doors,
    slots,
    racks,
    aisles,
    crossAisles: hasN ? [crossS, crossN] : [crossS],
    chargers,
    nav: nav.graph,
    lanes,
    queueSpots,
    roads,
  };
}

// ---- highways --------------------------------------------------------------------------------

interface HwNode {
  id: string;
  p: V2;
}
const hwNodes: Record<string, HwNode> = {};
const hwAdj: Record<string, string[]> = {};
function hwNode(id: string, p: V2) {
  hwNodes[id] = { id, p };
  hwAdj[id] = hwAdj[id] ?? [];
}
function hwEdge(a: string, b: string) {
  hwAdj[a].push(b);
  hwAdj[b].push(a);
}

function buildWorld(): WorldLayout {
  const sites = SITE_DEFS.map(buildSite);
  const siteById: Record<string, SiteLayout> = {};
  for (const s of sites) siteById[s.id] = s;

  const edges = { west: { x: -470, z: TRUNK_Z }, east: { x: 470, z: TRUNK_Z } };
  hwNode('west', edges.west);
  hwNode('east', edges.east);
  const trunk: HwNode[] = [hwNodes.west, hwNodes.east];
  const roads: RoadSeg[] = [];
  for (const s of sites) {
    hwNode(`G:${s.id}`, s.gate);
    if (s.id === 'stasiun-tabing') {
      hwNode('P1', { x: PINE_CONNECTOR_X, z: s.gate.z });
      hwNode(`J:${s.id}`, { x: PINE_CONNECTOR_X, z: TRUNK_Z });
      hwEdge(`G:${s.id}`, 'P1');
      hwEdge('P1', `J:${s.id}`);
      roads.push({ points: [s.gate, hwNodes.P1.p, hwNodes[`J:${s.id}`].p], width: 9, kind: 'spur' });
    } else {
      hwNode(`J:${s.id}`, { x: s.gate.x, z: TRUNK_Z });
      hwEdge(`G:${s.id}`, `J:${s.id}`);
      roads.push({ points: [s.gate, hwNodes[`J:${s.id}`].p], width: 9, kind: 'spur' });
    }
    trunk.push(hwNodes[`J:${s.id}`]);
  }
  trunk.sort((a, b) => a.p.x - b.p.x);
  for (let i = 1; i < trunk.length; i++) hwEdge(trunk[i - 1].id, trunk[i].id);
  roads.unshift({ points: trunk.map((n) => n.p), width: 12, kind: 'trunk' });

  return { sites, siteById, roads, edges, extent: { x0: -470, z0: -290, x1: 470, z1: 200 } };
}

export const WORLD: WorldLayout = buildWorld();

/**
 * Highway centreline polyline between two endpoints. Endpoints are site ids (the site gate)
 * or 'west' / 'east' (map edges). Includes both endpoints. Drive on the right: offset the
 * centreline to the right of travel by ~2.4 m for the lane.
 */
export function highwayPath(from: string, to: string): V2[] {
  const key = (s: string) => (s === 'west' || s === 'east' ? s : `G:${s}`);
  const a = key(from);
  const b = key(to);
  const prev: Record<string, string | null> = { [a]: null };
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === b) break;
    for (const n of hwAdj[cur]) {
      if (!(n in prev)) {
        prev[n] = cur;
        queue.push(n);
      }
    }
  }
  const path: V2[] = [];
  for (let cur: string | null = b; cur; cur = prev[cur] ?? null) path.unshift({ ...hwNodes[cur].p });
  return path;
}

/** A* over a site's forklift nav graph. Returns node ids from `from` to `to` inclusive, or [] if unreachable. */
export function findPath(nav: NavGraph, from: string, to: string): string[] {
  if (from === to) return [from];
  const goal = nav.nodes[to];
  const h = (id: string) => {
    const n = nav.nodes[id];
    return Math.abs(n.x - goal.x) + Math.abs(n.z - goal.z);
  };
  const g: Record<string, number> = { [from]: 0 };
  const came: Record<string, string> = {};
  const open = new MinHeap();
  open.push(from, h(from));
  const closed = new Set<string>();
  while (open.size) {
    const cur = open.pop()!;
    if (cur === to) {
      const out = [cur];
      let c = cur;
      while (came[c]) out.unshift((c = came[c]));
      return out;
    }
    if (closed.has(cur)) continue;
    closed.add(cur);
    const cn = nav.nodes[cur];
    for (const nb of nav.adj[cur]) {
      if (closed.has(nb)) continue;
      const nn = nav.nodes[nb];
      const cost = g[cur] + Math.hypot(nn.x - cn.x, nn.z - cn.z);
      if (cost < (g[nb] ?? Infinity)) {
        g[nb] = cost;
        came[nb] = cur;
        open.push(nb, cost + h(nb));
      }
    }
  }
  return [];
}

class MinHeap {
  private ids: string[] = [];
  private keys: number[] = [];
  get size() {
    return this.ids.length;
  }
  push(id: string, key: number) {
    this.ids.push(id);
    this.keys.push(key);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): string | undefined {
    if (!this.ids.length) return undefined;
    const top = this.ids[0];
    const lastId = this.ids.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.ids.length) {
      this.ids[0] = lastId;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number) {
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
  }
}
