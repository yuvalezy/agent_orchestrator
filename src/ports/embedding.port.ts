// Embedding port (design.md). Used from change 02 (pgvector memory/RAG).
export interface EmbeddingPort {
  embed(texts: string[]): Promise<number[][]>;
}
