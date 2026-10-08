/**
 * Forklift navigation on top of the layout nav graph: node classification into lockable lanes,
 * right-hand lane offsets on the cross aisles, polylines with lock acquire / release points.
 */
import { findPath } from '../core/layout';
import type { SiteLayout, V2 } from '../core/types';

export type NodeKind = 'cross' | 'svc' | 'col' | 'aisle';
const CROSS_LANE = 0;

export class NavInfo {
  readonly kind = new Map<string, NodeKind>();
  readonly key = new Map<string, string | null>();
  readonly svcX: number;
  readonly laneX: number;
  readonly parkX: number;
  private cache = new Map<string, string[]>();
  /** Cross-aisle nodes grouped by cross aisle (sorted by x). */
  readonly crossLines: { z: number; nodes: string[] }[] = [];

  constructor(readonly site: SiteLayout) {
    const nav = site.nav;
    this.svcX = site.building.rect.x0 + 3.2;
    this.laneX = site.building.rect.x0 + 4.75;
    this.parkX = site.building.rect.x0 + 2.25;
    const floor = site.def.storage === 'floor';
    const crossS = site.crossAisles[0];
    const crossN = site.crossAisles[1];
    for (const id in nav.nodes) {
      const n = nav.nodes[id];
      let kind: NodeKind;
      let key: string | null = null;
      if (site.crossAisles.some((z) => Math.abs(n.z - z) < 1e-3)) kind = 'cross';
      else if (Math.abs(n.x - this.svcX) < 1e-3) {
        kind = 'svc';
        key = 'svc';
      } else {
        const door = site.doors.find(
          (d) => Math.abs(d.pos.x - n.x) < 1e-3 && (d.side === 'S' ? n.z > crossS : crossN !== undefined && n.z < crossN),
        );
        if (door) {
          kind = 'col';
          key = floor ? `lane:${n.x.toFixed(2)}` : `door:${door.id}`;
        } else {
          kind = 'aisle';
          key = floor ? `lane:${n.x.toFixed(2)}` : `aisle:${n.x.toFixed(2)}`;
        }
      }
      this.kind.set(id, kind);
      this.key.set(id, key);
    }
    for (const z of site.crossAisles) {
      const ids = Object.keys(nav.nodes).filter((id) => this.kind.get(id) === 'cross' && Math.abs(nav.nodes[id].z - z) < 1e-3);
      ids.sort((a, b) => nav.nodes[a].x - nav.nodes[b].x);
      this.crossLines.push({ z, nodes: ids });
    }
  }

  /** Cross-aisle cells (node ids) a node path drives over, with a body-length margin. */
  cells(nodes: string[]): string[] {
    const N = this.site.nav.nodes;
    const out = new Set<string>();
    for (let i = 0; i < nodes.length; i++) {
      if (this.kind.get(nodes[i]) !== 'cross') continue;
      let j = i;
      while (j + 1 < nodes.length && this.kind.get(nodes[j + 1]) === 'cross' && Math.abs(N[nodes[j + 1]].z - N[nodes[i]].z) < 1e-3) j++;
      const xs = nodes.slice(i, j + 1).map((n) => N[n].x);
      const x0 = Math.min(...xs) - 3.4;
      const x1 = Math.max(...xs) + 3.4;
      const line = this.crossLines.find((l) => Math.abs(l.z - N[nodes[i]].z) < 1e-3);
      if (line) for (const id of line.nodes) if (N[id].x >= x0 && N[id].x <= x1) out.add(id);
      i = j;
    }
    return [...out];
  }

  path(from: string, to: string): string[] {
    const k = `${from}>${to}`;
    let p = this.cache.get(k);
    if (!p) {
      p = findPath(this.site.nav, from, to);
      if (this.cache.size > 4000) this.cache.clear();
      this.cache.set(k, p);
    }
    return p;
  }

  pos(id: string): V2 {
    const n = this.site.nav.nodes[id];
    return { x: n.x, z: n.z };
  }

  /**
   * Polyline from the current position along node ids. Cross-aisle segments keep to the right,
   * the charger lane is driven on its free side.
   */
  polyline(start: V2, nodes: string[], end?: V2): { pts: V2[]; s: number[] } {
    const N = this.site.nav.nodes;
    const segs: { horiz: boolean; line: number }[] = [];
    for (let i = 0; i < nodes.length - 1; i++) {
      const a = N[nodes[i]];
      const b = N[nodes[i + 1]];
      const horiz = Math.abs(a.z - b.z) < 1e-3;
      let line: number;
      if (horiz) {
        const off = this.kind.get(nodes[i]) === 'cross' && this.kind.get(nodes[i + 1]) === 'cross' ? CROSS_LANE * Math.sign(b.x - a.x) : 0;
        line = a.z + off;
      } else {
        const onSvc = Math.abs(a.x - this.svcX) < 1e-3 && Math.abs(b.x - this.svcX) < 1e-3;
        line = onSvc ? this.laneX : a.x;
      }
      segs.push({ horiz, line });
    }
    const pts: V2[] = [{ x: start.x, z: start.z }];
    for (let i = 1; i < nodes.length - 1; i++) {
      const p = segs[i - 1];
      const q = segs[i];
      const n = N[nodes[i]];
      if (p.horiz && !q.horiz) pts.push({ x: q.line, z: p.line });
      else if (!p.horiz && q.horiz) pts.push({ x: p.line, z: q.line });
      else if (p.horiz) pts.push({ x: n.x, z: q.line });
      else pts.push({ x: q.line, z: n.z });
    }
    if (nodes.length > 1) {
      const last = N[nodes[nodes.length - 1]];
      const ls = segs[segs.length - 1];
      if (end) pts.push({ ...end });
      else if (ls.horiz) pts.push({ x: last.x, z: last.z });
      else pts.push({ x: ls.line === this.laneX ? this.laneX : last.x, z: last.z });
    }
    const s: number[] = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
    return { pts, s };
  }

  /** Lock acquire/release points along a node path. */
  locks(nodes: string[], s: number[], held: Set<string>): { acquire: { key: string; s: number }[]; release: { key: string; s: number }[] } {
    const acquire: { key: string; s: number }[] = [];
    const release: { key: string; s: number }[] = [];
    const keys = nodes.map((n) => this.key.get(n) ?? null);
    const seen = new Set<string>();
    let lastRelease = 0;
    for (let i = 0; i < keys.length; i++) {
      const K = keys[i];
      if (!K || seen.has(K)) continue;
      seen.add(K);
      let l = i;
      for (let j = i; j < keys.length; j++) if (keys[j] === K) l = j;
      if (!held.has(K)) {
        const mouth = Math.max(0, i - 1);
        acquire.push({ key: K, s: Math.max(lastRelease, Math.max(0, s[mouth] - 5.2)) });
      }
      if (l < keys.length - 1) {
        const rs = Math.min(s[s.length - 1], s[l + 1] + 3.0);
        release.push({ key: K, s: rs });
        lastRelease = Math.max(lastRelease, rs);
      }
    }
    return { acquire, release };
  }
}
