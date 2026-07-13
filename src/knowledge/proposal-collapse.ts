// CORE (pure, ports-free): greedy embedding clustering used to collapse near-duplicate backfill
// proposals from a single sweep. WhatsApp discussion repeats the same ask across many messages/
// windows; without this, each would spawn its own approval card. Each item carries a precomputed
// embedding; items within `maxDistance` (cosine) of a cluster's representative join that cluster.
// Order-stable: the first item of each new cluster is its representative, so callers can order the
// input by confidence to make the highest-confidence proposal the survivor.

export interface EmbeddedItem {
  key: string;
  embedding: number[];
}

export interface Cluster {
  /** The representative item's key (first-seen in input order). */
  repKey: string;
  /** All member keys, including the representative. */
  memberKeys: string[];
}

/** Cosine distance in [0,2]; 0 = identical direction. Zero-norm vectors → max distance (2). */
export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 2;
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Greedy single-pass clustering: each item joins the first existing cluster whose representative
 *  is within `maxDistance`, else starts a new cluster. Deterministic in input order. */
export function clusterByEmbedding(items: EmbeddedItem[], maxDistance: number): Cluster[] {
  const clusters: Array<Cluster & { repEmbedding: number[] }> = [];
  for (const item of items) {
    const hit = clusters.find((c) => cosineDistance(c.repEmbedding, item.embedding) <= maxDistance);
    if (hit) hit.memberKeys.push(item.key);
    else clusters.push({ repKey: item.key, memberKeys: [item.key], repEmbedding: item.embedding });
  }
  return clusters.map(({ repKey, memberKeys }) => ({ repKey, memberKeys }));
}
