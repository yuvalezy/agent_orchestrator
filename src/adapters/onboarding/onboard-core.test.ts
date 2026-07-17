import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onboardCustomerCore, WorkItemTypeError, type OnboardCoreDeps } from './onboard-core';

// onboardCustomerCore's work-item-type membership check runs BEFORE any DB write (blueprint §3 /
// DA flag 3), so these cases exercise it with fake portal deps and never touch Postgres. A throw
// here is the whole point: a bad/ambiguous work item type must fail before a customer row lands.

function fakeDeps(workItemTypes: Array<{ ref: string; name: string }>): OnboardCoreDeps {
  return {
    ezy: {
      async getCustomer() { return { ref: 'bp', name: 'Acme' }; },
      async listContacts() { return []; },
      async listWorkItemTypes() { return workItemTypes; },
    },
    // Never reached — the guard throws first.
    wa: { async listWhitelist() { return []; }, async listGroups() { return []; } },
    notifier: { async ensureCustomerTopic() { return { ref: 't' }; }, async notifyCustomerEvent() {} },
  };
}

test('rejects a work item type that is not a member of the project type', async () => {
  const deps = fakeDeps([{ ref: 'wit-a', name: 'Support' }]);
  await assert.rejects(
    () => onboardCustomerCore({ bpRef: 'bp', projectRef: 'proj', workItemTypeRef: 'wit-x' }, deps),
    (err: unknown) => err instanceof WorkItemTypeError,
  );
});

test('rejects an ambiguous project type (multiple types, none chosen)', async () => {
  const deps = fakeDeps([{ ref: 'wit-a', name: 'Support' }, { ref: 'wit-b', name: 'Bug' }]);
  await assert.rejects(
    () => onboardCustomerCore({ bpRef: 'bp', projectRef: 'proj' }, deps),
    (err: unknown) => err instanceof WorkItemTypeError,
  );
});
