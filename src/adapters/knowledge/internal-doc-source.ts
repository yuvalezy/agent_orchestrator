import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, relative, isAbsolute, sep } from 'node:path';
import type { InternalDocSourcePort, InternalScannedDoc, InternalPathScan } from '../../ports/internal-doc-source.port';
import { INTERNAL_SOURCES, INTERNAL_REPO_ROOTS, type InternalSource, type InternalRepo } from './internal-sources';
import { computeContentHash } from './doc-hash';

// Internal filesystem doc-source ADAPTER (D1: disk IO lives in the adapter). Walks
// INTERNAL_SOURCES — plain planning markdown WITHOUT frontmatter (unlike the customer
// fs-doc-source, which requires a YAML slug). Derives the title from the first H1
// (else the filename), computes the same content hash recipe, and yields
// InternalScannedDoc rows.
//
// Invariants:
//  • docKey = `${sourceId}:${repo-relative path}` (forward-slashed) — stable identity.
//  • directory includes are walked RECURSIVELY for *.md, skipping excludeDirs segments.
//  • a configured include that does not exist is SKIPPED (the curated list drifts; a
//    deleted doc is then tombstoned by the reconcile). A real read/scan error on an
//    EXISTING file/dir THROWS (the reconciler aborts vs. diffing a partial set).
//  • per-(source) docKey uniqueness — throw on a dup.
//  • NEVER log document content.

const H1_RE = /^#\s+(.+?)\s*$/;

/** Injected seams so the walker is unit-testable with a mock fs + fixed sources. */
export interface InternalDocSourceDeps {
  sources?: readonly InternalSource[];
  repoRoots?: Record<InternalRepo, string>;
  readFile?: (absPath: string) => string;
  readDir?: (absPath: string) => string[];
  exists?: (absPath: string) => boolean;
  isDirectory?: (absPath: string) => boolean;
  hash?: typeof computeContentHash;
}

/** First H1 line as the title; null if the doc has none (walker falls back to filename). */
function extractTitle(body: string): string | null {
  for (const line of body.split('\n')) {
    const m = H1_RE.exec(line);
    if (m) return m[1].trim() || null;
    // Only look past leading blank lines / comments before the first heading; a doc
    // whose first content line is not an H1 still gets scanned (title ← filename).
    if (line.trim() !== '' && !line.startsWith('<!--')) break;
  }
  return null;
}

/** Normalize a markdown body: strip a leading BOM, CRLF→LF, then trim. Matches the
 *  hash's normalizeBody so the stored content and the hashed body agree. */
function normalizeBody(raw: string): string {
  let b = raw;
  if (b.charCodeAt(0) === 0xfeff) b = b.slice(1);
  b = b.replace(/\r\n/g, '\n');
  return b.trim();
}

