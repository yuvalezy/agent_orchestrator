import { createHash } from 'node:crypto';

// ⚠︎ Mirror the portal's computeContentHash shape
// (sdk/go-portal-sdk/docs/loader.go:249 / CoreDocsLoader.ComputeContentHash):
// fold the frontmatter fields + "\n---\n" + the NORMALIZED body, then sha256 hex.
// Normalization: CRLF→LF, strip a leading BOM, trim the body. This catches a
// frontmatter-only edit (which sha256(body) would miss → stale citation) while
// staying stable across CRLF churn.
//
// Recipe (per the implement task): the fields our ScannedDoc actually carries —
//   title \n route \n order \n tags(trimmed, byte-sorted, CSV) \n---\n body
// Tags are trimmed and sorted BY UTF-8 BYTES (Buffer.compare) so it matches Go's
// sort.Strings ordering and the frontmatter's authoring order is irrelevant.

/** Frontmatter subset that participates in the hash. Extend toward the full portal
 *  recipe as needed — but do NOT change the exported field names once implementers
 *  depend on them. */
export interface DocFrontmatter {
  title: string;
  route: string;
  order: number;
  /** Trimmed + sorted into a CSV in the recipe (order in the file is irrelevant). */
  tags: string[];
}

/** Sort tags by UTF-8 byte order (Go's sort.Strings), after trimming each. */
function sortedTagsCsv(tags: string[]): string {
  return tags
    .map((t) => t.trim())
    .sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')))
    .join(',');
}

/** Normalize a markdown body: strip a leading BOM, CRLF→LF, then trim. */
function normalizeBody(body: string): string {
  let b = body;
  if (b.charCodeAt(0) === 0xfeff) b = b.slice(1);
  b = b.replace(/\r\n/g, '\n');
  return b.trim();
}

/** sha256 hex (lowercase) over the portal-style normalized recipe. */
export function computeContentHash(fm: DocFrontmatter, body: string): string {
  const recipe =
    `${fm.title}\n` +
    `${fm.route}\n` +
    `${String(fm.order)}\n` +
    `${sortedTagsCsv(fm.tags)}\n---\n` +
    normalizeBody(body);
  return createHash('sha256').update(recipe, 'utf8').digest('hex');
}
