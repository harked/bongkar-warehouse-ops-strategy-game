import type { EntityRef, FeedEvent, Tone } from '../core/types';

/** Rolling event feed (newest first). */
export class Feed {
  readonly events: FeedEvent[] = [];
  private nextId = 1;
  push(t: number, text: string, tone: Tone, siteId?: string, ref?: EntityRef): void {
    this.events.unshift({ id: this.nextId++, t, text, tone, siteId, ref });
    if (this.events.length > 40) this.events.length = 40;
  }
}