export function buildInternalDocSource(deps?: InternalDocSourceDeps): InternalDocSourcePort {
  const sources: readonly InternalSource[] = deps?.sources ?? INTERNAL_SOURCES;
  const repoRoots = deps?.repoRoots ?? INTERNAL_REPO_ROOTS;
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const readDir = deps?.readDir ?? ((p: string) => readdirSync(p));
  const exists = deps?.exists ?? ((p: string) => existsSync(p));
  const isDirectory = deps?.isDirectory ?? ((p: string) => statSync(p).isDirectory());
  const hash = deps?.hash ?? computeContentHash;

  /** Scan one markdown file into a ScannedDoc. */
  function scanFile(args: { absPath: string; base: string; source: InternalSource }): InternalScannedDoc {
    const { absPath, base, source } = args;
    const relPath = relative(base, absPath).split('\\').join('/');
    const body = normalizeBody(readFile(absPath));
    const title = extractTitle(body) ?? basename(absPath).replace(/\.md$/i, '');
    // Reuse the customer hash recipe (title + route + order + tags + body). Internal
    // docs have no route/order/tags, so those fold as empty — the body drives the hash.
    const contentHash = hash({ title, route: '', order: 0, tags: [] }, body);
    return {
      sourceId: source.id,
      docKey: `${source.id}:${relPath}`,
      repo: source.repo,
      path: relPath,
      title,
      content: body,
      contentHash,
    };
  }

  /** Recursively collect *.md files under a directory into `out`, skipping excludeDirs. */
  function walkDir(args: {
    dir: string;
    base: string;
    source: InternalSource;
    excludes: Set<string>;
    seen: Set<string>;
    out: InternalScannedDoc[];
  }): void {
    const { dir, base, source, excludes, seen, out } = args;
    const entries = readDir(dir).slice().sort(); // deterministic order
    for (const name of entries) {
      const abs = join(dir, name);
      if (isDirectory(abs)) {
        if (excludes.has(name)) continue;
        walkDir({ dir: abs, base, source, excludes, seen, out });
      } else if (name.toLowerCase().endsWith('.md')) {
        addFile({ abs, base, source, seen, out });
      }
    }
  }

  function addFile(args: {
    abs: string;
    base: string;
    source: InternalSource;
    seen: Set<string>;
    out: InternalScannedDoc[];
  }): void {
    const { abs, base, source, seen, out } = args;
    const doc = scanFile({ absPath: abs, base, source });
    if (seen.has(doc.docKey)) {
      throw new Error(`internal source "${source.id}": duplicate docKey ${doc.docKey} (path ${abs})`);
    }
    seen.add(doc.docKey);
    out.push(doc);
  }

  async function listDocs(): Promise<InternalScannedDoc[]> {
    const out: InternalScannedDoc[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      const base = repoRoots[source.repo];
      const excludes = new Set(source.excludeDirs ?? []);
      for (const inc of source.include) {
        const abs = join(base, inc);
        // A configured include that has drifted away is SKIPPED (→ tombstoned), not fatal.
        if (!exists(abs)) continue;
        if (isDirectory(abs)) {
          walkDir({ dir: abs, base, source, excludes, seen, out });
        } else if (abs.toLowerCase().endsWith('.md')) {
          addFile({ abs, base, source, seen, out });
        }
      }
    }

    return out;
  }

  /** Candidate (source, absPath, repo-relative path) pairs the input could resolve to.
   *  Absolute → tested under every root; a `sourceId:relpath` docKey → that source;
   *  a bare repo-relative path → tried under every root. */
  function candidatesFor(inputPath: string): Array<{ source: InternalSource; abs: string; rel: string }> {
    const raw = inputPath.trim();
    const out: Array<{ source: InternalSource; abs: string; rel: string }> = [];
    if (isAbsolute(raw)) {
      for (const source of sources) {
        const base = repoRoots[source.repo];
        const rel = relative(base, raw);
        // Outside this root → relative() escapes with '..' or stays absolute.
        if (rel.startsWith('..') || isAbsolute(rel)) continue;
        out.push({ source, abs: raw, rel });
      }
      return out;
    }
    // `sourceId:relpath` docKey form (a search-result citation). An absolute path was
    // already handled above; the sourceId is validated against source.id below, so a
    // non-matching prefix (e.g. a stray colon) harmlessly falls through to repo-relative.
    const colon = raw.indexOf(':');
    if (colon > 0) {
      const sid = raw.slice(0, colon);
      const relKey = raw.slice(colon + 1);
      for (const source of sources) {
        if (source.id !== sid) continue;
        out.push({ source, abs: join(repoRoots[source.repo], relKey), rel: relKey });
      }
      if (out.length > 0) return out;
    }
    // Bare repo-relative path — try under each root.
    for (const source of sources) {
      out.push({ source, abs: join(repoRoots[source.repo], raw), rel: raw });
    }
    return out;
  }

  /** True when `abs` is the included file itself or lives beneath an included directory. */
  function withinAnInclude(source: InternalSource, base: string, abs: string): boolean {
    return source.include.some((inc) => {
      const incAbs = join(base, inc);
      return abs === incAbs || abs.startsWith(incAbs + sep);
    });
  }

  async function scanPath(inputPath: string): Promise<InternalPathScan> {
    for (const { source, abs, rel } of candidatesFor(inputPath)) {
      if (!abs.toLowerCase().endsWith('.md')) continue;
      const relN = rel.split('\\').join('/');
      // An excludeDirs segment anywhere in the path → out of scope (matches walkDir).
      const excludes = new Set(source.excludeDirs ?? []);
      if (relN.split('/').some((segment) => excludes.has(segment))) continue;
      const base = repoRoots[source.repo];
      if (!withinAnInclude(source, base, abs)) continue;
      const docKey = `${source.id}:${relN}`;
      // In scope. On disk → scan+hash for an upsert; gone → signal a tombstone.
      if (!exists(abs)) return { status: 'missing', docKey };
      return { status: 'found', doc: scanFile({ absPath: abs, base, source }) };
    }
    return { status: 'out-of-scope' };
  }

  return { listDocs, scanPath };
}
