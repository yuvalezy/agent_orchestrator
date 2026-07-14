import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateCalendarAccount,
  createCalendarAccount,
  listCalendarAccounts,
  listEnabledCalendarAccounts,
  mintCalendarCredentialName,
  removeCalendarAccount,
} from './calendar-accounts-repo';

// Unit coverage with a FAKE db (recording query returning canned rows) — no Postgres. Verifies the
// row → account mapping, the generated credential-ref collision-avoidance, and the mutation SQL.

interface Call { text: string; params?: unknown[] }
function fakeDb(results: unknown[][]): { q: never; calls: Call[] } {
  const calls: Call[] = [];
  const q = (async (text: string, params?: unknown[]) => {
    calls.push({ text, params });
    const rows = results.shift() ?? [];
    return { rows, rowCount: rows.length };
  }) as unknown as never;
  return { q, calls };
}

test('mintCalendarCredentialName: GOOGLE_CALENDAR_<SLUG>_OAUTH, dodging reserved/existing refs', () => {
  assert.equal(mintCalendarCredentialName('Team EU', []), 'GOOGLE_CALENDAR_TEAM_EU_OAUTH');
  // 'Work' is reserved (seeded) → work-2
  assert.equal(mintCalendarCredentialName('Work', ['GOOGLE_CALENDAR_WORK_OAUTH']), 'GOOGLE_CALENDAR_WORK_2_OAUTH');
  // collision with an existing generated ref
  assert.equal(mintCalendarCredentialName('Team', ['GOOGLE_CALENDAR_TEAM_OAUTH']), 'GOOGLE_CALENDAR_TEAM_2_OAUTH');
});

test('list / listEnabled: map rows → accounts; enabled filter is in SQL', async () => {
  const rows = [{ id: 'c1', label: 'Work', account_email: 'w@x.com', credentials_ref: 'GOOGLE_CALENDAR_WORK_OAUTH', calendar_id: 'primary', enabled: true }];
  assert.deepEqual((await listCalendarAccounts(fakeDb([rows]).q))[0], {
    id: 'c1', label: 'Work', accountEmail: 'w@x.com', credentialName: 'GOOGLE_CALENDAR_WORK_OAUTH', calendarId: 'primary', enabled: true,
  });
  const enabled = fakeDb([rows]);
  await listEnabledCalendarAccounts(enabled.q);
  assert.match(enabled.calls[0].text, /WHERE enabled = true/);
});

test('createCalendarAccount: reads existing refs then inserts a DISABLED row with the minted ref', async () => {
  const { q, calls } = fakeDb([
    [{ credentials_ref: 'GOOGLE_CALENDAR_WORK_OAUTH' }, { credentials_ref: 'GOOGLE_CALENDAR_PERSONAL_OAUTH' }],
    [{ id: 'c9', label: 'Team', account_email: null, credentials_ref: 'GOOGLE_CALENDAR_TEAM_OAUTH', calendar_id: 'primary', enabled: false }],
  ]);
  const created = await createCalendarAccount('Team', q);
  assert.equal(created.credentialName, 'GOOGLE_CALENDAR_TEAM_OAUTH');
  assert.equal(created.enabled, false);
  assert.match(calls[1].text, /INSERT INTO calendar_accounts/);
  assert.deepEqual(calls[1].params, ['Team', 'GOOGLE_CALENDAR_TEAM_OAUTH']);
});

test('activate persists email + enables; remove returns the credential ref', async () => {
  const activate = fakeDb([[{}]]);
  await activateCalendarAccount('c1', 'w@x.com', activate.q);
  assert.match(activate.calls[0].text, /enabled = true/);
  assert.deepEqual(activate.calls[0].params, ['c1', 'w@x.com']);

  const remove = fakeDb([[{ credentials_ref: 'GOOGLE_CALENDAR_TEAM_OAUTH' }]]);
  assert.equal(await removeCalendarAccount('c1', remove.q), 'GOOGLE_CALENDAR_TEAM_OAUTH');
  assert.equal(await removeCalendarAccount('nope', fakeDb([[]]).q), null);
});
