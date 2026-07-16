import type { MessageEvent } from '../ports/founder-notifier.port';
import {
  composeBriefing,
  renderBriefing,
  queueLine,
  humanizeAgeHours,
  dayInTz,
  type BriefingData,
  type PendingItem,
} from './daily-briefing';
import { COMMITMENT_DONE_OPTION, COMMITMENT_DISMISS_OPTION } from '../commitments/commitment-decision-handler';
import type { DuePrecision } from '../commitments/due-hint';

// Telegram founder slash-command surface (M5(c) — CORE, injected ports only; the concrete
// queue reads + notifier are wired at the composition root, so this never imports src/adapters
// — D1 boundary). A founder types a leading `/pending` / `/status` / `/history` … in a topic →
// the router dispatches → the reply is posted back to the SAME thread. Mirrors ask-command.ts
// (which stays its OWN handler for `/ask`): each handler returns whether it CONSUMED the message
// so both compose into the notifier's single onMessage router; a non-command (or an unknown
// command) falls through (returns false) to the ✏️ Edit / 🔁 Revise free-text captures.
//
// REUSE: the pending-queue readers and the digest aggregation/render come from daily-briefing.ts
// (composeBriefing/renderBriefing/queueLine/humanizeAgeHours) — this file adds NO new queue query
// and no second roll-up. Every other capability (open tasks, the three history legs, the change-02
// drafter, the change-03 backfill job) arrives as an INJECTED fn on SlashCommandDeps; an optional
// dep left undefined means "not wired / feature off", and the command says so instead of throwing.
//
// ── PII posture (refined for M5(c) task 2.1) ───────────────────────────────────────────────────
// The original posture ("replies carry customer NAMES + counts + ages only, NEVER a body") was
// written when every command was a queue roll-up. `/history` and `/draft email` return CONTENT by
// definition — that is their entire point — so the posture is now split by axis:
//   • DESTINATION: content may be posted ONLY back to the founder's own Telegram topic (the thread
//     the command came from). That is the same surface where change 02 already presents full draft
//     bodies for review, so a founder-requested snippet/draft there discloses nothing new. `/draft
//     email` now ENQUEUES the composed reply as a DRAFT (is_draft=true) to the customer's email and
//     presents it with Approve/Edit/Reject — structurally un-sendable until the founder approves
//     (the drainer skips is_draft=true), exactly like every other customer-facing draft.
//   • LOGGING: unchanged and ABSOLUTE. We log the command NAME + counts/flags ONLY — never the
//     command text (args), never a snippet, never a draft/answer body. Dispatch is reached only for
//     a REGISTERED command name, so the name itself is never free text.
//   • ROLL-UPS: `/pending` / `/briefing` / `/summary` keep the strict original shape (names +
//     counts + ages, no bodies) — the refinement below applies only to the two content commands.

/** A customer the founder's command is scoped to (agent_customers.id + display name). */
export interface ResolvedCustomerRef {
  customerId: string;
  customerName: string;
}

/** One open task for `/status`, reduced to what the reply renders. This is the founder's OWN work
 *  tracker (task titles/codes), not customer message content — the body rule does not apply. */
export interface OpenTaskLine {
  code: string | null;
  title: string;
  status: string;
}

/** One `/history` hit. `snippet` is CONTENT — founder-topic only, never logged (see the posture). */
export interface HistoryHit {
  /** When it happened; null when the leg has no timestamp. */
  at: Date | null;
  /** Who said it (sender name/address, chat name); null when unknown. */
  who: string | null;
  snippet: string;
}

/** One history leg's result. `capped` marks a truncated read so the reply can say "showing N of more". */
export interface HistoryLegResult {
  hits: HistoryHit[];
  capped?: boolean;
}

/** One open commitment for the `/commitments` surface — enough to render a card + wire its buttons.
 *  This is the founder's OWN promise-tracker (their words back to them), not customer message content
 *  the way a draft body is, but it is still founder-topic-only and never logged. */
export interface CommitmentLine {
  id: string;
  /** Present on the unscoped (all-customers) listing; null when the list is already one customer. */
  customerName: string | null;
  text: string;
  dueAt: Date | null;
  duePrecision: DuePrecision | null;
  createdAt: Date;
}

