import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  activateCalendarAccount,
  assignNextColor,
  CALENDAR_COLOR_KEYS,
  createCalendarAccount,
  listCalendarAccounts,
  listEnabledCalendarAccounts,
  mintCalendarCredentialName,
  relabelCalendarAccount,
  removeCalendarAccount,
  setCalendarEnabled,
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
  const rows = [{ id: 'c1', label: 'Work', account_email: 'w@x.com', credentials_ref: 'GOOGLE_CALENDAR_WORK_OAUTH', calendar_id: 'primary', enabled: true, color: 'sky' }];
  assert.deepEqual((await listCalendarAccounts(fakeDb([rows]).q))[0], {
    id: 'c1', label: 'Work', accountEmail: 'w@x.com', credentialName: 'GOOGLE_CALENDAR_WORK_OAUTH', calendarId: 'primary', enabled: true, color: 'sky',
  });
  const enabled = fakeDb([rows]);
  await listEnabledCalendarAccounts(enabled.q);
  assert.match(enabled.calls[0].text, /WHERE enabled = true/);
});

test('createCalendarAccount: reads existing refs + colors, then inserts a DISABLED row with the minted ref and next palette color', async () => {
  // Existing rows: Work + Personal (sky + violet seeded). Next color for 'Team' → emerald.
  const { q, calls } = fakeDb([
    [
      { credentials_ref: 'GOOGLE_CALENDAR_WORK_OAUTH', color: 'sky' },
      { credentials_ref: 'GOOGLE_CALENDAR_PERSONAL_OAUTH', color: 'violet' },
    ],
    [{ id: 'c9', label: 'Team', account_email: null, credentials_ref: 'GOOGLE_CALENDAR_TEAM_OAUTH', calendar_id: 'primary', enabled: false, color: 'emerald' }],
  ]);
  const created = await createCalendarAccount('Team', q);
  assert.equal(created.credentialName, 'GOOGLE_CALENDAR_TEAM_OAUTH');
  assert.equal(created.enabled, false);
  assert.equal(created.color, 'emerald');
  assert.match(calls[0].text, /SELECT credentials_ref, color FROM calendar_accounts/);
  assert.match(calls[1].text, /INSERT INTO calendar_accounts/);
  assert.deepEqual(calls[1].params, ['Team', 'GOOGLE_CALENDAR_TEAM_OAUTH', 'emerald']);
});

test('assignNextColor: empty → sky; picks first unused; least-used when all touched', () => {
  // Empty: first palette key.
  assert.equal(assignNextColor([]), 'sky');
  // One used → next palette key.
  assert.equal(assignNextColor(['sky']), 'violet');
  // Partial coverage: gaps get filled before reusing.
  assert.equal(assignNextColor(['sky', 'violet']), 'emerald');
  assert.equal(assignNextColor(['sky', 'violet', 'emerald', 'teal', 'rose', 'indigo', 'fuchsia']), 'cyan');
  // All 8 used at least once → least-used wins; here 'sky' is least-used → returns 'sky'.
  const allOnce = [...CALENDAR_COLOR_KEYS];
  assert.equal(assignNextColor(allOnce), 'sky');
  // After bumping 'sky' to 2, it is tied with the rest at 1 — palette order keeps 'sky' first,
  // but 'violet' now becomes least-used (sky=2, others=1) → returns 'violet'.
  assert.equal(assignNextColor(['sky', 'sky', ...CALENDAR_COLOR_KEYS.slice(1)]), 'violet');
  // Non-palette strings are ignored (defensive — DB CHECK makes this impossible, but the function
  // must not crash or return garbage).
  assert.equal(assignNextColor(['sky', 'not-a-key', '']), 'violet');
  // Always returns one of the palette keys.
  assert.ok(CALENDAR_COLOR_KEYS.includes(assignNextColor(['sky', 'violet', 'emerald', 'teal', 'rose', 'indigo', 'fuchsia', 'cyan', 'sky'])));
});

test('relabel / setCalendarEnabled: only touch their column (color is preserved by NOT being in the SET clause)', async () => {
  const relabel = fakeDb([[{}]]);
  assert.equal(await relabelCalendarAccount('c1', 'New Label', relabel.q), true);
  assert.match(relabel.calls[0].text, /SET label = \$2/);
  assert.deepEqual(relabel.calls[0].params, ['c1', 'New Label']);

  const toggle = fakeDb([[{}]]);
  assert.equal(await setCalendarEnabled('c1', false, toggle.q), true);
  assert.match(toggle.calls[0].text, /SET enabled = \$2/);
  assert.deepEqual(toggle.calls[0].params, ['c1', false]);
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
