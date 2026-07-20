import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { buildConsoleOnboardingRouter } from './console-onboarding.router';
import type { BackfillMode, BackfillState, CustomerPreview, CustomerSearchResult, OnboardResult, OnboardingService, ProjectSearchResult } from '../onboarding';
import type { OnboardCoreInput } from '../onboarding';

// The onboarding sub-router in ISOLATION with a fake OnboardingService (no portal, no DB): search
// pass-through + already-onboarded flag, preview, the onboard status-code mapping (201 / 409
// already-onboarded / 422 bad work item type), UUID validation, and the backfill start/status
// contract (409 when a job is already running). Audit is stubbed to a no-op.

const BP = '11111111-1111-1111-1111-111111111111';
const PROJECT = '22222222-2222-2222-2222-222222222222';
const WIT = '33333333-3333-3333-3333-333333333333';
const CUSTOMER = '44444444-4444-4444-4444-444444444444';

/** A fake OnboardingService whose behavior each test overrides per-method. */
function fakeService(overrides: Partial<OnboardingService> = {}): OnboardingService {
  return {
    async searchCustomers(): Promise<CustomerSearchResult[]> { return []; },
    async searchProjects(): Promise<ProjectSearchResult[]> { return []; },
    async listWorkItemTypes(): Promise<Array<{ ref: string; name: string }>> { return []; },
    async previewCustomer(): Promise<CustomerPreview> { return { ref: BP, name: 'Acme', website: null, email: null, contacts: [], alreadyOnboarded: false, customerId: null }; },
    async onboard(_input: OnboardCoreInput): Promise<OnboardResult> { return { ok: true, customerId: CUSTOMER, created: true, waBlocked: false, workItemTypeRef: WIT }; },
    async startBackfill(_id: string, _mode: BackfillMode): Promise<{ started: boolean; reason?: string }> { return { started: true }; },
    async backfillStatus(): Promise<BackfillState> { return { enabled: true, reason: null, status: null, running: false, dry: null }; },
    ...overrides,
  };
}

async function withRouter(service: OnboardingService, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => { res.locals.consoleAuditContext = { actor: 'founder', requestId: 'test' }; next(); });
  app.use('/onboarding', buildConsoleOnboardingRouter({ onboarding: service, audit: async () => {} }));
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('GET /onboarding/customers annotates alreadyOnboarded', async () => {
  const service = fakeService({
    async searchCustomers(q) {
      assert.equal(q, 'ac');
      return [
        { ref: BP, name: 'Acme', code: 'C1', alreadyOnboarded: false },
        { ref: PROJECT, name: 'Acme Onboarded', code: 'C2', alreadyOnboarded: true },
      ];
    },
  });
  await withRouter(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding/customers?q=ac`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: CustomerSearchResult[] };
    assert.equal(body.data.length, 2);
    assert.equal(body.data[1].alreadyOnboarded, true);
  });
});

test('GET /onboarding/customers with empty q short-circuits to []', async () => {
  let called = false;
  const service = fakeService({ async searchCustomers() { called = true; return []; } });
  await withRouter(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding/customers?q=%20`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: unknown[] };
    assert.deepEqual(body.data, []);
    assert.equal(called, false);
  });
});

test('POST /onboarding → 201 on success', async () => {
  await withRouter(fakeService(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bpRef: BP, projectRef: PROJECT, workItemTypeRef: WIT }) });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { data: { customerId: string } };
    assert.equal(body.data.customerId, CUSTOMER);
  });
});

test('POST /onboarding → 409 when already onboarded', async () => {
  const service = fakeService({ async onboard() { return { ok: false, error: 'already_onboarded', message: 'This customer is already onboarded.' }; } });
  await withRouter(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bpRef: BP, projectRef: PROJECT }) });
    assert.equal(res.status, 409);
    const body = (await res.json()) as { error: string };
    assert.match(body.error, /already onboarded/i);
  });
});

test('POST /onboarding → 422 on a bad work item type', async () => {
  const service = fakeService({ async onboard() { return { ok: false, error: 'work_item_type', message: 'This project type has 2 work item types — choose one.' }; } });
  await withRouter(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bpRef: BP, projectRef: PROJECT }) });
    assert.equal(res.status, 422);
  });
});

test('POST /onboarding → 400 on an invalid bp ref', async () => {
  await withRouter(fakeService(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ bpRef: 'not-a-uuid', projectRef: PROJECT }) });
    assert.equal(res.status, 400);
  });
});

test('POST /onboarding/:id/backfill/dry → 202 when started', async () => {
  await withRouter(fakeService(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding/${CUSTOMER}/backfill/dry`, { method: 'POST' });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { data: { mode: string } };
    assert.equal(body.data.mode, 'dry');
  });
});

test('POST /onboarding/:id/backfill/live → 409 when one is already running', async () => {
  const service = fakeService({ async startBackfill() { return { started: false, reason: 'A backfill is already running for this customer.' }; } });
  await withRouter(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding/${CUSTOMER}/backfill/live`, { method: 'POST' });
    assert.equal(res.status, 409);
  });
});

test('POST /onboarding/:id/backfill/:mode → 400 on an unknown mode', async () => {
  await withRouter(fakeService(), async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding/${CUSTOMER}/backfill/sideways`, { method: 'POST' });
    assert.equal(res.status, 400);
  });
});

test('GET /onboarding/:id/backfill returns the state', async () => {
  const service = fakeService({ async backfillStatus() { return { enabled: false, reason: 'Backfill is disabled.', status: 'pending', running: false, dry: null }; } });
  await withRouter(service, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/onboarding/${CUSTOMER}/backfill`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { data: BackfillState };
    assert.equal(body.data.enabled, false);
    assert.equal(body.data.status, 'pending');
  });
});
