import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSlashCommandRouter, parseCommand } from './commands';
import type { PendingItem } from './daily-briefing';
import type { MessageEvent } from '../ports/founder-notifier.port';

// Unit tests for the Telegram slash-command router (CORE, injected — no Telegram, no DB).
// Covers: command parsing (incl. @botname + non-command / unknown fall-through); the router
// CONSUMES /pending, /briefing, /help and posts the reply back to the SAME thread; a non-command
// (and /ask — handled by its OWN handler) is NOT consumed (returns false → the composite router
// falls through to the free-text captures); a read failure is reported to the founder.
//
// Task 2.1 adds /status, /summary, /history, /draft email and /backfill. Each capability is an
// OPTIONAL injected dep, so every command is tested three ways: dispatch + reply shape, the
// dep-absent (feature-off) degrade, and an error path. The PII posture is tested too: the log
// records the command NAME + counts/flags and NEVER the command text or a returned body.

const silentLog = { info: () => {}, error: () => {} };

const NOW = new Date('2026-07-14T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);
const daysAgo = (d: number): Date => hoursAgo(d * 24);

function collector() {
  const posts: Array<{ threadId: string; text: string }> = [];
  return { posts, postAnswer: async (threadId: string, text: string) => void posts.push({ threadId, text }) };
}

/** Captures every structured log payload so a test can assert what is (and isn't) recorded. */
function logSpy() {
  const entries: Array<{ o: object; m: string }> = [];
  return {
    entries,
    log: {
      info: (o: object, m: string) => void entries.push({ o, m }),
      error: (o: object, m: string) => void entries.push({ o, m }),
    },
  };
}

const msg = (text: string): MessageEvent => ({ chatId: '-100', messageId: '1', threadId: '77', text, by: 'founder' });

const ACME = { customerId: 'cus_1', customerName: 'Acme' };

function deps(over: Partial<Parameters<typeof buildSlashCommandRouter>[0]> = {}) {
  const c = collector();
  const base = {
    fetchPendingDrafts: async (): Promise<PendingItem[]> => [],
    fetchPendingProposals: async (): Promise<PendingItem[]> => [],
    postAnswer: c.postAnswer,
    now: () => NOW,
    tz: 'America/Panama',
    topN: 5,
    log: silentLog,
    ...over,
  };
  return { c, base, router: buildSlashCommandRouter(base) };
}

test('parseCommand: matches /cmd, /cmd@bot, case-insensitively; splits args; null for non-commands', () => {
  assert.deepEqual(parseCommand('/pending'), { name: 'pending', args: '' });
  assert.deepEqual(parseCommand('  /BRIEFING  '), { name: 'briefing', args: '' });
  assert.deepEqual(parseCommand('/help@ao_brain_bot me'), { name: 'help', args: 'me' });
  assert.deepEqual(parseCommand('/status acme corp'), { name: 'status', args: 'acme corp' });
  assert.equal(parseCommand('just a normal message'), null);
  assert.equal(parseCommand('/'), null, 'bare slash is not a command');
});

test('router CONSUMES /pending: reads both queues and posts counts + oldest age to the same thread', async () => {
  const { c, router } = deps({
    fetchPendingDrafts: async () => [{ customerId: 'a', customerName: 'Acme', createdAt: hoursAgo(5) }],
    fetchPendingProposals: async () => [],
  });

  const consumed = await router(msg('/pending'));

  assert.equal(consumed, true, '/pending is consumed (does not fall through to the edit capture)');
  assert.equal(c.posts.length, 1);
  assert.equal(c.posts[0].threadId, '77', 'reply posted back to the same thread');
  assert.match(c.posts[0].text, /Draft replies: 1 pending · oldest 5h/);
  assert.match(c.posts[0].text, /Task proposals: none pending/);
});

test('router CONSUMES /briefing: posts the rendered digest (title + needs-attention) to the thread', async () => {
  const { c, router } = deps({
    fetchPendingDrafts: async () => [{ customerId: 'a', customerName: 'Acme', createdAt: hoursAgo(30) }],
    fetchPendingProposals: async () => [{ customerId: 'a', customerName: 'Acme', createdAt: hoursAgo(2) }],
  });

  const consumed = await router(msg('/briefing'));

  assert.equal(consumed, true);
  assert.match(c.posts[0].text, /Daily briefing — 2026-07-14/);
  assert.match(c.posts[0].text, /Needs attention/);
  assert.match(c.posts[0].text, /Acme: 1 draft, 1 proposal/);
});

test('router CONSUMES /help: lists the registered commands (registry is the single source)', async () => {
  const { c, router } = deps();

  const consumed = await router(msg('/help'));

  assert.equal(consumed, true);
  // Every command in the registry is listed — /help renders FROM the registry, so a new command
  // appears here automatically. This is the assertion that task 2.2's contract still holds.
  assert.match(c.posts[0].text, /\/pending —/);
  assert.match(c.posts[0].text, /\/briefing —/);
  assert.match(c.posts[0].text, /\/status \[customer\] —/);
  assert.match(c.posts[0].text, /\/summary —/);
  assert.match(c.posts[0].text, /\/history <keyword> —/);
  assert.match(c.posts[0].text, /\/draft email <prompt> —/);
  assert.match(c.posts[0].text, /\/backfill \[customer\] —/);
  assert.match(c.posts[0].text, /\/help —/);
  assert.doesNotMatch(c.posts[0].text, /\/ask/, '/ask is a separate handler, not listed here');
});

test('router does NOT consume a non-command, /ask, or an unknown command (composite falls through)', async () => {
  const { c, router } = deps({
    fetchPendingDrafts: async () => { throw new Error('should not be called'); },
  });

  assert.equal(await router(msg('this is the replacement draft body')), false, 'free text falls through');
  assert.equal(await router(msg('/ask how does dedup work?')), false, '/ask is handled elsewhere');
  assert.equal(await router(msg('/frobnicate')), false, 'unknown command falls through');
  assert.equal(c.posts.length, 0, 'nothing posted, no queue read for fall-through messages');
});

test('a read failure is reported to the founder (founder tool surfaces failures), still consumed', async () => {
  const { c, router } = deps({
    fetchPendingDrafts: async () => { throw new Error('db unavailable'); },
  });

  const consumed = await router(msg('/pending'));

  assert.equal(consumed, true);
  assert.match(c.posts[0].text, /Couldn't run \/pending right now: db unavailable/);
});

// ── /status ─────────────────────────────────────────────────────────────────────────────────────

test('/status: resolves the customer from the TOPIC binding and lists their open tasks', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async (threadId) => (threadId === '77' ? ACME : null),
    listOpenTasks: async (customerId) => {
      assert.equal(customerId, 'cus_1', 'the topic-bound customer is what gets queried');
      return [
        { code: 'TSK-1', title: 'Fix the login redirect', status: 'in progress' },
        { code: null, title: 'Ship the invoice export', status: 'todo' },
      ];
    },
  });

  assert.equal(await router(msg('/status')), true);
  assert.match(c.posts[0].text, /Open tasks — Acme \(2\)/);
  assert.match(c.posts[0].text, /TSK-1 · in progress — Fix the login redirect/);
  assert.match(c.posts[0].text, /todo — Ship the invoice export/, 'a code-less task still renders');
});

