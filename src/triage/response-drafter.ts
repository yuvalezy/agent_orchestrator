import type { AgentLlmPort, DraftRequest, DraftResult, DraftReviserPort, DraftVerdict, DraftVerifierPort, Intent, KnowledgeChunk, ReviseRequest, VerifyDraftRequest } from '../ports/llm.port';
import type { RecipientGender, RecipientProfilePort } from '../ports/recipient-profile.port';
import type { FounderNotifierPort, Notification } from '../ports/founder-notifier.port';
import type { ClaimedInbox } from '../inbox/inbox-repo';
import type { CustomerConfig } from './context-loader';
import type { enqueueDraft, findOpenDraftByInbox, OpenDraftForInbox } from '../outbound/outbound-repo';
import type { recordDraftDecision } from '../decisions/decisions';
import type { StyleLane } from '../knowledge/style-lane';
import type { MeetingContext } from './meeting-context';
import type { CustomerBriefLoader } from '../knowledge/customer-brief';
import { logger } from '../logger';
import { draftButtons } from './draft-review';

// Response drafter (change 02 sub-milestone c, CORE — injected ports + core repo fns
// only, imports NO adapter, D1). For an ANSWERABLE 'question_existing' intent:
// draft a cited reply in the customer's language (LLM 'draft' role), enqueue it as a
// DRAFT (is_draft=true → NEVER auto-sent), record the audit decision, and present it
// in the customer's Telegram topic with citations + Approve/Edit/Reject controls.
// NO draft is ever delivered without founder action.
//
// Reclaim idempotency (blueprint must-fix #1): a prior attempt that failed AT/AFTER
// the notify is reclaimed by the inbox worker. draftAndPresent (and the R49-analog
// reconfirmOpenDraft) FIRST look up an existing OPEN draft for this inbox message and
// re-present it instead of minting a second customer-facing draft. Never logs the
// draft body or the customer message — ids/counts/status only.

export interface ResponseDrafterDeps {
  llm: Pick<AgentLlmPort, 'draftReply'>;
  notifier: Pick<FounderNotifierPort, 'notifyCustomerEvent'>;
  enqueueDraft: typeof enqueueDraft;
  recordDraftDecision: typeof recordDraftDecision;
  findOpenDraftByInbox: typeof findOpenDraftByInbox;
  /** Append the 🔁 Revise button under presented drafts (Draft correction loop). Set by the
   *  composition root from DRAFT_REVISE_ENABLED (default false → the original three buttons). */
  reviseEnabled?: boolean;
  /** Style-Correction Always-On lane (gated STYLE_LANE_ENABLED). When set, ALL of the customer's
   *  active style/tone corrections are pulled on EVERY draft (not embedding-gated) and injected as
   *  persistent voice guidance — a DIRECTIVE, never a citation source. Undefined → no voice lane. */
  styleLane?: StyleLane;
  /** Upcoming-meetings context (gated CALENDAR_ENABLED). When set, the drafted customer's upcoming
   *  meetings are pulled from the founder's calendar on every draft and injected as draft CONTEXT
   *  (best-effort → [] on miss) — never a citation source. Undefined → no meetings context. */
  meetings?: MeetingContext;
  /** WP6 relationship-brief loader (gated CUSTOMER_BRIEF_ENABLED). When set, the customer's live
   *  brief is pulled on every draft and injected as draft CONTEXT (best-effort → null on miss) —
   *  never a citation source. Undefined → no brief context. */
  brief?: CustomerBriefLoader;
  /** Recipient grammatical gender lookup. In a gendered language a reply must agree with the
   *  person; with `preferred_language='es'` and no gender the model can only hedge
   *  ("Bienvenido/a"). Best-effort by contract → null just means neutral phrasing.
   *  Undefined → never looked up. */
  recipientProfile?: RecipientProfilePort;
  /** Draft self-critique (gated DRAFT_VERIFIER_ENABLED). When set, EVERY draft is graded before it
   *  is presented; the verdict is persisted on the decision row and annotated on the founder
   *  notification. BEST-EFFORT — a throw never blocks/delays the draft. Undefined → no verification
   *  (byte-identical prior behavior). */
  verifier?: DraftVerifierPort;
  /** One-shot auto-revise (used only WITH `verifier`): on a FAILING verdict, regenerate the draft
   *  once from the failure details before presenting (the founder still approves). Undefined → a
   *  failing verdict is annotated but the original draft is presented as-is. */
  reviser?: DraftReviserPort;
}

