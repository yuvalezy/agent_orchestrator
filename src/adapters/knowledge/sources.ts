// The FOLDER REFERENCE (Layer-B input). A typed const array styled like
// src/adapters/llm/pricing.ts: no logic, just the on-disk corpus map. The fs
// doc-source (fs-doc-source.ts) walks these; nothing here reads the disk.
//
// Roots are REPO-RELATIVE; `repo` selects the checkout base (mapped to an absolute
// path in the adapter). Every root below was verified to exist with its locale
// subdirs at authoring time (`ls <repo>/<root>` → en/ es/).
//
//   layout 'flat-locale'  → <root>/{locale}/*.md              (one module = this source)
//   layout 'module-tree'  → <root>/<moduleDir>/docs/{locale}/*.md  (module per dir)
//   layout 'locale-tree'  → <root>/{locale}/**/*.md           (locale-first, recursive:
//                            module = the top sub-dir under the locale (files directly
//                            under the locale use `moduleName`); slug is DERIVED from the
//                            path below the module dir when the file has no `slug`
//                            frontmatter — for doc sets not authored in the DocArticle form)
//
// ⚠︎ Customer scope carries the BP-ref UUID (NOT the friendly code) so it resolves
// via findCustomerByBpRef (contact-resolution.ts). A customer source with an
// unresolved/absent bpRef MUST fail closed (skipped by sync) — it must NEVER fall
// back to shared (customer_id NULL = visible to every customer = data leak).

export type DocLayout = 'flat-locale' | 'module-tree' | 'locale-tree';
export type DocScope = 'shared' | 'customer';

export interface KnowledgeSource {
  /** Stable source id — the first segment of every docKey it produces. */
  id: string;
  /** Checkout the root is relative to. */
  repo: 'portal' | 'ai-agent' | 'wms';
  /** Repo-relative directory. flat-locale: contains {locale}/. module-tree: contains <mod>/docs/{locale}/. */
  root: string;
  layout: DocLayout;
  /** Fixed module name, or 'from-dir' to derive it from each module dir (module-tree only). */
  moduleName: string | 'from-dir';
  /** Locales that exist on disk for this source. */
  locales: string[];
  /** Subset of `locales` to actually ingest; defaults to all `locales` when omitted. */
  ingestLocales?: string[];
  /** Source authoring language — the drafter normalizes inbound questions to this before embedding. */
  primaryLocale: string;
  scope: DocScope;
  /** Portal BP-ref UUID for customer scope; null for shared. */
  bpRef: string | null;
}

export const KNOWLEDGE_SOURCES = [
  // ── portal core (.NET Infrastructure docs) — two flat-locale modules ──────────
  {
    id: 'portal',
    repo: 'portal',
    root: 'core/backend/src/Infrastructure/Docs/Content/portal',
    layout: 'flat-locale',
    moduleName: 'portal',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },
  {
    id: 'settings',
    repo: 'portal',
    root: 'core/backend/src/Infrastructure/Docs/Content/settings',
    layout: 'flat-locale',
    moduleName: 'settings',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },

  // ── portal-business — ONE module-tree over modules/*/docs; module = <dir>App;
  //    the reconciler/walker skips 'webhooks' (no user-facing docs). ─────────────
  {
    id: 'portal-business',
    repo: 'portal',
    root: 'services/portal-business/backend/config/registration/modules',
    layout: 'module-tree',
    moduleName: 'from-dir',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },

  // ── standalone services (flat-locale registration docs) ───────────────────────
  {
    id: 'pos',
    repo: 'portal',
    root: 'services/pos/backend/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'pos',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },
  {
    id: 'insight-studio',
    repo: 'portal',
    root: 'services/insight-studio/backend/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'insight-studio',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },
  {
    id: 'catalog-automation',
    repo: 'portal',
    root: 'services/catalog-automation/backend/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'catalog-automation',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },

  // ── customer-scoped corpora (customer_id resolved via bpRef; fail-closed) ──────
  {
    id: 'hola-doc',
    repo: 'portal',
    root: 'customers/hola-doc/backend/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'hola-doc',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'customer',
    // hola-doc's portal Business-Partner ref — matches the onboarded `Holadoc`
    // agent_customer, so sync resolves its customer_id and scopes these docs to it.
    bpRef: '5b860f4e-a9ec-4a0f-859d-400c65a0820a',
  },
  {
    id: 'pilates-gal',
    repo: 'portal',
    root: 'customers/pilates-gal/backend/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'pilates-gal',
    locales: ['en', 'es'],
    ingestLocales: ['es'], // Pilates contact writes Hebrew; the Spanish corpus is the semantic source
    primaryLocale: 'es',
    scope: 'customer',
    bpRef: 'b8d8e4e2-3bba-4d9b-91e1-ada1bf256ef3',
  },

  // ── ai-agent platform docs ────────────────────────────────────────────────────
  {
    id: 'ai-platform',
    repo: 'ai-agent',
    root: 'core-services/ai-platform/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'ai-platform',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'shared',
    bpRef: null,
  },

  // ── EZY WMS — the PUBLIC product knowledge base (locale-first, category subdirs;
  //    docs carry title/description only, so slugs are path-derived). SHARED knowledge
  //    used to answer customer questions about WMS. This is DISTINCT from the WMS
  //    entries in Project Brain (internal-sources.ts: wms-plan/backend/frontend →
  //    internal_knowledge), which point at plan/ + code docs, NOT this Service/Docs
  //    content — so there is no double-index and no isolation crossover. ─────────────
  {
    id: 'wms',
    repo: 'wms',
    root: 'ezy-wms-backend/Service/Docs/Content/wms',
    layout: 'locale-tree',
    moduleName: 'wms', // module for files directly under the locale (index/dashboard/…)
    locales: ['en', 'es'],
    primaryLocale: 'en', // WMS docs are authored English-first (es is the translation)
    scope: 'shared',
    bpRef: null,
  },
] as const satisfies readonly KnowledgeSource[];

export type KnowledgeSourceId = (typeof KNOWLEDGE_SOURCES)[number]['id'];
