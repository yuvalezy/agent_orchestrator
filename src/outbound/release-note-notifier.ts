import { logger } from '../logger';
import type { AgentLlmPort, KnowledgeChunk } from '../ports/llm.port';
import type { EmbeddingPort } from '../ports/embedding.port';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { CustomerHistoryMatch, HistoryMatchOptions } from '../knowledge/memory-repo';
import type { CustomerConfig } from '../triage/context-loader';
import { renderCitations } from '../triage/response-drafter';
import { draftButtons } from '../triage/draft-review';
import type { enqueueDraft } from './outbound-repo';
import type { PrimaryChannel } from './release-note-repo';
import type { recordReleaseNoteDraftDecision } from '../decisions/decisions';

// M2(e) release-note → customer notification drafter (CORE — injected ports + core repo
// fns only, imports NO adapter, D1). On ingest of a release note it: embeds the note,
// finds customers whose task/conversation history semantically matches (the confidence
// gate is memoryRepo.matchCustomersByHistory's maxDistance), and for each NOT-already-
// notified customer drafts ONE personalized, CITED notification in their language on
// their primary channel → enqueues is_draft=true (NEVER auto-sent) → presents via the
// SAME Telegram approve/edit/reject flow (draftButtons + the existing draft-review
// handlers, which are keyed by queueId, not by an inbox message). Idempotent: the
// ledger claim (claimNotification) means re-ingesting the same note never re-drafts.
// NEVER logs the draft body, the customer history, or the vectors — ids/counts only.

/** One release note handed to the notifier (already read from its source). */
export interface ReleaseNote {
  /** Stable identity = the idempotency key (its docKey / path). */
  key: string;
  title: string;
  /** Full note text — the single grounding source the cited draft is written from. */
  content: string;
  /** Optional note language (unused by the draft; the reply language is the customer's). */
  language?: string;
}

export interface ReleaseNoteNotifierConfig {
  /** Confidence gate — a customer whose nearest history row is beyond this cosine
   *  distance is NOT notified (tight by design; a spurious notification erodes trust). */
  matchMaxDistance: number;
  /** Cap on customers drafted per note (nearest-first). */
  maxCustomers: number;
  /** memory_types that count as customer "history" for the match. */
  memoryTypes: string[];
}

export interface ReleaseNoteNotifierDeps {
  embedding: EmbeddingPort;
  /** Cross-customer semantic match (memoryRepo.matchCustomersByHistory). */
  matchCustomers: (embedding: number[], opts: HistoryMatchOptions) => Promise<CustomerHistoryMatch[]>;
  /** Idempotency claim — true iff THIS call claimed the (note, customer) slot. */
  claimNotification: (releaseNoteKey: string, customerId: string) => Promise<boolean>;
  /** Stamp the claimed ledger row with the produced draft ids (best-effort). */
  finalizeNotification: (
    releaseNoteKey: string,
    customerId: string,
    ref: { decisionId: string; queueId: string; matchDistance: number },
  ) => Promise<void>;
  loadCustomerConfig: (customerId: string) => Promise<Pick<CustomerConfig, 'displayName' | 'preferredLanguage'> | null>;
  resolvePrimaryChannel: (customerId: string) => Promise<PrimaryChannel | null>;
  llm: Pick<AgentLlmPort, 'draftReply'>;
  enqueueDraft: typeof enqueueDraft;
  recordDraftDecision: typeof recordReleaseNoteDraftDecision;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  config: ReleaseNoteNotifierConfig;
}

