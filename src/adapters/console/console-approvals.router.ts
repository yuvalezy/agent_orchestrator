import { Router, type Response } from 'express';
import { logger } from '../../logger';
import type { FounderNotifierPort } from '../../ports/founder-notifier.port';
import { approveDraft, cancelDraft, replaceDraftBodyAndApprove } from '../../outbound/outbound-repo';
import { approveBackfillProposal, rejectBackfillProposal } from '../../knowledge/backfill-approve';
import {
  claimBackfillProposalDecision,
  completeBackfillProposalDecision,
  getBackfillProposal,
  releaseBackfillProposalDecision,
  resolveBackfillProposalDecision,
} from '../../decisions/decisions';
import { loadCustomerConfig } from '../../triage/context-loader';
import { buildEzyPortalGateway } from '../ezy-portal/factory';
import { buildDraftReviserService } from '../triage/callback-poller.factory';
import { listPendingDrafts, listPendingBackfillProposals, auditApproval } from './console-approvals-repo';
import type { ConsoleAuditContext } from './console-repo';

// Console Approvals surface (ADAPTER composition). Mounted under /console/api/approvals by the main
// console router — so it inherits its session-auth + audit-context middleware and the CSRF guard.
// Every mutation REUSES the exact core fn the Telegram flow calls (approveDraft / cancelDraft /
// replaceDraftBodyAndApprove / approveBackfillProposal / rejectBackfillProposal / the reviser) — no
// reimplementation, identical idempotency guards, identical send path. `by='founder'`.

const FOUNDER = 'founder';
const validId = (v: string): boolean => /^\d+$/.test(v) && Number(v) > 0;
const auditCtx = (res: Response): ConsoleAuditContext => res.locals.consoleAuditContext as ConsoleAuditContext;

export function buildConsoleApprovalsRouter(): Router {
  const router = Router();
  const portal = buildEzyPortalGateway();

  // Reviser with a NO-OP notifier: a console revise must NOT re-post to Telegram (the founder is
  // moving off it) — the console refetch shows the regenerated draft. null when DRAFT_REVISE_ENABLED
  // is off (→ the revise route 404s and the UI hides the control).
  const noopNotifier: Pick<FounderNotifierPort, 'notifyCustomerEvent' | 'notifyAdmin'> = {
    notifyCustomerEvent: async () => {},
    notifyAdmin: async () => {},
  };
  const reviser = buildDraftReviserService(noopNotifier);

  const backfillDeps = {
    claim: claimBackfillProposalDecision,
    getProposal: getBackfillProposal,
    getCustomerTarget: async (customerId: string) => {
      const c = await loadCustomerConfig(customerId);
      return c ? { projectRef: c.projectRef, workItemTypeRef: c.workItemTypeRef } : null;
    },
    createTask: (i: Parameters<typeof portal.createTask>[0]) => portal.createTask(i),
    complete: completeBackfillProposalDecision,
    release: releaseBackfillProposalDecision,
    log: logger,
  };

  // ── Lists ──────────────────────────────────────────────────────────────────
  router.get('/capabilities', (_req, res) => res.json({ data: { reviseEnabled: reviser !== null } }));
  router.get('/drafts', async (_req, res, next) => {
    try {
      res.json({ data: await listPendingDrafts() });
    } catch (err) {
      next(err);
    }
  });
  router.get('/proposals', async (_req, res, next) => {
    try {
      res.json({ data: await listPendingBackfillProposals() });
    } catch (err) {
      next(err);
    }
  });

  // ── Draft mutations (reuse outbound-repo core fns; null → 409 already-resolved) ──
  const conflict = (res: Response): void => void res.status(409).json({ error: 'state changed; refresh and review' });

  router.post('/drafts/:queueId/approve', async (req, res, next) => {
    if (!validId(req.params.queueId)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const r = await approveDraft(req.params.queueId, FOUNDER);
      if (!r) return conflict(res);
      await auditApproval(auditCtx(res), 'draft.approve', 'agent_outbound_queue', req.params.queueId, 'pending', 'approved');
      res.status(200).json({ data: { queueId: req.params.queueId, status: 'approved' } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/drafts/:queueId/reject', async (req, res, next) => {
    if (!validId(req.params.queueId)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const r = await cancelDraft(req.params.queueId, FOUNDER);
      if (!r) return conflict(res);
      await auditApproval(auditCtx(res), 'draft.reject', 'agent_outbound_queue', req.params.queueId, 'pending', 'cancelled');
      res.status(200).json({ data: { queueId: req.params.queueId, status: 'cancelled' } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/drafts/:queueId/edit', async (req, res, next) => {
    if (!validId(req.params.queueId)) return void res.status(400).json({ error: 'invalid id' });
    const body = (req.body as { body?: unknown } | undefined)?.body;
    if (typeof body !== 'string' || !body.trim()) return void res.status(400).json({ error: 'body is required' });
    try {
      const r = await replaceDraftBodyAndApprove(req.params.queueId, body, FOUNDER);
      if (!r) return conflict(res);
      await auditApproval(auditCtx(res), 'draft.edit', 'agent_outbound_queue', req.params.queueId, 'pending', 'approved');
      res.status(200).json({ data: { queueId: req.params.queueId, status: 'approved' } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/drafts/:queueId/revise', async (req, res, next) => {
    if (!validId(req.params.queueId)) return void res.status(400).json({ error: 'invalid id' });
    if (!reviser) return void res.status(404).json({ error: 'revise not enabled' });
    const instruction = (req.body as { instruction?: unknown } | undefined)?.instruction;
    if (typeof instruction !== 'string' || !instruction.trim()) return void res.status(400).json({ error: 'instruction is required' });
    try {
      // reviseFromInstruction NEVER throws (degrades internally); the client refetches /drafts to
      // see the regenerated body. It runs regeneration synchronously before returning.
      await reviser.reviseFromInstruction({ queueId: req.params.queueId, instruction, by: FOUNDER });
      await auditApproval(auditCtx(res), 'draft.revise', 'agent_outbound_queue', req.params.queueId, 'pending', 'pending');
      res.status(200).json({ data: { queueId: req.params.queueId, revised: true } });
    } catch (err) {
      next(err);
    }
  });

  // ── Backfill proposal mutations (reuse knowledge/backfill-approve core) ──────
  router.post('/proposals/:decisionId/approve', async (req, res, next) => {
    if (!validId(req.params.decisionId)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const r = await approveBackfillProposal(req.params.decisionId, FOUNDER, backfillDeps);
      if (!r.ok) {
        const status = r.reason === 'proposal not found' ? 404 : 422;
        return void res.status(status).json({ error: r.reason });
      }
      if (!r.created) return conflict(res); // already-resolved
      await auditApproval(auditCtx(res), 'backfill_proposal.approve', 'agent_decisions', req.params.decisionId, 'pending', 'accepted');
      res.status(200).json({ data: { decisionId: req.params.decisionId, taskRef: r.taskRef, title: r.title } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/proposals/:decisionId/reject', async (req, res, next) => {
    if (!validId(req.params.decisionId)) return void res.status(400).json({ error: 'invalid id' });
    try {
      const r = await rejectBackfillProposal(req.params.decisionId, FOUNDER, { resolve: resolveBackfillProposalDecision, log: logger });
      if (!r.resolved) return conflict(res);
      await auditApproval(auditCtx(res), 'backfill_proposal.reject', 'agent_decisions', req.params.decisionId, 'pending', 'rejected');
      res.status(200).json({ data: { decisionId: req.params.decisionId, status: 'rejected' } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
