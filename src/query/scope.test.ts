import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScopeResolver, type ResolvedCustomer } from './scope';

// Unit tests for scope resolution (CORE, no DB/network — findCustomer is a mock).
// Covers: forceInternal short-circuits the lookup; a customer match → customer scope;
// no match → internal fallback.

function resolver(match: ResolvedCustomer | null, spy?: { calls: string[] }) {
  return buildScopeResolver({
    findCustomer: async (q: string) => {
      spy?.calls.push(q);
      return match;
    },
  });
}

test('forceInternal → internal scope WITHOUT calling findCustomer', async () => {
  const spy = { calls: [] as string[] };
  const r = resolver({ customerId: 'c1', customerName: 'HolaDoc' }, spy);
  const scope = await r.resolveScope('what is the status with HolaDoc?', { forceInternal: true });
  assert.deepEqual(scope, { kind: 'internal' });
  assert.equal(spy.calls.length, 0, 'the /ask headline never runs a customer lookup');
});

test('a customer match → customer scope carrying the resolved id + name', async () => {
  const r = resolver({ customerId: 'c1', customerName: 'HolaDoc' });
  const scope = await r.resolveScope("what's the status with HolaDoc?");
  assert.deepEqual(scope, { kind: 'customer', customerId: 'c1', customerName: 'HolaDoc' });
});

test('no customer match → internal fallback (founder path degrades to the project corpus)', async () => {
  const r = resolver(null);
  const scope = await r.resolveScope('how does the outbound drainer gate sends?');
  assert.deepEqual(scope, { kind: 'internal' });
});
