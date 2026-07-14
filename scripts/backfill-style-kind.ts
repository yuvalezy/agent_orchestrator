import 'dotenv/config';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { tryResolveCredential } from '../src/config/credentials';
import { buildLlmRouter } from '../src/adapters/llm/factory';

// One-off backfill: tag pre-existing tone corrections metadata.kind='style' (Style-Correction
// Always-On lane). Corrections learned BEFORE the `kind` tag existed carry no metadata.kind, so the
// style lane (which filters memory_type='correction' AND metadata->>'kind'='style') can't see them —
// a learned voice/tone directive stays structurally invisible. This sweep re-runs the EXACT same
// correction classifier the live learning loop uses (LlmRouter.classifyCorrection) over each
// untagged correction and, for the ones it classifies 'style', stamps metadata.kind='style' in
// place. Fact-classified rows are left untouched (they already take the normal embedding-gated lane).
//
// ISOLATION: only ever touches agent_memory rows of memory_type='correction' (customer-readable) —
// NEVER internal_knowledge. NO migration (rides the existing JSONB). Idempotent: rows that already
// carry a kind are skipped by the query; a style UPDATE is guarded on kind still being absent, so a
// re-run is a no-op. NEVER logs correction bodies — counts only.
//
// DEFAULTS TO DRY-RUN. Pass --apply (or --no-dry-run) to actually write.
//
//   OPENAI_API_KEY=… npm run backfill:style-kind            # dry-run (reports counts, writes nothing)
//   OPENAI_API_KEY=… npm run backfill:style-kind -- --apply # writes metadata.kind='style'

interface UntaggedCorrection {
  id: string;
  /** The normalized directive/statement to classify — the stored `fact`, degrading to `content`
   *  for older rows that predate the fact field. Fed to the classifier as the correction text. */
  fact: string;
  language: string | null;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Dry-run is the SAFE default: an explicit --apply (or --no-dry-run) is required to write.
  const apply = args.includes('--apply') || args.includes('--no-dry-run');
  const dryRun = !apply;

  // The classifier is an LLM call — it needs a resolvable provider key (classify role default is
  // Anthropic haiku; the router fails over per its chain). Warn early rather than fail every row.
  if (!tryResolveCredential('ANTHROPIC_API_KEY') && !tryResolveCredential('OPENAI_API_KEY')) {
    logger.warn('no ANTHROPIC_API_KEY / OPENAI_API_KEY resolvable — the classifier will fail over and likely error per row');
  }

  const classifier = buildLlmRouter({
    // Script has no founder channel; surface a gateway warning to the log only.
    notifyAdmin: async (msg) => logger.warn({ msg }, 'llm gateway'),
  });

  // Untagged corrections only: metadata->>'kind' IS NULL covers BOTH an absent key and a JSON-null
  // value. Rows already carrying a kind are excluded here → idempotent (a re-run re-scans nothing
  // already tagged). Bodies are never logged; only the id + the fact we must classify are read.
  const { rows } = await query<UntaggedCorrection>(
    `SELECT id,
            COALESCE(NULLIF(metadata->>'fact', ''), content) AS fact,
            metadata->>'language' AS language
       FROM agent_memory
      WHERE memory_type = 'correction'
        AND (metadata->>'kind') IS NULL
      ORDER BY id`,
  );

  logger.info({ untagged: rows.length, mode: dryRun ? 'dry-run' : 'apply' }, 'backfill style-kind: scanning untagged corrections');

  let style = 0; // classified 'style'
  let fact = 0; // classified 'fact' (left untouched)
  let updated = 0; // rows actually stamped kind='style' (apply mode)
  let errors = 0; // classifier failures (row skipped, never logs the body)

  for (const row of rows) {
    let kind: 'fact' | 'style';
    try {
      // REUSE the live classifier fn/prompt — no hand-rolled heuristic. The stored fact IS the
      // normalized correction; there is no original prior-draft to replay, so pass it empty (the
      // prompt still classifies kind from the correction text). language carries the row's locale.
      const cls = await classifier.classifyCorrection({
        instruction: row.fact,
        priorDraft: '',
        language: row.language ?? undefined,
      });
      kind = cls.kind;
    } catch (err) {
      errors += 1;
      logger.warn({ id: row.id, reason: (err as Error)?.message }, 'backfill style-kind: classify failed — skipped');
      continue;
    }

    if (kind !== 'style') {
      fact += 1;
      continue;
    }
    style += 1;

    if (dryRun) continue;

    // Stamp metadata.kind='style' in place. Re-guarded on kind still being absent (concurrency- and
    // re-run-safe) and scoped to a correction row (never any other memory type). No body logged.
    const res = await query(
      `UPDATE agent_memory
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{kind}', '"style"')
        WHERE id = $1
          AND memory_type = 'correction'
          AND (metadata->>'kind') IS NULL`,
      [row.id],
    );
    updated += res.rowCount ?? 0;
  }

  logger.info(
    { scanned: rows.length, style, fact, errors, updated, mode: dryRun ? 'dry-run' : 'apply' },
    dryRun
      ? `backfill style-kind DRY-RUN: ${style} correction(s) would be tagged kind='style' (${fact} fact, ${errors} classify error(s)) — nothing written. Re-run with --apply to write.`
      : `backfill style-kind APPLIED: ${updated} correction(s) tagged kind='style' (${fact} fact, ${errors} classify error(s)).`,
  );
}

main()
  .catch((err) => { logger.error({ err: { message: (err as Error)?.message } }, 'backfill style-kind failed'); process.exitCode = 1; })
  .finally(() => void pool.end());
