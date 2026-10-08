/** Invented carriers, partners, products and helpers for human-readable text. */
import { P } from '../core/palette';
import type { CargoKind } from '../core/types';

export const CARRIERS = [
  'Bluebird Freight',
  'Harbor & Pine',
  'Lumen Logistics',
  'Northwind Haulage',
  'Cobalt Line',
  'Meadowlark Transport',
  'Tidewater Carriers',
  'Summit Express',
];
export const COLD_CARRIERS = ['Polar Bay Reefers', 'Glacier Run', 'Frostbyte Cold Freight'];
export const PARCEL_CARRIERS = ['Swift Parcel Co', 'Kite Courier'];

export const CAB_COLORS = [P.cobalt, P.azure, P.sky, P.coral, P.mint, P.sunbeam, P.midnight];

const SUPPLIERS_BY_CARGO: Record<CargoKind, string[]> = {
  cartons: ['Granite Paper Mills', 'Kestrel Home Goods', 'Brightwater Bottling'],
  wrapped: ['Kestrel Home Goods', 'Brightwater Bottling', 'Granite Paper Mills'],
  produce: ['Orchard Valley Farms', 'Coastline Foods'],
  frozen: ['Northshore Seafood', 'Coastline Foods'],
  parcels: ['Swiftline Marketplace', 'Harborview Outlet'],
  drums: ['Granite Chemicals', 'Brightwater Bottling'],
};
export const supplierFor = (c: CargoKind, r: () => number): string => pick(SUPPLIERS_BY_CARGO[c], r);

export const CUSTOMERS = ['Maple Retail', 'Corner Pantry Markets', 'Hillside Hardware', 'Lakeview Grocers', 'Parcelport Direct', 'Sunrise Pharmacies'];

export const CARGO_LABEL: Record<CargoKind, string> = {
  cartons: 'Mixed cartons',
  wrapped: 'Wrapped goods',
  produce: 'Chilled produce',
  frozen: 'Frozen foods',
  parcels: 'Parcels',
  drums: 'Drums',
};

const PRODUCTS: Record<CargoKind, { name: string; kg: [number, number] }[]> = {
  cartons: [
    { name: 'Oat cereal 12x500 g', kg: [280, 420] },
    { name: 'Paper towels 24 rolls', kg: [140, 220] },
    { name: 'Canned tomatoes 24x400 g', kg: [620, 820] },
    { name: 'Dish soap 12x1 L', kg: [480, 640] },
    { name: 'Coffee beans 10x1 kg', kg: [300, 420] },
  ],
  wrapped: [
    { name: 'Garden chairs, 8 units', kg: [180, 260] },
    { name: 'Bottled water 6x1.5 L', kg: [760, 920] },
    { name: 'Pet food 15 kg bags', kg: [600, 760] },
    { name: 'Flat-pack shelving', kg: [380, 520] },
  ],
  produce: [
    { name: 'Apples, Honeycrisp', kg: [520, 700] },
    { name: 'Yogurt 12x500 g', kg: [420, 560] },
    { name: 'Leafy greens', kg: [240, 360] },
    { name: 'Fresh milk 12x2 L', kg: [640, 820] },
  ],
  frozen: [
    { name: 'Frozen peas 20x1 kg', kg: [420, 560] },
    { name: 'Ice cream tubs', kg: [380, 520] },
    { name: 'Frozen fish fillets', kg: [520, 680] },
    { name: 'Pizza bases 40 pack', kg: [300, 420] },
  ],
  parcels: [
    { name: 'Mixed parcels, cage', kg: [160, 320] },
    { name: 'E-commerce returns', kg: [120, 260] },
    { name: 'Small parcels, sorted', kg: [140, 300] },
  ],
  drums: [
    { name: 'Cooking oil drums 4x200 L', kg: [720, 860] },
    { name: 'Detergent drums', kg: [680, 820] },
    { name: 'Lubricant drums', kg: [700, 880] },
  ],
};

export function product(kind: CargoKind, r: () => number): { sku: string; desc: string; kg: number } {
  const list = PRODUCTS[kind];
  const p = list[Math.floor(r() * list.length)];
  const sku = `SKU ${String(10000 + Math.floor(r() * 89999))}`;
  return { sku, desc: p.name, kg: Math.round(p.kg[0] + r() * (p.kg[1] - p.kg[0])) };
}

export const pick = <T>(arr: readonly T[], r: () => number): T => arr[Math.floor(r() * arr.length) % arr.length];

export function clock(sec: number): string {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400;
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`;
}

export function mins(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60));
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export const cap = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
