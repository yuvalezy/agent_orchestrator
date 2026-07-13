import type { HistoricalThread } from '../knowledge/backfill';

// History-source port (backfill L2 input). The orchestrator (runBackfill) depends ONLY on this
// contract; concrete readers (WhatsApp group history, Gmail threads) live in the adapter layer.
// Readers are READ-ONLY — they never mutate the channel; a read error for one customer must not
// abort the sweep (return what is readable, log the rest).

export interface HistorySourcePort {
  /** Every readable historical thread for a customer, normalized for reconciliation. */
  readThreads(customerId: string): Promise<HistoricalThread[]>;
}
