import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCustomerDocSources, buildCustomerAwareDocSource } from './customer-sources';
import type { CustomerDocSourceRow } from '../../customers/customer-doc-sources';
import { KNOWLEDGE_SOURCES, type KnowledgeSource } from './sources';

// Unit tests for the DB-registered customer doc corpora (ADAPTER). Proves the row→KnowledgeSource
// mapping (per-customer source id, customer scope + real bpRef), the FAIL-CLOSED skip of a row
// without a bpRef (the data-leak rule — a customer corpus must never be emitted as shared), the
// double-registration guard against the static consts, and that the static corpus still resolves
// unchanged through the union.

const REPO_ROOTS: Record<KnowledgeSource['repo'], string> = {
  portal: '/repo',
  'ai-agent': '/ai',
  wms: '/wms',
  'ezy-integration': '/ezy',
};

const ROW: CustomerDocSourceRow = {
  customerId: 'cust-a',
  bpRef: 'bp-a',
  docsRepo: 'portal',
  docsRoot: 'customers/cotton-candy-crm/backend/config/registration/docs',
};

/** Static stand-in for KNOWLEDGE_SOURCES: one shared entry + one hand-written customer entry. */
const STATIC: KnowledgeSource[] = [
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
    id: 'hola-doc',
    repo: 'portal',
    root: 'customers/hola-doc/backend/config/registration/docs',
    layout: 'flat-locale',
    moduleName: 'hola-doc',
    locales: ['en', 'es'],
    primaryLocale: 'es',
    scope: 'customer',
    bpRef: 'bp-hola',
  },
];

function build(rows: CustomerDocSourceRow[], over?: { exists?: (p: string) => boolean; log?: unknown }) {
  return buildCustomerDocSources({
    rows,
    staticSources: STATIC,
    repoRoots: REPO_ROOTS,
    exists: over?.exists ?? (() => true),
    log: over?.log as never,
  });
}

function collectWarns() {
  const warns: unknown[] = [];
  return {
    warns,
    log: { info: () => {}, warn: (o: unknown) => warns.push(o), error: () => {}, debug: () => {} },
  };
}

test('maps a row → KnowledgeSource: per-customer source id, customer scope, real bpRef', () => {
  const [s] = build([ROW]);
  assert.equal(s.id, 'customer-docs:cust-a');
  assert.equal(s.scope, 'customer');
  assert.equal(s.bpRef, 'bp-a');
  assert.equal(s.repo, 'portal');
  assert.equal(s.root, ROW.docsRoot);
  assert.equal(s.layout, 'flat-locale');
  assert.deepEqual(s.locales, ['en', 'es']);
  assert.equal(s.primaryLocale, 'es');
});

test('⚠︎ FAIL-CLOSED: a row with a NULL/blank bpRef is SKIPPED — never emitted as shared', () => {
  for (const bpRef of [null, '', '   ']) {
    const { warns, log } = collectWarns();
    const out = build([{ ...ROW, bpRef }], { log });
    // The leak this guards: a source that still registered, but fell back to shared. Asserted
    // before the emptiness check, which would narrow `out` to never[] and void this.
    assert.equal(
      out.some((s) => s.scope === 'shared' || s.bpRef === null),
      false,
      'a customer corpus must NEVER be emitted as shared (customer_id NULL = visible to every customer)',
    );
    assert.deepEqual(out, [], `bpRef=${JSON.stringify(bpRef)} must register nothing`);
    assert.equal(warns.length, 1);
  }
});

test('a customer already covered by a static const is not registered twice (bpRef collision)', () => {
  const rows = [{ ...ROW, customerId: 'cust-hola', bpRef: 'bp-hola', docsRoot: 'customers/hola-doc/some/other/docs' }];
  assert.deepEqual(build(rows), [], 'the static hola-doc entry stays the single source of truth');
});

test('a root already covered by a static const is not registered twice (same files, two source ids)', () => {
  const rows = [{ ...ROW, customerId: 'cust-x', bpRef: 'bp-x', docsRoot: 'customers/hola-doc/backend/config/registration/docs' }];
  assert.deepEqual(build(rows), []);
});

test('a stray leading/trailing slash does not defeat the root-collision guard', () => {
  const rows = [{ ...ROW, customerId: 'cust-x', bpRef: 'bp-x', docsRoot: '/services/pos/backend/config/registration/docs/' }];
  assert.deepEqual(build(rows), []);
});

test('two rows pointed at one directory: the first wins, the second is skipped', () => {
  const rows = [ROW, { ...ROW, customerId: 'cust-b', bpRef: 'bp-b' }];
  const out = build(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'customer-docs:cust-a');
});

test('NULL docs_repo defaults to the portal checkout; an unknown repo is skipped', () => {
  const [s] = build([{ ...ROW, docsRepo: null }]);
  assert.equal(s.repo, 'portal');

  const { warns, log } = collectWarns();
  assert.deepEqual(build([{ ...ROW, docsRepo: 'not-a-checkout' }], { log }), []);
  assert.equal(warns.length, 1);
});

test('a docs_root that is not on disk is skipped this pass (the walker would abort the whole reconcile)', () => {
  const { warns, log } = collectWarns();
  const out = build([ROW], { exists: () => false, log });
  assert.deepEqual(out, []);
  assert.equal(warns.length, 1);
});

test('blank docs_root is skipped (it would join to the checkout base and walk the whole repo)', () => {
  assert.deepEqual(build([{ ...ROW, docsRoot: '   ' }]), []);
});

test('the real KNOWLEDGE_SOURCES set still resolves unchanged: no static entry is dropped or altered', () => {
  // The union feeds the walker; a regression here would silently unregister the shared corpus.
  const dynamic = buildCustomerDocSources({ rows: [ROW], repoRoots: REPO_ROOTS, exists: () => true });
  const union: KnowledgeSource[] = [...KNOWLEDGE_SOURCES, ...dynamic];

  for (const original of KNOWLEDGE_SOURCES) {
    const found = union.find((s) => s.id === original.id);
    assert.ok(found, `static source ${original.id} must survive the union`);
    assert.deepEqual(found, original, `static source ${original.id} must be unaltered`);
  }
  // The dynamic entry is purely additive, and every id stays unique across the union.
  const ids = union.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'source ids must be unique across the union');
  assert.deepEqual(dynamic.map((s) => s.id), ['customer-docs:cust-a']);
});

test('a real hand-written customer const (hola-doc) is never double-registered from the DB', () => {
  // Guards the live consts, not the fixture: hola-doc's real bpRef registered from the DB must lose.
  const hola = KNOWLEDGE_SOURCES.find((s) => s.id === 'hola-doc');
  assert.ok(hola?.bpRef);
  const rows = [{ ...ROW, customerId: 'cust-hola', bpRef: hola.bpRef, docsRoot: 'customers/hola-doc/elsewhere/docs' }];
  assert.deepEqual(buildCustomerDocSources({ rows, repoRoots: REPO_ROOTS, exists: () => true }), []);
});

test('registry read failure degrades to the static corpus instead of aborting the reconcile', async () => {
  const { warns, log } = collectWarns();
  const port = buildCustomerAwareDocSource({
    listCustomers: async () => {
      throw new Error('db down');
    },
    staticSources: STATIC,
    fs: { repoRoots: REPO_ROOTS, exists: () => true, readDir: () => [], readFile: () => '' },
    log,
  });
  assert.deepEqual(await port.listDocs(), []); // walked the static corpus, did not throw
  assert.equal(warns.length, 1);
});
