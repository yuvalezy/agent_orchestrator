import { useCallback, useState } from 'react';
import { useAppData } from './AppData';
import type { DecideHandler } from './DecisionChips';
import type { Message } from './types';

export interface OptimisticDecide {
  /** What to paint as chosen: the server's answer if it has one, else the founder's tap. */
  decidedFor: (card: Message) => string | null;
  /** Decide with rollback — rethrows so the chips can surface the refusal. */
  decide: DecideHandler;
}

/**
 * Paint the founder's choice the instant they tap, confirm it with the server, and put the
 * card back exactly as it was if the call fails. Shared by Attention and Customer › Pending so
 * the two queues behave identically — and so this block exists once rather than twice.
 */
export function useOptimisticDecide(): OptimisticDecide {
  const { feed, refetchAttention } = useAppData();
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});

  const decide = useCallback(async (messageId: string, optionId: string) => {
    setOptimistic((m) => ({ ...m, [messageId]: optionId }));
    try {
      await feed.decide(messageId, optionId);
      refetchAttention();
    } catch (err) {
      setOptimistic((m) => { const next = { ...m }; delete next[messageId]; return next; });
      throw err;
    }
  }, [feed, refetchAttention]);

  const decidedFor = useCallback(
    (card: Message) => card.decidedOptionId ?? optimistic[card.id] ?? null,
    [optimistic],
  );

  return { decidedFor, decide };
}
