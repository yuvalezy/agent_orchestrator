import { createContext, useCallback, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { api } from './lib/api';
import { useFeed, type Feed } from './useFeed';
import type { AppConfig, Attention } from './types';

interface AppDataValue {
  config: AppConfig | null;
  deviceLabel: string;
  feed: Feed;
  attention: Attention | null;
  attentionLoading: boolean;
  refetchAttention: () => void;
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

  return (
    <Ctx.Provider value={{ config, deviceLabel, feed, attention, attentionLoading, refetchAttention: () => void loadAttention() }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppData(): AppDataValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useAppData must be used within AppDataProvider');
  return value;
}

export function useFeedContext(): Feed {
  return useAppData().feed;
}
