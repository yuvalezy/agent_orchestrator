import {
  CustomerDirectoryPort,
  TaskTargetPort,
  TaskRef,
  TargetTask,
  SourceEntityRef,
  TicketingPort,
  TargetTicket,
  TicketThreadEntry,
} from '../../ports';
import { EzyPortalHttpClient } from './http-client';

/** Portal field limits (DA-verified vs task_input.go) — truncate defensively so a
 *  long LLM title/description never 422s. M1.5b should also validate upstream. */
const TITLE_MAX = 240;
const DESC_MAX = 4000;
const TAG_MAX = 64;
const TAGS_MAX = 50;
/** Non-terminal statuses = "open" (server-side `status IN ?` filter; exact spellings). */
const OPEN_STATUSES = 'backlog,todo,in-progress,review';
/** Every status — for the source dedup: the portal enforces UNIQUE(sourceService,
 *  sourceEntityType, sourceEntityId) across ALL statuses, so a closed task still
 *  "owns" its source and a new create 400s. Dedup must find it (any status). */
const ALL_STATUSES = 'backlog,todo,in-progress,review,done,cancelled';

// EzyPortalGateway — the single adapter behind the EZY Portal ports (invariant
// #4). M1.2 implements CustomerDirectoryPort plus the real two-hop
// listWorkItemTypes (a TaskTargetPort method needed by onboarding); M1.5a
// extends the class to `implements CustomerDirectoryPort, TaskTargetPort` and
// fills in createTask/addComment/etc. — completion, not rework.
//
// Refs are opaque to core: a BP/project/work-item-type "ref" is the portal UUID,
// and only this adapter knows that.

// ── Raw portal response shapes (only the fields we read; verified live) ──
interface EzyBpDetail {
  id: string;
  name: string;
  website?: string | null;
  email?: string | null;
}

interface EzyBpListItem {
  id: string;
  code: string;
  name: string;
}

interface EzyContact {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  whatsapp?: string | null;
  telegram?: string | null;
  isPrimary?: boolean;
}

interface EzyProjectDetail {
  id: string;
  projectTypeId: string;
}

interface EzyWorkItemType {
  id: string;
  name: string;
}

interface EzyTask {
  id: string;
  title: string;
  status: string;
  projectId?: string;
  updatedAt?: string;
}

interface Paged<T> {
  data: T[];
}

// ── Service-desk raw shapes (recon §2; camelCase JSON, only fields we read) ──
interface EzyTicket {
  id: string;
  ticketNumber: string;
  subject: string;
  description?: string | null;
  status: string;
  priority: string;
  source?: string | null;
  requesterType: string;
  requesterBPID?: string | null;
  requesterContactID?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
  accountId?: string | null;
  createdAt: string;
  updatedAt: string;
  tags?: string[] | null;
}

/** The changed-ticket list envelope (recon §2): {data, totalCount, pageNumber, pageSize}. */
interface EzyTicketList {
  data: EzyTicket[];
  totalCount: number;
  pageNumber: number;
  pageSize: number;
}

interface EzyTicketThreadEntry {
  id: string;
  ticketId?: string;
  entryType: string;
  visibility: string;
  body: string;
  authorName?: string | null;
  authorIsExternal: boolean;
  createdAt: string;
}

/** Raw portal ticket → opaque TargetTicket (refs are UUID strings). */
function mapTicket(t: EzyTicket): TargetTicket {
  return {
    id: t.id,
    ticketNumber: t.ticketNumber,
    subject: t.subject,
    description: t.description ?? null,
    status: t.status as TargetTicket['status'],
    priority: t.priority as TargetTicket['priority'],
    requesterType: t.requesterType as TargetTicket['requesterType'],
    requesterBPID: t.requesterBPID ?? null,
    requesterEmail: t.requesterEmail ?? null,
    requesterName: t.requesterName ?? null,
    createdAt: new Date(t.createdAt),
    updatedAt: new Date(t.updatedAt),
  };
}

/** Raw thread entry → opaque TicketThreadEntry. */
function mapEntry(e: EzyTicketThreadEntry): TicketThreadEntry {
  return {
    id: e.id,
    body: e.body,
    authorName: e.authorName ?? '',
    authorIsExternal: e.authorIsExternal,
    visibility: e.visibility as TicketThreadEntry['visibility'],
    entryType: e.entryType as TicketThreadEntry['entryType'],
    createdAt: new Date(e.createdAt),
  };
}

