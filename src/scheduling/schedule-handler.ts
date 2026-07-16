import { DateTime } from 'luxon';
import type { DecisionEvent, MessageEvent, Notification } from '../ports/founder-notifier.port';
import type { ScheduleInterpretation, ScheduleInterpreterPort } from '../ports/llm.port';
import type { RecipientGender, RecipientProfilePort } from '../ports/recipient-profile.port';
import { checkComposedBody, COMPOSE_MAX_CHARS } from './composed-body';
import {
  MAX_CLARIFY_TURNS,
  mergeCommandText,
  originCommand,
  parsePending,
  serializePending,
  type PendingAsk,
  type PendingClarification,
  type PendingDraft,
} from './pending-clarification';
import type { ReplyOrigin, ScheduleRoute, ScheduledAction } from './scheduling-repo';
import { deriveRecurrence, parseRecurrenceDetail, type Recurrence, type RecurrenceKind } from './recurrence';

// Founder scheduling commands ("send this at 8am", "remind me tomorrow"), driven from a
// customer's Telegram topic. Two properties are load-bearing:
//
//  1. CONVERSATIONAL. Every question we ask ARMS a pending record, so the answer merges
//     with the command that prompted it. Previously each question stored nothing, so the
//     answer arrived context-free and had to satisfy every rule alone — "WhatsApp" never
//     could, and the loop could not converge.
//
//  2. THE FOUNDER'S WORDS ARE PREFERRED, AND ANYTHING ELSE IS GATED. A body quoted from
//     the founder is scheduled outright. A body the model wrote is shown for approval
//     first. Which one it is, is DERIVED here (verbatimBody) — never declared by the
//     model, which would let it pick its own enforcement level.

/** Button ids. Flat, with no embedded ':' — dispatchCallback splits callback_data on the
 *  FIRST colon, so a nested id ('bf:ok:<x>') silently mis-routes; see backfill-approve. */
export const SCHEDULE_OPTIONS = {
  whatsapp: 'scw',
  email: 'sce',
  approve: 'sca',
  edit: 'scx',
  cancel: 'scc',
} as const;

const CHANNEL_BY_OPTION: Record<string, string> = {
  [SCHEDULE_OPTIONS.whatsapp]: 'whatsapp',
  [SCHEDULE_OPTIONS.email]: 'email',
};

export function isScheduleOption(optionId: string): boolean {
  return Object.values(SCHEDULE_OPTIONS).some((o) => o === optionId);
}

const channelLabel = (t: string): string => (t === 'email' ? 'Email' : 'WhatsApp');

/** Inline-keyboard labels. Telegram lays a keyboard out as ONE horizontal row, so every
 *  label must be thumb-short — "✅ Send via WhatsApp" ran off the screen. The channel is
 *  already spelled out in the preview above the buttons, so the button only has to name
 *  the choice, and a distinct icon per channel makes the pair readable at a glance. */
const channelButtonLabel = (t: string): string => (t === 'email' ? '✉️ Email' : '💬 WhatsApp');
const channelOptionId = (t: string): string => (t === 'email' ? SCHEDULE_OPTIONS.email : SCHEDULE_OPTIONS.whatsapp);
const REJECT_LABEL = '❌ Reject';
const EDIT_LABEL = '✏️ Edit';

