# Row-claiming SQL template (`FOR UPDATE SKIP LOCKED`)

`worker-runner.ts` owns the generic interval / backoff / registry loop. It does
**not** provide a generic row-claiming helper. whatsapp_manager's precedent is
one bespoke claim method per table (`message.service.ts:597-619`), and we follow
it: each concrete worker writes its own `claimPending*()` following the template
below.

Concrete workers arriving in later milestones:

- **inbox processor** — M1.5b, claims from `agent_inbox`
- **outbound drainer** — M1.8, claims from `agent_outbound_queue`

## Template

```sql
UPDATE <table>
   SET status = 'processing',
       retry_count = retry_count + 1
 WHERE id IN (
   SELECT id FROM <table>
    WHERE status = 'pending'
       OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
    ORDER BY id ASC
    FOR UPDATE SKIP LOCKED
    LIMIT $1
 )
RETURNING id, ... ;   -- select only the IDs / metadata needed for the log line, NEVER the body
```

## Why this is correct

- `FOR UPDATE SKIP LOCKED` lets overlapping poll ticks (and future replicas)
  claim disjoint batches without blocking or double-processing.
- The `status='processing' AND updated_at < now() - interval` clause reclaims
  rows stuck by a crash mid-processing.
- ◆ **BF2:** that stuck-row clause is correct **only because** the
  `set_updated_at()` trigger (migration 001, attached to every mutable table)
  bumps `updated_at` on the claiming `UPDATE`. It therefore measures age from the
  **last claim**, not row creation. Do **not** also `SET updated_at = now()` in
  the statement — the trigger is the single source of truth (DRY); duplicating it
  diverges the day the trigger changes.
- A poison-pill guard (a companion `failStuck*()` that flips rows past their
  attempt budget to `status='failed'`, per `message.service.ts:628-638`) belongs
  next to each concrete claim method so a row that reliably crashes the process
  can't be reclaimed forever.

## Logging invariant

Never log `run()` internals or message bodies — IDs and metadata only. The runner
logs `{ worker, durationMs, ok }`; concrete workers must keep their own log sites
to the same standard.