/** `/draft email` request — what to say, to which resolved customer. */
export interface DraftEmailInput {
  prompt: string;
  customer: ResolvedCustomerRef;
}

/**
 * Outcome of `/draft email`. On success the draft was ENQUEUED (is_draft=true) to the
 * customer's email, an audit decision opened, and an Approve/Edit/Reject card presented in
 * the customer's topic — `ok:true` carries the preview the command echoes back as a
 * confirmation. `no_email_route` means the customer has no email contact / sending account,
 * so nothing was composed or queued (the command says so in-topic).
 */
export type DraftEmailResult =
  | {
      ok: true;
      /** The email recipient's display name (or address) — for the founder confirmation. */
      recipient: string;
      /** False when retrieval found nothing — the confirmation flags the draft as ungrounded. */
      grounded: boolean;
      /** Human "Based on:" labels rendered from OUR chunks (never a hallucinated citation). */
      citations: string[];
    }
  | { ok: false; reason: 'no_email_route' };

/** Outcome of asking the change-03 sweep to start. `already-running` is NOT an error (one sweep
 *  per customer fills the same memory — mirrors the WA history client's 409 handling). */
export type BackfillStart = 'started' | 'already-running';

export interface SlashCommandDeps {
  /** Pending draft replies (is_draft, status='pending'), PII-light — reused from the briefing. */
  fetchPendingDrafts: () => Promise<PendingItem[]>;
  /** Pending backfill task proposals (outcome='pending'), PII-light — reused from the briefing. */
  fetchPendingProposals: () => Promise<PendingItem[]>;
  /** Post the reply back to the thread the command came from (the founder's topic). Injected so
   *  this core router never imports the Telegram adapter. */
  postAnswer: (threadId: string, text: string) => Promise<void>;
  /** Injected clock (test seam). */
  now: () => Date;
  /** Timezone for the `/briefing` day title so it matches the daily digest (founder's local day). */
  tz: string;
  /** Max customers in the `/briefing` attention list. */
  topN?: number;
  /** Structured logger (command name + counts/flags only — NEVER command text or reply bodies). */
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };

  // ── Command capabilities. Each is OPTIONAL: undefined = not wired (feature off / dependency
  //    unavailable) → the command reports it is unavailable rather than throwing.

  /** The customer bound to a Telegram topic (agent_customers.telegram_topic_id = threadId), or
   *  null for a topic with no customer (the Admin topic). THE topic→customer binding. */
  resolveThreadCustomer?: (threadId: string) => Promise<ResolvedCustomerRef | null>;
  /** Find a customer by display name — the explicit-argument path (`/status acme`), and the only
   *  way to scope a command typed in the Admin topic. */
  findCustomerByName?: (name: string) => Promise<ResolvedCustomerRef | null>;
  /** Open tasks for a customer (TaskTargetPort.findOpenTasks, via the customer's projectRef —
   *  the portal has no customer filter, R46). null = the customer has no project bound, which is
   *  NOT the same as "no open tasks" and must not be reported as an all-clear. */
  listOpenTasks?: (customerId: string) => Promise<OpenTaskLine[] | null>;
  /** `/history` leg: agent_inbox keyword search, scoped to a customer or cross-customer (null). */
  searchInboxHistory?: (keyword: string, customerId: string | null) => Promise<HistoryLegResult>;
  /** `/history` leg: agent_memory semantic search (embed + memoryRepo.search). */
  searchMemoryHistory?: (keyword: string, customerId: string | null) => Promise<HistoryLegResult>;
  /** `/history` leg: the whatsapp_manager archive. */
  searchWhatsAppHistory?: (keyword: string, customerId: string | null) => Promise<HistoryLegResult>;
  /** `/draft email` — composes, ENQUEUES the draft (is_draft=true) to the customer's email,
   *  opens the audit decision, and presents Approve/Edit/Reject in the customer's topic. NEVER
   *  auto-sent (the drainer skips is_draft=true). Returns the preview / a no-route refusal. */
  draftEmail?: (input: DraftEmailInput) => Promise<DraftEmailResult>;
  /** `/backfill` — start the change-03 sweep for a customer, reporting back to `threadId` when it
   *  finishes. Returns as soon as the sweep is ACCEPTED (it runs in the background and posts its
   *  own report): a sweep takes minutes, and the Telegram poll loop awaits this handler, so
   *  blocking on it would stall the whole founder surface. */
  startBackfill?: (customerId: string, threadId: string) => Promise<BackfillStart>;
  /** `/commitments` — open commitments for a customer (customerId given) or ALL customers (null).
   *  undefined = commitment tracking is off → the command reports it is unavailable. */
  listOpenCommitments?: (customerId: string | null) => Promise<CommitmentLine[]>;
  /** Post ONE commitment card (text + ✔ done / ✖ dismiss buttons) to the requesting thread. Wired
   *  alongside listOpenCommitments; a card needs buttons, which postAnswer cannot carry. */
  postCommitmentCard?: (threadId: string, text: string, buttons: Array<{ id: string; label: string }>) => Promise<void>;
}

