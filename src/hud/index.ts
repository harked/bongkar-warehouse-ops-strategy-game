/**
 * Yardmaster HUD: a strategy-game overlay of glass panels around the 3D world.
 *
 *   top-left      site crest (banner + medallion tokens)
 *   top-centre    pulse strip (segmented KPIs)
 *   top-right     sun dial (day arc, time, speed control)
 *   left          roster drawer (docks / forklifts / trucks), event ticker below
 *   right         unit card hanging under the portrait lens
 *   bottom-centre shipment rail
 *   bottom-right  camera keys + keyboard hints
 *
 * Plain DOM, created once and diffed on every render. Add `?hudmock` to the URL to drive the
 * HUD from a rich animated mock instead of the live simulation.
 */
import './hud.css';
import type { CreateHud } from '../core/contracts';
import type { AppCommands, EntityRef, HudSnapshot, SiteSummary } from '../core/types';
import type { Ctx } from './ctx';
import { el } from './dom';
import { createMock } from './mock';
import { CamKeys } from './panels/camkeys';
import { UnitCard } from './panels/card';
import { Clock } from './panels/clock';
import { Crest } from './panels/crest';
import { Pulse } from './panels/pulse';
import { Rail } from './panels/rail';
import { Roster } from './panels/roster';
import { Ticker } from './panels/ticker';
import { WorldTag } from './panels/worldtag';

export const createHud: CreateHud = (root, realCommands) => {
  const mockMode = new URLSearchParams(location.search).has('hudmock');
  const mock = mockMode ? createMock() : null;
  let mockSel: EntityRef | null = null;
  let lastReal: HudSnapshot | null = null;

  // In mock mode the HUD keeps its own selection (the live sim does not know mock entities),
  // while still forwarding every command so the camera, speed and site switching stay real.
  const commands: AppCommands = mockMode
    ? {
        ...realCommands,
        select(ref) {
          mockSel = ref;
          realCommands.select(ref);
          if (lastReal) render(lastReal);
        },
      }
    : realCommands;
  if (mockMode) {
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape' && mockSel) {
        mockSel = null;
        if (lastReal) render(lastReal);
      }
    });
    (window as unknown as { __hud: unknown }).__hud = {
      select: (kind: EntityRef['kind'], id: string) => commands.select({ kind, id }),
      snapshot: () => lastSnap,
    };
  }

  root.classList.add('ym-hud');
  if (mockMode) root.classList.add('is-mock');

  let ctx: Ctx = {
    cmds: commands,
    snap: emptySnapshot(),
    selKey: '',
    selected: null,
    site: null,
    sites: new Map(),
    network: true,
  };
  const getCtx = () => ctx;

  const crest = new Crest(getCtx);
  const pulse = new Pulse();
  const clock = new Clock(getCtx);
  const roster = new Roster(getCtx);
  const ticker = new Ticker();
  const card = new UnitCard(getCtx);
  const rail = new Rail(getCtx);
  const cam = new CamKeys(getCtx);
  const tag = new WorldTag();

  const left = el('div', 'ym-col ym-col--left', root);
  left.append(crest.el, roster.el, ticker.el);
  const top = el('div', 'ym-top', root);
  top.append(pulse.el);
  const right = el('div', 'ym-col ym-col--right', root);
  right.append(clock.el, card.el);
  const bottom = el('div', 'ym-bottom', root);
  bottom.append(rail.el);
  root.append(cam.el, tag.el);

  // Hovering the shipment link on the card lights up the rail.
  root.addEventListener('ym-ship-hover', (e) => rail.el.classList.toggle('is-lit', (e as CustomEvent<boolean>).detail));

  let lastSnap: HudSnapshot | null = null;

  function render(real: HudSnapshot): void {
    lastReal = real;
    const snap = mock ? mock.snapshot(real, mockSel) : real;
    if (mock && mockSel && !snap.selection) mockSel = null;
    lastSnap = snap;
    const sites = new Map<string, SiteSummary>();
    for (const s of snap.sites) sites.set(s.id, s);
    const selected = snap.selection?.ref ?? null;
    const site = snap.activeSiteId !== 'network' ? (sites.get(snap.activeSiteId) ?? null) : null;
    ctx = {
      cmds: commands,
      snap,
      selKey: selected ? `${selected.kind}:${selected.id}` : '',
      selected,
      site,
      sites,
      network: !site,
    };
    root.dataset.site = site ? site.kind : 'network';
    crest.update(ctx);
    pulse.update(ctx);
    clock.update(ctx);
    roster.update(ctx);
    ticker.update(ctx);
    card.update(ctx);
    rail.update(ctx);
    tag.setTone(snap.selection?.statusTone ?? 'neutral');
    if (mock) {
      // The live scene cannot place mock units, so park the tag where a unit would plausibly be.
      tag.set(window.innerWidth * 0.56, window.innerHeight * 0.44, snap.selection?.title ?? '', !!snap.selection);
    }
  }

  return {
    render,
    portraitCanvas: () => card.portrait(),
    setWorldTag(t) {
      if (mock) return;
      tag.set(t.x, t.y, t.text, t.visible);
    },
  };
};

function emptySnapshot(): HudSnapshot {
  return {
    clock: { seconds: 0, label: '--:--', dayLabel: '', speed: 1, paused: false },
    activeSiteId: 'network',
    network: { trucksInTransit: 0, shipmentsOpen: 0, shipmentsDoneToday: 0, onTime: 1, palletsMovedToday: 0 },
    sites: [],
    docks: [],
    forklifts: [],
    trucks: [],
    shipments: [],
    events: [],
    selection: null,
  };
}