export interface DraftAndPresentInput {
  row: ClaimedInbox;
  customerId: string;
  config: Pick<CustomerConfig, 'displayName' | 'preferredLanguage'>;
  threadKey: string;
  /** Non-empty — the caller gates on knowledge.length > 0. */
  knowledge: KnowledgeChunk[];
  intent: Intent;
  /** Module scoping (C): the portal modules this customer uses. Draft CONTEXT — the reply must
   *  never attribute behavior to a module NOT listed. Empty/absent = unscoped (uses everything). */
  activeModules?: string[];
}

export interface ResponseDrafter {
  /**
   * Draft → enqueue (is_draft=true) → record decision → present with citations +
   * Approve/Edit/Reject buttons. Idempotent under reclaim: re-presents an existing
   * open draft for `input.row.id` instead of re-drafting.
   */
  draftAndPresent(input: DraftAndPresentInput): Promise<void>;
  /**
   * R49-analog reclaim guard (called from tryR49Reconfirm BEFORE the LLM re-extract):
   * if this inbox message already has an OPEN draft, re-present it and return true;
   * else false. Keeps a reclaimed answerable question from minting a second draft.
   */
  reconfirmOpenDraft(inboxMessageId: string): Promise<boolean>;
}

export function buildResponseDrafter(deps: ResponseDrafterDeps): ResponseDrafter {
  /** Present (or re-present) an open draft in the customer's topic with citations +
   *  Approve/Edit/Reject controls. Body is never logged. */
  async function present(
    customerId: string,
    queueId: string,
    body: string,
    citations: string[],
    language: string,
    original?: string,
    inboxMessageId?: string,
    verifierNote?: string,
  ): Promise<void> {
    const presentation = buildPresentation(body, citations, language, original, verifierNote);
    if (inboxMessageId) presentation.contextRef = { kind: 'inbox', ref: inboxMessageId };
    await deps.notifier.notifyCustomerEvent(
      customerId,
      presentation,
      draftButtons(queueId, { revise: deps.reviseEnabled }),
    );
  }

  /** Re-present an existing OPEN draft (reclaim idempotency, must-fix #1) — reuses the
   *  linked decision's stored citations/language so we NEVER re-invoke the LLM. */
  async function represent(existing: OpenDraftForInbox, inboxMessageId: string): Promise<void> {
    const { citations, language } = readDraftMeta(existing.agentOutput);
    await present(existing.customerId ?? '', existing.queueId, existing.body, citations, language, undefined, inboxMessageId);
  }

  return {
    async draftAndPresent(input: DraftAndPresentInput): Promise<void> {
      const { row, customerId, config, threadKey, knowledge, intent, activeModules } = input;

      // whatsapp_manager also ingests messages the founder sends directly. The
      // reply reconciler links this inbound to that outbound before (or while)
      // triage runs. Never compose a second answer for an already-answered turn.
      if (row.answered_by_inbox_id) {
        logger.info(
          { inboxId: row.id, outboundInboxId: row.answered_by_inbox_id },
          'drafter: founder already answered directly on WhatsApp — suppressing draft',
        );
        return;
      }

      // (1) Reclaim guard: a prior attempt that failed AT/AFTER the notify left an OPEN
      // draft for this inbox message — re-present it instead of minting a second draft.
      const existing = await deps.findOpenDraftByInbox(row.id);
      if (existing) {
        logger.info({ inboxId: row.id, queueId: existing.queueId }, 'drafter: open draft exists — re-presenting');
        await represent(existing, row.id);
        return;
      }

      // Can't draft a reply to nobody — guard (failure-isolated, never throws triage).
      if (!row.sender_address) {
        logger.warn({ inboxId: row.id }, 'drafter: no sender_address — skipping draft');
        return;
      }

      // (2a) Always-on style lane: pull this customer's persistent voice/tone directives (NOT
      //      embedding-gated, best-effort → [] on miss). Injected as guidance, NOT a citation
      //      source — it never feeds renderCitations, so no "Based on:" hallucination.
      const voiceGuidance = deps.styleLane ? await deps.styleLane.guidanceFor(customerId) : [];

      // (2b) Upcoming meetings (gated CALENDAR_ENABLED): the drafted customer's calendar meetings,
      //      matched by the sender's email, injected as draft CONTEXT (best-effort → [] on miss).
      //      NOT a citation source — it never feeds renderCitations, so no "Based on:" hallucination.
      const upcomingMeetings = deps.meetings
        ? await deps.meetings.upcomingFor({ customerId, matchEmails: meetingMatchEmails(row) })
        : [];

      // (2b') WP6 relationship brief (gated CUSTOMER_BRIEF_ENABLED): the customer's live brief injected
      //       as draft CONTEXT (best-effort → null on miss). NOT a citation source — it never feeds
      //       renderCitations, so no "Based on:" hallucination.
      const customerBrief = deps.brief ? (await deps.brief.load(customerId)) ?? undefined : undefined;

      // (2) Draft in the customer's preferred language, grounded ONLY in `knowledge`; voice
      //     guidance shapes phrasing only; meetings are acknowledgeable context only.
      // (2c) Recipient gender (best-effort → null): the sender we are replying TO is the
      //      person whose grammar the reply must agree with in a gendered language. The
      //      port contracts to swallow its own failures, but this is the hot inbound path
      //      and gender is a nicety — belt-and-braces so no lookup can ever cost a reply.
      let gender: RecipientGender | null = null;
      if (deps.recipientProfile) {
        try {
          gender = await deps.recipientProfile.resolveGender(row.channel_type, row.sender_address);
        } catch (err) {
          logger.warn({ inboxId: row.id, reason: (err as Error)?.message }, 'drafter: gender lookup failed — writing neutral');
        }
      }

      const req: DraftRequest = {
        question: assembleQuestion(row),
        language: config.preferredLanguage,
        gender,
        customerName: config.displayName,
        knowledge,
        voiceGuidance,
        upcomingMeetings,
        customerBrief,
        activeModules,
      };
      const result = await deps.llm.draftReply(req);

      // (2.5) Draft self-critique (gated; best-effort). When a verifier is injected, grade the draft
      //       BEFORE presenting. On a FAILING verdict with a reviser available, do ONE auto-revise
      //       from the failure details and RE-verify — the final draft is presented REGARDLESS (the
      //       founder still approves), with the verdict annotated on the notification. A verifier /
      //       reviser throw NEVER blocks or delays the draft (swallowed + warned, no bodies logged).
      let body = result.body;
      let usedSourceIndexes = result.usedSourceIndexes;
      let verdict: DraftVerdict | undefined;
      let revised = false;
      if (deps.verifier) {
        verdict = await gradeSafely(deps, {
          question: req.question,
          draftBody: body,
          language: config.preferredLanguage,
          knowledge,
          voiceGuidance,
        });
        if (verdict && !verdict.pass && deps.reviser) {
          const regen = await reviseSafely(deps, {
            question: req.question,
            language: config.preferredLanguage,
            customerName: config.displayName,
            knowledge,
            priorDraft: body,
            instruction: reviseInstruction(verdict),
            voiceGuidance,
          });
          if (regen) {
            body = regen.body;
            usedSourceIndexes = regen.usedSourceIndexes;
            revised = true;
            // Re-verify the regenerated draft; keep the new verdict when we got one (else the first).
            const reverdict = await gradeSafely(deps, {
              question: req.question,
              draftBody: body,
              language: config.preferredLanguage,
              knowledge,
              voiceGuidance,
            });
            if (reverdict) verdict = reverdict;
          }
        }
      }

      // (3) Citations rendered from OUR chunks at the (possibly regenerated) model's used indexes
      //     (no hallucinated cite). Voice guidance is deliberately EXCLUDED — directive, never cited.
      const citations = renderCitations(knowledge, usedSourceIndexes);

      const verifierVerdict = verdict ? { pass: verdict.pass, failures: verdict.failures, revised } : undefined;
      const verifierNote = verdict ? verifierAnnotation(verdict, revised) : undefined;

      // (4) Open the audit decision (outcome='pending') — the queue row FKs to it. The verdict rides
      //     on verifier_verdict (mig 038) so acceptance analytics can correlate it with the outcome.
      const { decisionId } = await deps.recordDraftDecision({
        customerId,
        inboxMessageId: row.id,
        agentOutput: {
          intent,
          draft_body: body,
          citations,
          language: config.preferredLanguage,
          // Carried so the 🔁 Revise loop can regenerate with the same salutation/tone
          // without a customer lookup (never the raw customer body — just the display name).
          customer_name: config.displayName,
        },
        verifierVerdict,
      });

      // (5) Enqueue as a DRAFT (status='pending', is_draft=true) — NEVER auto-drained.
      //     in_reply_to is PER-CHANNEL (matches OutboundMessage.inReplyTo, channel.port):
      //       • WhatsApp → the inbound channel_message_id (wamid) → an approved send QUOTES it (must-fix #2).
      //       • email    → the inbound RFC-2822 Message-ID header → the M2(d) drainer sets
      //         In-Reply-To/References so the reply threads (falls back to channel_message_id
      //         if the header is absent). subject carries the inbound subject (Re:-prefixed)
      //         so the send lands in the SAME Gmail thread; channel_instance_id (below) pins
      //         the reply to the SAME account it arrived on (work/personal never cross).
      const isEmail = row.channel_type === 'email';
      const queueId = await deps.enqueueDraft({
        channelInstanceId: row.channel_instance_id,
        channelType: row.channel_type,
        recipientAddress: row.sender_address,
        body,
        threadKey,
        inReplyTo: isEmail ? row.message_id_header ?? row.channel_message_id : row.channel_message_id,
        subject: isEmail ? emailReplySubject(row.subject) : undefined,
        customerId,
        decisionId,
      });

      logger.info(
        { inboxId: row.id, queueId, decisionId, citations: citations.length },
        'drafter: cited draft enqueued (pending) — presenting for approval',
      );

      // (6) Present with Approve/Edit/Reject (+ the verifier annotation when one ran). A failure
      //     here throws → the row is reclaimed and step (1) re-presents this same draft (no double).
      await present(customerId, queueId, body, citations, config.preferredLanguage, assembleQuestion(row), row.id, verifierNote);
    },

    async reconfirmOpenDraft(inboxMessageId: string): Promise<boolean> {
      const existing = await deps.findOpenDraftByInbox(inboxMessageId);
      if (!existing) return false;
      logger.info({ inboxId: inboxMessageId, queueId: existing.queueId }, 'drafter: reconfirm — re-presenting open draft');
      await represent(existing, inboxMessageId);
      return true;
    },
  };
}

