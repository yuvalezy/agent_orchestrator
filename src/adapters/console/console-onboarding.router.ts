import { Router } from 'express';
import type { OnboardingService } from '../onboarding';
import {
  listCustomerModules,
  listModuleVocabulary,
  getModuleScoping,
  setOperatorModules,
} from '../../customers/customer-modules';
import { auditConsoleAction, type ConsoleAuditContext } from './console-repo';

// Console Onboarding surface. Mounted under /console/api/onboarding (inherits the parent router's
// session + CSRF + audit-context, like console-approvals/console-connectors). Search + preview are
// GET reads (no CSRF); onboarding, the backfill triggers, and the module-scoping PUT are CSRF-guarded
// mutations. All portal I/O and persistence live in the injected OnboardingService / customer-modules
// core — this router only validates input, maps outcomes to status codes, and audits the writes.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The customer-module (scoping, C) core queries the router reads — db-only, mirrors the customer-
 *  modules module's exports. Injectable (like `audit`) so the router can be tested without a DB. */
export interface CustomerModuleQueries {
  listModuleVocabulary: typeof listModuleVocabulary;
  listCustomerModules: typeof listCustomerModules;
  getModuleScoping: typeof getModuleScoping;
  setOperatorModules: typeof setOperatorModules;
}

export interface OnboardingRouterDeps {
  onboarding: OnboardingService;
  /** Best-effort audit sink (defaults to the console audit table). Injected as a no-op in tests. */
  audit?: typeof auditConsoleAction;
  /** Module-scoping core queries (defaults to the real customer-modules db functions). */
  modules?: CustomerModuleQueries;
}

export function buildConsoleOnboardingRouter(deps: OnboardingRouterDeps): Router {
  const router = Router();
  const { onboarding } = deps;
  const audit = deps.audit ?? auditConsoleAction;
  const modules = deps.modules ?? { listModuleVocabulary, listCustomerModules, getModuleScoping, setOperatorModules };

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

  // ── Module-scoping vocabulary (picker options: the distinct module keys across the corpus) ──
  // Two literal segments, so it never collides with the `/:customerId/modules` param route below.
  router.get('/modules/vocabulary', async (_req, res, next) => {
    try {
      res.json({ data: await modules.listModuleVocabulary() });
    } catch (err) {
      next(err);
    }
  });

  // ── A customer's module set + the module_scoping_enabled flag (each row carries its source) ──
  router.get('/:customerId/modules', async (req, res, next) => {
    if (!UUID_RE.test(req.params.customerId)) return void res.status(400).json({ error: 'invalid customer id' });
    try {
      const [rows, scoping] = await Promise.all([
        modules.listCustomerModules(req.params.customerId),
        modules.getModuleScoping(req.params.customerId),
      ]);
      res.json({ data: { modules: rows, moduleScopingEnabled: scoping.enabled } });
    } catch (err) {
      next(err);
    }
  });

  // ── Declare a customer's modules (CSRF-guarded, audited). Operator picks → source='operator',
  //    deselected rows soft-removed, module_scoping_enabled turned on (all behind setOperatorModules) ─
  router.put('/:customerId/modules', async (req, res, next) => {
    if (!UUID_RE.test(req.params.customerId)) return void res.status(400).json({ error: 'invalid customer id' });
    const body = req.body as { moduleKeys?: unknown } | undefined;
    if (!Array.isArray(body?.moduleKeys) || !body.moduleKeys.every((k) => typeof k === 'string')) {
      return void res.status(400).json({ error: 'moduleKeys must be an array of strings' });
    }
    const moduleKeys = (body.moduleKeys as string[]).map((k) => k.trim()).filter((k) => k.length > 0);
    try {
      await modules.setOperatorModules(req.params.customerId, moduleKeys);
      await audit(res.locals.consoleAuditContext as ConsoleAuditContext, 'onboarding.customer.modules', 'agent_customers', req.params.customerId, { moduleKeys });
      res.json({ data: { customerId: req.params.customerId, moduleKeys } });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
