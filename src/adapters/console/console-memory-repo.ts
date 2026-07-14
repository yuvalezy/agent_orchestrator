import { existsSync } from 'node:fs';
import type { PoolClient } from 'pg';
import { query, withClient } from '../../db';
import { INTERNAL_REPO_ROOTS, INTERNAL_SOURCES } from '../knowledge/internal-sources';
import type { ConsoleAuditContext, Page } from './console-repo';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMORY_TYPES = ['conversation', 'task', 'release_note', 'guide', 'feedback', 'pattern', 'decision', 'correction'] as const;
const GUIDANCE_TYPES = new Set(['feedback', 'correction']);

type MemoryCursor = { at: string; id: string };
type MemoryScope = 'global' | 'customer' | 'all';
type MemoryState = 'active' | 'superseded' | 'all';
type InternalState = 'active' | 'tombstoned' | 'all';
export type GuidanceKind = 'fact' | 'style';
export type GuidanceScope = 'global' | 'customer';
export type MemoryMutationResult = 'ok' | 'not_found' | 'conflict';

function decodeCursor(value: unknown): MemoryCursor | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as MemoryCursor;
    return typeof parsed.at === 'string' && typeof parsed.id === 'string' ? parsed : null;
  } catch { return null; }
}

function encodeCursor(row: { created_at: string; id: string }): string {
  return Buffer.from(JSON.stringify({ at: row.created_at, id: row.id })).toString('base64url');
}

function parseLimit(value: unknown): number | null {
  if (value === undefined) return 50;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return parsed >= 1 && parsed <= 100 ? parsed : null;
}

function parseSearch(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text.length <= 200 ? text || null : undefined;
}

function parseMemoryScope(value: unknown): MemoryScope | undefined {
  if (value === undefined) return 'all';
  return value === 'global' || value === 'customer' || value === 'all' ? value : undefined;
}

function parseMemoryState(value: unknown): MemoryState | undefined {
  if (value === undefined) return 'active';
  return value === 'active' || value === 'superseded' || value === 'all' ? value : undefined;
}

function parseInternalState(value: unknown): InternalState | undefined {
  if (value === undefined) return 'active';
  return value === 'active' || value === 'tombstoned' || value === 'all' ? value : undefined;
}

function safeMetadataSql(alias: string): string {
  return `jsonb_strip_nulls(jsonb_build_object(
    'source', ${alias}.metadata->>'source', 'kind', ${alias}.metadata->>'kind',
    'fact', ${alias}.metadata->>'fact', 'title', ${alias}.metadata->>'title',
    'section', ${alias}.metadata->>'section', 'module', ${alias}.metadata->>'module',
    'route', ${alias}.metadata->>'route', 'locale', ${alias}.metadata->>'locale',
    'decision_id', ${alias}.metadata->>'decision_id',
    'document_key', d.doc_key, 'document_source', d.source_id))`;
}

