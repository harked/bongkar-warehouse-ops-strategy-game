import type { V2 } from './types';

export type SiteKind = 'dc' | 'cold' | 'crossdock' | 'hub';

export interface SiteDef {
  id: string;
  name: string;
  /** Short code used in labels, e.g. truck plates "NG-204". */
  code: string;
  kind: SiteKind;
  blurb: string;
  /** Building centre in world space. */
  center: V2;
  /** Building footprint (x by z) and wall height. */
  w: number;
  d: number;
  h: number;
  /** Dock doors on the south (+z) wall and north (-z) wall. */
  doorsS: number;
  doorsN: number;
  doorSpacing: number;
  /** How many of the south doors (from the west) are inbound. The rest are outbound. North doors are outbound. */
  inboundS: number;
  storage: 'racks' | 'floor';
  forklifts: number;
  /** Target number of trucks working this site at once (docked + queued + arriving). */
  truckLoad: number;
}

export const SITE_DEFS: SiteDef[] = [
  {
    id: 'northgate',
    name: 'Northgate DC',
    code: 'NG',
    kind: 'dc',
    blurb: 'Ambient distribution center',
    center: { x: 0, z: 0 },
    w: 96,
    d: 56,
    h: 11,
    doorsS: 10,
    doorsN: 0,
    doorSpacing: 8.5,
    inboundS: 5,
    storage: 'racks',
    forklifts: 8,
    truckLoad: 9,
  },
  {
    id: 'frostline',
    name: 'Frostline Cold Chain',
    code: 'FL',
    kind: 'cold',
    blurb: 'Chilled and frozen storage',
    center: { x: -250, z: 30 },
    w: 70,
    d: 48,
    h: 10,
    doorsS: 6,
    doorsN: 0,
    doorSpacing: 9,
    inboundS: 3,
    storage: 'racks',
    forklifts: 5,
    truckLoad: 6,
  },
  {
    id: 'riverside',
    name: 'Riverside Cross-Dock',
    code: 'RV',
    kind: 'crossdock',
    blurb: 'Flow-through, no storage',
    center: { x: 250, z: 10 },
    w: 112,
    d: 28,
    h: 8.5,
    doorsS: 9,
    doorsN: 9,
    doorSpacing: 11,
    inboundS: 9,
    storage: 'floor',
    forklifts: 6,
    truckLoad: 10,
  },
  {
    id: 'pinecrest',
    name: 'Pinecrest Hub',
    code: 'PC',
    kind: 'hub',
    blurb: 'Regional parcel hub',
    center: { x: 10, z: -230 },
    w: 64,
    d: 40,
    h: 9,
    doorsS: 6,
    doorsN: 0,
    doorSpacing: 8.5,
    inboundS: 3,
    storage: 'racks',
    forklifts: 4,
    truckLoad: 5,
  },
];