function fullName(c: EzyContact): string {
  return [c.firstName, c.lastName].filter((s) => s && s.trim()).join(' ').trim();
}

/** Portal task row → opaque TargetTask (the task API has no url field). */
function mapTask(t: EzyTask): TargetTask {
  return {
    ref: t.id,
    title: t.title,
    status: t.status,
    projectRef: t.projectId,
    updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
  };
}

/** Truncate to ≤max Unicode code points. The portal counts title/description in
 *  RUNES (utf8.RuneCountInString), so this matches its limit AND never splits a
 *  UTF-16 surrogate pair (which would corrupt an emoji to U+FFFD) — code-review #4. */
function truncateRunes(s: string, max: number): string {
  const runes = Array.from(s);
  return runes.length > max ? runes.slice(0, max).join('') : s;
}

/** Truncate to ≤maxBytes UTF-8 bytes. The portal's TAG limit is BYTE-based (Go
 *  len()), so UTF-16-unit `.slice` could leave a multibyte tag >64 bytes → 400.
 *  Cut on rune boundaries so bytes never exceed the cap (code-review #3). */
function truncateBytes(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  for (const r of Array.from(s)) {
    if (Buffer.byteLength(out + r, 'utf8') > maxBytes) break;
    out += r;
  }
  return out;
}

export class EzyPortalGateway implements CustomerDirectoryPort, TaskTargetPort, TicketingPort {
  constructor(private readonly http: EzyPortalHttpClient) {}

  async getCustomer(
    ref: string,
  ): Promise<{ ref: string; name: string; website?: string; email?: string }> {
    const bp = await this.http.get<EzyBpDetail>(`/api/business-partners/bp/${ref}`);
    return {
      ref: bp.id,
      name: bp.name,
      website: bp.website ?? undefined,
      email: bp.email ?? undefined,
    };
  }

  async searchCustomers(q: string): Promise<Array<{ ref: string; name: string; code: string }>> {
    const res = await this.http.get<Paged<EzyBpListItem>>('/api/business-partners/bp', {
      query: q,
      page: '1',
      perPage: '50',
    });
    return res.data.map((bp) => ({ ref: bp.id, name: bp.name, code: bp.code }));
  }

  async listContacts(ref: string): Promise<
    Array<{
      ref: string;
      name: string;
      email?: string;
      phone?: string;
      whatsapp?: string;
      telegram?: string;
      isPrimary: boolean;
    }>
  > {
    const res = await this.http.get<Paged<EzyContact>>('/api/business-partners/contacts', {
      bpId: ref,
      page: '1',
      perPage: '100',
    });
    return res.data.map((c) => ({
      ref: c.id,
      name: fullName(c),
      email: c.email ?? undefined,
      phone: c.phone ?? c.mobile ?? undefined,
      whatsapp: c.whatsapp ?? undefined,
      telegram: c.telegram ?? undefined,
      isPrimary: c.isPrimary ?? false,
    }));
  }

  /**
   * Two-hop resolution (blueprint ground-truth correction): work item types
   * belong to a project's PROJECT TYPE, not the project. Hop 1 reads the
   * project's projectTypeId; hop 2 lists the types for that project type. A
   * projectId filter is silently ignored by the portal and returns the whole
   * tenant list, so filtering by projectId would let a wrong type slip through
   * and 422 at task-create time (M1.5a).
   */
  async listWorkItemTypes(projectRef: string): Promise<Array<{ ref: string; name: string }>> {
    const project = await this.http.get<EzyProjectDetail>(`/api/projects/projects/${projectRef}`);
    const types = await this.http.get<EzyWorkItemType[]>('/api/projects/work-item-types', {
      projectTypeId: project.projectTypeId,
    });
    return types.map((t) => ({ ref: t.id, name: t.name }));
  }