export async function listCustomerMemory(input: { customerId?: unknown; scope?: unknown; type?: unknown; state?: unknown; q?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const scope = parseMemoryScope(input.scope);
  const state = parseMemoryState(input.state);
  const search = parseSearch(input.q);
  const customerId = input.customerId === undefined ? null : typeof input.customerId === 'string' && UUID_RE.test(input.customerId) ? input.customerId : undefined;
  const type = input.type === undefined ? null : typeof input.type === 'string' && MEMORY_TYPES.includes(input.type as typeof MEMORY_TYPES[number]) ? input.type : undefined;
  if (limit === null || !scope || !state || search === undefined || customerId === undefined || type === undefined || (input.cursor !== undefined && !cursor)) return null;
  if (scope === 'customer' && !customerId) return null;

  const { rows } = await query<Record<string, unknown>>(
    `SELECT m.id::text, to_char(m.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            m.memory_type, m.lifecycle_status, m.document_id::text, m.customer_id::text,
            c.display_name AS customer_name, left(regexp_replace(m.content, '\\s+', ' ', 'g'), 280) AS excerpt,
            ${safeMetadataSql('m')} AS metadata
       FROM agent_memory m
  LEFT JOIN agent_customers c ON c.id = m.customer_id
  LEFT JOIN knowledge_documents d ON d.id = m.document_id
      WHERE ($1::uuid IS NULL OR m.customer_id = $1)
        AND ($2::text = 'all' OR ($2 = 'global' AND m.customer_id IS NULL) OR ($2 = 'customer' AND m.customer_id IS NOT NULL))
        AND ($3::text = 'all' OR m.lifecycle_status = $3)
        AND ($4::text IS NULL OR m.memory_type = $4)
        AND ($5::text IS NULL OR to_tsvector('simple', m.content) @@ websearch_to_tsquery('simple', $5))
        AND ($6::timestamptz IS NULL OR (m.created_at, m.id) < ($6::timestamptz, $7::bigint))
   ORDER BY m.created_at DESC, m.id DESC
      LIMIT $8`,
    [customerId, scope, state, type, search, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

export async function customerMemoryDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT m.id::text, m.created_at, m.memory_type, m.lifecycle_status, m.superseded_at,
            m.superseded_by::text, m.document_id::text, m.customer_id::text, c.display_name AS customer_name,
            m.content, ${safeMetadataSql('m')} AS metadata
       FROM agent_memory m
  LEFT JOIN agent_customers c ON c.id = m.customer_id
  LEFT JOIN knowledge_documents d ON d.id = m.document_id
      WHERE m.id = $1`, [id],
  );
  return rows[0] ?? null;
}

export async function listInternalMemory(input: { source?: unknown; repo?: unknown; status?: unknown; q?: unknown; cursor?: unknown; limit?: unknown }): Promise<Page<Record<string, unknown>> | null> {
  const limit = parseLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const state = parseInternalState(input.status);
  const search = parseSearch(input.q);
  const source = input.source === undefined ? null : typeof input.source === 'string' && input.source.length <= 100 ? input.source || null : undefined;
  const repo = input.repo === undefined ? null : typeof input.repo === 'string' && Object.hasOwn(INTERNAL_REPO_ROOTS, input.repo) ? input.repo : undefined;
  if (limit === null || !state || search === undefined || source === undefined || repo === undefined || (input.cursor !== undefined && !cursor)) return null;
  const { rows } = await query<Record<string, unknown>>(
    `SELECT i.id::text, to_char(i.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            i.source_id, i.doc_key, i.chunk_index, i.repo, i.path, i.title, i.section, i.status,
            left(regexp_replace(i.content, '\\s+', ' ', 'g'), 280) AS excerpt
       FROM internal_knowledge i
      WHERE ($1::text IS NULL OR i.source_id = $1)
        AND ($2::text IS NULL OR i.repo = $2)
        AND ($3::text = 'all' OR i.status = $3)
        AND ($4::text IS NULL OR to_tsvector('simple', i.content) @@ websearch_to_tsquery('simple', $4))
        AND ($5::timestamptz IS NULL OR (i.updated_at, i.id) < ($5::timestamptz, $6::bigint))
   ORDER BY i.updated_at DESC, i.id DESC
      LIMIT $7`,
    [source, repo, state, search, cursor?.at ?? null, cursor?.id ?? null, limit + 1],
  );
  const data = rows.slice(0, limit);
  const last = data[data.length - 1] as { created_at: string; id: string } | undefined;
  return { data, nextCursor: rows.length > limit && last ? encodeCursor(last) : null };
}

export async function internalMemoryDetail(id: string): Promise<Record<string, unknown> | null> {
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id::text, source_id, doc_key, chunk_index, repo, path, title, section, content, status, created_at, updated_at
       FROM internal_knowledge WHERE id = $1`, [id],
  );
  return rows[0] ?? null;
}

export async function listMemorySources(): Promise<Record<string, unknown>[]> {
  const { rows } = await query<{ source_id: string; active_documents: string; tombstoned_documents: string; chunks: string; last_updated_at: Date | null }>(
    `SELECT source_id, count(DISTINCT doc_key) FILTER (WHERE status = 'active')::text AS active_documents,
            count(DISTINCT doc_key) FILTER (WHERE status = 'tombstoned')::text AS tombstoned_documents,
            count(*)::text AS chunks, max(updated_at) AS last_updated_at
       FROM internal_knowledge GROUP BY source_id`,
  );
  const stats = new Map(rows.map((row) => [row.source_id, row]));
  return INTERNAL_SOURCES.map((source) => {
    const stat = stats.get(source.id);
    return {
      id: source.id, repo: source.repo, rootAvailable: existsSync(INTERNAL_REPO_ROOTS[source.repo]),
      include: source.include, excludeDirs: source.excludeDirs ?? [],
      activeDocuments: Number(stat?.active_documents ?? 0), tombstonedDocuments: Number(stat?.tombstoned_documents ?? 0),
      chunks: Number(stat?.chunks ?? 0), lastUpdatedAt: stat?.last_updated_at?.toISOString() ?? null,
    };
  });
}

function toVectorLiteral(embedding: number[]): string { return `[${embedding.join(',')}]`; }

function guidanceMetadata(input: { scope: GuidanceScope; kind: GuidanceKind; fact: string; originCustomerId: string | null; supersedesId?: string }): Record<string, unknown> {
  return {
    source: 'founder_console', scope: input.scope === 'global' ? 'shared' : 'customer', kind: input.kind, fact: input.fact,
    ...(input.originCustomerId ? { origin_customer_id: input.originCustomerId } : {}),
    ...(input.supersedesId ? { supersedes_memory_id: input.supersedesId } : {}),
  };
}

async function auditMemory(client: PoolClient, context: ConsoleAuditContext, action: string, id: string, before: string | null, after: string, kind: GuidanceKind | null, scope: GuidanceScope | null): Promise<void> {
  await client.query(
    `INSERT INTO console_audit_events (actor, action, entity_type, entity_id, request_id, safe_metadata)
     VALUES ($1, $2, 'agent_memory', $3, $4, jsonb_strip_nulls(jsonb_build_object(
       'before_status', $5::text, 'after_status', $6::text, 'kind', $7::text, 'scope', $8::text)))`,
    [context.actor, action, id, context.requestId, before, after, kind, scope],
  );
}

async function insertGuidance(client: PoolClient, input: { scope: GuidanceScope; customerId: string | null; kind: GuidanceKind; fact: string; embedding: number[]; originCustomerId: string | null; supersedesId?: string }): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO agent_memory (customer_id, memory_type, document_id, content, embedding, metadata, chunk_index, lifecycle_status)
     VALUES ($1, 'correction', NULL, $2, $3::vector, $4::jsonb, 0, 'active') RETURNING id::text`,
    [input.customerId, `Founder guidance (${input.scope}): ${input.fact}`, toVectorLiteral(input.embedding), JSON.stringify(guidanceMetadata(input))],
  );
  return rows[0].id;
}

export async function createGuidance(input: { scope: GuidanceScope; customerId: string | null; kind: GuidanceKind; fact: string; embedding: number[] }, context: ConsoleAuditContext): Promise<{ id: string }> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const id = await insertGuidance(client, { ...input, originCustomerId: input.customerId });
      await auditMemory(client, context, 'memory.guidance.create', id, null, 'active', input.kind, input.scope);
      await client.query('COMMIT');
      return { id };
    } catch (err) { await client.query('ROLLBACK'); throw err; }
  });
}

export async function supersedeGuidance(id: string, input: { scope: GuidanceScope; customerId: string | null; kind: GuidanceKind; fact: string; embedding: number[] }, context: ConsoleAuditContext): Promise<{ result: MemoryMutationResult; id?: string }> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const current = await client.query<{ memory_type: string; lifecycle_status: string; document_id: string | null; customer_id: string | null }>(
        `SELECT memory_type, lifecycle_status, document_id, customer_id::text FROM agent_memory WHERE id = $1 FOR UPDATE`, [id],
      );
      const row = current.rows[0];
      if (!row) { await client.query('ROLLBACK'); return { result: 'not_found' }; }
      if (!GUIDANCE_TYPES.has(row.memory_type) || row.document_id !== null || row.lifecycle_status !== 'active') { await client.query('ROLLBACK'); return { result: 'conflict' }; }
      // A customer-specific lesson can be promoted to global, but never silently
      // reattached to a different customer through a crafted console request.
      if (input.scope === 'customer' && input.customerId !== row.customer_id) { await client.query('ROLLBACK'); return { result: 'conflict' }; }
      const replacementId = await insertGuidance(client, { ...input, originCustomerId: row.customer_id ?? input.customerId, supersedesId: id });
      await client.query(`UPDATE agent_memory SET lifecycle_status = 'superseded', superseded_at = now(), superseded_by = $2 WHERE id = $1`, [id, replacementId]);
      await auditMemory(client, context, 'memory.guidance.supersede', id, 'active', 'superseded', input.kind, input.scope);
      await client.query('COMMIT');
      return { result: 'ok', id: replacementId };
    } catch (err) { await client.query('ROLLBACK'); throw err; }
  });
}

export async function retireGuidance(id: string, context: ConsoleAuditContext): Promise<MemoryMutationResult> {
  return withClient(async (client) => {
    await client.query('BEGIN');
    try {
      const current = await client.query<{ memory_type: string; lifecycle_status: string; document_id: string | null }>(
        `SELECT memory_type, lifecycle_status, document_id FROM agent_memory WHERE id = $1 FOR UPDATE`, [id],
      );
      const row = current.rows[0];
      if (!row) { await client.query('ROLLBACK'); return 'not_found'; }
      if (!GUIDANCE_TYPES.has(row.memory_type) || row.document_id !== null || row.lifecycle_status !== 'active') { await client.query('ROLLBACK'); return 'conflict'; }
      await client.query(`UPDATE agent_memory SET lifecycle_status = 'superseded', superseded_at = now() WHERE id = $1`, [id]);
      await auditMemory(client, context, 'memory.guidance.retire', id, 'active', 'superseded', null, null);
      await client.query('COMMIT');
      return 'ok';
    } catch (err) { await client.query('ROLLBACK'); throw err; }
  });
}