/** A parsed leading slash command: the lowercased name (no `/`, no `@botname`) + the rest. */
export interface ParsedCommand {
  name: string;
  args: string;
}

/** Parse a leading `/command` (optionally `/command@botname`, case-insensitively) → its name +
 *  args, or null when the message is not a slash command (so the composite falls through). */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const sep = trimmed.search(/\s/);
  const token = sep === -1 ? trimmed : trimmed.slice(0, sep);
  const args = sep === -1 ? '' : trimmed.slice(sep + 1).trim();
  // Drop the leading slash + any @botname suffix; the whole first token IS the command name.
  const name = token.slice(1).replace(/@\S+$/, '').toLowerCase();
  if (!name) return null;
  return { name, args };
}

interface CommandContext {
  deps: SlashCommandDeps;
  threadId: string;
  args: string;
}

interface CommandSpec {
  /** The command name (no leading slash) — what the founder types after `/`. */
  name: string;
  /** Argument hint rendered by `/help` (e.g. `<keyword>`); omit for a no-arg command. */
  usage?: string;
  /** One-line help, listed by `/help`. */
  summary: string;
  run: (ctx: CommandContext) => Promise<void>;
}

/** `/pending` reply: just the two queue roll-ups (a lighter check than the full `/briefing`). */
function formatPending(data: BriefingData): string {
  return [
    '📥 Pending on you',
    queueLine('📝 Draft replies', data.drafts),
    queueLine('📋 Task proposals', data.proposals),
  ].join('\n');
}

async function runPending(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  const [drafts, proposals] = await Promise.all([deps.fetchPendingDrafts(), deps.fetchPendingProposals()]);
  const data = composeBriefing(drafts, proposals, deps.now(), { topN: deps.topN });
  deps.log.info({ command: 'pending', drafts: data.drafts.count, proposals: data.proposals.count }, 'slash: pending');
  await deps.postAnswer(ctx.threadId, formatPending(data));
}

async function runBriefing(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  const now = deps.now();
  const [drafts, proposals] = await Promise.all([deps.fetchPendingDrafts(), deps.fetchPendingProposals()]);
  const data = composeBriefing(drafts, proposals, now, { topN: deps.topN });
  // Reuse the daily digest render; post it to the REQUESTING thread (not the Admin topic) and
  // WITHOUT the once-a-day idempotency guard — an on-demand `/briefing` always answers.
  const n = renderBriefing(data, dayInTz(now, deps.tz));
  deps.log.info({ command: 'briefing', drafts: data.drafts.count, proposals: data.proposals.count }, 'slash: briefing');
  await deps.postAnswer(ctx.threadId, `${n.title}\n${n.body}`);
}

// ── Customer scoping ────────────────────────────────────────────────────────────────────────────

/** How a command resolved its customer, or why it could not. */
type CustomerScope =
  | { kind: 'customer'; customer: ResolvedCustomerRef }
  | { kind: 'none'; reason: string };

/**
 * Resolve the customer a command acts on:
 *   1. an explicit name argument (`/status acme`) — wins, so the founder can always override; then
 *   2. the TOPIC BINDING (agent_customers.telegram_topic_id = this thread) — a real binding: every
 *      customer topic is claimed at onboarding and the notifier already routes BY it. `/ask` chose
 *      not to use it (it forces the internal corpus and matches a name in the question instead),
 *      which is why it looked absent — but the column is the authoritative topic→customer link.
 *   3. otherwise → none, with a reason the founder can act on (the Admin topic has no customer).
 */
