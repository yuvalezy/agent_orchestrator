import 'dotenv/config';
import { pool } from '../src/db';
import { buildEzyPortalGateway } from '../src/adapters/ezy-portal';
import { EzyHttpError } from '../src/adapters/ezy-portal/http-client';

// §5.2 contract suite (M1.5a gate) — a REAL create → find-by-sourceEntity →
// comment → setStatus round-trip against the test tenant (account-test / :5040)
// using the scoped ten_ key. NOT a mock. Uses TEST_PROJECT_REF/TEST_BP_REF (.env).
//
//   npm run contract:ezy
//
// Cleanup is setStatus('cancelled') — the scoped Write key can't DELETE (Admin).
// A per-run sourceEntityId prevents collisions across runs.

const log = (s: string) => process.stdout.write(s + '\n');

async function main(): Promise<void> {
  const projectRef = process.env.TEST_PROJECT_REF;
  const bpRef = process.env.TEST_BP_REF;
  if (!projectRef || !bpRef) throw new Error('set TEST_PROJECT_REF and TEST_BP_REF in .env');

  const gw = buildEzyPortalGateway();
  const runId = `contract-${Date.now()}`;
  log(`▶ EZY TaskTargetPort contract — project ${projectRef}, runId ${runId}\n`);

  // 1. WIT (proves the two-hop + project-type match)
  const wits = await gw.listWorkItemTypes(projectRef);
  if (!wits.length) throw new Error('no work-item-types for the project (two-hop returned empty)');
  const wit = wits[0];
  log(`  1. listWorkItemTypes → ${wits.length} types; using "${wit.name}" (${wit.ref})`);

  // 2. createTask (must not 422)
  const task = await gw.createTask({
    customerRef: bpRef,
    projectRef,
    workItemTypeRef: wit.ref,
    title: `Contract test ${runId}`,
    description: 'Automated M1.5a contract-suite task. Safe to cancel.',
    priority: 'medium',
    source: { service: 'agent-orchestrator', entityType: 'whatsapp', entityId: runId, display: 'contract suite' },
    tags: ['contract', 'agent-orchestrator'],
  });
  log(`  2. createTask → ${task.ref}`);

  // 3. findOpenTasks by sourceEntity (the dedup linchpin)
  const found = await gw.findOpenTasks({ sourceEntity: { type: 'whatsapp', id: runId } });
  const hit = found.find((t) => t.ref === task.ref);
  if (!hit) throw new Error(`findOpenTasks did not return the created task (got ${found.length} rows)`);
  log(`  3. findOpenTasks(sourceEntity) → found it (status=${hit.status})`);

  // 4. addComment
  await gw.addComment(task, 'Contract-suite comment.');
  log('  4. addComment → ok');

  // 5. setStatus in-progress → done (WIP-limit/read-only would 409 here — R45)
  await gw.setStatus(task, 'in-progress');
  await gw.setStatus(task, 'done');
  log('  5. setStatus in-progress → done → ok');

  // 6. cleanup (can't DELETE with the Write key)
  await gw.setStatus(task, 'cancelled');
  log('  6. setStatus cancelled (cleanup) → ok');

  log('\n✅ CONTRACT PASSED — verified-strict portal write path is correct.');
}

main()
  .catch((err) => {
    if (err instanceof EzyHttpError) {
      const kind = err.status === 422 ? 'VALIDATION (422)' : err.status === 409 ? 'CONFLICT (409 — project read-only / WIP limit?)' : `HTTP ${err.status}`;
      log(`\n❌ CONTRACT FAILED — ${kind}: ${err.message}\n   detail: ${err.detail}`);
    } else {
      log(`\n❌ CONTRACT FAILED — ${(err as Error)?.message}`);
    }
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