test('/status <name>: an explicit customer argument overrides the topic binding', async () => {
  let asked: string | null = null;
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    findCustomerByName: async (name) => (name === 'globex' ? { customerId: 'cus_2', customerName: 'Globex' } : null),
    listOpenTasks: async (customerId) => {
      asked = customerId;
      return [];
    },
  });

  assert.equal(await router(msg('/status globex')), true);
  assert.equal(asked, 'cus_2', 'the NAMED customer wins over the topic the command was typed in');
  assert.match(c.posts[0].text, /Globex — no open tasks/);
});

test('/status: an unbound topic with no argument asks for a customer instead of guessing', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => null, // the Admin topic
    listOpenTasks: async () => { throw new Error('should not be called'); },
  });

  assert.equal(await router(msg('/status')), true);
  assert.match(c.posts[0].text, /isn't bound to a customer/);
});

test('/status: no project bound reports the gap — NOT a false "no open tasks" all-clear', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    listOpenTasks: async () => null, // null = no projectRef (distinct from [])
  });

  assert.equal(await router(msg('/status')), true);
  assert.match(c.posts[0].text, /no project bound/);
  assert.doesNotMatch(c.posts[0].text, /no open tasks/, 'never reports an all-clear it cannot verify');
});

test('/status: degrades honestly when the task target is not wired', async () => {
  const { c, router } = deps({ listOpenTasks: undefined });

  assert.equal(await router(msg('/status')), true, 'still consumed — it IS our command');
  assert.match(c.posts[0].text, /\/status is unavailable/);
});

