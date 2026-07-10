import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DocSourcePort, ScannedDoc } from '../../ports/doc-source.port';
import { KNOWLEDGE_SOURCES, type KnowledgeSource } from './sources';
import { computeContentHash } from './doc-hash';

// Filesystem doc-source ADAPTER (D1: disk IO lives in the adapter layer). Walks
// KNOWLEDGE_SOURCES, reads {ingestLocales}/*.md, parses YAML frontmatter, computes
// the portal hash, and yields ScannedDoc rows.
//
// Invariants upheld here:
//  • ⚠︎ validate the slug against ^[a-z0-9]+(?:-[a-z0-9]+)*$ (kebab) and enforce
//    per-(source,module,locale) slug uniqueness — throw on a dup/invalid slug.
//  • docKey = `${sourceId}:${module ?? ''}:${locale}:${slug}`.
//  • module-tree: module = moduleName==='from-dir' ? `${dir}App` : moduleName; skip 'webhooks'.
//  • ⚠︎ on ANY IO/scan error for a source, THROW (reconciler aborts vs. diffing a
//    partial set → false tombstones). We never swallow fs errors.
//  • NEVER log document content.

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_ORDER = 100; // mirrors portal loader.go `defaultOrder`
const SKIP_MODULE_DIRS = new Set(['webhooks']);

/** Injected seams so the walker is unit-testable with a mock fs + fixed sources. */
export interface FsDocSourceDeps {
  /** Override the corpus (default: the real KNOWLEDGE_SOURCES). */
  sources?: readonly KnowledgeSource[];
  /** Map a source `repo` to its absolute checkout root (default: real /mnt/dev paths). */
  repoRoots?: Record<KnowledgeSource['repo'], string>;
  /** File-read seam (default: node:fs readFileSync utf8). */
  readFile?: (absPath: string) => string;
  /** Directory-list seam (default: node:fs readdirSync). */
  readDir?: (absPath: string) => string[];
  /** Existence seam (default: node:fs existsSync). */
  exists?: (absPath: string) => boolean;
  /** Hash function seam (default: computeContentHash). */
  hash?: typeof computeContentHash;
}

const DEFAULT_REPO_ROOTS: Record<KnowledgeSource['repo'], string> = {
  portal: '/mnt/dev/portal',
  'ai-agent': '/mnt/dev/ai-agent',
};

interface ParsedFrontmatter {
  slug: string | null;
  title: string | null;
  route: string | null;
  order: number | null;
  tags: string[];
}

/** Strip a matching pair of surrounding single/double quotes from a scalar. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2) {
    const first = t[0];
    if ((first === '"' || first === "'") && t[t.length - 1] === first) {
      return t.slice(1, -1);
    }
  }
  return t;
}

/** Split the leading `---` fenced YAML block from the body. Mirrors the portal's
 *  splitFrontmatter: strip BOM, CRLF→LF, tolerate leading blank lines. Throws when
 *  the fences are missing (a scan error → reconciler aborts). */
function splitFrontmatter(raw: string, path: string): { fmText: string; body: string } {
  let content = raw;
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  content = content.replace(/\r\n/g, '\n').replace(/^\n+/, '');
  const lines = content.split('\n');
  if (lines.length === 0 || lines[0].trim() !== '---') {
    throw new Error(`${path}: missing opening '---' frontmatter fence`);
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    throw new Error(`${path}: missing closing '---' frontmatter fence`);
  }
  return {
    fmText: lines.slice(1, closing).join('\n'),
    body: lines.slice(closing + 1).join('\n'),
  };
}

/** Minimal frontmatter parser for the fields that feed the hash / manifest
 *  (slug, title, route, order, tags). The corpus uses flat `key: value` scalars and
 *  flow-style `tags: [a, b]`; block-style `- item` lists are also tolerated. */
