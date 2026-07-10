import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildFsDocSource, type FsDocSourceDeps } from './fs-doc-source';
import type { KnowledgeSource } from './sources';

// Unit tests for the filesystem doc-source ADAPTER, driven by an in-memory fs (no
// real disk). Covers: flat-locale parse + stable docKey, ingestLocales gating,
// module-tree + from-dir (`<dir>App`) derivation with the 'webhooks' skip, kebab
// slug rejection, per-(source,module,locale) slug uniqueness, and ⚠︎ IO/scan errors
// propagating as a THROW (so the reconciler aborts rather than diffing a partial set).

const REPO_ROOTS = { portal: '/repo', 'ai-agent': '/ai' } as const;

/** Build fs seams from a flat { absPath: content } file map. */
function mockFs(files: Record<string, string>): Pick<FsDocSourceDeps, 'readFile' | 'readDir' | 'exists'> {
  const paths = Object.keys(files);
  const isDir = (p: string): boolean => paths.some((f) => f.startsWith(p.endsWith('/') ? p : p + '/'));
  return {
    exists: (p) => Object.prototype.hasOwnProperty.call(files, p) || isDir(p),
    readFile: (p) => {
      if (!Object.prototype.hasOwnProperty.call(files, p)) {
        throw new Error(`ENOENT: ${p}`);
      }
      return files[p];
    },
    readDir: (p) => {
      const prefix = p.endsWith('/') ? p : p + '/';
      const children = new Set<string>();
      for (const f of paths) {
        if (f.startsWith(prefix)) {
          children.add(f.slice(prefix.length).split('/')[0]);
        }
      }
      if (children.size === 0) throw new Error(`ENOTDIR: ${p}`);
      return [...children];
    },
  };
}

const doc = (slug: string, extra = ''): string =>
  `---\nslug: ${slug}\ntitle: T ${slug}\nroute: /r/${slug}\norder: 10\ntags: [a, b]\n---\n\nBody for ${slug}.${extra}\n`;

const flatSource = (over: Partial<KnowledgeSource> = {}): KnowledgeSource => ({
  id: 'pos',
  repo: 'portal',
  root: 'services/pos/docs',
  layout: 'flat-locale',
  moduleName: 'pos',
  locales: ['en', 'es'],
  primaryLocale: 'es',
  scope: 'shared',
  bpRef: null,
  ...over,
});

test('flat-locale: parses a doc and builds a stable docKey', async () => {
  const src = flatSource();
  const files = { '/repo/services/pos/docs/es/intro.md': doc('intro') };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  const docs = await port.listDocs();
  assert.equal(docs.length, 1);
  const d = docs[0];
  assert.equal(d.docKey, 'pos:pos:es:intro');
  assert.equal(d.sourceId, 'pos');
  assert.equal(d.module, 'pos');
  assert.equal(d.locale, 'es');
  assert.equal(d.title, 'T intro');
  assert.equal(d.route, '/r/intro');
  assert.equal(d.order, 10);
  assert.deepEqual(d.tags, ['a', 'b']);
  assert.equal(d.scope, 'shared');
  assert.equal(d.bpRef, null);
  assert.match(d.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(d.content, 'Body for intro.'); // frontmatter stripped, trimmed
});

test('flat-locale: ingestLocales gates which locales are scanned', async () => {
  const src = flatSource({ id: 'pilates-gal', root: 'customers/pg/docs', moduleName: 'pilates-gal', ingestLocales: ['es'], scope: 'customer', bpRef: 'b8d8e4e2-3bba-4d9b-91e1-ada1bf256ef3' });
  const files = {
    '/repo/customers/pg/docs/es/clases.md': doc('clases'),
    '/repo/customers/pg/docs/en/classes.md': doc('classes'),
  };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  const docs = await port.listDocs();
  assert.equal(docs.length, 1, 'only the es locale is ingested');
  assert.equal(docs[0].locale, 'es');
  assert.equal(docs[0].scope, 'customer');
  assert.equal(docs[0].bpRef, 'b8d8e4e2-3bba-4d9b-91e1-ada1bf256ef3');
});

test('module-tree: derives module `<dir>App` and skips webhooks', async () => {
  const src = flatSource({
    id: 'portal-business',
    root: 'services/pb/modules',
    layout: 'module-tree',
    moduleName: 'from-dir',
  });
  const files = {
    '/repo/services/pb/modules/bp/docs/es/managing-bp.md': doc('managing-bp'),
    '/repo/services/pb/modules/commerce/docs/es/orders.md': doc('orders'),
    '/repo/services/pb/modules/webhooks/docs/es/hooks.md': doc('hooks'),
    '/repo/services/pb/modules/README.md': 'not a module dir',
  };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  const docs = await port.listDocs();
  const keys = docs.map((d) => d.docKey).sort();
  assert.deepEqual(keys, [
    'portal-business:bpApp:es:managing-bp',
    'portal-business:commerceApp:es:orders',
  ]);
  assert.ok(!docs.some((d) => d.module === 'webhooksApp'), 'webhooks module is skipped');
});

test('rejects a non-kebab slug (THROWS)', async () => {
  const src = flatSource();
  const files = { '/repo/services/pos/docs/es/bad.md': doc('Bad_Slug') };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  await assert.rejects(port.listDocs(), /kebab-case/);
});

test('rejects a missing slug (THROWS)', async () => {
  const src = flatSource();
  const files = { '/repo/services/pos/docs/es/noslug.md': '---\ntitle: X\nroute: /x\n---\nbody\n' };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  await assert.rejects(port.listDocs(), /'slug' is required/);
});

test('rejects a duplicate slug within (source,module,locale) (THROWS)', async () => {
  const src = flatSource();
  const files = {
    '/repo/services/pos/docs/es/a.md': doc('dup'),
    '/repo/services/pos/docs/es/b.md': doc('dup'),
  };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  await assert.rejects(port.listDocs(), /duplicate slug/);
});

test('a read error propagates as a THROW (reconciler aborts, no partial diff)', async () => {
  const src = flatSource();
  const fs = mockFs({ '/repo/services/pos/docs/es/intro.md': doc('intro') });
  const boom: FsDocSourceDeps = {
    sources: [src],
    repoRoots: REPO_ROOTS,
    exists: fs.exists,
    readDir: fs.readDir,
    readFile: () => {
      throw new Error('EIO: disk exploded');
    },
  };
  const port = buildFsDocSource(boom);
  await assert.rejects(port.listDocs(), /EIO: disk exploded/);
});

test('a missing configured root THROWS (fail-loud misconfig)', async () => {
  const src = flatSource({ root: 'services/does-not-exist/docs' });
  const files = { '/repo/services/pos/docs/es/intro.md': doc('intro') };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  await assert.rejects(port.listDocs(), /root does not exist/);
});

test('a malformed frontmatter fence THROWS', async () => {
  const src = flatSource();
  const files = { '/repo/services/pos/docs/es/bad.md': 'no frontmatter here\njust body' };
  const port = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs(files) });
  await assert.rejects(port.listDocs(), /frontmatter fence/);
});

test('a CRLF-only rewrite of a file yields the SAME contentHash', async () => {
  const src = flatSource();
  const lf = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs({ '/repo/services/pos/docs/es/x.md': doc('x') }) });
  const crlf = buildFsDocSource({ sources: [src], repoRoots: REPO_ROOTS, ...mockFs({ '/repo/services/pos/docs/es/x.md': doc('x').replace(/\n/g, '\r\n') }) });
  const [a] = await lf.listDocs();
  const [b] = await crlf.listDocs();
  assert.equal(a.contentHash, b.contentHash);
});
