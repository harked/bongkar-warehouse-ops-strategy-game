/** Named palette. See DESIGN.md. Numbers for three.js, strings for CSS. */
export const P = {
  cloud: 0xffffff,
  haze: 0xeef6fd,
  glacier: 0xd6eafb,
  sky: 0x6cb8f0,
  azure: 0x2f8ce8,
  cobalt: 0x2147d9,
  midnight: 0x13296e,
  ink: 0x26354d,
  slate: 0x6b7c96,
  meadow: 0xa9db8c,
  fern: 0x6db66a,
  pine: 0x3e8e5e,
  lagoon: 0x8fd3f4,
  concrete: 0xe6ebf1,
  asphalt: 0xa9b4c2,
  sunbeam: 0xffc145,
  coral: 0xff6f61,
  mint: 0x2ccb94,
  frost: 0xa8e6ff,
} as const;

export type PaletteName = keyof typeof P;

export const css = (n: number): string => '#' + n.toString(16).padStart(6, '0');