function parseFrontmatter(fmText: string): ParsedFrontmatter {
  const out: ParsedFrontmatter = { slug: null, title: null, route: null, order: null, tags: [] };
  const lines = fmText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = /^([A-Za-z][\w-]*):\s?(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rawVal = m[2];
    switch (key) {
      case 'slug':
        out.slug = unquote(rawVal) || null;
        break;
      case 'title':
        out.title = unquote(rawVal) || null;
        break;
      case 'route':
        out.route = unquote(rawVal) || null;
        break;
      case 'order': {
        const n = Number.parseInt(rawVal.trim(), 10);
        out.order = Number.isNaN(n) ? null : n;
        break;
      }
      case 'tags': {
        const v = rawVal.trim();
        if (v.startsWith('[')) {
          // flow style: [a, b, c] (possibly missing the closing ] if wrapped, be lenient)
          const inner = v.replace(/^\[/, '').replace(/\]$/, '');
          out.tags = inner
            .split(',')
            .map((t) => unquote(t))
            .filter((t) => t.length > 0);
        } else if (v === '') {
          // block style: subsequent `- item` lines
          const collected: string[] = [];
          let j = i + 1;
          for (; j < lines.length; j++) {
            const im = /^\s*-\s+(.*)$/.exec(lines[j]);
            if (!im) break;
            const item = unquote(im[1]);
            if (item.length > 0) collected.push(item);
          }
          out.tags = collected;
          i = j - 1;
        } else {
          out.tags = [unquote(v)].filter((t) => t.length > 0);
        }
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** Parse one markdown file into a ScannedDoc. Throws on a missing/invalid slug. */
function scanFile(args: {
  path: string;
  raw: string;
  source: KnowledgeSource;
  module: string;
  locale: string;
  hash: typeof computeContentHash;
}): ScannedDoc {
  const { path, raw, source, module, locale, hash } = args;
  const { fmText, body } = splitFrontmatter(raw, path);
  const fm = parseFrontmatter(fmText);

  const slug = fm.slug?.trim() ?? '';
  if (!slug) {
    throw new Error(`${path}: frontmatter field 'slug' is required`);
  }
  if (!SLUG_RE.test(slug)) {
    throw new Error(`${path}: slug "${slug}" must be kebab-case (^[a-z0-9]+(?:-[a-z0-9]+)*$)`);
  }

  const title = fm.title?.trim() ?? null;
  const route = fm.route?.trim() ?? null;
  const order = fm.order ?? DEFAULT_ORDER;

  // Normalized body (BOM/CRLF/trim) — computeContentHash re-normalizes idempotently.
  let normBody = body;
  if (normBody.charCodeAt(0) === 0xfeff) normBody = normBody.slice(1);
  normBody = normBody.replace(/\r\n/g, '\n').trim();

  const contentHash = hash({ title: title ?? '', route: route ?? '', order, tags: fm.tags }, normBody);

  return {
    sourceId: source.id,
    docKey: `${source.id}:${module}:${locale}:${slug}`,
    module,
    locale,
    title,
    route,
    order,
    tags: fm.tags,
    scope: source.scope,
    bpRef: source.bpRef,
    content: normBody,
    contentHash,
  };
}

export function buildFsDocSource(deps?: FsDocSourceDeps): DocSourcePort {
  const sources: readonly KnowledgeSource[] = deps?.sources ?? KNOWLEDGE_SOURCES;
  const repoRoots = deps?.repoRoots ?? DEFAULT_REPO_ROOTS;
  const readFile = deps?.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const readDir = deps?.readDir ?? ((p: string) => readdirSync(p));
  const exists = deps?.exists ?? ((p: string) => existsSync(p));
  const hash = deps?.hash ?? computeContentHash;

  /** Scan one `{localeDir}/*.md` directory into the accumulator, enforcing docKey
   *  uniqueness. Missing locale dirs are skipped; real IO errors propagate (throw). */
  function scanLocaleDir(args: {
    localeDir: string;
    source: KnowledgeSource;
    module: string;
    locale: string;
    seen: Set<string>;
    out: ScannedDoc[];
  }): void {
    const { localeDir, source, module, locale, seen, out } = args;
    if (!exists(localeDir)) return;
    const entries = readDir(localeDir).filter((n) => n.endsWith('.md'));
    entries.sort(); // deterministic order
    for (const name of entries) {
      const path = join(localeDir, name);
      const raw = readFile(path);
      const doc = scanFile({ path, raw, source, module, locale, hash });
      if (seen.has(doc.docKey)) {
        throw new Error(
          `${path}: duplicate slug for (source=${source.id}, module=${module}, locale=${locale}) → docKey ${doc.docKey}`,
        );
      }
      seen.add(doc.docKey);
      out.push(doc);
    }
  }

  async function listDocs(): Promise<ScannedDoc[]> {
    const out: ScannedDoc[] = [];
    const seen = new Set<string>();

    for (const source of sources) {
      const base = repoRoots[source.repo];
      const absRoot = join(base, source.root);
      if (!exists(absRoot)) {
        throw new Error(`knowledge source "${source.id}": root does not exist: ${absRoot}`);
      }
      const ingestLocales = source.ingestLocales ?? source.locales;

      if (source.layout === 'flat-locale') {
        const module = source.moduleName === 'from-dir' ? source.id : source.moduleName;
        for (const locale of ingestLocales) {
          scanLocaleDir({ localeDir: join(absRoot, locale), source, module, locale, seen, out });
        }
      } else {
        // module-tree: <root>/<moduleDir>/docs/{locale}/*.md, module = <dir>App (or fixed).
        const moduleDirs = readDir(absRoot);
        moduleDirs.sort();
        for (const dir of moduleDirs) {
          if (SKIP_MODULE_DIRS.has(dir)) continue;
          const docsDir = join(absRoot, dir, 'docs');
          if (!exists(docsDir)) continue; // not a module dir (or no docs) → skip
          const module = source.moduleName === 'from-dir' ? `${dir}App` : source.moduleName;
          for (const locale of ingestLocales) {
            scanLocaleDir({ localeDir: join(docsDir, locale), source, module, locale, seen, out });
          }
        }
      }
    }

    return out;
  }

  return { listDocs };
}
