import { EventEmitter } from 'node:events';
import type { FeedMessage } from './founder-app-repo';

// In-process live feed for the AO Founder PWA (M6). Both surfaces that append a row —
// the AppFounderNotifier (mirrored notifications/questions) and the chat POST handler —
// publish here; the SSE endpoint (GET /app/api/events) subscribes. A single founder on
// a couple of devices means an in-process emitter is sufficient; a horizontally-scaled
// deployment would swap this for a pub/sub channel behind the same interface.

export class FounderAppFeed {
  private readonly emitter = new EventEmitter();

  constructor() {
    // A founder with a few devices, each holding one EventSource, can exceed Node's
    // default 10-listener warning without anything being wrong.
    this.emitter.setMaxListeners(0);
  }

  /** Announce a newly persisted feed row to every open SSE stream. */
  publish(message: FeedMessage): void {
    this.emitter.emit('message', message);
  }

  /** Subscribe an SSE stream; returns an unsubscribe fn to call on connection close. */
  subscribe(listener: (message: FeedMessage) => void): () => void {
    this.emitter.on('message', listener);
    return () => this.emitter.off('message', listener);
  }
}
