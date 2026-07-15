import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DocSourcePort } from '../../ports/doc-source.port';
import type { SyncLogger } from '../../knowledge/sync';
import type { CustomerDocSourceRow } from '../../customers/customer-doc-sources';
import { buildFsDocSource, DEFAULT_REPO_ROOTS, type FsDocSourceDeps } from './fs-doc-source';
import { KNOWLEDGE_SOURCES, type KnowledgeSource } from './sources';

// DB-REGISTERED customer doc corpora (ADAPTER). sources.ts is the compile-time corpus map;
// this is its data-driven twin — the rows migration 032 lets onboarding write, turned into
// the SAME KnowledgeSource shape and unioned onto the const. The walker (fs-doc-source.ts)
// is untouched: its `sources` dep was already injectable, so this is purely additive.
//
// Resolved PER TICK, not at boot: buildCustomerAwareDocSource re-reads the registry on every
// listDocs(), so a customer onboarded at 10:01 is walked on the 10:05 tick. Resolving once at
// wiring time would have traded "code edit + redeploy" for "restart", which is not the point.
//
// ⚠︎ Isolation: every dynamic source is scope='customer' + the row's real bpRef, and the
// source id is per-customer ('customer-docs:<customerId>', mirroring portal-task-source's
// 'task-inventory:<customerId>'). The id is load-bearing twice over: it is the first segment
// of every docKey, AND the reconciler's zero-doc + tombstone-ratio guards group on it — so a
// per-customer id means one customer's emptied/errored corpus can only ever tombstone that
// customer's own docs. customerId (the PK) keys it rather than bp_ref or a path, because the
// PK is the one identifier that cannot be re-pointed underneath a docKey that already exists.
//
// ⚠︎ FAIL-CLOSED, and this is the data-leak-class rule (sources.ts:17-21): a row without a
// resolvable bpRef is SKIPPED, never registered. It must never reach the reconciler, which
// would be its second line of defence — customer_id NULL = shared = visible to EVERY customer.

/** Fixed shape of a registered customer corpus — mirrors the hand-written hola-doc entry. */
const CUSTOMER_DOCS_LAYOUT = 'flat-locale' as const;
const CUSTOMER_DOCS_LOCALES = ['en', 'es'];
const CUSTOMER_DOCS_PRIMARY_LOCALE = 'es';
/** Module label for every registered corpus. The source id already carries the customer
 *  identity (and guarantees docKey uniqueness), so the module stays a plain honest noun
 *  rather than a guess derived from the customer's directory name. */
const CUSTOMER_DOCS_MODULE = 'docs';
/** Every customer corpus lives in the portal checkout today; docs_repo overrides it. */
const DEFAULT_DOCS_REPO: KnowledgeSource['repo'] = 'portal';

const KNOWN_REPOS = new Set<string>(Object.keys(DEFAULT_REPO_ROOTS));

export interface BuildCustomerDocSourcesDeps {
  rows: readonly CustomerDocSourceRow[];
  /** The compile-time corpus the dynamic set is checked against (default: KNOWLEDGE_SOURCES). */
  staticSources?: readonly KnowledgeSource[];
  /** Map a source `repo` to its absolute checkout root (default: the real /mnt/dev paths). */
  repoRoots?: Record<KnowledgeSource['repo'], string>;
  /** Existence seam for the on-disk root guard (default: node:fs existsSync). */
  exists?: (absPath: string) => boolean;
  log?: SyncLogger;
}

