// Internal doc-source port (MI "Project Brain" — the FOUNDER/dev-facing corpus).
// The internal reconciler (src/knowledge/internal-sync.ts) depends ONLY on this
// contract; the concrete filesystem walker lives in the adapter layer
// (src/adapters/knowledge/internal-doc-source.ts) per the hexagonal boundary (D1).
//
// An InternalScannedDoc is ONE internal markdown document (planning / decision /
// architecture / risk / backlog) already read + hashed at the source. Unlike the
// customer ScannedDoc it carries NO locale / module / scope / bpRef — internal
// knowledge is never customer-scoped (that is the whole point of the isolation).
// `docKey` is the stable identity `sourceId:<repo-relative path>`.
export interface InternalScannedDoc {
  /** INTERNAL_SOURCES entry id this doc was scanned from (first docKey segment). */
  sourceId: string;
  /** Stable manifest identity: `sourceId:<repo-relative path>`. */
  docKey: string;
  /** Checkout the doc came from (citation), e.g. 'yuval_dev_manager' | 'ai-agent' | 'portal'. */
  repo: string;
  /** Repo-relative source path (citation), e.g. 'plan/EXECUTION-PLAN.md'. */
  path: string;
  /** Doc title — the first H1, else the filename. */
  title: string | null;
  /** Raw markdown body (whole file, normalized). NEVER logged. */
  content: string;
  /** sha256 hex over the normalized doc (doc-hash.ts recipe) — the change detector. */
  contentHash: string;
}

export interface InternalDocSourcePort {
  /** Walk every configured internal source and return the full doc set. Throws on
   *  any IO/scan error so the reconciler aborts rather than diffing a partial set
   *  (a partial scan would false-tombstone the missing docs). */
  listDocs(): Promise<InternalScannedDoc[]>;
}
