// The INTERNAL corpus map (MI "Project Brain" — founder/dev-facing knowledge).
// A typed const array styled like sources.ts: no logic, just the on-disk map of OUR
// planning / decision / architecture / risk / backlog docs. The internal fs walker
// (internal-doc-source.ts) reads these; nothing here touches the disk.
//
// Roots are REPO-RELATIVE; `repo` selects the checkout base (INTERNAL_REPO_ROOTS).
// `include` entries are repo-relative FILES or DIRECTORIES; a directory is walked
// recursively for *.md. `excludeDirs` names directory segments skipped ANYWHERE in
// the tree (superseded scratch / archives / session logs — not decision truth).
//
// ⚠︎ CURATED. INCLUDE decision/architecture/risk/backlog/spec docs; EXCLUDE session
// logs, prompt archives, throwaway checklists, and superseded scratch. This corpus is
// isolated from the customer corpus by construction (separate table + search fn), so
// nothing here can leak into a customer reply — but keep it decision-grade anyway.

export type InternalRepo = 'yuval_dev_manager' | 'ai-agent' | 'portal';

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
 *  yuval_dev_manager holds the orchestrator planning corpus (plan/…). */
export const INTERNAL_REPO_ROOTS: Record<InternalRepo, string> = {
  yuval_dev_manager: '/mnt/dev/tools/yuval_dev_manager',
  'ai-agent': '/mnt/dev/ai-agent',
  portal: '/mnt/dev/portal',
};

// Directory segments that are NEVER decision truth — archived/superseded scratch.
const COMMON_EXCLUDES = ['archive', 'active', 'executed', 'sessions', 'session-logs', 'prompts', 'tmp'];

export const INTERNAL_SOURCES = [
  // ── Agent Orchestrator planning (the OpenSpec plan: execution, risk, blueprints,
  //    change proposals, shipped specs). The source of truth for how we build. ─────
  {
    id: 'ao-plan',
    repo: 'yuval_dev_manager',
    include: [
      'plan/EXECUTION-PLAN.md',
      'plan/RISK-REGISTER.md',
      'plan/project.md',
      'plan/blueprints',
      'plan/changes',
      'plan/specs',
    ],
    excludeDirs: COMMON_EXCLUDES,
  },

  // ── ai-agent platform reference + the SaaS platform specification. EXCLUDE the
  //    active/executed plan scratch (superseded working notes, not decisions). ──────
  {
    id: 'ai-agent-ref',
    repo: 'ai-agent',
    include: ['plan/reference', 'docs/AI_Agent_SaaS_Platform_Specification.md'],
    excludeDirs: COMMON_EXCLUDES,
  },

  // ── portal decision/spec docs (cross-service implementation plans + contracts). ──
  {
    id: 'portal-specs',
    repo: 'portal',
    include: ['superplan/specs'],
    excludeDirs: COMMON_EXCLUDES,
  },
] as const satisfies readonly InternalSource[];

export type InternalSourceId = (typeof INTERNAL_SOURCES)[number]['id'];
