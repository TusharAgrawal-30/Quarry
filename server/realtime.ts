import { EventEmitter } from 'node:events';

// Live collaboration plumbing: a process-wide change bus plus per-issue
// presence with TTL. Delivered to clients over a single SSE stream —
// chosen over WebSockets because every event here flows server → client,
// SSE reconnects for free via the browser, and it needs zero extra
// dependencies or protocol upgrades through proxies.

export interface ChangeEvent {
  type: 'issue_changed';
  key: string;
  actorId: number;
  kind: string; // transition | comment | edit | relation | watch
  at: string;
}

export interface PresenceEvent {
  type: 'presence';
  key: string;
  viewers: number[];
}

export type LiveEvent = ChangeEvent | PresenceEvent;

const PRESENCE_TTL_MS = 40_000;

export class Realtime {
  private bus = new EventEmitter();
  private viewers = new Map<string, Map<number, number>>(); // key -> actorId -> lastSeen

  constructor() {
    this.bus.setMaxListeners(200);
  }

  publishChange(key: string, actorId: number, kind: string): void {
    const ev: ChangeEvent = { type: 'issue_changed', key, actorId, kind, at: new Date().toISOString() };
    this.bus.emit('event', ev);
  }

  touchPresence(key: string, actorId: number): number[] {
    let m = this.viewers.get(key);
    if (!m) {
      m = new Map();
      this.viewers.set(key, m);
    }
    m.set(actorId, Date.now());
    const list = this.currentViewers(key);
    this.bus.emit('event', { type: 'presence', key, viewers: list } satisfies PresenceEvent);
    return list;
  }

  leave(key: string, actorId: number): void {
    const m = this.viewers.get(key);
    if (!m) return;
    m.delete(actorId);
    this.bus.emit('event', { type: 'presence', key, viewers: this.currentViewers(key) } satisfies PresenceEvent);
  }

  currentViewers(key: string): number[] {
    const m = this.viewers.get(key);
    if (!m) return [];
    const now = Date.now();
    for (const [actor, seen] of m) if (now - seen > PRESENCE_TTL_MS) m.delete(actor);
    return [...m.keys()];
  }

  subscribe(fn: (ev: LiveEvent) => void): () => void {
    this.bus.on('event', fn);
    return () => this.bus.off('event', fn);
  }
}
