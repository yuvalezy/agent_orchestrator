import { type RefObject, useLayoutEffect, useRef } from 'react';

/** Still "following the thread" — a new line scrolls into view instead of waiting. */
const NEAR_BOTTOM_PX = 80;
/** Close enough to the top that the previous page should already be on its way. */
const LOAD_OLDER_PX = 120;

export interface ThreadScrollInput {
  /** How many rows are rendered, ASCENDING (oldest→newest). */
  count: number;
  /** Id of the newest rendered row; a change means a new line arrived at the bottom. */
  lastKey: string | null;
  hasMore: boolean;
  /** An older page is already in flight — don't ask for another. */
  loading: boolean;
  onLoadOlder: () => void;
  /** A row to reveal instead of the bottom. Attach `focusRef` to it; when it is not
   *  rendered (e.g. it lives in a page we haven't loaded) the bottom wins, silently. */
  focusKey?: string | null;
}

export interface ThreadScroll {
  /** The scroll container (`h-full overflow-y-auto`). */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** A zero-height sentinel rendered after the last row. */
  bottomRef: RefObject<HTMLDivElement | null>;
  /** Attach to the row matching `focusKey`, if it is rendered. */
  focusRef: RefObject<HTMLDivElement | null>;
  onScroll: () => void;
  /** The explicit "Load earlier" affordance; pins the viewport like the scroll trigger does. */
  loadOlder: () => void;
}

/**
 * Chat-thread scroll orchestration for an ascending list that pages BACKWARDS: jump to the
 * bottom on first paint, keep the viewport pinned when older history is prepended (otherwise
 * the reader is thrown up the thread mid-read), and follow new lines only when already at the
 * bottom.
 *
 * Extracted from the orchestration proven in `ChatFeed`, which can adopt it in its own right —
 * it is deliberately told nothing about messages, only about counts and keys.
 */
export function useThreadScroll({
  count,
  lastKey,
  hasMore,
  loading,
  onLoadOlder,
  focusKey = null,
}: ThreadScrollInput): ThreadScroll {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  const atBottom = useRef(true);
  const prevLastKey = useRef<string | null>(null);
  const prevCount = useRef(0);
  /** scrollHeight captured just before an older page lands — the pin's anchor. */
  const prependAnchor = useRef<number | null>(null);
  const revealed = useRef<string | null>(null);

  useLayoutEffect(() => {
    const node = scrollRef.current;
    const firstPaint = prevCount.current === 0 && count > 0;

    if (focusKey && focusKey !== revealed.current && focusRef.current) {
      // A card pointed at this exact row: it, not the bottom, is what was asked for.
      focusRef.current.scrollIntoView({ behavior: firstPaint ? 'auto' : 'smooth', block: 'center' });
      revealed.current = focusKey;
    } else if (firstPaint) {
      bottomRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    } else if (prependAnchor.current !== null && node) {
      node.scrollTop += node.scrollHeight - prependAnchor.current;
    } else if (lastKey && lastKey !== prevLastKey.current && atBottom.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }

    prependAnchor.current = null;
    prevLastKey.current = lastKey;
    prevCount.current = count;
  }, [count, lastKey, focusKey]);

  const loadOlder = (): void => {
    if (!hasMore || loading) return;
    const node = scrollRef.current;
    if (node) prependAnchor.current = node.scrollHeight;
    onLoadOlder();
  };

  const onScroll = (): void => {
    const node = scrollRef.current;
    if (!node) return;
    atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
    if (node.scrollTop <= LOAD_OLDER_PX) loadOlder();
  };

  return { scrollRef, bottomRef, focusRef, onScroll, loadOlder };
}