async function resolveCustomer(ctx: CommandContext, nameArg: string): Promise<CustomerScope> {
  const { deps } = ctx;
  if (nameArg) {
    if (!deps.findCustomerByName) return { kind: 'none', reason: 'Customer lookup is unavailable.' };
    const byName = await deps.findCustomerByName(nameArg);
    // Never echo the arg back — it is command text (logging rule is about logs, but the reply is
    // the founder's own text anyway; the count-only log below is what matters).
    if (!byName) return { kind: 'none', reason: 'I don\'t know a customer by that name.' };
    return { kind: 'customer', customer: byName };
  }
  if (deps.resolveThreadCustomer) {
    const byTopic = await deps.resolveThreadCustomer(ctx.threadId);
    if (byTopic) return { kind: 'customer', customer: byTopic };
  }
  return {
    kind: 'none',
    reason: 'This topic isn\'t bound to a customer — name one explicitly (e.g. `/status Acme`).',
  };
}

// ── /status ─────────────────────────────────────────────────────────────────────────────────────

function formatStatus(customer: ResolvedCustomerRef, tasks: OpenTaskLine[]): string {
  if (tasks.length === 0) return `📋 ${customer.customerName} — no open tasks. 🎉`;
  const lines = [`📋 Open tasks — ${customer.customerName} (${tasks.length})`];
  for (const t of tasks) lines.push(`  ${t.code ? `${t.code} · ` : ''}${t.status} — ${t.title}`);
  return lines.join('\n');
}

async function runStatus(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  if (!deps.listOpenTasks) {
    await deps.postAnswer(ctx.threadId, '⚠️ /status is unavailable — the task target isn\'t configured.');
    deps.log.info({ command: 'status', available: false }, 'slash: status unavailable');
    return;
  }
  const scope = await resolveCustomer(ctx, ctx.args);
  if (scope.kind === 'none') {
    deps.log.info({ command: 'status', scoped: false }, 'slash: status unscoped');
    await deps.postAnswer(ctx.threadId, `⚠️ ${scope.reason}`);
    return;
  }
  const tasks = await deps.listOpenTasks(scope.customer.customerId);
  if (tasks === null) {
    // No project bound → there is nowhere to read tasks from. Saying "no open tasks" here would be
    // a false all-clear, so name the actual gap instead.
    deps.log.info({ command: 'status', scoped: true, project: false }, 'slash: status no project');
    await deps.postAnswer(
      ctx.threadId,
      `⚠️ ${scope.customer.customerName} has no project bound, so I can't read their tasks.`,
    );
    return;
  }
  deps.log.info({ command: 'status', scoped: true, tasks: tasks.length }, 'slash: status');
  await deps.postAnswer(ctx.threadId, formatStatus(scope.customer, tasks));
}

// ── /summary ────────────────────────────────────────────────────────────────────────────────────

const SUMMARY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `/summary` — the 7-day digest. REUSES the briefing aggregation (composeBriefing) over the two
 * queues WINDOWED to the last 7 days, plus a carry-over count for what predates the window (those
 * items are the oldest and most urgent, so hiding them would make the digest lie by omission).
 * Renders with queueLine/humanizeAgeHours — the same roll-up the daily digest prints, no second one.
 */
function formatSummary(data: BriefingData, carriedOver: number, from: string, to: string): string {
  const parts = [
    `🗓️ ${SUMMARY_DAYS}-day summary — ${from} → ${to}`,
    queueLine('📝 Draft replies', data.drafts),
    queueLine('📋 Task proposals', data.proposals),
  ];
  if (data.topCustomers.length > 0) {
    parts.push('', 'Needs attention');
    for (const c of data.topCustomers) {
      const bits: string[] = [];
      if (c.draftCount > 0) bits.push(`${c.draftCount} draft${c.draftCount === 1 ? '' : 's'}`);
      if (c.proposalCount > 0) bits.push(`${c.proposalCount} proposal${c.proposalCount === 1 ? '' : 's'}`);
      parts.push(`  ${c.customerName ?? c.customerId}: ${bits.join(', ')} · oldest ${humanizeAgeHours(c.oldestAgeHours)}`);
    }
  }
  if (carriedOver > 0) {
    parts.push('', `⏳ Carried over from before this window: ${carriedOver} (older than ${SUMMARY_DAYS}d)`);
  } else if (data.drafts.count + data.proposals.count === 0) {
    parts.push('', `All clear — nothing arrived in the last ${SUMMARY_DAYS} days. 🎉`);
  }
  return parts.join('\n');
}