test('/status: a task-target failure is reported to the founder, still consumed', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    listOpenTasks: async () => { throw new Error('portal 503'); },
  });

  assert.equal(await router(msg('/status')), true);
  assert.match(c.posts[0].text, /Couldn't run \/status right now: portal 503/);
});

// ── /summary ────────────────────────────────────────────────────────────────────────────────────

test('/summary: rolls up the last 7 days and counts older items as carried over', async () => {
  const { c, router } = deps({
    fetchPendingDrafts: async () => [
      { customerId: 'a', customerName: 'Acme', createdAt: daysAgo(2) }, // in window
      { customerId: 'a', customerName: 'Acme', createdAt: daysAgo(30) }, // carried over
    ],
    fetchPendingProposals: async () => [{ customerId: 'a', customerName: 'Acme', createdAt: daysAgo(1) }],
  });

  assert.equal(await router(msg('/summary')), true);
  const text = c.posts[0].text;
  assert.match(text, /7-day summary — 2026-07-07 → 2026-07-14/);
  assert.match(text, /Draft replies: 1 pending/, 'only the in-window draft is rolled up');
  assert.match(text, /Task proposals: 1 pending/);
  assert.match(text, /Acme: 1 draft, 1 proposal/);
  assert.match(text, /Carried over from before this window: 1/, 'the 30-day-old item is surfaced, not hidden');
});

test('/summary: an empty window posts an all-clear (the command always answers)', async () => {
  const { c, router } = deps();

  assert.equal(await router(msg('/summary')), true);
  assert.match(c.posts[0].text, /All clear — nothing arrived in the last 7 days/);
});

test('/summary: a queue read failure is reported to the founder, still consumed', async () => {
  const { c, router } = deps({
    fetchPendingProposals: async () => { throw new Error('db unavailable'); },
  });

  assert.equal(await router(msg('/summary')), true);
  assert.match(c.posts[0].text, /Couldn't run \/summary right now: db unavailable/);
});

// ── /history ────────────────────────────────────────────────────────────────────────────────────

test('/history <kw>: searches all three legs and renders each leg with its hits', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    searchInboxHistory: async (kw, customerId) => {
      assert.equal(kw, 'invoice');
      assert.equal(customerId, 'cus_1', 'the topic scopes the search to that customer');
      return { hits: [{ at: new Date('2026-07-10T09:00:00Z'), who: 'jane@acme.com', snippet: 'Invoice 42 is overdue' }] };
    },
    searchMemoryHistory: async () => ({ hits: [{ at: null, who: 'Billing › Terms', snippet: 'Invoices are net-30.' }] }),
    searchWhatsAppHistory: async () => ({ hits: [{ at: new Date('2026-07-11T10:00:00Z'), who: 'Jane', snippet: 'sent the invoice' }] }),
  });

  assert.equal(await router(msg('/history invoice')), true);
  const text = c.posts[0].text;
  assert.match(text, /History — Acme/);
  assert.match(text, /📥 Inbox \(1\)/);
  assert.match(text, /2026-07-10 · jane@acme.com — Invoice 42 is overdue/);
  assert.match(text, /🧠 Memory \(1\)/);
  assert.match(text, /Billing › Terms — Invoices are net-30./);
  assert.match(text, /💬 WhatsApp \(1\)/);
});

test('/history: an unbound topic searches cross-customer and says so', async () => {
  let scope: string | null | undefined;
  const { c, router } = deps({
    resolveThreadCustomer: async () => null, // the Admin topic
    searchInboxHistory: async (_kw, customerId) => {
      scope = customerId;
      return { hits: [] };
    },
  });

  assert.equal(await router(msg('/history invoice')), true);
  assert.equal(scope, null, 'no customer binding → an unscoped search');
  assert.match(c.posts[0].text, /History — all customers/);
  // Memory isolation makes an unscoped memory search shared-only; the label must not overclaim.
  assert.match(c.posts[0].text, /🧠 Memory \(shared only\)/);
});

