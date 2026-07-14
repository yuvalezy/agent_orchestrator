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

const silentLog = { info: () => {}, error: () => {} };

const NOW = new Date('2026-07-14T12:00:00Z');
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 60 * 60 * 1000);

function collector() {
  const posts: Array<{ threadId: string; text: string }> = [];
  return { posts, postAnswer: async (threadId: string, text: string) => void posts.push({ threadId, text }) };
}

const msg = (text: string): MessageEvent => ({ threadId: '77', text, by: 'founder' });

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

test('router CONSUMES /help: lists the registered commands', async () => {
  const { c, router } = deps();

  const consumed = await router(msg('/help'));

  assert.equal(consumed, true);
  assert.match(c.posts[0].text, /\/pending —/);
  assert.match(c.posts[0].text, /\/briefing —/);
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
