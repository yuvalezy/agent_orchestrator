// The INTERNAL corpus map (MI "Project Brain" — founder/dev-facing knowledge).
// A typed const array styled like sources.ts: no logic, just the on-disk map of OUR
// planning / decision / architecture / risk / backlog docs. The internal fs walker
// (internal-doc-source.ts) reads these; nothing here touches the disk.
//
// Roots are REPO-RELATIVE; `repo` selects the checkout base (INTERNAL_REPO_ROOTS).
// `include` entries are repo-relative FILES or DIRECTORIES; a directory is walked
// recursively for *.md. `excludeDirs` names directory segments skipped ANYWHERE
// UNDER an included directory (an explicitly-included dir is itself always walked,
// even if its own name is in the set — only its sub-dirs are pruned).
//
// ⚠︎ CURATED + CLASSIFIED. Each entry is one `sourceId` = the citation prefix, so the
// corpus is threaded by area: portal cross-cutting (`portal-*`), per micro-service
// (`svc-*`), per portal-business module (`pb-*`), per customer code (`cust-*`), and
// the sibling repos (`wms-*`, `ezy-integration`, `ezy-report-generator`).
//
// ⚠︎ EXCLUDE the EMBEDDED customer-facing docs by construction: we NEVER include the
// DocArticle locale trees (`config/registration/docs`, `modules/*/docs`,
// `Infrastructure/Docs/Content`) — those are the CUSTOMER corpus (see sources.ts),
// and this internal corpus is isolated from customer replies (separate table + search).

export type InternalRepo =
  | 'yuval_dev_manager'
  | 'ai-agent'
  | 'portal'
  | 'wms'
  | 'ezy-integration'
  | 'ezy-report-generator';

export interface InternalSource {
  /** Stable source id — the first segment of every docKey it produces. */
  id: string;
  /** Checkout the includes are relative to. */
  repo: InternalRepo;
  /** Repo-relative files or directories. Directories are walked recursively for *.md. */
  include: string[];
  /** Directory-name segments to skip anywhere under an included directory. */
  excludeDirs?: string[];
}

/** Absolute checkout root per repo. Mirrors fs-doc-source's DEFAULT_REPO_ROOTS shape;
 *  the 'yuval_dev_manager' repo key is a legacy citation label — the orchestrator
 *  planning corpus (plan/…) now lives under this repo's own docs/. */
export const INTERNAL_REPO_ROOTS: Record<InternalRepo, string> = {
  yuval_dev_manager: '/mnt/dev/tools/agent_orchestrator/docs',
  'ai-agent': '/mnt/dev/ai-agent',
  portal: '/mnt/dev/portal',
  wms: '/mnt/dev/wms',
  'ezy-integration': '/mnt/dev/ezy/ezy-integration',
  'ezy-report-generator': '/mnt/dev/ezy/ezy-report-generator',
};

// Directory segments that are NEVER decision truth — superseded/archived scratch,
// build/output artifacts, duplicate worktrees, run-summaries + e2e test notes (noise).
const SCRATCH_EXCLUDES = [
  'archive', 'active', 'executed', 'sessions', 'session-logs', 'prompts', 'tmp', '.tmp',
  'node_modules', 'bin', 'obj', '.git', '.worktrees', 'worktrees', '.claude',
  'summary', 'e2e', 'publish', 'test-results', 'logs', 'playwright-report',
  'temp-pdfs', 'output', 'reports',
];

// ezy-report-generator's ONLY architecture/config/plugin design docs live under
// archive/planning (Yuval: include them) — so this source must NOT prune 'archive'.
const REPORTGEN_EXCLUDES = SCRATCH_EXCLUDES.filter((d) => d !== 'archive');

/** One curated source. `excludeDirs` defaults to the shared scratch set. */
const src = (id: string, repo: InternalRepo, include: string[], excludeDirs: string[] = SCRATCH_EXCLUDES): InternalSource => ({
  id,
  repo,
  include,
  excludeDirs,
});

// A portal micro-service: its internal plan/ + docs/ + root instruction files. NEVER
// its `backend/config/registration/docs` (embedded customer docs) — not included.
const svc = (name: string): InternalSource =>
  src(`svc-${name}`, 'portal', [
    `services/${name}/plan`,
    `services/${name}/docs`,
    `services/${name}/README.md`,
    `services/${name}/AGENTS.md`,
    `services/${name}/CHANGELOG.md`,
    `services/${name}/CLAUDE.md`,
  ]);