async function runSummary(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  const now = deps.now();
  const cutoff = now.getTime() - SUMMARY_DAYS * DAY_MS;
  const [drafts, proposals] = await Promise.all([deps.fetchPendingDrafts(), deps.fetchPendingProposals()]);
  const inWindow = (items: PendingItem[]): PendingItem[] => items.filter((i) => i.createdAt.getTime() >= cutoff);
  const wDrafts = inWindow(drafts);
  const wProposals = inWindow(proposals);
  const carriedOver = drafts.length - wDrafts.length + (proposals.length - wProposals.length);
  const data = composeBriefing(wDrafts, wProposals, now, { topN: deps.topN });
  deps.log.info(
    { command: 'summary', days: SUMMARY_DAYS, drafts: data.drafts.count, proposals: data.proposals.count, carriedOver },
    'slash: summary',
  );
  await deps.postAnswer(
    ctx.threadId,
    formatSummary(data, carriedOver, dayInTz(new Date(cutoff), deps.tz), dayInTz(now, deps.tz)),
  );
}

// ── /history ────────────────────────────────────────────────────────────────────────────────────

/** Max hits rendered per leg — a Telegram reply the founder can actually scan. */
const HISTORY_PER_LEG = 3;
/** Max snippet chars per hit. */
const HISTORY_SNIPPET = 200;

function clip(s: string): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > HISTORY_SNIPPET ? `${flat.slice(0, HISTORY_SNIPPET)}…` : flat;
}

function formatHistoryLeg(label: string, result: HistoryLegResult | null): string[] {
  if (result === null) return [`${label} — unavailable`];
  if (result.hits.length === 0) return [`${label} (0)`];
  const shown = result.hits.slice(0, HISTORY_PER_LEG);
  const more = result.hits.length - shown.length;
  const lines = [`${label} (${result.hits.length}${result.capped ? '+' : ''})`];
  for (const h of shown) {
    const when = h.at ? h.at.toISOString().slice(0, 10) : '—';
    const who = h.who ? ` · ${h.who}` : '';
    lines.push(`  ${when}${who} — ${clip(h.snippet)}`);
  }
  if (more > 0) lines.push(`  …and ${more} more`);
  return lines;
}

/** Run one leg without letting it fail the whole command: a dead leg reports "unavailable" and the
 *  other two still answer (three independent sources — one being down is not a `/history` failure). */
async function safeLeg(
  fn: ((keyword: string, customerId: string | null) => Promise<HistoryLegResult>) | undefined,
  keyword: string,
  customerId: string | null,
): Promise<HistoryLegResult | null> {
  if (!fn) return null;
  try {
    return await fn(keyword, customerId);
  } catch {
    return null; // reason is not logged: it can carry the query text
  }
}

async function runHistory(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  const keyword = ctx.args;
  if (!keyword) {
    await deps.postAnswer(ctx.threadId, 'Usage: /history <keyword> — I search the inbox, memory and WhatsApp history.');
    return;
  }
  if (!deps.searchInboxHistory && !deps.searchMemoryHistory && !deps.searchWhatsAppHistory) {
    deps.log.info({ command: 'history', available: false }, 'slash: history unavailable');
    await deps.postAnswer(ctx.threadId, '⚠️ /history is unavailable — no history source is configured.');
    return;
  }
  // Scope to the topic's customer when there is one; the Admin topic searches cross-customer.
  const scoped = deps.resolveThreadCustomer ? await deps.resolveThreadCustomer(ctx.threadId) : null;
  const customerId = scoped?.customerId ?? null;

  const [inbox, memory, whatsapp] = await Promise.all([
    safeLeg(deps.searchInboxHistory, keyword, customerId),
    safeLeg(deps.searchMemoryHistory, keyword, customerId),
    safeLeg(deps.searchWhatsAppHistory, keyword, customerId),
  ]);

  // Counts + availability flags ONLY — never the keyword, never a snippet (PII posture).
  deps.log.info(
    {
      command: 'history',
      scoped: customerId !== null,
      inbox: inbox?.hits.length ?? null,
      memory: memory?.hits.length ?? null,
      whatsapp: whatsapp?.hits.length ?? null,
    },
    'slash: history',
  );

  const header = scoped ? `🔎 History — ${scoped.customerName}` : '🔎 History — all customers';
  const lines = [
    header,
    ...formatHistoryLeg('📥 Inbox', inbox),
    // Memory scope isolation means an unscoped search reaches SHARED rows only — never a sweep
    // across tenants. Say so, or an empty leg in the Admin topic reads as "no such memory exists".
    ...formatHistoryLeg(scoped ? '🧠 Memory' : '🧠 Memory (shared only)', memory),
    ...formatHistoryLeg('💬 WhatsApp', whatsapp),
  ];
  await deps.postAnswer(ctx.threadId, lines.join('\n'));
}

