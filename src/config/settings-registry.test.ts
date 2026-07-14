import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SETTINGS_REGISTRY, SETTINGS_KEYS, settingDef } from './settings-registry';

// The 22 non-secret `*_ENABLED` flags (blueprint scope pass 1). If a flag is added
// to / removed from the registry, update this count deliberately.
const EXPECTED_KEYS = [
  'OUTBOUND_ENABLED',
  'OUTBOUND_EMAIL_ENABLED',
  'KNOWLEDGE_RETRIEVAL_ENABLED',
  'KNOWLEDGE_DRAFT_ENABLED',
  'KNOWLEDGE_SYNC_ENABLED',
  'KNOWLEDGE_INTERNAL_ENABLED',
  'DRAFT_REVISE_ENABLED',
  'STYLE_LANE_ENABLED',
  'QUERY_ENGINE_ENABLED',
  'SLASH_COMMANDS_ENABLED',
  'BACKFILL_ENABLED',
  'BACKFILL_WA_ENABLED',
  'BACKFILL_STARRED_ENABLED',
  'LIVE_DEDUP_FINGERPRINT_ENABLED',
  'DAILY_BRIEFING_ENABLED',
  'WEEKLY_PATTERNS_ENABLED',
  'ACCEPTANCE_REPORT_ENABLED',
  'FEEDBACK_LEARNING_ENABLED',
  'RELEASE_NOTE_DRAFTS_ENABLED',
  'CROSS_CHANNEL_DEDUP_ENABLED',
  'TASK_INVENTORY_ENABLED',
  'CALENDAR_ENABLED',
];

test('registry holds exactly the 22 expected flags with unique keys', () => {
  assert.equal(SETTINGS_REGISTRY.length, 22);
  assert.equal(SETTINGS_KEYS.length, 22);
  assert.deepEqual([...SETTINGS_KEYS], EXPECTED_KEYS);
  assert.equal(new Set(SETTINGS_KEYS).size, 22, 'keys must be unique');
});

test('every def is well-formed (boolean type, false default, valid applyMode)', () => {
  for (const def of SETTINGS_REGISTRY) {
    assert.equal(def.type, 'boolean', `${def.key} must be boolean in pass 1`);
    assert.equal(def.default, false, `${def.key} default mirrors the zod default (false)`);
    assert.ok(['live', 'restart'].includes(def.applyMode), `${def.key} applyMode`);
    assert.ok(def.label.length > 0 && def.description.length > 0, `${def.key} label/description`);
    assert.ok(def.category.length > 0, `${def.key} category`);
  }
});

test('all 22 flags are restart-apply (each is read once at boot, none per-operation)', () => {
  for (const def of SETTINGS_REGISTRY) {
    assert.equal(def.applyMode, 'restart', `${def.key} is a boot-read gate`);
  }
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
