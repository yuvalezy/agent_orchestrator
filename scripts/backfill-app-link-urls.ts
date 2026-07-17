import 'dotenv/config';
import { env } from '../src/config/env';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { taskDeepLink } from '../src/adapters/shared/portal-url';

// One-off: give the app's EXISTING task cards their "Open Task" link and their "View thread"
// origin. `link_url` and `context` arrived with migration 043, so every card minted before it has
// neither — and those are the cards the founder is looking at right now. New cards get both from
// the Notification port at insert; this is only for the backlog.
//
// Both are recoverable without guessing:
//  - link_url — a task card's `notification_ref` IS its EZY Portal task UUID (core mints the
//    button id as '<optionId>:<ref>'; partitionButtons stores the bare 'x' and lifts the ref).
//  - context  — the inbox row the task was raised from, via the triage decision (or the task
//    bridge) that carries the same task_ref. This is exactly what `contextRef` held.
//
// SCOPE — only rows whose buttons carry the cancel option 'x' (CANCEL_PREFIX), which is what
// makes the ref a TASK ref. Draft-approval cards (da/de/dr/dv) also have a notification_ref, but
// it points at a draft decision, NOT a task: giving those a /projects/tasks/<ref> URL would
// fabricate a link to a task that does not exist. Never widen this predicate.
//
// It does NOT rewrite any card's BODY. A stale "Task (confirmed)" card said what it said; the
// enrichment applies to new ones. Backfilling metadata restores what the card can DO — rewriting
// its text would forge what the assistant told the founder at the time.
//
// DRY by default; --apply writes. Prints no card bodies — ids and links only.
//
//   npm run backfill:app-links -- [--apply]

interface Row { id: string; notification_ref: string; inbox_ref: string | null }

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  // The earliest triage row for a task_ref is the intent it was created from; agent_tasks is the
  // fallback for a task bridged without one. Both carry the inbox row the card came from.
  const { rows } = await query<Row>(
    `SELECT m.id::text, m.notification_ref,
            COALESCE(d.inbox_message_id, t.inbox_message_id)::text AS inbox_ref
       FROM founder_app_messages m
       LEFT JOIN LATERAL (
            SELECT inbox_message_id FROM agent_decisions
             WHERE task_ref = m.notification_ref AND decision_type = 'triage'
             ORDER BY id ASC LIMIT 1) d ON true
       LEFT JOIN LATERAL (
            SELECT inbox_message_id FROM agent_tasks
             WHERE task_ref = m.notification_ref
             ORDER BY id ASC LIMIT 1) t ON true
      WHERE (m.link_url IS NULL OR m.context IS NULL)
        AND m.notification_ref IS NOT NULL
        AND m.buttons @> '[{"id":"x"}]'::jsonb
      ORDER BY m.created_at ASC`,
  );

  if (rows.length === 0) {
    logger.info('backfill:app-links — nothing to do');
    return;
  }

  // portalTaskUrl fails closed on an unset/!url base, so a misconfigured environment backfills
  // nothing rather than writing a broken link into every card.
  const planned = rows.map((row) => ({
    id: row.id,
    url: taskDeepLink(env.EZY_PORTAL_BASE_URL, row.notification_ref) ?? null,
    // The shape AppFounderNotifier stores today: MessageContext.contextRef.
    context: row.inbox_ref ? { contextRef: { kind: 'inbox', ref: row.inbox_ref } } : null,
  })).filter((p) => p.url !== null || p.context !== null);
  const untouchable = rows.length - planned.length;

  for (const p of planned) logger.info({ id: p.id, url: p.url, origin: p.context?.contextRef.ref ?? null }, apply ? 'backfilling' : 'would backfill');
  if (untouchable > 0) logger.warn({ untouchable }, 'rows with neither a url nor an origin — left untouched');

  if (!apply) {
    logger.info({ candidates: rows.length, writable: planned.length }, 'DRY run — re-run with --apply to write');
    return;
  }

  let updated = 0;
  for (const p of planned) {
    // COALESCE + the IS NULL guards: only ever FILL a gap. A live insert that wrote either column
    // under us wins — this backfill must not clobber what the running service just recorded.
    const { rowCount } = await query(
      `UPDATE founder_app_messages
          SET link_url = COALESCE(link_url, $2),
              context  = COALESCE(context, $3::jsonb)
        WHERE id = $1::uuid AND (link_url IS NULL OR context IS NULL)`,
      [p.id, p.url, p.context ? JSON.stringify(p.context) : null],
    );
    updated += rowCount ?? 0;
  }
  logger.info({ updated, candidates: rows.length }, 'backfill:app-links done');
}

main()
  .catch((err) => {
    logger.error({ err: { name: (err as { name?: string })?.name } }, 'backfill:app-links failed');
    process.exitCode = 1;
  })
  .finally(() => pool.end());
