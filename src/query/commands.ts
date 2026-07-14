import type { MessageEvent } from '../ports/founder-notifier.port';
import {
  composeBriefing,
  renderBriefing,
  queueLine,
  dayInTz,
  type BriefingData,
  type PendingItem,
} from './daily-briefing';

// Telegram founder slash-command surface (M5(c) — CORE, injected ports only; the concrete
// queue reads + notifier are wired at the composition root, so this never imports src/adapters
// — D1 boundary). A founder types a leading `/pending` / `/briefing` / `/help` in a topic → the
// router dispatches → the reply is posted back to the SAME thread. Mirrors ask-command.ts (which
// stays its OWN handler for `/ask`): each handler returns whether it CONSUMED the message so both
// compose into the notifier's single onMessage router; a non-command (or an unknown command) falls
// through (returns false) to the ✏️ Edit / 🔁 Revise free-text captures.
//
// REUSE: the pending-queue readers and the digest aggregation/render come from daily-briefing.ts
// (composeBriefing/renderBriefing/queueLine) — this file adds NO new queue query. PII posture:
// like the briefing, replies carry customer NAMES + counts + ages only, NEVER a message/draft/
// proposal body. NEVER logs command text or answer bodies — the command NAME + counts/flags only
// (dispatch is reached only for a REGISTERED command name, never free text).

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

/** `/help` renders the command registry (this router's commands). `/ask` is a separate handler
 *  (its own gate) and is intentionally not listed here. */
function formatHelp(): string {
  const lines = ['🛠️ Commands'];
  for (const c of COMMANDS) lines.push(`/${c.name} — ${c.summary}`);
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
