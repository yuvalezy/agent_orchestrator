// Per-thread "armed capture" markers (M2c ✏️ Edit, 🔁 Revise, and the scheduling
// clarification). A marker means: "the founder's NEXT message in this topic is the
// answer to something we asked", so whichever marker is armed decides who consumes
// that message. Two invariants live here and nowhere else:
//
//  1. MUTUAL EXCLUSION — a thread holds AT MOST ONE armed capture. Arming any kind
//     CLEARS every other kind FIRST, so a crash between the two ops leaves NEITHER
//     armed (the founder retries — the safe direction) and never BOTH (a mis-consume).
//     This was previously a hard-coded edit/revise pair inlined in the callback-poller
//     factory; a third marker had to either join the invariant or silently break it.
//
//  2. TTL — an armed marker EXPIRES. Without one, an abandoned ✏️ Edit stays armed
//     forever (app_state is durable, and `updated_at` is never read), so the founder's
//     next unrelated message in that topic — hours later — is consumed as the draft
//     replacement and SENT VERBATIM TO THE CUSTOMER. Expiry is evaluated on read
//     against an injected clock, so an expired marker is indistinguishable from an
//     absent one to every caller.
//
// The store is injected rather than importing app_state directly: the ordering and
// expiry rules above are the whole point of this module, and they must be testable
// without a database.

export type MarkerKind = 'draft_edit' | 'draft_revise' | 'schedule';

export const MARKER_KINDS: MarkerKind[] = ['draft_edit', 'draft_revise', 'schedule'];

const MARKER_KEY_PREFIX: Record<MarkerKind, string> = {
  draft_edit: 'draft_edit_pending',
  draft_revise: 'draft_revise_pending',
  schedule: 'schedule_pending',
};

export const markerKey = (kind: MarkerKind, threadId: string): string =>
  `${MARKER_KEY_PREFIX[kind]}:${threadId}`;

/** 30 min: long enough for the founder to finish a thought they started, short enough
 *  that a forgotten prompt cannot ambush a later unrelated message. */
export const MARKER_TTL_MS = 30 * 60_000;

interface StoredMarker {
  v: 1;
  value: string;
  armedAt: number;
}

export interface MarkerStore {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  clear: (key: string) => Promise<void>;
}

export interface ThreadMarkers {
  arm: (kind: MarkerKind, threadId: string, value: string) => Promise<void>;
  read: (kind: MarkerKind, threadId: string) => Promise<string | null>;
  clear: (kind: MarkerKind, threadId: string) => Promise<void>;
}

export function buildThreadMarkers(store: MarkerStore, now: () => Date): ThreadMarkers {
  const arm: ThreadMarkers['arm'] = async (kind, threadId, value) => {
    // Clear-then-set, and clear EVERY other kind — see invariant 1.
    for (const other of MARKER_KINDS) {
      if (other !== kind) await store.clear(markerKey(other, threadId));
    }
    const stored: StoredMarker = { v: 1, value, armedAt: now().getTime() };
    await store.set(markerKey(kind, threadId), JSON.stringify(stored));
  };

  const read: ThreadMarkers['read'] = async (kind, threadId) => {
    const key = markerKey(kind, threadId);
    const raw = await store.get(key);
    if (raw === null) return null;

    let parsed: StoredMarker | null = null;
    try {
      const candidate = JSON.parse(raw) as Partial<StoredMarker>;
      if (candidate && candidate.v === 1 && typeof candidate.value === 'string' && typeof candidate.armedAt === 'number') {
        parsed = candidate as StoredMarker;
      }
    } catch {
      // Not JSON → a pre-TTL marker (a bare queueId) armed before this shipped. Its
      // age is unknowable, and an unknown-age marker is exactly what invariant 2
      // exists to stop, so drop it: the founder re-taps ✏️ Edit at worst.
    }
    if (!parsed) {
      await store.clear(key);
      return null;
    }
    if (now().getTime() - parsed.armedAt >= MARKER_TTL_MS) {
      await store.clear(key);
      return null;
    }
    return parsed.value;
  };

  const clear: ThreadMarkers['clear'] = async (kind, threadId) => {
    await store.clear(markerKey(kind, threadId));
  };

  return { arm, read, clear };
}
