/**
 * Pallet entities and the single instanced renderer that draws them. Stored pallets are placed
 * once; pallets on forks are re-placed every frame; pallets in trailers show only while the
 * trailer is open at a dock.
 */
import type { PalletRenderer } from '../core/contracts';
import { DOCK_HEIGHT, FORKLIFT, TRUCK_CARGO_SLOTS } from '../core/constants';
import type { CargoKind, V3 } from '../core/types';
import type { Loc, Shipment } from './model';

export interface Pallet {
  idx: number;
  id: string;
  cargo: CargoKind;
  sku: string;
  desc: string;
  kg: number;
  origin: string;
  siteId: string | null;
  shipment: Shipment | null;
  loc: Loc;
  receivedAt: number;
  /** Reserved by a forklift task. */
  busy: boolean;
}

export class PalletStore {
  readonly all: (Pallet | null)[];
  private free: number[] = [];
  readonly byId = new Map<string, Pallet>();
  private nextId = 104000;
  private pos: V3 = { x: 0, y: 0, z: 0 };
  /** Indices whose placement must be refreshed every frame (on forks). */
  readonly live = new Set<Pallet>();
  private shown: Uint8Array;

  constructor(readonly renderer: PalletRenderer) {
    this.all = new Array(renderer.capacity).fill(null);
    for (let i = renderer.capacity - 1; i >= 0; i--) this.free.push(i);
    this.shown = new Uint8Array(renderer.capacity);
    renderer.setPickResolver((i) => {
      const p = this.all[i];
      return p ? { kind: 'pallet', id: p.id } : null;
    });
  }

  get count(): number {
    return this.byId.size;
  }

  create(init: Omit<Pallet, 'idx' | 'id' | 'busy'>, r: () => number): Pallet | null {
    const idx = this.free.pop();
    if (idx === undefined) return null;
    this.nextId += 1 + Math.floor(r() * 7);
    const p: Pallet = { ...init, idx, id: `P-${this.nextId}`, busy: false };
    this.all[idx] = p;
    this.byId.set(p.id, p);
    this.place(p);
    return p;
  }

  remove(p: Pallet): void {
    if (this.all[p.idx] !== p) return;
    this.renderer.hide(p.idx);
    this.shown[p.idx] = 0;
    this.all[p.idx] = null;
    this.byId.delete(p.id);
    this.live.delete(p);
    this.free.push(p.idx);
  }

  setLoc(p: Pallet, loc: Loc): void {
    p.loc = loc;
    if (loc.t === 'forks') this.live.add(p);
    else this.live.delete(p);
    this.place(p);
  }

  /** World position of a pallet (bottom centre) and heading. Returns false when hidden. */
  where(p: Pallet, out: V3): { ok: boolean; heading: number } {
    const loc = p.loc;
    switch (loc.t) {
      case 'slot':
        out.x = loc.slot.pos.x;
        out.y = loc.slot.pos.y;
        out.z = loc.slot.pos.z;
        return { ok: true, heading: loc.slot.palletHeading };
      case 'stage': {
        const s = loc.door.L.stageSlots[loc.i];
        out.x = s.pos.x;
        out.y = s.pos.y;
        out.z = s.pos.z;
        return { ok: true, heading: s.palletHeading };
      }
      case 'trailer': {
        const t = loc.truck;
        const c = TRUCK_CARGO_SLOTS[loc.i];
        const ch = Math.cos(t.h);
        const sh = Math.sin(t.h);
        out.x = t.x + c.x * ch + c.z * sh;
        out.z = t.z - c.x * sh + c.z * ch;
        out.y = c.y;
        return { ok: t.phase === 'docked' && t.rearDoors > 0.02, heading: t.h };
      }
      case 'forks': {
        const f = loc.fl;
        out.x = f.x + Math.sin(f.h) * FORKLIFT.forkOffset;
        out.z = f.z + Math.cos(f.h) * FORKLIFT.forkOffset;
        out.y = DOCK_HEIGHT + f.fork;
        return { ok: true, heading: f.h };
      }
      default:
        return { ok: false, heading: 0 };
    }
  }

  place(p: Pallet): void {
    const w = this.where(p, this.pos);
    if (w.ok) {
      this.renderer.set(p.idx, this.pos, w.heading, p.cargo);
      this.shown[p.idx] = 1;
    } else if (this.shown[p.idx]) {
      this.renderer.hide(p.idx);
      this.shown[p.idx] = 0;
    }
  }

  /** Refresh pallets that move with forklifts, then upload. */
  frame(): void {
    for (const p of this.live) this.place(p);
    this.renderer.commit();
  }
}
