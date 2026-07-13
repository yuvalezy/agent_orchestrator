// Doc-source port (Layer-B knowledge input). The reconciler (src/knowledge/sync.ts)
// depends ONLY on this contract; the concrete filesystem walker lives in the adapter
// layer (src/adapters/knowledge/fs-doc-source.ts) per the hexagonal boundary (D1).
//
// A ScannedDoc is ONE localized markdown document already parsed + hashed at the
// source. `docKey` is the stable identity `sourceId:module:locale:slug` used by the
// manifest for the add/change/skip/resurrect/tombstone diff. `contentHash` mirrors
// the portal recipe (see doc-hash.ts) so a frontmatter-only edit still re-embeds.
export interface ScannedDoc {
  /** KNOWLEDGE_SOURCES entry id this doc was scanned from. */
  sourceId: string;
  /** Stable manifest identity: `sourceId:module:locale:slug`. */
  docKey: string;
  /** Logical module (e.g. 'pos', 'bpApp'); null when a source has no module concept. */
  module: string | null;
  /** BCP-47-ish locale of THIS document (e.g. 'es', 'en'). */
  locale: string;
  title: string | null;
  route: string | null;
  order: number | null;
  tags: string[];
  /** 'shared' → customer_id NULL; 'customer' → resolved via bpRef (fail-closed). */
  scope: 'shared' | 'customer';
  /** Portal BP-ref UUID for customer scope; null for shared. */
  bpRef: string | null;
  /** Raw markdown body (frontmatter stripped). NEVER logged. */
  content: string;
  /** sha256 hex over the portal normalized recipe (doc-hash.ts). */
  contentHash: string;
  /** agent_memory.memory_type to persist the chunks as. Default 'guide' (Layer-B
   *  product-doc mirror). A non-doc source (e.g. the portal task inventory) sets
   *  'task' so the drafter's history retrieval surfaces it — the reconciler threads
   *  this straight into replaceChunks, otherwise unchanged. */
  memoryType?: string;
  /** Extra key/values merged into EVERY chunk's metadata (e.g. a task's
   *  {task_ref, code, status, project_ref}). The reconciler's own doc metadata
   *  (title/section/module/route/locale) always wins on key collision. NEVER logged. */
  extraMetadata?: Record<string, unknown>;
}

export interface DocSourcePort {
  /** Walk every configured source and return the full localized doc set. Throws on
   *  any IO/scan error so the reconciler aborts rather than diffing a partial set. */
  listDocs(): Promise<ScannedDoc[]>;
}