// ── /draft email ────────────────────────────────────────────────────────────────────────────────

/** The founder confirmation after a `/draft email` is queued. The full draft + buttons are
 *  presented on the card just above (same topic); this is a short ack, not a second copy. */
function formatDraftEmailQueued(recipient: string, grounded: boolean, cited: number): string {
  const lines = [`✉️ Draft to ${recipient} queued for approval.`, 'Use ✅ Approve / ✏️ Edit / 🚫 Reject on the card above — nothing sends until you approve.'];
  if (!grounded) {
    lines.push('⚠️ Ungrounded — I found no matching knowledge, so it is phrasing only. Check the facts before approving.');
  } else if (cited > 0) {
    lines.push(`Grounded in ${cited} source${cited === 1 ? '' : 's'} (listed on the card).`);
  }
  return lines.join('\n');
}

async function runDraft(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  if (!deps.draftEmail) {
    deps.log.info({ command: 'draft', available: false }, 'slash: draft unavailable');
    await deps.postAnswer(ctx.threadId, '⚠️ /draft is unavailable — the drafter is disabled (KNOWLEDGE_DRAFT_ENABLED=false).');
    return;
  }
  // Only `email` exists today; the subcommand is explicit so `/draft whatsapp …` can join later
  // without changing what `/draft email` means.
  const match = /^email\b/i.exec(ctx.args);
  if (!match) {
    await deps.postAnswer(ctx.threadId, 'Usage: /draft email <what to say> — I draft it in the customer\'s language, grounded in their knowledge.');
    return;
  }
  const prompt = ctx.args.slice(match[0].length).trim();
  if (!prompt) {
    await deps.postAnswer(ctx.threadId, 'Usage: /draft email <what to say> — tell me what the email should say.');
    return;
  }
  // A draft needs a customer: their language, their name, their knowledge. The topic binding is the
  // natural source; the Admin topic has none, so it must be named.
  const scope = await resolveCustomer(ctx, '');
  if (scope.kind === 'none') {
    deps.log.info({ command: 'draft', scoped: false }, 'slash: draft unscoped');
    await deps.postAnswer(ctx.threadId, '⚠️ Run /draft email in a customer\'s topic — I draft in their language, grounded in their knowledge.');
    return;
  }
  const result = await deps.draftEmail({ prompt, customer: scope.customer });
  if (!result.ok) {
    // No email contact / no sending account → an honest in-topic refusal (nothing composed
    // or queued), mirroring how the command surfaces every other missing prerequisite.
    deps.log.info({ command: 'draft', kind: 'email', enqueued: false, reason: result.reason }, 'slash: draft email no route');
    await deps.postAnswer(
      ctx.threadId,
      `⚠️ I can't draft an email to ${scope.customer.customerName} — they have no email contact or sending account configured.`,
    );
    return;
  }
  // Counts/flags ONLY — never the prompt, never the drafted body. The draft card + buttons
  // were already presented in this topic; here we just confirm it is queued for approval.
  deps.log.info(
    { command: 'draft', kind: 'email', enqueued: true, grounded: result.grounded, cited: result.citations.length },
    'slash: draft email',
  );
  await deps.postAnswer(ctx.threadId, formatDraftEmailQueued(result.recipient, result.grounded, result.citations.length));
}

// ── /backfill ───────────────────────────────────────────────────────────────────────────────────

