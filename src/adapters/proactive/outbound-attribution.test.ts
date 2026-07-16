import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OUTBOUND_CONTACT_ATTRIBUTION_JOIN } from './outbound-attribution';

// The commitment + meeting-prep worker reads share ONE outbound-attribution join. This pins its
// exact text (whitespace included) so the three call sites cannot silently drift: any consumer
// splices it after a 7-space indent, and its second line must stay 9-space-indented `ON …`.

test('the shared join is the exact byte-identical fragment all three sites embed', () => {
  assert.equal(
    OUTBOUND_CONTACT_ATTRIBUTION_JOIN,
    'LEFT JOIN agent_customer_contacts ct\n         ON ct.channel_type = ci.channel_type AND ct.address = i.channel_thread_id',
  );
});
