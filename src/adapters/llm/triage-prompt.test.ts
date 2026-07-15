import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS_SCHEMA, parseIntents, triageUserMessage } from './triage-prompt';
import type { TriageContext } from '../../ports/llm.port';

// DA B3: the WIRE schema must be strict-output-clean or it 400s OpenAI/Anthropic
// strict modes. Assert it contains NONE of the banned keywords, additionalProperties
// is false on every object, and every property is required.
const BANNED = ['minimum', 'maximum', 'minLength', 'maxLength', 'multipleOf', 'format', 'pattern'];

function walk(node: unknown, visit: (obj: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) {
    node.forEach((n) => walk(n, visit));
  } else if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    visit(obj);
    Object.values(obj).forEach((v) => walk(v, visit));
  }
}

test('golden schema contains no strict-incompatible keywords', () => {
  walk(INTENTS_SCHEMA, (obj) => {
    for (const key of BANNED) assert.ok(!(key in obj), `banned keyword "${key}" found in wire schema`);
  });
});

test('every object in the schema sets additionalProperties:false and lists all props as required', () => {
  walk(INTENTS_SCHEMA, (obj) => {
    if (obj.type === 'object') {
      assert.equal(obj.additionalProperties, false, 'object missing additionalProperties:false');
      const props = Object.keys((obj.properties ?? {}) as object);
      const required = (obj.required ?? []) as string[];
      assert.deepEqual([...required].sort(), [...props].sort(), 'required must list every property');
    }
  });
});

test('parseIntents accepts a valid payload', () => {
  const intents = parseIntents({
    intents: [
      {
        category: 'bug_report',
        summary: 'Export fails',
        suggested_title: 'Fix export',
        priority: 'high',
        confidence: 0.9,
        explicit_action_request: true,
        related_open_task_ref: null,
      },
    ],
  });
  assert.equal(intents.length, 1);
  assert.equal(intents[0].category, 'bug_report');
});

test('parseIntents rejects out-of-range confidence (zod range guard)', () => {
  assert.throws(() =>
    parseIntents({
      intents: [
        { category: 'bug_report', summary: 's', suggested_title: 't', priority: 'high', confidence: 1.5, explicit_action_request: true, related_open_task_ref: null },
      ],
    }),
  );
});

test('parseIntents rejects an unknown category', () => {
  assert.throws(() =>
    parseIntents({
      intents: [
        { category: 'nope', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.5, explicit_action_request: true, related_open_task_ref: null },
      ],
    }),
  );
});

test('parseIntents accepts an empty intents array', () => {
  assert.deepEqual(parseIntents({ intents: [] }), []);
});

test('parseIntents requires the explicit-action safety signal', () => {
  assert.throws(() =>
    parseIntents({
      intents: [
        { category: 'compliment', summary: 'Says thanks', suggested_title: 'No task', priority: 'low', confidence: 0.99, related_open_task_ref: null },
      ],
    }),
  );
});

// ── M2a(b): the injected "Relevant knowledge" section (cited RAG chunks) ──
const baseCtx = (over: Partial<TriageContext> = {}): TriageContext => ({
  message: { body: 'the export button is broken' },
  customer: { ref: 'bp1', displayName: 'Acme', preferredLanguage: 'en' },
  recentTasks: [],
  ...over,
});

test('triageUserMessage renders cited knowledge chunks (title › section (route) + content) when present', () => {
  const msg = triageUserMessage(
    baseCtx({
      knowledge: [
        { content: 'To export, open Reports → Export.', title: 'Exporting', section: 'CSV export', route: '/reports', distance: 0.1 },
        { content: 'Invoices live under Settings.', title: 'Billing', section: null, route: null, distance: 0.3 },
      ],
    }),
  );
  assert.match(msg, /Relevant knowledge \(may be empty\):/);
  assert.match(msg, /\[1\] Exporting › CSV export \(\/reports\)/, 'chunk 1 cites title/section/route');
  assert.match(msg, /To export, open Reports → Export\./, 'chunk 1 content is included');
  assert.match(msg, /\[2\] Billing/, 'chunk 2 cites the title (no section/route)');
  assert.match(msg, /Invoices live under Settings\./, 'chunk 2 content is included');
});

test('triageUserMessage renders an explicit (none) when knowledge is empty or absent', () => {
  const withEmpty = triageUserMessage(baseCtx({ knowledge: [] }));
  const withAbsent = triageUserMessage(baseCtx());
  for (const m of [withEmpty, withAbsent]) {
    assert.match(m, /Relevant knowledge \(may be empty\):\n\(none\)/, 'header + (none) so the model knows nothing matched');
  }
});

test('triageUserMessage renders timestamped speaker context and the exchange initiator', () => {
  const msg = triageUserMessage(baseCtx({
    exchangeInitiator: 'founder',
    recentConversation: [
      { direction: 'outbound', body: 'Congratulations on the opening', sentAt: '2026-07-14T20:42:00.000Z' },
    ],
    message: { body: 'Gracias Yuval' },
  }));
  assert.match(msg, /Active exchange initiated by: founder/);
  assert.match(msg, /2026-07-14T20:42:00\.000Z Founder: Congratulations/);
  assert.match(msg, /CURRENT customer message: Gracias Yuval/);
});