test('/history: ONE dead leg reports unavailable; the other legs still answer', async () => {
  const { c, router } = deps({
    searchInboxHistory: async () => { throw new Error('db down'); },
    searchMemoryHistory: async () => ({ hits: [{ at: null, who: null, snippet: 'a memory' }] }),
    searchWhatsAppHistory: undefined, // not configured
  });

  assert.equal(await router(msg('/history invoice')), true);
  const text = c.posts[0].text;
  assert.match(text, /📥 Inbox — unavailable/, 'a failing leg is named, not silently empty');
  assert.match(text, /🧠 Memory \(shared only\) \(1\)/, 'the healthy leg still answers');
  assert.match(text, /💬 WhatsApp — unavailable/, 'an unwired leg is honest too');
});

test('/history: no keyword posts usage; no leg wired at all degrades honestly', async () => {
  const withLegs = deps({ searchInboxHistory: async () => ({ hits: [] }) });
  assert.equal(await withLegs.router(msg('/history')), true);
  assert.match(withLegs.c.posts[0].text, /Usage: \/history <keyword>/);

  const noLegs = deps();
  assert.equal(await noLegs.router(msg('/history invoice')), true);
  assert.match(noLegs.c.posts[0].text, /\/history is unavailable/);
});

test('/history: PII posture — logs the command name + per-leg COUNTS, never the keyword or a snippet', async () => {
  const spy = logSpy();
  const { router } = deps({
    log: spy.log,
    resolveThreadCustomer: async () => ACME,
    searchInboxHistory: async () => ({ hits: [{ at: null, who: 'jane@acme.com', snippet: 'SECRET BODY TEXT' }] }),
    searchMemoryHistory: async () => ({ hits: [] }),
  });

  await router(msg('/history acme-secret-keyword'));

  const serialized = JSON.stringify(spy.entries);
  assert.match(serialized, /"command":"history"/, 'the command NAME is logged');
  assert.match(serialized, /"inbox":1/, 'counts are logged');
  assert.doesNotMatch(serialized, /acme-secret-keyword/, 'the command TEXT is never logged');
  assert.doesNotMatch(serialized, /SECRET BODY TEXT/, 'a returned snippet is never logged');
});

// ── /draft email ────────────────────────────────────────────────────────────────────────────────

test('/draft email <prompt>: enqueues for the topic customer and confirms it is queued for approval', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    draftEmail: async ({ prompt, customer }) => {
      assert.equal(prompt, 'tell them the invoice is late', 'the subcommand token is stripped from the prompt');
      assert.equal(customer.customerId, 'cus_1');
      return { ok: true, recipient: 'Acme Billing', grounded: true, citations: ['Billing › Terms'] };
    },
  });

  assert.equal(await router(msg('/draft email tell them the invoice is late')), true);
  const text = c.posts[0].text;
  assert.match(text, /Draft to Acme Billing queued for approval/);
  assert.match(text, /Approve .* Edit .* Reject/);
  assert.match(text, /nothing sends until you approve/);
  assert.match(text, /Grounded in 1 source/);
});

test('/draft email: an ungrounded draft says so rather than implying it is sourced', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    draftEmail: async () => ({ ok: true, recipient: 'Acme', grounded: false, citations: [] }),
  });

  assert.equal(await router(msg('/draft email anything')), true);
  assert.match(c.posts[0].text, /Ungrounded — I found no matching knowledge/);
});

test('/draft email: no email contact/account → an honest in-topic refusal, nothing queued', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    draftEmail: async () => ({ ok: false, reason: 'no_email_route' }),
  });

  assert.equal(await router(msg('/draft email hi')), true);
  assert.match(c.posts[0].text, /can't draft an email to Acme — they have no email contact or sending account/);
});

