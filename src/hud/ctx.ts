import type { AppCommands, EntityRef, HudSnapshot, SiteSummary } from '../core/types';

/** Shared per-render state that panels read. Rebuilt cheaply on every render. */
export interface Ctx {
  cmds: AppCommands;
  snap: HudSnapshot;
  /** `${kind}:${id}` of the selection, or '' */
  selKey: string;
  selected: EntityRef | null;
  site: SiteSummary | null;
  sites: Map<string, SiteSummary>;
  /** True when rosters should list every site (network overview). */
  network: boolean;
}