export interface ScheduleHandlerDeps {
  interpreter: ScheduleInterpreterPort;
  timezone: string;
  graceMinutes: number;
  outboundEnabled: boolean;
  allowedChannelTypes: string[];
  now: () => Date;
  newNonce: () => string;
  findCustomer: (threadId: string) => Promise<{ id: string; displayName: string; language: string } | null>;
  resolveReplyOrigin: (chatId: string, messageId: number, customerId: string) => Promise<ReplyOrigin | null>;
  loadMappedOutboundBody: (ref: string, customerId: string) => Promise<string | null>;
  resolveRoute: (customerId: string, allowed: string[], origin?: ReplyOrigin | null) => Promise<ScheduleRoute | null>;
  listRouteCandidates: (customerId: string, allowed: string[]) => Promise<ScheduleRoute[]>;
  /** Recipient facts the wording depends on (gender). Optional — absent means every
   *  composed message is written gender-neutral, which is always safe. */
  recipientProfile?: RecipientProfilePort;
  createAction: (input: {
    sourceChatId: string;
    sourceMessageId: number;
    sourceThreadId: string;
    createdBy: string;
    customerId: string;
    kind: 'customer_message' | 'reminder';
    executeAt: Date;
    expiresAt: Date;
    timezone: string;
    body: string;
    contextSnapshot?: unknown;
    route?: ScheduleRoute | null;
    recurrenceKind?: RecurrenceKind | null;
    recurrenceDetail?: Recurrence | null;
  }) => Promise<{ action: ScheduledAction; created: boolean }>;
  readPending: (threadId: string) => Promise<string | null>;
  armPending: (threadId: string, value: string) => Promise<void>;
  clearPending: (threadId: string) => Promise<void>;
  postAnswer: (threadId: string, text: string) => Promise<void>;
  notifyCustomer: (customerId: string, n: Notification, buttons?: Array<{ id: string; label: string }>) => Promise<void>;
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

/**
 * Validate the MODEL's timestamp: the offset must agree with the founder timezone, and
 * the result must land in the future.
 *
 * `explicitDate=false` means the founder gave a bare clock time ("at 8 am"), which means
 * the NEXT occurrence of it. That roll is done HERE, in code: asked to compare its own
 * clock time against nowIso, the model reliably got it wrong — "say hi at 8 am" sent at
 * 08:31 came back as 08:00 TODAY, already past, and the founder got "what future time?"
 * for a command that was perfectly clear. Date arithmetic is not a judgement call, so it
 * does not belong in the prompt; the model only reports whether a day was named.
 */
function validatedExecution(iso: string | null, timezone: string, now: Date, explicitDate: boolean): Date | null {
  if (!iso) return null;
  const parsed = DateTime.fromISO(iso, { setZone: true });
  if (!parsed.isValid) return null;
  const local = parsed.setZone(timezone);
  if (!local.isValid) return null;
  // Reject a model-provided offset that changes the intended local wall-clock minute.
  if (parsed.toFormat('yyyy-LL-dd HH:mm') !== local.toFormat('yyyy-LL-dd HH:mm')) return null;

  let when = parsed;
  if (!explicitDate && when.toMillis() < now.getTime()) {
    // Bare clock time already past today → the founder meant tomorrow. Adding a calendar
    // day (not 24h) keeps the wall-clock hour across a DST shift.
    when = when.plus({ days: 1 });
  }
  return stillFuture(when.toJSDate().toISOString(), now);
}

/** Re-check an ALREADY-validated instant that has been sitting in a pending record.
 *  Deliberately NOT validatedExecution: that one's offset guard polices the model's
 *  wording, and our own stored instant is UTC by construction, so it would always fail.
 *  The only thing that can go wrong between asking and answering is the time lapsing. */
function stillFuture(iso: string, now: Date): Date | null {
  const parsed = DateTime.fromISO(iso, { setZone: true });
  if (!parsed.isValid) return null;
  const date = parsed.toJSDate();
  return date.getTime() >= now.getTime() - 60_000 ? date : null;
}

/**
 * The founder's own words, or null if the model wrote them.
 *
 * `command` is the merged founder text across clarify turns — both halves are founder
 * speech, so a body quoted from either is still verbatim. Called on EVERY body: the
 * answer decides whether an approval gate is required, which is why the model is never
 * asked to label its own output.
 */
export function verbatimBody(
  kind: 'customer_message' | 'reminder',
  body: string | null,
  command: string,
  mappedOutboundBody: string | null,
): string | null {
  const candidate = body?.trim() ?? '';
  if (!candidate || candidate.length > 4096) return null;
  if (command.includes(candidate)) return candidate;
  if (kind === 'customer_message' && mappedOutboundBody !== null && candidate === mappedOutboundBody.trim()) {
    return mappedOutboundBody.trim();
  }
  return null;
}

/** Human phrasing for a recurrence, e.g. "every day at 9:00 AM" / "every Monday at 9:00 AM" /
 *  "on the 15th of every month at 9:00 AM". Reads the DERIVED pattern (recurrence_detail). */
function describeRecurrence(rec: Recurrence): string {
  const t = DateTime.fromObject({ hour: rec.hour, minute: rec.minute }).toFormat('h:mm a');
  if (rec.kind === 'daily') return `every day at ${t}`;
  if (rec.kind === 'weekly') {
    const day = rec.dow ? DateTime.fromObject({ weekday: rec.dow as 1 | 2 | 3 | 4 | 5 | 6 | 7 }).toFormat('cccc') : 'week';
    return `every ${day} at ${t}`;
  }
  const dom = rec.dom ?? 1;
  const ord = dom + (dom % 10 === 1 && dom !== 11 ? 'st' : dom % 10 === 2 && dom !== 12 ? 'nd' : dom % 10 === 3 && dom !== 13 ? 'rd' : 'th');
  return `on the ${ord} of every month at ${t}`;
}

function renderConfirmation(action: ScheduledAction, isGroup: boolean): string {
  const when = DateTime.fromJSDate(new Date(action.execute_at), { zone: action.timezone }).toFormat("ccc LLL d, yyyy 'at' h:mm a ZZZZ");
  if (action.action_kind === 'reminder') {
    const rec = parseRecurrenceDetail(action.recurrence_detail);
    if (rec) return `🔁 Recurring reminder set — ${describeRecurrence(rec)}\nNext: ${when}\n\n${action.body}`;
    return `⏰ Reminder scheduled\n${when}\n\n${action.body}`;
  }
  // Spell out the address and group-ness: a group's display name renders exactly like a
  // person's, and a group send reaches every participant.
  const who = isGroup
    ? `👥 GROUP "${action.recipient_label ?? action.recipient_address}"`
    : `${action.recipient_label ?? action.recipient_address}`;
  return `📤 Customer message scheduled\nTo: ${who} <${action.recipient_address}> via ${action.channel_type}\n${when}\n\n${action.body}`;
}

function renderPreview(draft: PendingDraft, timezone: string, route: ScheduleRoute | null): string {
  const when = DateTime.fromISO(draft.executeAt, { setZone: true }).setZone(timezone).toFormat("ccc LLL d, yyyy 'at' h:mm a ZZZZ");
  const to = route ? `\nTo: ${route.recipientLabel} <${route.recipientAddress}> via ${route.channelType}` : '';
  return `✍️ I wrote this — send it?${to}\n${when}\n\n${draft.body}`;
}

/** A draft whose channel question is settled: a concrete channel, or null for a reminder
 *  (which has no channel at all). Not `PendingDraft & {channel: string|null}` — that
 *  intersection silently collapses back to a required string. */
type ResolvedDraft = Omit<PendingDraft, 'channel'> & { channel: string | null };

/**
 * The recipient's gender, from whichever candidate route can answer.
 *
 * Only WhatsApp carries a gender (it is the founder's whitelist), so when both channels
 * are available the phone contact answers for the email one too — it is the same person,
 * and their grammar does not change with the transport. Best-effort by contract: null
 * means "write for anyone".
 */
async function resolveGenderFor(
  deps: Pick<ScheduleHandlerDeps, 'recipientProfile' | 'log'>,
  candidates: ScheduleRoute[],
): Promise<RecipientGender | null> {
  if (!deps.recipientProfile) return null;
  try {
    for (const c of candidates) {
      if (c.isGroup) continue; // a group has no single person's grammar
      const g = await deps.recipientProfile.resolveGender(c.channelType, c.recipientAddress);
      if (g) return g;
    }
  } catch (err) {
    // The port contracts to swallow its own failures; this is belt-and-braces so a
    // cosmetic lookup can never cost the founder their scheduled message.
    deps.log.error({ reason: (err as Error)?.message }, 'schedule: gender lookup failed — writing neutral');
  }
  return null;
}

/** Everything the handler and the button router both need after a customer is known. */
interface Ctx {
  threadId: string;
  by: string;
  customer: { id: string; displayName: string; language: string };
  pending: PendingClarification | null;
}

export interface ScheduleHandlers {
  onMessage: (m: MessageEvent) => Promise<boolean>;
  onDecision: (d: DecisionEvent) => Promise<void>;
}

export function buildScheduleHandlers(deps: ScheduleHandlerDeps): ScheduleHandlers {
  const armPending = async (
    threadId: string,
    fields: Omit<PendingClarification, 'v' | 'nonce'> & { nonce?: string },
  ): Promise<string> => {
    const nonce = fields.nonce ?? deps.newNonce();
    await deps.armPending(threadId, serializePending({ ...fields, v: 1, nonce }));
    return nonce;
  };

  /** Validate the time, resolve the route, create the action, confirm. The single exit
   *  through which every path — verbatim, auto-picked, button-chosen, approved — leaves. */
  const finalize = async (
    ctx: Ctx,
    draft: ResolvedDraft,
    origin: ReplyOrigin | null,
  ): Promise<boolean> => {
    const now = deps.now();
    // Re-checked HERE, not just at interpret time: the founder may have taken minutes to
    // answer, and "8am" can lapse while the question sits unanswered.
    const executeAt = stillFuture(draft.executeAt, now);
    if (!executeAt) {
      await deps.clearPending(ctx.threadId);
      await deps.postAnswer(ctx.threadId, `That time has already passed. What future date and time should I use? Times are in ${deps.timezone}.`);
      return true;
    }

    let route: ScheduleRoute | null = null;
    if (draft.kind === 'customer_message') {
      if (!draft.channel) {
        await deps.clearPending(ctx.threadId);
        await deps.postAnswer(ctx.threadId, 'I lost track of which channel to use. Please send the command again.');
        return true;
      }
      route = await deps.resolveRoute(ctx.customer.id, [draft.channel], origin);
      if (!route) {
        await deps.clearPending(ctx.threadId);
        await deps.postAnswer(ctx.threadId, 'I could not resolve an active send-capable contact for this customer. Nothing was scheduled.');
        return true;
      }
      // A composed body is text the founder never wrote; a group route delivers it to
      // every participant. Auto-composition is for 1:1 pleasantries.
      if (route.isGroup && draft.composed) {
        await deps.clearPending(ctx.threadId);
        await deps.postAnswer(ctx.threadId, `"${route.recipientLabel}" is a group. I will not send a message I wrote myself to a group — tell me the exact words to send.`);
        return true;
      }
    }

    const anchor = originCommand(ctx.pending, { chatId: '', messageId: '' });
    const sourceMessageId = Number(anchor.messageId);
    if (!anchor.chatId || !Number.isSafeInteger(sourceMessageId)) {
      await deps.clearPending(ctx.threadId);
      await deps.postAnswer(ctx.threadId, '⚠️ I could not identify the original Telegram message, so nothing was scheduled.');
      return true;
    }

    const expiresAt = new Date(executeAt.getTime() + deps.graceMinutes * 60_000);
    const { action, created } = await deps.createAction({
      sourceChatId: anchor.chatId,
      sourceMessageId,
      sourceThreadId: ctx.threadId,
      createdBy: ctx.by,
      customerId: ctx.customer.id,
      kind: draft.kind,
      executeAt,
      expiresAt,
      timezone: deps.timezone,
      body: draft.body,
      contextSnapshot: { origin, composed: draft.composed },
      route,
      // Recurrence is only ever set on reminders (a recurring customer_message is refused
      // upstream). One-shots pass null → an ordinary single-fire action.
      recurrenceKind: draft.recurrence?.kind ?? null,
      recurrenceDetail: draft.recurrence ?? null,
    });
    await deps.clearPending(ctx.threadId);

    if (!created && action.status !== 'pending') {
      await deps.postAnswer(ctx.threadId, `This command was already handled (status: ${action.status}).`);
      return true;
    }
    await deps.notifyCustomer(
      ctx.customer.id,
      { title: 'Scheduled', body: renderConfirmation(action, route?.isGroup ?? false), severity: 'action' },
      [{ id: `sc:${action.id}`, label: '❌ Cancel schedule' }],
    );
    deps.log.info({ actionId: action.id, customerId: ctx.customer.id, kind: action.action_kind, composed: draft.composed }, 'schedule: action created');
    return true;
  };

  /** Channel resolution. Explicit founder choice wins; otherwise availability decides —
   *  one option is not a choice worth interrupting for, two is. */
  const resolveChannel = async (
    ctx: Ctx,
    draft: PendingDraft,
    explicit: string | null,
    origin: ReplyOrigin | null,
  ): Promise<boolean> => {
    if (explicit) return finalize(ctx, { ...draft, channel: explicit }, origin);

    const candidates = await deps.listRouteCandidates(ctx.customer.id, deps.allowedChannelTypes);
    const available = [...new Set(candidates.map((c) => c.channelType))];

    if (available.length === 0) {
      await deps.clearPending(ctx.threadId);
      await deps.postAnswer(ctx.threadId, 'I could not resolve an active send-capable contact for this customer. Nothing was scheduled.');
      return true;
    }
    if (available.length === 1) return finalize(ctx, { ...draft, channel: available[0] }, origin);

    const nonce = await armPending(ctx.threadId, {
      ask: 'channel',
      turns: ctx.pending?.turns ?? 0,
      chatId: ctx.pending?.chatId ?? '',
      messageId: ctx.pending?.messageId ?? '',
      customerId: ctx.customer.id,
      commandText: ctx.pending?.commandText ?? '',
      clarification: 'Which channel should I use?',
      origin,
      draft,
    });
    await deps.notifyCustomer(
      ctx.customer.id,
      { title: 'Which channel?', body: `${draft.body}\n\nSend this on WhatsApp or email?`, severity: 'action' },
      [
        ...available.map((t) => ({ id: `${channelOptionId(t)}:${nonce}`, label: channelButtonLabel(t) })),
        { id: `${SCHEDULE_OPTIONS.cancel}:${nonce}`, label: REJECT_LABEL },
      ],
    );
    return true;
  };

  /** Ask something free-text, remembering enough that the answer can be merged. */
  const askAndArm = async (ctx: Ctx, merged: string, question: string, origin: ReplyOrigin | null, anchor: { chatId: string; messageId: string }): Promise<boolean> => {
    const turns = (ctx.pending?.turns ?? 0) + 1;
    if (turns > MAX_CLARIFY_TURNS) {
      await deps.clearPending(ctx.threadId);
      await deps.postAnswer(ctx.threadId, "I'm still not getting it — please send the whole instruction in one message (what to send, when, and on which channel).");
      return true;
    }
    await armPending(ctx.threadId, {
      ask: 'free',
      turns,
      chatId: anchor.chatId,
      messageId: anchor.messageId,
      customerId: ctx.customer.id,
      commandText: merged,
      clarification: question,
      origin,
    });
    await deps.postAnswer(ctx.threadId, question);
    return true;
  };

  const onMessage = async (m: MessageEvent): Promise<boolean> => {
    const customer = await deps.findCustomer(m.threadId);
    if (!customer) return false; // scheduling is customer-topic only

    const pending = parsePending(await deps.readPending(m.threadId));
    // A pending record is only valid for the customer it was armed against — a topic
    // re-pointed at a different customer must not inherit it.
    const usable = pending && pending.customerId === customer.id ? pending : null;
    if (pending && !usable) await deps.clearPending(m.threadId);

    const ctx: Ctx = { threadId: m.threadId, by: m.by, customer, pending: usable };

    // ✏️ Edit of a composed draft: this message IS the replacement body, verbatim.
    if (usable?.ask === 'edit' && usable.draft) {
      if (!m.text.trim()) return true; // hold the marker for the next non-empty message
      const edited: PendingDraft = { ...usable.draft, body: m.text.trim(), composed: false };
      // A draft offered with two channels carries none yet — the channel would have
      // arrived on the button the founder chose not to press. Ask, rather than dropping
      // the words they just typed.
      if (edited.kind === 'customer_message' && !edited.channel) {
        return resolveChannel(ctx, edited, null, usable.origin);
      }
      return finalize(ctx, { ...edited, channel: edited.channel ?? null }, usable.origin);
    }

    const sourceMessageId = Number(m.messageId);
    if (!Number.isSafeInteger(sourceMessageId)) {
      await deps.postAnswer(m.threadId, '⚠️ I could not identify that Telegram message, so nothing was scheduled.');
      return true;
    }
    // The action is anchored to the ORIGINAL command, so every clarify round and button
    // tap collapses onto one row via ON CONFLICT (source_chat_id, source_message_id).
    const anchor = originCommand(usable, { chatId: m.chatId, messageId: m.messageId });

    let origin: ReplyOrigin | null = usable?.origin ?? null;
    if (!origin && m.replyTo) {
      const replyMessageId = Number(m.replyTo.messageId);
      if (Number.isSafeInteger(replyMessageId)) {
        origin = await deps.resolveReplyOrigin(m.chatId, replyMessageId, customer.id);
      }
    }
    // Re-fetched from the DB rather than carried in the pending record: untrusted
    // customer text never round-trips through app_state.
    const mappedOutboundBody = origin?.kind === 'outbound'
      ? await deps.loadMappedOutboundBody(origin.ref, customer.id)
      : null;

    const merged = mergeCommandText(usable, m.text);
    const now = deps.now();

    let interpreted: ScheduleInterpretation;
    try {
      interpreted = await deps.interpreter.interpretSchedule({
        commandText: m.text,
        priorCommandText: usable?.commandText ?? null,
        priorClarification: usable?.clarification ?? null,
        repliedText: m.replyTo?.text ?? null,
        mappedOutboundBody,
        customerName: customer.displayName,
        nowIso: DateTime.fromJSDate(now, { zone: deps.timezone }).toISO() ?? now.toISOString(),
        timezone: deps.timezone,
      }, customer.id);
    } catch {
      deps.log.error({ customerId: customer.id, messageId: m.messageId }, 'schedule: interpretation failed');
      await deps.postAnswer(m.threadId, '⚠️ I could not check that message for scheduling. Please try again.');
      return true;
    }

    if (interpreted.kind === 'none') {
      // Only ordinary chatter when nothing was pending; mid-clarification it means we
      // failed to read the answer, and falling silent would strand the founder.
      if (!usable) return false;
      return askAndArm(ctx, merged, interpreted.clarification?.trim() || 'Sorry — what should I schedule, and when?', origin, anchor);
    }
    if (interpreted.kind === 'clarify') {
      return askAndArm(ctx, merged, interpreted.clarification?.trim() || 'What exact action, time, and wording should I schedule?', origin, anchor);
    }

    const executeAt = validatedExecution(interpreted.execute_at, deps.timezone, now, interpreted.explicit_date);
    if (!executeAt) {
      return askAndArm(ctx, merged, `What future date and time should I use? Times are interpreted in ${deps.timezone}.`, origin, anchor);
    }

    // Recurrence v1 is reminders-only. A standing message to a CUSTOMER needs more thought than v1
    // should assume (which contact, what cadence of un-approved sends, when to stop), so a recurring
    // customer_message is declined with a clear next step rather than half-supported.
    if (interpreted.recurrence && interpreted.kind === 'customer_message') {
      await deps.clearPending(m.threadId);
      await deps.postAnswer(
        m.threadId,
        "I can't set up a recurring message to a customer yet — a standing customer send needs more thought than I want to assume. I can schedule a one-time message, or a recurring reminder to you.",
      );
      return true;
    }
    // Derive the authoritative recurrence pattern from the VALIDATED first occurrence (never the
    // model's fields) so the pattern can't disagree with the instant the founder confirmed. Only
    // reminders reach a recurring finalize; the customer_message case was refused just above.
    const recurrence =
      interpreted.recurrence && interpreted.kind === 'reminder'
        ? deriveRecurrence(executeAt, interpreted.recurrence.kind, deps.timezone)
        : null;

    const explicitChannel = interpreted.delivery_channel !== 'none' ? interpreted.delivery_channel : null;
    if (explicitChannel && !deps.allowedChannelTypes.includes(explicitChannel)) {
      await deps.clearPending(m.threadId);
      await deps.postAnswer(m.threadId, `${channelLabel(explicitChannel)} delivery is disabled, so nothing was scheduled.`);
      return true;
    }
    if (interpreted.kind === 'customer_message' && !deps.outboundEnabled) {
      await deps.clearPending(m.threadId);
      await deps.postAnswer(m.threadId, 'Outbound delivery is disabled, so I did not schedule a customer message.');
      return true;
    }

    const ctxWithAnchor: Ctx = { ...ctx, pending: { ...(usable ?? emptyPending(anchor, customer.id)), commandText: merged, origin } };

    // The founder's own words → no gate, exactly as before.
    const quoted = verbatimBody(interpreted.kind, interpreted.body, merged, mappedOutboundBody);
    if (quoted) {
      const draft: PendingDraft = { kind: interpreted.kind, executeAt: executeAt.toISOString(), body: quoted, composed: false };
      if (interpreted.kind === 'reminder') return finalize(ctxWithAnchor, { ...draft, channel: null, recurrence }, origin);
      return resolveChannel(ctxWithAnchor, draft, explicitChannel, origin);
    }

    // A reminder only ever reaches the founder, so there is nothing to gate — but we
    // still will not invent one out of nothing.
    if (interpreted.kind === 'reminder') {
      return askAndArm(ctxWithAnchor, merged, 'What exactly should I remind you about?', origin, anchor);
    }

    // Routes are resolved BEFORE composing, not after: the recipient's address is what
    // the gender lookup keys on, and gender changes the words in a gendered language.
    // Resolving first also avoids paying for a compose we would then throw away because
    // the customer has no send-capable contact.
    const candidates = await deps.listRouteCandidates(customer.id, explicitChannel ? [explicitChannel] : deps.allowedChannelTypes);
    const available = [...new Set(candidates.map((c) => c.channelType))];
    if (available.length === 0) {
      await deps.clearPending(m.threadId);
      await deps.postAnswer(m.threadId, 'I could not resolve an active send-capable contact for this customer. Nothing was scheduled.');
      return true;
    }
    const gender = await resolveGenderFor(deps, candidates);

    // The model described a message rather than quoting one → compose it and gate it.
    let composed: string;
    try {
      composed = await deps.interpreter.composeMessage(
        { commandText: merged, customerName: customer.displayName, language: customer.language, gender },
        customer.id,
      );
    } catch {
      deps.log.error({ customerId: customer.id }, 'schedule: compose failed');
      return askAndArm(ctxWithAnchor, merged, 'What exact words should I send?', origin, anchor);
    }
    const checked = checkComposedBody(composed, {
      maxChars: COMPOSE_MAX_CHARS,
      founderText: merged,
      untrusted: [m.replyTo?.text, mappedOutboundBody],
    });
    if (!checked.ok) {
      deps.log.info({ customerId: customer.id, reason: checked.reason }, 'schedule: composed body rejected');
      return askAndArm(ctxWithAnchor, merged, `I could not write that safely (${checked.reason}). What exact words should I send?`, origin, anchor);
    }

    const draft: PendingDraft = {
      kind: 'customer_message',
      executeAt: executeAt.toISOString(),
      body: checked.body,
      composed: true,
      // Pinned now when there is nothing to choose, so ✅ Send needs no channel of its
      // own; with two options the channel arrives on the button instead.
      ...(available.length === 1 ? { channel: available[0] } : {}),
    };

    const nonce = await armPending(m.threadId, {
      ask: 'draft',
      turns: usable?.turns ?? 0,
      chatId: anchor.chatId,
      messageId: anchor.messageId,
      customerId: customer.id,
      commandText: merged,
      clarification: 'Approve the draft I wrote?',
      origin,
      draft,
    });

    // One channel → the tap is pure approval (the preview names the channel). Two → the
    // channel tap IS the approval, so the founder never answers two questions.
    const buttons = [
      ...(available.length === 1
        ? [{ id: `${SCHEDULE_OPTIONS.approve}:${nonce}`, label: '✅ Send' }]
        : available.map((t) => ({ id: `${channelOptionId(t)}:${nonce}`, label: channelButtonLabel(t) }))),
      { id: `${SCHEDULE_OPTIONS.edit}:${nonce}`, label: EDIT_LABEL },
      { id: `${SCHEDULE_OPTIONS.cancel}:${nonce}`, label: REJECT_LABEL },
    ];
    const previewRoute = available.length === 1 ? candidates.find((c) => c.channelType === available[0]) ?? null : null;
    await deps.notifyCustomer(
      customer.id,
      { title: 'Draft ready', body: renderPreview(draft, deps.timezone, previewRoute), severity: 'action' },
      buttons,
    );
    return true;
  };

  const onDecision = async (d: DecisionEvent): Promise<void> => {
    if (!d.threadId) return;
    const threadId = d.threadId;
    const nonce = d.notificationRef;

    const customer = await deps.findCustomer(threadId);
    const pending = parsePending(await deps.readPending(threadId));
    // A tap is only honoured for the exact question it was rendered on. Buttons stay
    // tappable forever (nothing edits a sent keyboard), and the pending record expires,
    // so a stale tap is expected — say so rather than no-op and let the founder believe
    // it worked.
    if (!customer || !pending || pending.nonce !== nonce || pending.customerId !== customer.id) {
      await deps.postAnswer(threadId, 'That question has expired — please send the command again.');
      return;
    }
    if (!pending.draft) {
      await deps.clearPending(threadId);
      await deps.postAnswer(threadId, 'I lost track of that draft — please send the command again.');
      return;
    }

    const ctx: Ctx = { threadId, by: d.by, customer, pending };

    if (d.optionId === SCHEDULE_OPTIONS.cancel) {
      await deps.clearPending(threadId);
      await deps.postAnswer(threadId, 'Rejected — nothing scheduled.');
      return;
    }
    if (d.optionId === SCHEDULE_OPTIONS.edit) {
      await armPending(threadId, { ...pending, ask: 'edit', nonce });
      await deps.postAnswer(threadId, 'Send the exact words as your next message in this topic.');
      return;
    }
    if (d.optionId === SCHEDULE_OPTIONS.approve) {
      // Approve carries no channel of its own — it is only offered when exactly one was
      // available, and that one was already recorded on the draft.
      await finalize(ctx, { ...pending.draft, channel: pending.draft.channel ?? null }, pending.origin);
      return;
    }

    const channel = CHANNEL_BY_OPTION[d.optionId];
    if (!channel) return;
    // Re-checked at tap time: the flag may have flipped since the buttons were rendered.
    if (!deps.allowedChannelTypes.includes(channel)) {
      await deps.clearPending(threadId);
      await deps.postAnswer(threadId, `${channelLabel(channel)} delivery is disabled, so nothing was scheduled.`);
      return;
    }
    await finalize(ctx, { ...pending.draft, channel }, pending.origin);
  };

  return { onMessage, onDecision };
}

function emptyPending(anchor: { chatId: string; messageId: string }, customerId: string): PendingClarification {
  return {
    v: 1, nonce: '', ask: 'free' as PendingAsk, turns: 0,
    chatId: anchor.chatId, messageId: anchor.messageId, customerId,
    commandText: '', clarification: null, origin: null,
  };
}
