/** The slice of the simulation every module may use (implemented by the Sim in index.ts). */
import type { WorldView } from '../core/contracts';
import type { EntityRef, Tone, WorldLayout } from '../core/types';
import type { Feed } from './feed';
import type { Fleet } from './fleet';
import type { SiteOps } from './ops';
import type { PalletStore } from './pallets';
import type { ShipmentBook } from './shipments';
import type { YardGeometry } from './yard';

export interface SimCore {
  t: number;
  rand: () => number;
  layout: WorldLayout;
  world: WorldView;
  yard: YardGeometry;
  pallets: PalletStore;
  feed: Feed;
  fleet: Fleet;
  shipments: ShipmentBook;
  sites: Map<string, SiteOps>;
  /** True while pre-warming (no view updates). */
  headless: boolean;
  event(text: string, tone: Tone, siteId?: string, ref?: EntityRef): void;
}
