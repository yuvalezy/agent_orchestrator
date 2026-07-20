import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { api } from './lib/api';
import { useFeed, type Feed } from './useFeed';
import type { AppConfig, Attention, AttentionCard, Message } from './types';

interface AppDataValue {
  config: AppConfig | null;
  deviceLabel: string;
  feed: Feed;
  attention: Attention | null;
  attentionLoading: boolean;
  refetchAttention: () => void;
  /** Acknowledge a card ("I've seen this") — it leaves the queue here and stays gone.
   *  Rejects on a 409 (a `question` must be answered, not dismissed) with the queue restored. */
  dismiss: (messageId: string) => Promise<void>;
  /** Abandon a meeting "wants to talk" / "pick a time" question with NO task — the meeting-specific
   *  dismiss the plain `/dismiss` route refuses (it's a `question`). Same optimistic-drop-then-settle
   *  behaviour as `dismiss`, against POST /meeting/:messageId/dismiss. */
  dismissMeeting: (messageId: string) => Promise<void>;
}

/** The server dismisses by `notification_ref`, because several rows legitimately mirror ONE
 *  thing (the re-confirm notification reuses the original's ref). The queue has to drop the
 *  same set, or the founder taps Dismiss and watches a duplicate stay behind. */
function sameThing(row: AttentionCard, target: AttentionCard): boolean {
  return row.id === target.id || (target.notificationRef !== null && row.notificationRef === target.notificationRef);
}

const Ctx = createContext<AppDataValue | null>(null);

/** One place owns the single SSE feed and the attention queue; every screen and the tab
 *  badge read from here so there's exactly one event stream and one source of truth. */
export function AppDataProvider({
  config,
  deviceLabel,
  children,
}: {
  config: AppConfig | null;
  deviceLabel: string;
  children: ReactNode;
}): ReactElement {
  const feed = useFeed();
  const [attention, setAttention] = useState<Attention | null>(null);
  const [attentionLoading, setAttentionLoading] = useState(true);

  const loadAttention = useCallback(async () => {
    try {
      setAttention(await api<Attention>('/attention'));
    } catch {
      /* transient — keep the last good queue rather than blanking the screen */
    } finally {
      setAttentionLoading(false);
    }
  }, []);

  // Refetch the queue on first mount and whenever the world changes (any live row).
  useEffect(() => { void loadAttention(); }, [loadAttention, feed.eventToken]);

  // Drop the card from the queue the instant the founder taps, fire the given request, and settle
  // from the server (which also re-publishes the affected rows over SSE); on failure, roll the queue
  // back. Shared by the plain dismiss and the meeting-specific dismiss so both behave identically.
  const removeFromQueue = useCallback(async (messageId: string, send: () => Promise<unknown>) => {
    const snapshot = attention;
    const target = attention?.decisions.find((card) => card.id === messageId) ?? null;
    if (target) {
      setAttention((current) => current && { ...current, decisions: current.decisions.filter((card) => !sameThing(card, target)) });
    }
    try {
      await send();
      void loadAttention();
    } catch (err) {
      if (target) setAttention(snapshot);
      throw err;
    }
  }, [attention, loadAttention]);

  const dismiss = useCallback(
    (messageId: string) => removeFromQueue(messageId, () => api<{ data: Message[] }>('/dismiss', { method: 'POST', body: JSON.stringify({ messageId }) })),
    [removeFromQueue],
  );

  const dismissMeeting = useCallback(
    (messageId: string) => removeFromQueue(messageId, () => api<{ data: { status: string } }>(`/meeting/${encodeURIComponent(messageId)}/dismiss`, { method: 'POST' })),
    [removeFromQueue],
  );

  return (
    <Ctx.Provider value={{ config, deviceLabel, feed, attention, attentionLoading, refetchAttention: () => void loadAttention(), dismiss, dismissMeeting }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppData(): AppDataValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAppData must be used within AppDataProvider');
  return value;
}

/** For leaves that *may* render outside the data layer (a bubble in CustomerAsk's local thread,
 *  a card in an isolated test): the actions they'd reach for are simply not offered. */
export function useOptionalAppData(): AppDataValue | null {
  return useContext(Ctx);
}

export function useFeedContext(): Feed {
  return useAppData().feed;
}
