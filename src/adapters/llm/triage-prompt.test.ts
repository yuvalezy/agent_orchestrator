import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INTENTS_SCHEMA, parseIntents } from './triage-prompt';

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
        { category: 'bug_report', summary: 's', suggested_title: 't', priority: 'high', confidence: 1.5, related_open_task_ref: null },
      ],
    }),
  );
});

test('parseIntents rejects an unknown category', () => {
  assert.throws(() =>
    parseIntents({
      intents: [
        { category: 'nope', summary: 's', suggested_title: 't', priority: 'low', confidence: 0.5, related_open_task_ref: null },
      ],
    }),
  );
});

test('parseIntents accepts an empty intents array', () => {
  assert.deepEqual(parseIntents({ intents: [] }), []);
});
