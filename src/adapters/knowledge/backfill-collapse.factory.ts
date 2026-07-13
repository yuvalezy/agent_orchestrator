import type { PendingProposal, CollapsedProposal } from '../../knowledge/backfill';
import { clusterByEmbedding, type EmbeddedItem } from '../../knowledge/proposal-collapse';
import type { SyncLogger } from '../../knowledge/sync';

// Sweep-wide proposal collapser (ADAPTER composition of the core clustering with an embedder). Two
// jobs, in order:
//   1. STRICT GATE — drop proposals below `minConfidence`. The classifier only reaches a `propose`
//      outcome for explicit work-request categories (bug/feature/custom-dev); the confidence floor
//      keeps only the ones it is sure about, so conversational asides don't become cards.
//   2. DEDUPE — embed each survivor's title+summary and greedily cluster near-duplicates; the
//      highest-confidence proposal in a cluster is the card, absorbing the rest (all their threads
//      are marked processed by the orchestrator). WhatsApp repeats the same ask many times; this is
//      what stops one subject from spawning a dozen cards.

export interface ProposalCollapserConfig {
  /** Confidence floor (0..1) a proposal must clear to become a card. */
  minConfidence: number;
  /** Cosine-distance ceiling under which two proposals are the "same" ask. */
  clusterMaxDistance: number;
}

export interface ProposalCollapserDeps {
  /** Best-effort single-text embed (null on failure — the item then can't be clustered, kept alone). */
  embedOne: (text: string) => Promise<number[] | null>;
  config: ProposalCollapserConfig;
  log?: SyncLogger;
}

const proposalText = (p: PendingProposal): string => `${p.outcome.title}. ${p.outcome.summary}`.trim();

export function buildProposalCollapser(
  deps: ProposalCollapserDeps,
): (pending: PendingProposal[], customerId: string) => Promise<CollapsedProposal[]> {
  return async (pending, customerId) => {
    // 1. Strict confidence gate.
    const gated = pending.filter((p) => p.outcome.confidence >= deps.config.minConfidence);
    const droppedByGate = pending.length - gated.length;

    // Highest-confidence first → it becomes each cluster's representative (the surviving card).
    const ordered = gated.slice().sort((a, b) => b.outcome.confidence - a.outcome.confidence);
    const byKey = new Map(ordered.map((p) => [p.thread.threadKey, p]));

    // 2. Embed for dedupe. An embed failure → the item can't cluster; keep it as its own singleton
    //    (never silently drop a real proposal because embedding hiccuped).
    const embedded: EmbeddedItem[] = [];
    const orphans: PendingProposal[] = [];
    for (const p of ordered) {
      const v = await deps.embedOne(proposalText(p));
      if (v) embedded.push({ key: p.thread.threadKey, embedding: v });
      else orphans.push(p);
    }

    const clusters = clusterByEmbedding(embedded, deps.config.clusterMaxDistance);
    const survivors: CollapsedProposal[] = clusters.map((c) => {
      const rep = byKey.get(c.repKey)!;
      const outcome =
        c.memberKeys.length > 1
          ? { ...rep.outcome, description: `${rep.outcome.description}\n\n_(Raised across ${c.memberKeys.length} chats/threads.)_` }
          : rep.outcome;
      return { thread: rep.thread, outcome, mergedThreadKeys: c.memberKeys };
    });
    for (const o of orphans) survivors.push({ thread: o.thread, outcome: o.outcome, mergedThreadKeys: [o.thread.threadKey] });

    deps.log?.info(
      {
        customerId,
        considered: pending.length,
        droppedByGate,
        clustered: embedded.length,
        orphans: orphans.length,
        cards: survivors.length,
      },
      'backfill proposal collapse complete',
    );
    return survivors;
  };
}
