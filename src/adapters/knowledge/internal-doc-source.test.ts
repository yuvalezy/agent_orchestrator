import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildInternalDocSource, type InternalDocSourceDeps } from './internal-doc-source';
import type { InternalSource, InternalRepo } from './internal-sources';

// Unit tests for the internal fs walker (ADAPTER) with a VIRTUAL fs — no real disk.
// Covers: recursive *.md collection, excludeDirs pruning, single-file includes, the
// docKey/title/citation shape, non-.md skipping, missing-include tolerance, and the
// duplicate-docKey guard. Frontmatter-less docs (title ← first H1, else filename).

type Node = { type: 'dir'; entries: string[] } | { type: 'file'; content: string };

function makeFs(nodes: Record<string, Node>): Pick<InternalDocSourceDeps, 'exists' | 'isDirectory' | 'readDir' | 'readFile'> {
  return {
    exists: (p) => p in nodes,
    isDirectory: (p) => nodes[p]?.type === 'dir',
    readDir: (p) => {
      const n = nodes[p];
      if (!n || n.type !== 'dir') throw new Error(`ENOTDIR ${p}`);
      return n.entries;
    },
    readFile: (p) => {
      const n = nodes[p];
      if (!n || n.type !== 'file') throw new Error(`ENOENT ${p}`);
      return n.content;
    },
  };
}

const REPO_ROOTS: Record<InternalRepo, string> = {
  yuval_dev_manager: '/root',
  'ai-agent': '/ai',
  portal: '/p',
};

const source = (over: Partial<InternalSource> & Pick<InternalSource, 'include'>): InternalSource => ({
  id: 's',
  repo: 'yuval_dev_manager',
  excludeDirs: ['archive'],
  ...over,
});

test('walks a dir recursively + a single file, skips excludeDirs and non-md, derives title', async () => {
  const fs = makeFs({
    '/root/plan/EXECUTION-PLAN.md': { type: 'file', content: '# Execution Plan\n\nbody here' },
    '/root/plan/blueprints': { type: 'dir', entries: ['M2a.md', 'archive', 'notes.txt', 'sub'] },
    '/root/plan/blueprints/M2a.md': { type: 'file', content: '# M2a Blueprint\nx' },
    '/root/plan/blueprints/archive': { type: 'dir', entries: ['old.md'] },
    '/root/plan/blueprints/archive/old.md': { type: 'file', content: '# Old\ny' },
    '/root/plan/blueprints/notes.txt': { type: 'file', content: 'not markdown' },
    '/root/plan/blueprints/sub': { type: 'dir', entries: ['deep.md'] },
    '/root/plan/blueprints/sub/deep.md': { type: 'file', content: 'no heading here, first line is prose' },
  });
  const ds = buildInternalDocSource({
    sources: [source({ include: ['plan/EXECUTION-PLAN.md', 'plan/blueprints'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });

  const docs = await ds.listDocs();
  const byKey = new Map(docs.map((d) => [d.docKey, d]));

  assert.deepEqual(
    docs.map((d) => d.docKey).sort(),
    ['s:plan/EXECUTION-PLAN.md', 's:plan/blueprints/M2a.md', 's:plan/blueprints/sub/deep.md'],
    'recursive md only; archive pruned; notes.txt ignored',
  );

  const exec = byKey.get('s:plan/EXECUTION-PLAN.md')!;
  assert.equal(exec.title, 'Execution Plan', 'title ← first H1');
  assert.equal(exec.repo, 'yuval_dev_manager');
  assert.equal(exec.path, 'plan/EXECUTION-PLAN.md');
  assert.equal(exec.sourceId, 's');
  assert.equal(exec.content, '# Execution Plan\n\nbody here', 'content normalized (trimmed) body');
  assert.ok(exec.contentHash.length > 0);

  assert.equal(byKey.get('s:plan/blueprints/sub/deep.md')!.title, 'deep', 'title ← filename when no H1');
});

test('a missing include is skipped (not fatal) — supports the tombstone-on-removal flow', async () => {
  const fs = makeFs({
    '/root/plan/present.md': { type: 'file', content: '# Present' },
  });
  const ds = buildInternalDocSource({
    sources: [source({ include: ['plan/present.md', 'plan/GONE.md', 'plan/missing-dir'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });
  const docs = await ds.listDocs();
  assert.deepEqual(docs.map((d) => d.docKey), ['s:plan/present.md']);
});

test('duplicate docKey (overlapping includes) throws', async () => {
  const fs = makeFs({
    '/root/plan/blueprints': { type: 'dir', entries: ['M2a.md'] },
    '/root/plan/blueprints/M2a.md': { type: 'file', content: '# M2a' },
  });
  const ds = buildInternalDocSource({
    sources: [source({ include: ['plan/blueprints', 'plan/blueprints/M2a.md'] })],
    repoRoots: REPO_ROOTS,
    ...fs,
  });
  await assert.rejects(ds.listDocs(), /duplicate docKey/);
});

test('content hash is stable across runs for unchanged content', async () => {
  const fs = makeFs({ '/root/plan/a.md': { type: 'file', content: '# A\nbody' } });
  const mk = () =>
    buildInternalDocSource({ sources: [source({ include: ['plan/a.md'] })], repoRoots: REPO_ROOTS, ...fs });
  const h1 = (await mk().listDocs())[0].contentHash;
  const h2 = (await mk().listDocs())[0].contentHash;
  assert.equal(h1, h2);
});