test('/draft email: usage for a missing/unknown subcommand or prompt; customer topic required', async () => {
  const noSub = deps({ draftEmail: async () => ({ ok: true, recipient: 'x', grounded: true, citations: [] }) });
  assert.equal(await noSub.router(msg('/draft')), true);
  assert.match(noSub.c.posts[0].text, /Usage: \/draft email <what to say>/);

  const noPrompt = deps({ draftEmail: async () => ({ ok: true, recipient: 'x', grounded: true, citations: [] }) });
  assert.equal(await noPrompt.router(msg('/draft email')), true);
  assert.match(noPrompt.c.posts[0].text, /tell me what the email should say/);

  const unbound = deps({
    resolveThreadCustomer: async () => null,
    draftEmail: async () => { throw new Error('should not be called'); },
  });
  assert.equal(await unbound.router(msg('/draft email hi')), true);
  assert.match(unbound.c.posts[0].text, /Run \/draft email in a customer's topic/);
});

test('/draft email: degrades honestly when the drafter is disabled (KNOWLEDGE_DRAFT_ENABLED=false)', async () => {
  const { c, router } = deps({ draftEmail: undefined });

  assert.equal(await router(msg('/draft email hi')), true);
  assert.match(c.posts[0].text, /\/draft is unavailable — the drafter is disabled/);
});

test('/draft email: an LLM failure is reported to the founder, still consumed', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    draftEmail: async () => { throw new Error('llm daily cap reached'); },
  });

  assert.equal(await router(msg('/draft email hi')), true);
  assert.match(c.posts[0].text, /Couldn't run \/draft right now: llm daily cap reached/);
});

test('/draft email: PII posture — logs flags/counts only, never the prompt or the drafted body', async () => {
  const spy = logSpy();
  const { router } = deps({
    log: spy.log,
    resolveThreadCustomer: async () => ACME,
    draftEmail: async () => ({ ok: true, recipient: 'Acme', grounded: true, citations: ['Billing'] }),
  });

  await router(msg('/draft email mention the secret-project-codename'));

  const serialized = JSON.stringify(spy.entries);
  assert.match(serialized, /"command":"draft"/);
  assert.match(serialized, /"grounded":true/);
  assert.match(serialized, /"cited":1/);
  assert.doesNotMatch(serialized, /secret-project-codename/, 'the prompt is never logged');
});

// ── /backfill ───────────────────────────────────────────────────────────────────────────────────

test('/backfill: starts the sweep for the topic customer and acks that it runs in the background', async () => {
  const started: Array<{ customerId: string; threadId: string }> = [];
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    startBackfill: async (customerId, threadId) => {
      started.push({ customerId, threadId });
      return 'started';
    },
  });

  assert.equal(await router(msg('/backfill')), true);
  assert.deepEqual(started, [{ customerId: 'cus_1', threadId: '77' }], 'the report goes back to the asking thread');
  assert.match(c.posts[0].text, /Backfill started for Acme/);
  assert.match(c.posts[0].text, /runs in the background/);
});

test('/backfill: an in-flight sweep is reported as already-running, NOT as an error', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    startBackfill: async () => 'already-running',
  });

  assert.equal(await router(msg('/backfill')), true);
  assert.match(c.posts[0].text, /already running for Acme/);
  assert.doesNotMatch(c.posts[0].text, /⚠️/, 'a concurrent sweep is a normal outcome, not a failure');
});

test('/backfill <name>: an explicit customer works from an unbound topic', async () => {
  let asked: string | null = null;
  const { c, router } = deps({
    resolveThreadCustomer: async () => null,
    findCustomerByName: async () => ({ customerId: 'cus_2', customerName: 'Globex' }),
    startBackfill: async (customerId) => {
      asked = customerId;
      return 'started';
    },
  });

  assert.equal(await router(msg('/backfill globex')), true);
  assert.equal(asked, 'cus_2');
  assert.match(c.posts[0].text, /Backfill started for Globex/);
});

test('/backfill: an unknown customer name is refused rather than sweeping the wrong customer', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    findCustomerByName: async () => null, // unknown / ambiguous
    startBackfill: async () => { throw new Error('should not be called'); },
  });

  assert.equal(await router(msg('/backfill nope')), true);
  assert.match(c.posts[0].text, /don't know a customer by that name/);
});

test('/backfill: degrades honestly when the sweep is disabled (BACKFILL_ENABLED=false)', async () => {
  const { c, router } = deps({ startBackfill: undefined });

  assert.equal(await router(msg('/backfill')), true);
  assert.match(c.posts[0].text, /\/backfill is unavailable — the sweep is disabled/);
});

test('/backfill: a start failure is reported to the founder, still consumed', async () => {
  const { c, router } = deps({
    resolveThreadCustomer: async () => ACME,
    startBackfill: async () => { throw new Error('OPENAI_API_KEY not resolvable'); },
  });

  assert.equal(await router(msg('/backfill')), true);
  assert.match(c.posts[0].text, /Couldn't run \/backfill right now: OPENAI_API_KEY not resolvable/);
});