// A portal-business module's INTERNAL design docs (Go internal/ tree) — distinct from
// the customer `config/registration/modules/<m>/docs` locale corpus (excluded).
const pbMod = (name: string): InternalSource =>
  src(`pb-${name}`, 'portal', [`services/portal-business/backend/internal/modules/${name}`]);

// A customer code's INTERNAL planning/docs only — NOT its customer-facing
// `backend/config/registration/docs` (that is the customer RAG).
const cust = (code: string): InternalSource =>
  src(`cust-${code}`, 'portal', [
    `customers/${code}/plan`,
    `customers/${code}/docs`,
    `customers/${code}/gap`,
    `customers/${code}/README.md`,
  ]);

// Enumerated once here (curated). Add a service/module/customer by extending its list.
const PORTAL_SERVICES = ['accounting', 'catalog-automation', 'insight-studio', 'pos', 'sbo-insights', 'showcase'];
const PB_MODULES = ['bp', 'inspect', 'items', 'payment-processor', 'pricing-tax', 'projects', 'prospects', 'service-desk'];
const PORTAL_CUSTOMERS = ['hola-doc', 'myezy', 'pilates-gal', 'red-cloud-quotation-tool', 'lavazza', 'cotton-candy-crm', 'home_group'];

export const INTERNAL_SOURCES: readonly InternalSource[] = [
  // ── Agent Orchestrator planning (the OpenSpec plan) + ai-agent platform reference ──
  src('ao-plan', 'yuval_dev_manager', [
    'plan/EXECUTION-PLAN.md',
    'plan/RISK-REGISTER.md',
    'plan/project.md',
    'plan/blueprints',
    'plan/changes',
    'plan/specs',
  ]),
  src('ai-agent-ref', 'ai-agent', ['plan/reference', 'docs/AI_Agent_SaaS_Platform_Specification.md']),

  // ── Portal — cross-cutting platform docs ─────────────────────────────────────────
  src('portal-superplan', 'portal', ['superplan']),
  src('portal-plan', 'portal', ['plan', 'docs', 'AGENTS.md', 'CLAUDE.md', 'dev_portal.md']),
  src('portal-services', 'portal', [
    'services/SERVICES_OVERVIEW.md',
    'services/SERVICES_ROADMAP.md',
    'services/DESIGN_SPECIFICATION.md',
    'services/DATABASE_SCHEMA.md',
    'services/AUTH_AND_ERROR_HANDLING.md',
    'services/AGENTS.md',
  ]),
  src('portal-origin', 'portal', [
    'origin/plan',
    'origin/docs',
    'origin/contracts',
    'origin/roadmap',
    'origin/RUNBOOK.md',
    'origin/DOCKER.md',
    'origin/README.md',
  ]),
  src('portal-core', 'portal', ['core/plan', 'core/backend/docs', 'core/frontend/docs', 'core/frontend/plan']),
  src('portal-mcp', 'portal', ['mcp-server/DEPLOYMENT.md', 'mcp-server/plan']),
  src('pb-shared', 'portal', ['services/portal-business/plan']),

  // ── Portal — per micro-service / per portal-business module / per customer code ───
  ...PORTAL_SERVICES.map(svc),
  ...PB_MODULES.map(pbMod),
  ...PORTAL_CUSTOMERS.map(cust),

  // ── Sibling repos ────────────────────────────────────────────────────────────────
  src('wms-plan', 'wms', ['plan', 'CLAUDE.md']),
  src('wms-backend', 'wms', ['ezy-wms-backend/docs', 'ezy-wms-backend/CLAUDE.md']),
  src('wms-frontend', 'wms', [
    'ezy-wms-frontend/docs',
    'ezy-wms-frontend/CLAUDE.md',
    'ezy-wms-frontend/packages_plan.md',
    'ezy-wms-frontend/TRANSFER_CONTEXT_REFACTOR.md',
    'ezy-wms-frontend/.junie/guidelines.md',
  ]),
  src('ezy-integration', 'ezy-integration', ['docs', 'plan', 'bootstrap', 'CLAUDE.md']),
  src(
    'ezy-report-generator',
    'ezy-report-generator',
    ['docs', 'plan', 'archive/planning', 'SECURITY.md', 'SECURITY_IMPLEMENTATION_SUMMARY.md', 'CHANGELOG.md', 'CLAUDE.md'],
    REPORTGEN_EXCLUDES,
  ),
];

export type InternalSourceId = (typeof INTERNAL_SOURCES)[number]['id'];
