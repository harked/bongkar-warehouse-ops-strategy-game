/** Hand-drawn 24x24 line icons. Stroke follows currentColor. */
import { svg } from './dom';

const P: Record<string, string> = {
  network:
    '<circle cx="12" cy="6.2" r="2.6"/><circle cx="5.8" cy="17.2" r="2.6"/><circle cx="18.2" cy="17.2" r="2.6"/><path d="M10.7 8.5 7.1 14.9M13.3 8.5l3.6 6.4M8.4 17.2h7.2"/>',
  dc: '<path d="M3.5 10.2 12 5l8.5 5.2v9.3h-17z"/><path d="M8 19.5v-6.2h8v6.2M8 16.4h8"/>',
  cold: '<path d="M12 3.2v17.6M4.4 7.6l15.2 8.8M4.4 16.4l15.2-8.8"/><path d="M9.5 4.6 12 7l2.5-2.4M9.5 19.4 12 17l2.5 2.4M4.6 10.7l3.3-.9-.9-3.3M19.4 13.3l-3.3.9.9 3.3M7 17.2l.9-3.3-3.3-.9M17 6.8l-.9 3.3 3.3.9"/>',
  crossdock: '<path d="M3.8 8.6h13.4M13.6 5l3.6 3.6-3.6 3.6M20.2 15.4H6.8M10.4 11.8l-3.6 3.6 3.6 3.6"/>',
  hub: '<path d="M12 3.6 19.6 7.8v8.4L12 20.4l-7.6-4.2V7.8z"/><path d="M4.4 7.8 12 12l7.6-4.2M12 12v8.4M8.2 5.7l7.6 4.2"/>',
  throughput: '<path d="M3.5 12h12.5M12.5 7.5 17 12l-4.5 4.5"/><path d="M20.5 5v14"/><path d="M3.5 7h4M3.5 17h4"/>',
  dock: '<path d="M3.8 20V8.8L12 4.2l8.2 4.6V20"/><path d="M7.4 20v-8h9.2v8M7.4 14.6h9.2M7.4 17.3h9.2"/>',
  ontime: '<circle cx="12" cy="12" r="8.2"/><path d="m8.4 12.3 2.5 2.5 4.8-5.2"/>',
  storage: '<path d="M4.5 3.8v16.4M19.5 3.8v16.4M4.5 9h15M4.5 14.6h15M4.5 20.2h15"/><path d="M7.2 9v-2.6h4.2V9M12.8 14.6v-2.8h4.4v2.8"/>',
  temp: '<path d="M9.8 14.3V5.6a2.2 2.2 0 0 1 4.4 0v8.7a3.9 3.9 0 1 1-4.4 0z"/><path d="M12 9.2v7.4"/>',
  forklift:
    '<path d="M3.8 17.4V9.2h5.6l2.9 5.4v2.8"/><path d="M5.6 9.2V5.6h3.2"/><path d="M16.2 3.8v14.6h4.4"/><path d="M12.3 12.4h3.9"/><circle cx="6.6" cy="18" r="1.9"/><circle cx="11.6" cy="18" r="1.4"/>',
  truck:
    '<path d="M2.8 6.2h11.4v10.6H2.8zM14.2 9.4h3.9l3.1 3.4v4h-7"/><circle cx="6.8" cy="17.6" r="1.9"/><circle cx="17.4" cy="17.6" r="1.9"/>',
  pallet: '<path d="M3.8 15.2h16.4M3.8 19h16.4M5.8 15.2V19M12 15.2V19M18.2 15.2V19"/><rect x="5.6" y="5" width="12.8" height="10.2" rx="1.2"/><path d="M5.6 9.6h12.8"/>',
  site: '<path d="M3.5 10.2 12 5l8.5 5.2v9.3h-17z"/><path d="M8 19.5v-6.2h8v6.2"/>',
  focus: '<circle cx="12" cy="12" r="6.6"/><path d="M12 2.6v3.6M12 17.8v3.6M2.6 12h3.6M17.8 12h3.6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  close: '<path d="M7 7l10 10M17 7 7 17"/>',
  pause: '<rect x="6.6" y="5.6" width="3.6" height="12.8" rx="1.1" fill="currentColor" stroke="none"/><rect x="13.8" y="5.6" width="3.6" height="12.8" rx="1.1" fill="currentColor" stroke="none"/>',
  play: '<path d="M8.2 6.1v11.8c0 .7.8 1.2 1.4.8l9.2-5.9c.6-.4.6-1.2 0-1.6L9.6 5.3c-.6-.4-1.4 0-1.4.8z" fill="currentColor" stroke="none"/>',
  rotl: '<path d="M4.4 4.6v4.6H9"/><path d="M5 9a8 8 0 1 1-.6 6.2"/>',
  rotr: '<path d="M19.6 4.6v4.6H15"/><path d="M19 9a8 8 0 1 0 .6 6.2"/>',
  zoomin: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.8 4.8M10.6 7.8v5.6M7.8 10.6h5.6"/>',
  zoomout: '<circle cx="10.6" cy="10.6" r="6.4"/><path d="m15.4 15.4 4.8 4.8M7.8 10.6h5.6"/>',
  home: '<path d="M4 11.2 12 4.4l8 6.8"/><path d="M6.4 9.4v10.2h11.2V9.4"/><path d="M10.2 19.6v-5.2h3.6v5.2"/>',
  keyboard:
    '<rect x="2.8" y="6.4" width="18.4" height="11.2" rx="2.6"/><path d="M6.8 10h.01M10.2 10h.01M13.8 10h.01M17.2 10h.01M8 14h8"/>',
  bolt: '<path d="M13.2 2.8 5.6 13.4h6l-1 7.8 7.8-10.6h-6z" fill="currentColor" stroke="none"/>',
  arrow: '<path d="M4.5 12h14M13.5 7l5 5-5 5"/>',
  check: '<path d="m5.5 12.5 4.2 4.2 8.8-9.4"/>',
  alert: '<path d="M12 4.2 21 19.4H3z"/><path d="M12 10v4.2M12 16.9h.01"/>',
  pin: '<path d="M12 21s-6.5-6.1-6.5-11a6.5 6.5 0 0 1 13 0c0 4.9-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  route: '<circle cx="6" cy="18" r="2.4"/><circle cx="18" cy="6" r="2.4"/><path d="M8.4 18h6.1a3.5 3.5 0 0 0 0-7h-5a3.5 3.5 0 0 1 0-7h6.1"/>',
  calm: '<path d="M4 15.5c2.6 0 2.6-2.4 5.3-2.4s2.6 2.4 5.3 2.4 2.7-2.4 5.4-2.4"/><path d="M4 10.5c2.6 0 2.6-2.4 5.3-2.4s2.6 2.4 5.3 2.4 2.7-2.4 5.4-2.4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.8v2.2M12 19v2.2M2.8 12H5M19 12h2.2M5.5 5.5l1.6 1.6M16.9 16.9l1.6 1.6M5.5 18.5l1.6-1.6M16.9 7.1l1.6-1.6"/>',
  moon: '<path d="M19.6 14.6A7.6 7.6 0 0 1 9.4 4.4a7.6 7.6 0 1 0 10.2 10.2z"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};

export type IconName = keyof typeof P;

export function iconMarkup(name: string, size = 18, stroke = 1.7): string {
  const body = P[name] ?? P.site;
  return `<svg class="ym-i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

export function icon(name: string, size = 18, stroke = 1.7): SVGSVGElement {
  return svg(iconMarkup(name, size, stroke));
}

/** Swap the icon inside a host element when the name changes. */
export function setIcon(host: HTMLElement, name: string, size = 18, stroke = 1.7): void {
  if (host.dataset.icon === name) return;
  host.dataset.icon = name;
  host.replaceChildren(icon(name, size, stroke));
}

