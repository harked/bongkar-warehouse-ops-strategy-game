/** Vehicle colour tones, all derived from the named palette. */
import { P } from '../core/palette';
import { mixHex } from './builder';

export const C = {
  /** Chassis, frames: a mid slate leaning toward ink. */
  chassis: mixHex(P.slate, P.ink, 0.42),
  chassisLight: mixHex(P.slate, P.asphalt, 0.35),
  /** Tyres: dark slate rather than black. */
  tyre: mixHex(P.ink, P.slate, 0.22),
  tyreTread: mixHex(P.ink, P.slate, 0.1),
  rim: mixHex(P.concrete, P.asphalt, 0.25),
  hub: P.cloud,
  glass: mixHex(P.midnight, P.azure, 0.5),
  glassSheen: mixHex(P.sky, P.glacier, 0.35),
  glassDark: mixHex(P.midnight, P.ink, 0.35),
  chrome: mixHex(P.concrete, P.asphalt, 0.45),
  grille: mixHex(P.ink, P.slate, 0.3),
  /** Trailer interior: light so the open box reads from above. */
  liner: mixHex(P.glacier, P.cloud, 0.55),
  linerFloor: mixHex(P.asphalt, P.concrete, 0.55),
  frost: P.frost,
  amber: P.sunbeam,
  red: mixHex(P.coral, 0xe8384a, 0.35),
  white: P.cloud,
  headlamp: mixHex(P.haze, P.cloud, 0.5),
  mint: P.mint,
  /** Warm tan wood for pallets (never cream). */
  wood: 0xc98f55,
  woodDark: 0xae7442,
  woodLight: 0xd49c62,
  skin: mixHex(P.coral, P.cloud, 0.62),
};
