import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGmailAccount,
  listGmailAccounts,
  mintGmailNames,
  relabelGmailAccount,
  removeGmailAccount,
  setGmailEnabled,
} from './channel-accounts-repo';

// Unit coverage with a FAKE db (a recording query that returns canned rows in order) — no Postgres.
// Verifies the row → account mapping, the generated name/credential collision-avoidance, and that
// each mutation issues the expected parameterized SQL.

interface Call { text: string; params?: unknown[] }
/** A fake `query`: pops the next canned rows result and records the call. */
function fakeDb(results: unknown[][]): { q: never; calls: Call[] } {
  const calls: Call[] = [];
  const q = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = results.shift() ?? [];
    return { rows, rowCount: rows.length };
  }) as unknown as never;
  return { q, calls };
}

test('mintGmailNames: derives email:gmail:<slug> + GMAIL_<SLUG>_OAUTH, dodging reserved/existing', () => {
  assert.deepEqual(mintGmailNames('Acme Corp', []), { name: 'email:gmail:acme-corp', credentialName: 'GMAIL_ACME_CORP_OAUTH' });
  // 'Work' is reserved (seeded) → bumps to work-2
  assert.deepEqual(mintGmailNames('Work', ['email:gmail:work']), { name: 'email:gmail:work-2', credentialName: 'GMAIL_WORK_2_OAUTH' });
  // collision with an existing generated account
  assert.deepEqual(mintGmailNames('Acme', ['email:gmail:acme']), { name: 'email:gmail:acme-2', credentialName: 'GMAIL_ACME_2_OAUTH' });
});

test('listGmailAccounts: maps rows → accounts (label from config, enabled from status)', async () => {
  const { q } = fakeDb([
    [
      { id: 'g1', name: 'email:gmail:work', config: { label: 'Work', accountEmail: 'w@x.com' }, credentials_ref: 'GMAIL_WORK_OAUTH', status: 'active' },
      { id: 'g2', name: 'email:gmail:acme', config: {}, credentials_ref: 'GMAIL_ACME_OAUTH', status: 'paused' },
    ],
  ]);
  const accounts = await listGmailAccounts(q);
  assert.deepEqual(accounts[0], { id: 'g1', name: 'email:gmail:work', label: 'Work', accountEmail: 'w@x.com', credentialName: 'GMAIL_WORK_OAUTH', enabled: true });
  // no config.label → falls back to the slug; no accountEmail → null; paused → disabled
  assert.deepEqual(accounts[1], { id: 'g2', name: 'email:gmail:acme', label: 'acme', accountEmail: null, credentialName: 'GMAIL_ACME_OAUTH', enabled: false });
});

test('createGmailAccount: reads existing names then inserts a PAUSED row with the minted name', async () => {
  const { q, calls } = fakeDb([
    [{ name: 'email:gmail:work' }, { name: 'email:gmail:personal' }], // existing names
    [{ id: 'g9', name: 'email:gmail:acme', config: { label: 'Acme' }, credentials_ref: 'GMAIL_ACME_OAUTH', status: 'paused' }],
  ]);
  const created = await createGmailAccount('Acme', q);
  assert.equal(created.credentialName, 'GMAIL_ACME_OAUTH');
  assert.equal(created.enabled, false);
  // the INSERT got the minted name + label + credential ref
  assert.match(calls[1].text, /INSERT INTO channel_instances/);
  assert.deepEqual(calls[1].params, ['email:gmail:acme', 'Acme', 'GMAIL_ACME_OAUTH']);
});

test('relabel / setEnabled / remove issue the expected SQL + return outcomes', async () => {
  const relabel = fakeDb([[{}]]);
  assert.equal(await relabelGmailAccount('g1', 'New', relabel.q), true);
  assert.deepEqual(relabel.calls[0].params, ['g1', 'New']);

  const enable = fakeDb([[{}]]);
  assert.equal(await setGmailEnabled('g1', true, enable.q), true);
  assert.deepEqual(enable.calls[0].params, ['g1', 'active']);

  const disable = fakeDb([[{}]]);
  await setGmailEnabled('g1', false, disable.q);
  assert.deepEqual(disable.calls[0].params, ['g1', 'paused']);

  const remove = fakeDb([[{ credentials_ref: 'GMAIL_ACME_OAUTH' }]]);
  assert.equal(await removeGmailAccount('g1', remove.q), 'GMAIL_ACME_OAUTH');

  const missing = fakeDb([[]]);
  assert.equal(await removeGmailAccount('nope', missing.q), null);
});