  // ── TaskTargetPort (M1.5a) ──
  // Fields are DA-verified camelCase (task_input.go). `workItemTypeId` is required
  // and must belong to the project's PROJECT TYPE (422 otherwise — the two-hop
  // listWorkItemTypes guarantees a match). Write errors: 422 = validation (bad/
  // missing WIT); 409 = "Project is read-only" (terminal project) or "WIP limit
  // exceeded" (setStatus) — the EzyHttpError carries `.status` so callers/the
  // contract test distinguish them (R45).
  //
  // ⚠ R47: the portal's projects/tasks module does NOT honor Idempotency-Key (only
  // the bp module wired that middleware), so a transport-retry after a committed
  // create would DOUBLE-create. `createTask` is therefore NOT exactly-once on its
  // own — M1.5b's pre-create findOpenTasks(sourceEntity) reconcile is the
  // compensating control (and a portal-side idempotency handler is the real fix).

  async createTask(input: {
    customerRef: string;
    projectRef: string;
    workItemTypeRef: string;
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    source: { service: string; entityType: string; entityId: string; display: string; url?: string };
    tags: string[];
  }): Promise<TaskRef> {
    const created = await this.http.post<EzyTask>('/api/projects/tasks', {
      projectId: input.projectRef,
      workItemTypeId: input.workItemTypeRef,
      title: truncateRunes(input.title, TITLE_MAX),
      description: truncateRunes(input.description, DESC_MAX),
      priority: input.priority,
      sourceService: input.source.service,
      sourceEntityType: input.source.entityType,
      sourceEntityId: input.source.entityId,
      sourceDisplay: input.source.display,
      sourceUrl: input.source.url,
      tags: input.tags.slice(0, TAGS_MAX).map((t) => truncateBytes(t, TAG_MAX)),
    });
    return { ref: created.id, display: created.title };
  }

  async addComment(task: TaskRef, body: string): Promise<void> {
    await this.http.post(`/api/projects/tasks/${task.ref}/comments`, { body });
  }

  async findOpenTasks(q: {
    customerRef?: string;
    projectRef?: string;
    sourceEntity?: SourceEntityRef;
    text?: string;
  }): Promise<TargetTask[]> {
    // ⚠ R46: the portal ListTasks has NO customer/BP filter (Task carries no BP
    // field), so `customerRef` is INERT here. A query with neither projectRef nor
    // sourceEntity would return tenant-wide open tasks (page 1) — a wrong-scope
    // dedup hazard for M1.5b. Fail loud instead of silently over-matching.
    if (!q.projectRef && !q.sourceEntity) {
      throw new Error(
        'findOpenTasks requires projectRef or sourceEntity (customerRef is not a portal task filter; an unscoped query returns tenant-wide tasks — R46)',
      );
    }
    // NOTE: page 1 only (default pageSize 25). Sufficient for exact sourceEntity
    // dedup; a list-all-open use (change 04) must paginate.
    const res = await this.http.get<Paged<EzyTask>>('/api/projects/tasks', {
      projectId: q.projectRef,
      // dedup lookup: sourceService varies by origin channel (D5) — caller-supplied.
      sourceService: q.sourceEntity?.service,
      sourceEntityType: q.sourceEntity?.type,
      sourceEntityId: q.sourceEntity?.id,
      search: q.text, // ⚠ the portal param is `search`, NOT `text` (unknown params are ignored)
      status: OPEN_STATUSES, // server-side non-terminal filter
    });
    return res.data.map(mapTask);
  }

  /**
   * Find the task that OWNS a source (any status) — the portal's source-triple
   * uniqueness means at most one exists, and a create with the same source 400s
   * even when it is cancelled/done. The money-loop dedups the thread against THIS
   * (not open-only) so a closed thread's follow-up comments on the existing task
   * instead of failing to create.
   */
  async findTasksBySource(q: { projectRef?: string; sourceEntity: SourceEntityRef }): Promise<TargetTask[]> {
    const res = await this.http.get<Paged<EzyTask>>('/api/projects/tasks', {
      projectId: q.projectRef,
      sourceService: q.sourceEntity.service,
      sourceEntityType: q.sourceEntity.type,
      sourceEntityId: q.sourceEntity.id,
      status: ALL_STATUSES,
    });
    return res.data.map(mapTask);
  }

  async setStatus(task: TaskRef, status: string): Promise<void> {
    // Dedicated endpoint — POST /:id/status, NOT PATCH /:id (task_update.go).
    await this.http.post(`/api/projects/tasks/${task.ref}/status`, { status });
  }