/** Repo-relative root → comparable key (tolerates a stray leading/trailing slash). */
function rootKey(repo: string, root: string): string {
  return `${repo}:${root.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/**
 * Turn registry rows into KnowledgeSources, dropping every row that cannot be registered
 * safely. Each drop is warned (ids/reasons only — never content) and costs only that one
 * customer's corpus; the rest of the union is unaffected.
 */
export function buildCustomerDocSources(deps: BuildCustomerDocSourcesDeps): KnowledgeSource[] {
  const staticSources = deps.staticSources ?? KNOWLEDGE_SOURCES;
  const repoRoots = deps.repoRoots ?? DEFAULT_REPO_ROOTS;
  const exists = deps.exists ?? ((p: string) => existsSync(p));

  // Double-registration guard. The static consts are the source of truth for the customers
  // they already cover (hola-doc, pilates-gal): if their docs_root is ever also set in the DB,
  // the dynamic row loses. Registering both would mean two source ids over the same files —
  // the same doc embedded twice, and neither copy tombstoned when the files move.
  // Keyed on BOTH bpRef (same customer twice) and repo+root (same files twice), since either
  // alone duplicates memory. The `seen` sets also dedupe the dynamic rows against each other
  // (bp_ref is UNIQUE, but two customers can be pointed at one directory by mistake).
  const seenBpRefs = new Set<string>();
  const seenRoots = new Set<string>();
  for (const s of staticSources) {
    if (s.bpRef) seenBpRefs.add(s.bpRef);
    seenRoots.add(rootKey(s.repo, s.root));
  }

  const out: KnowledgeSource[] = [];
  for (const row of deps.rows) {
    const customerId = row.customerId;

    // ⚠︎ FAIL-CLOSED: no bpRef → no customer_id → shared → leak. Skip, never register.
    const bpRef = row.bpRef?.trim();
    if (!bpRef) {
      deps.log?.warn({ customerId }, 'customer docs: row has no bpRef — skipped (fail-closed, never shared)');
      continue;
    }

    const root = row.docsRoot?.trim();
    if (!root) {
      deps.log?.warn({ customerId }, 'customer docs: blank docs_root — skipped');
      continue;
    }

    const repo = row.docsRepo?.trim() || DEFAULT_DOCS_REPO;
    if (!KNOWN_REPOS.has(repo)) {
      deps.log?.warn({ customerId, repo }, 'customer docs: unknown docs_repo — skipped (no checkout to resolve it against)');
      continue;
    }

    if (seenBpRefs.has(bpRef)) {
      deps.log?.debug?.({ customerId, bpRef }, 'customer docs: bpRef already registered by another source — skipped (no double-index)');
      continue;
    }
    const key = rootKey(repo, root);
    if (seenRoots.has(key)) {
      deps.log?.warn({ customerId, repo, root }, 'customer docs: root already registered by another source — skipped (no double-index)');
      continue;
    }

    // ⚠︎ The walker THROWS on a root that is not on disk, which aborts the ENTIRE reconcile —
    // shared corpora and every other customer with it. A static root is code-reviewed and moves
    // with the code; a DB root can rot the moment someone renames a directory. So a missing root
    // costs this one customer a pass (zero-doc → the reconciler skips it, no tombstone) instead
    // of taking down the corpus sync.
    const absRoot = join(repoRoots[repo as KnowledgeSource['repo']], root);
    if (!exists(absRoot)) {
      deps.log?.warn({ customerId, repo, root }, 'customer docs: docs_root does not exist on disk — skipped this pass');
      continue;
    }

    seenBpRefs.add(bpRef);
    seenRoots.add(key);
    out.push({
      id: `customer-docs:${customerId}`,
      repo: repo as KnowledgeSource['repo'],
      root,
      layout: CUSTOMER_DOCS_LAYOUT,
      moduleName: CUSTOMER_DOCS_MODULE,
      locales: CUSTOMER_DOCS_LOCALES,
      primaryLocale: CUSTOMER_DOCS_PRIMARY_LOCALE,
      scope: 'customer',
      bpRef,
    });
  }

  return out;
}

export interface CustomerAwareDocSourceDeps {
  /** The registry read (default wiring: listCustomerDocSources from src/customers). */
  listCustomers: () => Promise<CustomerDocSourceRow[]>;
  /** The compile-time corpus to union onto (default: KNOWLEDGE_SOURCES). */
  staticSources?: readonly KnowledgeSource[];
  /** Walker seams, passed through to buildFsDocSource (`sources` is owned by this builder). */
  fs?: Omit<FsDocSourceDeps, 'sources'>;
  log?: SyncLogger;
}

/**
 * The DocSourcePort the knowledge-sync worker consumes: the static corpus unioned with every
 * safely-registered customer corpus, re-read per tick.
 */
export function buildCustomerAwareDocSource(deps: CustomerAwareDocSourceDeps): DocSourcePort {
  const staticSources = deps.staticSources ?? KNOWLEDGE_SOURCES;
  return {
    async listDocs() {
      let dynamic: KnowledgeSource[] = [];
      try {
        dynamic = buildCustomerDocSources({
          rows: await deps.listCustomers(),
          staticSources,
          repoRoots: deps.fs?.repoRoots,
          exists: deps.fs?.exists,
          log: deps.log,
        });
      } catch (err) {
        // A registry read failure degrades to the static corpus rather than aborting: the
        // dynamic sources simply do not appear this pass → zero-doc → the reconciler SKIPS
        // them (sync.ts, no tombstone). Nothing is lost, and the shared corpus still syncs.
        deps.log?.warn(
          { reason: err instanceof Error ? err.message : String(err) },
          'customer docs: registry read failed — this pass walks the static corpus only',
        );
      }
      if (dynamic.length > 0) {
        deps.log?.info({ registered: dynamic.length }, 'customer docs: registered corpora from the DB registry');
      }
      return buildFsDocSource({ ...deps.fs, sources: [...staticSources, ...dynamic] }).listDocs();
    },
  };
}