/** Title on every draft-approval presentation. */
const PRESENT_TITLE = '📝 Draft reply — needs approval';

/** The reply subject for an email draft: the inbound subject with a single `Re:`
 *  prefix (case-insensitive, not doubled). A matching subject keeps the send in the
 *  SAME Gmail thread alongside the threadId. Null/blank inbound → a bare 'Re:'. */
export function emailReplySubject(inboundSubject: string | null): string {
  const s = inboundSubject?.trim() ?? '';
  if (!s) return 'Re:';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/** The email(s) used to match this customer's calendar meetings by attendee (M5(d)). Only an
 *  email-shaped sender_address qualifies (a WhatsApp phone can't match a calendar attendee), so
 *  a non-email sender yields [] → the meeting lane is a no-op for that draft. Lower-cased. */
export function meetingMatchEmails(row: ClaimedInbox): string[] {
  const addr = row.sender_address?.trim().toLowerCase();
  return addr && addr.includes('@') ? [addr] : [];
}

/** Assemble the customer question (subject + body) the drafter answers. Trims + drops
 *  empty parts; both may be null (e.g. a WhatsApp message has no subject). */
function assembleQuestion(row: ClaimedInbox): string {
  return [row.subject, row.body]
    .map((s) => s?.trim())
    .filter((s): s is string => !!s)
    .join('\n\n');
}

/** Build the founder-facing presentation: the customer's ORIGINAL message (so the founder can judge
 *  the reply without digging), then the draft body + a "Based on:" citation list + the reply
 *  language + (when the verifier ran) a one-line verdict annotation. Never logged. */
function buildPresentation(body: string, citations: string[], language: string, original?: string, verifierNote?: string): Notification {
  const lines: string[] = [];
  const orig = original?.trim();
  if (orig) lines.push('📨 They wrote:', orig, '', '✍️ Suggested reply:');
  lines.push(body);
  if (citations.length > 0) {
    lines.push('', 'Based on:', ...citations.map((c) => `- ${c}`));
  }
  lines.push('', `Language: ${language}`);
  if (verifierNote) lines.push(verifierNote);
  return { title: PRESENT_TITLE, body: lines.join('\n'), severity: 'action' };
}

/**
 * The one-line founder-facing verdict annotation on a presented draft. A pass shows a small check;
 * a fail lists the flagged failure codes. `revised` notes that the one-shot auto-revise fired (the
 * verdict is then the RE-verify of the regenerated draft). Exported + reused by the revise path.
 */
export function verifierAnnotation(verdict: DraftVerdict, revised: boolean): string {
  if (verdict.pass) return revised ? '✅ Verifier: passed after auto-revise' : '✅ Verifier: passed';
  const codes = verdict.failures.map((f) => f.code).join(', ') || 'failed';
  return revised ? `⚠️ Verifier: ${codes} (auto-revised, still flagged)` : `⚠️ Verifier: ${codes}`;
}

/** The auto-revise instruction built from a failing verdict's one-sentence failure details. */
function reviseInstruction(verdict: DraftVerdict): string {
  const details = verdict.failures.map((f) => f.detail.trim()).filter((d) => d.length > 0);
  return `Fix: ${details.join('; ')}`;
}

/** Grade a draft, swallowing any verifier fault → undefined (a throw must never block the draft). */
async function gradeSafely(deps: Pick<ResponseDrafterDeps, 'verifier'>, input: VerifyDraftRequest): Promise<DraftVerdict | undefined> {
  if (!deps.verifier) return undefined;
  try {
    return await deps.verifier.verifyDraft(input);
  } catch (err) {
    logger.warn({ reason: (err as Error)?.message }, 'drafter: verifier failed — presenting unannotated');
    return undefined;
  }
}

/** Regenerate a draft once, swallowing any reviser fault → undefined (the original draft stands). */
async function reviseSafely(deps: Pick<ResponseDrafterDeps, 'reviser'>, input: ReviseRequest): Promise<{ body: string; usedSourceIndexes: number[] } | undefined> {
  if (!deps.reviser) return undefined;
  try {
    return await deps.reviser.reviseReply(input);
  } catch (err) {
    logger.warn({ reason: (err as Error)?.message }, 'drafter: auto-revise failed — presenting original draft');
    return undefined;
  }
}

/** Safely read the citations + language a prior attempt stored on the decision's
 *  agent_output ({ intent, draft_body, citations, language }) for re-presentation. */
function readDraftMeta(agentOutput: unknown): { citations: string[]; language: string } {
  if (agentOutput && typeof agentOutput === 'object') {
    const o = agentOutput as Record<string, unknown>;
    const citations = Array.isArray(o.citations)
      ? o.citations.filter((c): c is string => typeof c === 'string')
      : [];
    const language = typeof o.language === 'string' ? o.language : '';
    return { citations, language };
  }
  return { citations: [], language: '' };
}

/** A chunk's human-readable citation label: `title › section (route)`, degrading
 *  gracefully when fields are null. */
function chunkLabel(c: KnowledgeChunk): string {
  let label = c.title?.trim() || 'Untitled';
  const section = c.section?.trim();
  if (section) label += ` › ${section}`;
  const route = c.route?.trim();
  if (route) label += ` (${route})`;
  return label;
}

/**
 * Render the human-readable "Based on:" citation labels from OUR retrieved chunks at
 * the model's `usedSourceIndexes` — indexes are validated + clamped to the valid
 * range, deduped; when none are valid the fallback is ALL retrieved chunk labels
 * (never a hallucinated citation). A chunk's label is `title › section (route)`.
 * Exported for unit test (clamp / dedup / fallback cases).
 */
export function renderCitations(knowledge: KnowledgeChunk[], usedSourceIndexes: number[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of usedSourceIndexes) {
    if (!Number.isInteger(i) || i < 0 || i >= knowledge.length) continue; // validate + clamp
    const label = chunkLabel(knowledge[i]);
    if (seen.has(label)) continue; // dedupe
    seen.add(label);
    out.push(label);
  }
  if (out.length === 0) {
    // Fallback: the model reported no valid source → cite ALL retrieved chunks (never
    // a hallucinated citation, and never an empty "Based on:" list).
    for (const c of knowledge) {
      const label = chunkLabel(c);
      if (seen.has(label)) continue;
      seen.add(label);
      out.push(label);
    }
  }
  return out;
}

// Reference: the DraftRequest DTO is re-exported for downstream convenience.
export type { DraftRequest, DraftResult };