  /**
   * Attach a file to a task (M2). Multipart upload to the shared files endpoint
   * with the projects/Task source triple — the tenant key already has
   * projects.tasks Write. Field name is `file`; folder pins it under the task's
   * project storage. Best-effort at the call site (never fails the inbox row).
   */
  async attachFileToTask(task: TaskRef, bytes: Uint8Array, filename: string, contentType: string): Promise<void> {
    await this.http.uploadFile(
      '/api/files/upload',
      {
        sourceService: 'projectsApp',
        sourceEntityType: 'Task',
        sourceEntityId: task.ref,
        folder: 'projects/tasks',
      },
      { bytes, filename, contentType },
    );
  }

  // ── TicketingPort (M1.7) — READ half wired (service-desk.view); WRITE half
  // (postReply/setTicketStatus) port-complete but UNWIRED (needs service-desk.manage,
  // M1.8). All routes go through nginx as /api/service-desk/* (CLAUDE.md rewrite).

  /**
   * Drain the changed-ticket list on an INCLUSIVE `updatedAfter` (recon §2, D-D):
   * `sortBy=updatedAt&sortDescending=false&pageSize=100`, walking `pageNumber`
   * until `(pageNumber-1)*pageSize >= totalCount`. `nextCursor = max(updatedAt)`
   * across the drained set, or the passed `updatedAfter` on an empty drain (never
   * null — B9). Re-delivered boundary rows are deduped downstream by id (no +1ns).
   */
  async listChangedTickets(updatedAfter: string): Promise<{ tickets: TargetTicket[]; nextCursor: string }> {
    const pageSize = 100; // hard-capped server-side
    const tickets: TargetTicket[] = [];
    let pageNumber = 1;
    let totalCount = Infinity;
    // Drain EVERY page before advancing (R32) — a partial drain would lose rows
    // past the cursor once max(updatedAt) advances.
    while ((pageNumber - 1) * pageSize < totalCount) {
      const res = await this.http.get<EzyTicketList>('/api/service-desk/tickets', {
        updatedAfter,
        sortBy: 'updatedAt',
        sortDescending: 'false',
        pageNumber: String(pageNumber),
        pageSize: String(pageSize),
      });
      totalCount = res.totalCount;
      for (const t of res.data) tickets.push(mapTicket(t));
      if (res.data.length === 0) break; // safety: no more rows than totalCount claims
      pageNumber += 1;
    }
    let maxMs = new Date(updatedAfter).getTime();
    for (const t of tickets) maxMs = Math.max(maxMs, t.updatedAt.getTime());
    return { tickets, nextCursor: new Date(maxMs).toISOString() };
  }

  /** Public thread entries only — `?visibility=public` excludes internal notes.
   *  The endpoint returns a RAW ARRAY (created_at ASC), not a paged envelope. */
  async getThread(ticketRef: string): Promise<TicketThreadEntry[]> {
    const entries = await this.http.get<EzyTicketThreadEntry[]>(
      `/api/service-desk/tickets/${ticketRef}/thread`,
      { visibility: 'public' },
    );
    return entries.map(mapEntry);
  }

  /** UNWIRED (M1.8) — needs service-desk.manage. Endpoint shape is best-effort
   *  (recon §2 documents only reads); revisit when outbound is wired. */
  async postReply(ticketRef: string, body: string, visibility: 'public' | 'internal'): Promise<void> {
    await this.http.post(`/api/service-desk/tickets/${ticketRef}/thread`, {
      body,
      visibility,
      entryType: 'reply',
    });
  }

  /** UNWIRED (M1.8) — needs service-desk.manage. See postReply note on endpoint shape. */
  async setTicketStatus(ticketRef: string, status: 'open' | 'pending' | 'resolved' | 'closed'): Promise<void> {
    await this.http.post(`/api/service-desk/tickets/${ticketRef}/status`, { status });
  }

  /** Cheap connectivity probe for the service-desk channel health check (D-F). */
  async pingServiceDesk(): Promise<void> {
    await this.http.get<EzyTicketList>('/api/service-desk/tickets', { pageSize: '1' });
  }
}
