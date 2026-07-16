import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_REGISTRY, SETTINGS_KEYS, settingDef, coerceSettingValue } from './settings-registry';

// Pass 1 = the `*_ENABLED` booleans; pass 2 appends the tuned knobs (LLM routing/effort +
// backfill determinism + style-lane size). If a setting is added/removed, update this list.
const EXPECTED_KEYS = [
  'OUTBOUND_ENABLED',
  'OUTBOUND_EMAIL_ENABLED',
  'TELEGRAM_SCHEDULING_ENABLED',
  'TELEGRAM_FOUNDER_USER_IDS',
  'KNOWLEDGE_RETRIEVAL_ENABLED',
  'KNOWLEDGE_DRAFT_ENABLED',
  'KNOWLEDGE_SYNC_ENABLED',
  'KNOWLEDGE_INTERNAL_ENABLED',
  'DRAFT_REVISE_ENABLED',
  'STYLE_LANE_ENABLED',
  'QUERY_ENGINE_ENABLED',
  'QUERY_FREE_TEXT_ENABLED',
  'SLASH_COMMANDS_ENABLED',
  'BACKFILL_ENABLED',
  'BACKFILL_WA_ENABLED',
  'LIVE_DEDUP_FINGERPRINT_ENABLED',
  'DAILY_BRIEFING_ENABLED',
  'BRIEFING_SYNTHESIS_ENABLED',
  'WEEKLY_PATTERNS_ENABLED',
  'ACCEPTANCE_REPORT_ENABLED',
  'FEEDBACK_LEARNING_ENABLED',
  'RELEASE_NOTE_DRAFTS_ENABLED',
  'CROSS_CHANNEL_DEDUP_ENABLED',
  'TASK_INVENTORY_ENABLED',
  'CALENDAR_ENABLED',
  'PROACTIVE_NOTIFICATIONS_ENABLED',
  'STALE_TASK_CHASER_ENABLED',
  'AWAITING_REPLY_NUDGE_ENABLED',
  'NEEDS_INFO_DRAFT_ENABLED',
  // pass-2 tuning knobs
  'LLM_DEFAULT_PROVIDER',
  'LLM_FALLBACK_CHAIN',
  'OPENAI_TRANSCRIBE_MODEL',
  'LLM_ANTHROPIC_EFFORT',
  'LLM_OPENAI_EFFORT',
  'BACKFILL_JUDGE_VOTES',
  'BACKFILL_COLLAPSE_MAX_DISTANCE',
  'STYLE_LANE_MAX',
];

test('registry holds exactly the expected settings with unique keys', () => {
  assert.equal(SETTINGS_REGISTRY.length, EXPECTED_KEYS.length);
  assert.equal(SETTINGS_KEYS.length, EXPECTED_KEYS.length);
  assert.deepEqual([...SETTINGS_KEYS], EXPECTED_KEYS);
  assert.equal(new Set(SETTINGS_KEYS).size, EXPECTED_KEYS.length, 'keys must be unique');
});

test('every def is well-formed (type-matched default, valid applyMode, enum options, number bounds)', () => {
  const TYPES = ['boolean', 'number', 'string', 'enum'];
  for (const def of SETTINGS_REGISTRY) {
    assert.ok(TYPES.includes(def.type), `${def.key} type`);
    assert.ok(['live', 'restart'].includes(def.applyMode), `${def.key} applyMode`);
    assert.ok(def.label.length > 0 && def.description.length > 0, `${def.key} label/description`);
    assert.ok(def.category.length > 0, `${def.key} category`);
    if (def.type === 'boolean') assert.equal(typeof def.default, 'boolean', `${def.key} default`);
    if (def.type === 'string') assert.equal(typeof def.default, 'string', `${def.key} default`);
    if (def.type === 'number') {
      assert.equal(typeof def.default, 'number', `${def.key} default`);
      if (def.min !== undefined) assert.ok((def.default as number) >= def.min, `${def.key} default ≥ min`);
      if (def.max !== undefined) assert.ok((def.default as number) <= def.max, `${def.key} default ≤ max`);
    }
    if (def.type === 'enum') {
      assert.ok(def.options && def.options.length > 0, `${def.key} enum needs options`);
      assert.ok(def.options!.includes(def.default as string), `${def.key} default must be an option`);
    }
  }
});

test('every *_ENABLED flag is a restart-apply boolean', () => {
  for (const def of SETTINGS_REGISTRY) {
    if (def.key.endsWith('_ENABLED')) {
      assert.equal(def.type, 'boolean', `${def.key} is a flag`);
      assert.equal(def.default, false, `${def.key} default mirrors the zod default (false)`);
      assert.equal(def.applyMode, 'restart', `${def.key} is a boot-read gate`);
    }
  }
});

test('the LLM effort + backfill tuning knobs are live-apply', () => {
  for (const key of ['LLM_ANTHROPIC_EFFORT', 'LLM_OPENAI_EFFORT', 'OPENAI_TRANSCRIBE_MODEL', 'BACKFILL_JUDGE_VOTES', 'BACKFILL_COLLAPSE_MAX_DISTANCE']) {
    assert.equal(settingDef(key)?.applyMode, 'live', `${key} applies without a restart`);
  }
});

test('coerceSettingValue validates per type/constraint', () => {
  const provider = settingDef('LLM_DEFAULT_PROVIDER')!;
  assert.deepEqual(coerceSettingValue(provider, 'openai'), { value: 'openai' });
  assert.ok('error' in coerceSettingValue(provider, 'grok'), 'enum rejects a non-option');
  assert.ok('error' in coerceSettingValue(provider, 3), 'enum rejects a non-string');

  const votes = settingDef('BACKFILL_JUDGE_VOTES')!;
  assert.deepEqual(coerceSettingValue(votes, '3'), { value: 3 }, 'number accepts a numeric string');
  assert.ok('error' in coerceSettingValue(votes, 0), 'below min rejected');
  assert.ok('error' in coerceSettingValue(votes, 99), 'above max rejected');
  assert.ok('error' in coerceSettingValue(votes, 2.5), 'non-integer rejected');

  const dist = settingDef('BACKFILL_COLLAPSE_MAX_DISTANCE')!;
  assert.deepEqual(coerceSettingValue(dist, '0.35'), { value: 0.35 }, 'fractional number allowed');
  assert.ok('error' in coerceSettingValue(dist, 5), 'above max rejected');

  const flag = settingDef('OUTBOUND_ENABLED')!;
  assert.deepEqual(coerceSettingValue(flag, true), { value: true });
  assert.ok('error' in coerceSettingValue(flag, 'yes'), 'boolean rejects a string');
});

test('dependsOn always points at another key IN the registry', () => {
  for (const def of SETTINGS_REGISTRY) {
    if (def.dependsOn) {
      assert.ok(settingDef(def.dependsOn), `${def.key} dependsOn ${def.dependsOn} must exist`);
      assert.notEqual(def.dependsOn, def.key, `${def.key} cannot depend on itself`);
    }
  }
});

test('settingDef resolves known keys and rejects unknown ones', () => {
  assert.equal(settingDef('OUTBOUND_ENABLED')?.key, 'OUTBOUND_ENABLED');
  assert.equal(settingDef('NOPE_ENABLED'), undefined);
});