async function runBackfillCommand(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  if (!deps.startBackfill) {
    deps.log.info({ command: 'backfill', available: false }, 'slash: backfill unavailable');
    await deps.postAnswer(ctx.threadId, '⚠️ /backfill is unavailable — the sweep is disabled (BACKFILL_ENABLED=false).');
    return;
  }
  const scope = await resolveCustomer(ctx, ctx.args);
  if (scope.kind === 'none') {
    deps.log.info({ command: 'backfill', scoped: false }, 'slash: backfill unscoped');
    await deps.postAnswer(ctx.threadId, `⚠️ ${scope.reason}`);
    return;
  }
  const outcome = await deps.startBackfill(scope.customer.customerId, ctx.threadId);
  deps.log.info({ command: 'backfill', outcome }, 'slash: backfill');
  const text =
    outcome === 'already-running'
      ? `🔄 A backfill is already running for ${scope.customer.customerName} — it fills the same memory, so I'll let it finish.`
      : `🔄 Backfill started for ${scope.customer.customerName}. It runs in the background (minutes) — I'll post the report here when it's done, and any task proposals as approval cards.`;
  await deps.postAnswer(ctx.threadId, text);
}

// ── /commitments ──────────────────────────────────────────────────────────────────────────────────

/** Max commitment cards posted per `/commitments` — one Telegram message each, so bound the fan-out;
 *  the header names the true total and the tail says how many were not shown. */
const MAX_COMMITMENT_CARDS = 20;

/** Compact due suffix for a commitment card: overdue is flagged, an upcoming deadline names the day
 *  (week-precision hints render "~" to signal the softer target); no deadline renders nothing. */
function dueSuffix(c: CommitmentLine, now: Date, tz: string): string {
  if (!c.dueAt) return '';
  const fmt = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz });
  const when = fmt.format(c.dueAt);
  if (c.dueAt.getTime() < now.getTime()) return ` · ⚠️ overdue (was ${when})`;
  const approx = c.duePrecision === 'week' ? '~' : '';
  return ` · due ${approx}${when}`;
}

/** One commitment card body: the promise text, its age, and the due suffix; the customer name is
 *  prefixed only on the all-customers listing (a scoped list already names them in the header). */
function formatCommitmentCard(c: CommitmentLine, showCustomer: boolean, now: Date, tz: string): string {
  const ageHours = Math.max(0, Math.floor((now.getTime() - c.createdAt.getTime()) / (60 * 60 * 1000)));
  const who = showCustomer && c.customerName ? `${c.customerName}: ` : '';
  return `⏰ ${who}${c.text}\n${humanizeAgeHours(ageHours)} old${dueSuffix(c, now, tz)}`;
}

async function runCommitments(ctx: CommandContext): Promise<void> {
  const { deps } = ctx;
  if (!deps.listOpenCommitments || !deps.postCommitmentCard) {
    deps.log.info({ command: 'commitments', available: false }, 'slash: commitments unavailable');
    await deps.postAnswer(ctx.threadId, '⚠️ /commitments is unavailable — commitment tracking is off (COMMITMENT_TRACKING_ENABLED=false).');
    return;
  }
  // Scope: an explicit name wins; else the topic binding; else (Admin, no arg) → ALL customers.
  const arg = ctx.args.trim();
  let scopeId: string | null;
  let scopeName: string | null;
  if (arg) {
    if (!deps.findCustomerByName) {
      await deps.postAnswer(ctx.threadId, '⚠️ Customer lookup is unavailable.');
      return;
    }
    const byName = await deps.findCustomerByName(arg);
    if (!byName) {
      await deps.postAnswer(ctx.threadId, "⚠️ I don't know a customer by that name.");
      return;
    }
    scopeId = byName.customerId;
    scopeName = byName.customerName;
  } else {
    const byTopic = deps.resolveThreadCustomer ? await deps.resolveThreadCustomer(ctx.threadId) : null;
    scopeId = byTopic?.customerId ?? null;
    scopeName = byTopic?.customerName ?? null;
  }

  const items = await deps.listOpenCommitments(scopeId);
  deps.log.info({ command: 'commitments', scoped: scopeId !== null, count: items.length }, 'slash: commitments');

  const header = scopeName ? `⏰ Open commitments — ${scopeName} (${items.length})` : `⏰ Open commitments — all customers (${items.length})`;
  if (items.length === 0) {
    await deps.postAnswer(ctx.threadId, `${header}\nNothing open. 🎉`);
    return;
  }
  await deps.postAnswer(ctx.threadId, header);
  const now = deps.now();
  const shown = items.slice(0, MAX_COMMITMENT_CARDS);
  for (const c of shown) {
    await deps.postCommitmentCard(ctx.threadId, formatCommitmentCard(c, scopeId === null, now, deps.tz), [
      { id: `${COMMITMENT_DONE_OPTION}:${c.id}`, label: '✔ done' },
      { id: `${COMMITMENT_DISMISS_OPTION}:${c.id}`, label: '✖ dismiss' },
    ]);
  }
  if (items.length > shown.length) {
    await deps.postAnswer(ctx.threadId, `…and ${items.length - shown.length} more not shown.`);
  }
}

