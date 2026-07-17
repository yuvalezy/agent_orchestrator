import { Router } from 'express';
import type { OnboardingService } from '../onboarding';
import { auditConsoleAction, type ConsoleAuditContext } from './console-repo';

// Console Onboarding surface. Mounted under /console/api/onboarding (inherits the parent router's
// session + CSRF + audit-context, like console-approvals/console-connectors). Search + preview are
// GET reads (no CSRF); onboarding and the backfill triggers are CSRF-guarded mutations. All portal
// I/O and persistence live in the injected OnboardingService — this router only validates input,
// maps outcomes to status codes, and audits the writes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OnboardingRouterDeps {
  onboarding: OnboardingService;
  /** Best-effort audit sink (defaults to the console audit table). Injected as a no-op in tests. */
  audit?: typeof auditConsoleAction;
}

export function buildConsoleOnboardingRouter(deps: OnboardingRouterDeps): Router {
  const router = Router();
  const { onboarding } = deps;
  const audit = deps.audit ?? auditConsoleAction;

  // ── Portal customer search (annotated with alreadyOnboarded) ────────────────
  router.get('/customers', async (req, res, next) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return void res.json({ data: [] });
    try {
      res.json({ data: await onboarding.searchCustomers(q) });
    } catch (err) {
      next(err);
    }
  });

  // ── Portal project search (the operator picks the target project) ───────────
  router.get('/projects', async (req, res, next) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q) return void res.json({ data: [] });
    try {
      res.json({ data: await onboarding.searchProjects(q) });
    } catch (err) {
      next(err);
    }
  });

  // ── Customer preview: detail + WhatsApp/email contacts + alreadyOnboarded ────
  router.get('/customers/:bpRef/preview', async (req, res, next) => {
    if (!UUID_RE.test(req.params.bpRef)) return void res.status(400).json({ error: 'invalid business partner ref' });
    try {
      res.json({ data: await onboarding.previewCustomer(req.params.bpRef) });
    } catch (err) {
      next(err);
    }
  });

  // ── Work item types for a project (2-hop resolution behind the service) ──────
  router.get('/projects/:ref/work-item-types', async (req, res, next) => {
    if (!UUID_RE.test(req.params.ref)) return void res.status(400).json({ error: 'invalid project ref' });
    try {
      res.json({ data: await onboarding.listWorkItemTypes(req.params.ref) });
    } catch (err) {
      next(err);
    }
  });

  // ── Onboard (CSRF-guarded). 409 when already onboarded, 422 for a bad work item type ─
  router.post('/', async (req, res, next) => {
    const body = req.body as { bpRef?: unknown; projectRef?: unknown; workItemTypeRef?: unknown } | undefined;
    const bpRef = typeof body?.bpRef === 'string' ? body.bpRef : '';
    const projectRef = typeof body?.projectRef === 'string' ? body.projectRef : '';
    const workItemTypeRef = typeof body?.workItemTypeRef === 'string' && body.workItemTypeRef ? body.workItemTypeRef : undefined;
    if (!UUID_RE.test(bpRef)) return void res.status(400).json({ error: 'invalid business partner ref' });
    if (!UUID_RE.test(projectRef)) return void res.status(400).json({ error: 'invalid project ref' });
    if (workItemTypeRef && !UUID_RE.test(workItemTypeRef)) return void res.status(400).json({ error: 'invalid work item type ref' });
    try {
      const result = await onboarding.onboard({ bpRef, projectRef, workItemTypeRef });
      if (!result.ok) {
        const status = result.error === 'already_onboarded' ? 409 : 422;
        return void res.status(status).json({ error: result.message });
      }
      await audit(res.locals.consoleAuditContext as ConsoleAuditContext, 'onboarding.customer.onboard', 'agent_customers', result.customerId, { bpRef, projectRef });
      res.status(201).json({ data: { customerId: result.customerId, created: result.created, waBlocked: result.waBlocked, workItemTypeRef: result.workItemTypeRef } });
    } catch (err) {
      next(err);
    }
  });

  // ── Backfill status (dry summary + live status + enablement) ────────────────
  router.get('/:customerId/backfill', async (req, res, next) => {
    if (!UUID_RE.test(req.params.customerId)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      res.json({ data: await onboarding.backfillStatus(req.params.customerId) });
    } catch (err) {
      next(err);
    }
  });

  // ── Kick a backfill job (CSRF-guarded). 409 when one is already running / disabled ─
  router.post('/:customerId/backfill/:mode', async (req, res, next) => {
    if (!UUID_RE.test(req.params.customerId)) return void res.status(400).json({ error: 'invalid customer id' });
    const mode = req.params.mode;
    if (mode !== 'dry' && mode !== 'live') return void res.status(400).json({ error: 'mode must be "dry" or "live"' });
    try {
      const started = await onboarding.startBackfill(req.params.customerId, mode);
      if (!started.started) return void res.status(409).json({ error: started.reason ?? 'could not start backfill' });
      await audit(res.locals.consoleAuditContext as ConsoleAuditContext, `onboarding.backfill.${mode}`, 'agent_customers', req.params.customerId, {});
      res.status(202).json({ data: { customerId: req.params.customerId, mode, started: true } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
