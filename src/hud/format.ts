export const pct = (v: number): string => `${Math.round(Math.max(0, Math.min(1, v)) * 100)}%`;

/** Seconds-of-day to "09:42". Wraps past midnight. */
export function clockTime(sec: number): string {
  const s = ((Math.floor(sec) % 86400) + 86400) % 86400;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Duration in sim seconds to "4 min", "1 h 12 min", "now". */
export function duration(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 45) return 'now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function int(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function shiftName(sec: number): string {
  const h = (((sec / 3600) % 24) + 24) % 24;
  if (h >= 6 && h < 14) return 'Early shift';
  if (h >= 14 && h < 22) return 'Late shift';
  return 'Night shift';
}