/** Per-note outcome (counts only — never bodies). */
export interface ReleaseNoteNotifyResult {
  matched: number;
  drafted: number;
  skipped: number; // already notified (idempotent) OR unresolvable channel/config
  failed: number;
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface ReleaseNoteNotifier {
  /** Draft personalized notifications for every customer whose history matches `note`.
   *  Idempotent per (note, customer). Per-customer isolation: one failure is counted
   *  and the loop continues. */
  notifyForReleaseNote(note: ReleaseNote): Promise<ReleaseNoteNotifyResult>;
}

/** Title on every release-note draft presentation. */
const PRESENT_TITLE = '📣 Release-note notification — needs approval';

export function buildReleaseNoteNotifier(deps: ReleaseNoteNotifierDeps): ReleaseNoteNotifier {
  return {
    async notifyForReleaseNote(note: ReleaseNote): Promise<ReleaseNoteNotifyResult> {
      const result: ReleaseNoteNotifyResult = { matched: 0, drafted: 0, skipped: 0, failed: 0 };

      const text = `${note.title}\n\n${note.content}`.trim();
      if (!text) return result; // nothing to embed

      const [embedding] = await deps.embedding.embed([text]);
      if (!embedding || embedding.length === 0) return result;

      const matches = await deps.matchCustomers(embedding, {
        maxDistance: deps.config.matchMaxDistance,
        limit: deps.config.maxCustomers,
        memoryTypes: deps.config.memoryTypes,
      });
      result.matched = matches.length;

      // The release note is the single grounding source for the cited draft.
      const knowledge: KnowledgeChunk[] = [
        { content: note.content, title: note.title, route: null, section: null, distance: 0 },
      ];

      for (const match of matches) {
        try {
          // (1) Idempotency claim FIRST — re-ingesting the same note skips here.
          const claimed = await deps.claimNotification(note.key, match.customerId);
          if (!claimed) {
            result.skipped += 1;
            logger.info({ noteKey: note.key, customerId: match.customerId }, 'release-note: already notified — skipped (idempotent)');
            continue;
          }

          const config = await deps.loadCustomerConfig(match.customerId);
          const channel = await deps.resolvePrimaryChannel(match.customerId);
          if (!config || !channel) {
            // Claimed but unresolvable → skip (at-most-once; the ledger row simply
            // never carries a draft). NEVER fall back to an unknown recipient.
            result.skipped += 1;
            logger.warn(
              { noteKey: note.key, customerId: match.customerId, hasConfig: !!config, hasChannel: !!channel },
              'release-note: customer config/channel unresolved — skipped (claimed, no draft)',
            );
            continue;
          }

          // (2) Draft a personalized, cited notification grounded ONLY in the release
          // note, framed around THIS customer's original request (the matched excerpt).
          const drafted = await deps.llm.draftReply({
            question: notificationDirective(match.excerpt),
            language: config.preferredLanguage,
            customerName: config.displayName,
            knowledge,
          });
          const citations = renderCitations(knowledge, drafted.usedSourceIndexes);

          // (3) Audit decision (draft_reply, inbox NULL) → (4) enqueue draft (pending,
          // is_draft=true — NEVER drained) linked to it → (5) stamp the ledger.
          const { decisionId } = await deps.recordDraftDecision({
            customerId: match.customerId,
            agentOutput: {
              kind: 'release_note',
              release_note_key: note.key,
              title: note.title,
              draft_body: drafted.body,
              citations,
              language: config.preferredLanguage,
            },
          });
          const queueId = await deps.enqueueDraft({
            channelInstanceId: channel.channelInstanceId,
            channelType: channel.channelType,
            recipientAddress: channel.recipientAddress,
            body: drafted.body,
            subject: channel.channelType === 'email' ? note.title : undefined,
            customerId: match.customerId,
            decisionId,
          });
          await deps.finalizeNotification(note.key, match.customerId, { decisionId, queueId, matchDistance: match.distance });

          // (6) Present with citations + Approve/Edit/Reject (the existing draft-review
          // handlers act on it by queueId — nothing release-note-specific downstream).
          await deps.notifier.notifyCustomerEvent(
            match.customerId,
            { ...buildPresentation(drafted.body, citations, config.preferredLanguage), contextRef: { kind: 'outbound', ref: queueId } },
            draftButtons(queueId),
          );

          result.drafted += 1;
          logger.info(
            { noteKey: note.key, customerId: match.customerId, queueId, decisionId, citations: citations.length },
            'release-note: personalized cited draft enqueued (pending) — presenting for approval',
          );
        } catch (err) {
          // ⚠︎ per-customer isolation: count + continue (never the body/excerpt/vector).
          result.failed += 1;
          logger.warn({ noteKey: note.key, customerId: match.customerId, reason: errMessage(err) }, 'release-note: customer draft failed');
        }
      }

      logger.info({ noteKey: note.key, ...result }, 'release-note notify complete');
      return result;
    },
  };
}

/** The `question` handed to the draft role: instruct a proactive, grounded notification
 *  personalized on the customer's original request. The draft is written ONLY from the
 *  release note (the numbered source), so the citation is real, not hallucinated. */
export function notificationDirective(historyExcerpt: string): string {
  return [
    'This is a PROACTIVE product update — the customer did not just message you.',
    'They previously reached out about the following:',
    `"${historyExcerpt}"`,
    '',
    'A new update (the release note below) is relevant to that request. Write a short,',
    'warm notification letting them know what is now available and how it helps with what',
    'they asked about. Reference their original request naturally. Stay strictly within the',
    'facts in the release note — do not promise anything not stated there.',
  ].join('\n');
}

/** Founder-facing presentation: draft body + "Based on:" citations + reply language. */
function buildPresentation(body: string, citations: string[], language: string): Notification {
  const lines: string[] = [body];
  if (citations.length > 0) lines.push('', 'Based on:', ...citations.map((c) => `- ${c}`));
  lines.push('', `Language: ${language}`);
  return { title: PRESENT_TITLE, body: lines.join('\n'), severity: 'action' };
}
