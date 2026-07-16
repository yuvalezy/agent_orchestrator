import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveContact, type ContactResolutionQueries } from './contact-resolution';

// Unit tests for resolveContact — the DB seam is faked. Focus: the D-A (revised)
// service_desk branch (bp-ref PRIMARY, email fallback, domain propose, unknown),
// plus regression coverage that the email/whatsapp paths are unchanged.

function deps(over: Partial<ContactResolutionQueries> = {}): ContactResolutionQueries {
  return {
    findCustomerByBpRef: async () => null,
    findContactByAddress: async () => null,
    findCustomersByEmailDomain: async () => [],
    findContactEmailByAddress: async () => null,
    ...over,
  };
}

test('service_desk + bp-ref match → known (PRIMARY path; contactId empty, D-A)', async () => {
  const res = await resolveContact(
    { channelType: 'service_desk', address: 'bp-1' },
    deps({ findCustomerByBpRef: async (ref) => (ref === 'bp-1' ? { customerId: 'cust-1' } : null) }),
  );
  assert.deepEqual(res, { kind: 'known', customerId: 'cust-1', contactId: '' });
});

test('service_desk: bp-ref wins over a matching email contact (order matters)', async () => {
  let emailLookups = 0;
  const res = await resolveContact(
    { channelType: 'service_desk', address: 'bp-1' },
    deps({
      findCustomerByBpRef: async () => ({ customerId: 'via-bp' }),
      findContactByAddress: async () => { emailLookups += 1; return { customerId: 'via-email', contactId: 'c9' }; },
    }),
  );
  assert.equal(res.kind, 'known');
  assert.equal((res as { customerId: string }).customerId, 'via-bp');
  assert.equal(emailLookups, 0, 'email lookup is not reached once bp-ref hits');
});

test('service_desk + no bp-ref but a known email contact → known via email fallback', async () => {
  let lookedUpType = '';
  const res = await resolveContact(
    { channelType: 'service_desk', address: 'a@x.com' },
    deps({
      findContactByAddress: async (channelType) => { lookedUpType = channelType; return { customerId: 'cust-2', contactId: 'c2' }; },
    }),
  );
  assert.deepEqual(res, { kind: 'known', customerId: 'cust-2', contactId: 'c2' });
  assert.equal(lookedUpType, 'email', 'service_desk email fallback queries the email channel');
});

test('service_desk + single email-domain match (no bp, no contact) → propose', async () => {
  const res = await resolveContact(
    { channelType: 'service_desk', address: 'someone@acme.com' },
    deps({ findCustomersByEmailDomain: async (d) => (d === 'acme.com' ? [{ id: 'cust-3', displayName: 'Acme' }] : []) }),
  );
  assert.deepEqual(res, { kind: 'propose', customerId: 'cust-3', customerName: 'Acme' });
});

test('service_desk + unknown email domain → unknown', async () => {
  const res = await resolveContact(
    { channelType: 'service_desk', address: 'a@gmail.com' },
    deps({ findCustomersByEmailDomain: async () => [] }),
  );
  assert.deepEqual(res, { kind: 'unknown' });
});

test('service_desk + unresolvable bp-ref UUID (no @) → unknown, never domain-proposes', async () => {
  let domainLookups = 0;
  const res = await resolveContact(
    { channelType: 'service_desk', address: 'deadbeef-uuid' },
    deps({ findCustomersByEmailDomain: async () => { domainLookups += 1; return [{ id: 'x', displayName: 'X' }]; } }),
  );
  assert.deepEqual(res, { kind: 'unknown' });
  assert.equal(domainLookups, 0, 'a bp-ref has no domain to propose against');
});

// ── Regression: the email / whatsapp paths are unchanged ──

test('email + exact contact → known (unchanged)', async () => {
  const res = await resolveContact(
    { channelType: 'email', address: 'a@x.com' },
    deps({ findContactByAddress: async () => ({ customerId: 'ce', contactId: 'ce1' }) }),
  );
  assert.deepEqual(res, { kind: 'known', customerId: 'ce', contactId: 'ce1' });
});

test('email + single domain match → propose (unchanged)', async () => {
  const res = await resolveContact(
    { channelType: 'email', address: 'x@acme.com' },
    deps({ findCustomersByEmailDomain: async () => [{ id: 'cd', displayName: 'Acme' }] }),
  );
  assert.deepEqual(res, { kind: 'propose', customerId: 'cd', customerName: 'Acme' });
});

test('whatsapp non-match → unknown, never bp-ref or domain propose (unchanged)', async () => {
  let bpLookups = 0;
  const res = await resolveContact(
    { channelType: 'whatsapp', address: '50760000000' },
    deps({ findCustomerByBpRef: async () => { bpLookups += 1; return { customerId: 'nope' }; } }),
  );
  assert.deepEqual(res, { kind: 'unknown' });
  assert.equal(bpLookups, 0, 'bp-ref lookup is a service_desk-only affordance');
});