// ── Registry ────────────────────────────────────────────────────────────────────────────────────

/** `/help` renders the command registry (this router's commands). `/ask` is a separate handler
 *  (its own gate) and is intentionally not listed here. */
function formatHelp(): string {
  const lines = ['🛠️ Commands'];
  for (const c of COMMANDS) lines.push(`/${c.name}${c.usage ? ` ${c.usage}` : ''} — ${c.summary}`);
  return lines.join('\n');
}

async function runHelp(ctx: CommandContext): Promise<void> {
  ctx.deps.log.info({ command: 'help' }, 'slash: help');
  await ctx.deps.postAnswer(ctx.threadId, formatHelp());
}

/** The command registry — the single source of truth for dispatch AND `/help`. */
const COMMANDS: readonly CommandSpec[] = [
  { name: 'pending', summary: 'Counts + oldest age of pending draft replies and task proposals.', run: runPending },
  { name: 'briefing', summary: 'Post the daily founder briefing on demand.', run: runBriefing },
  {
    name: 'status',
    usage: '[customer]',
    summary: 'Open tasks for this topic\'s customer (or a named one).',
    run: runStatus,
  },
  { name: 'summary', summary: `What arrived in the last ${SUMMARY_DAYS} days, plus what carried over.`, run: runSummary },
  {
    name: 'history',
    usage: '<keyword>',
    summary: 'Search the inbox, memory and WhatsApp history.',
    run: runHistory,
  },
  {
    name: 'draft',
    usage: 'email <prompt>',
    summary: 'Draft a customer email → Approve/Edit/Reject card (never auto-sent).',
    run: runDraft,
  },
  {
    name: 'backfill',
    usage: '[customer]',
    summary: 'Re-run the history sweep that seeds memory + task proposals.',
    run: runBackfillCommand,
  },
  {
    name: 'commitments',
    usage: '[customer]',
    summary: 'Open promises you made — ✔ done / ✖ dismiss per item.',
    run: runCommitments,
  },
  { name: 'help', summary: 'List the available commands.', run: runHelp },
];

/**
 * Build the slash-command router. Returns a fn that:
 *  • returns false when the message is NOT a registered command (composite falls through — this
 *    includes `/ask`, handled by its own handler, and any unknown `/…`);
 *  • otherwise → runs the command, posts the reply, returns true (consumed).
 * A read/render failure is caught and reported to the founder (founder tool surfaces failures) —
 * it still returns true (the command WAS consumed).
 */
export function buildSlashCommandRouter(deps: SlashCommandDeps): (m: MessageEvent) => Promise<boolean> {
  const byName = new Map(COMMANDS.map((c) => [c.name, c]));
  return async ({ threadId, text }: MessageEvent): Promise<boolean> => {
    const parsed = parseCommand(text);
    if (parsed === null) return false; // not a slash command → fall through
    const cmd = byName.get(parsed.name);
    if (!cmd) return false; // not one of ours (e.g. /ask, or unknown) → fall through

    try {
      await cmd.run({ deps, threadId, args: parsed.args });
    } catch (err) {
      const reason = (err as Error)?.message ?? 'unknown';
      deps.log.error({ command: parsed.name, reason }, 'slash: command failed');
      await deps.postAnswer(threadId, `⚠️ Couldn't run /${parsed.name} right now: ${reason}`);
    }
    return true;
  };
}
