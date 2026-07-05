import { CustomerDirectoryPort, TaskTargetPort, TaskRef, TargetTask } from '../../ports';
import { EzyPortalHttpClient } from './http-client';

/** The orchestrator's identity in the portal `sourceService` field (D5 dedup). */
const SOURCE_SERVICE = 'agent-orchestrator';
/** Portal field limits (DA-verified vs task_input.go) — truncate defensively so a
 *  long LLM title/description never 422s. M1.5b should also validate upstream. */
const TITLE_MAX = 240;
const DESC_MAX = 4000;
const TAG_MAX = 64;
const TAGS_MAX = 50;
/** Non-terminal statuses = "open" (server-side `status IN ?` filter; exact spellings). */
const OPEN_STATUSES = 'backlog,todo,in-progress,review';

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

function fullName(c: EzyContact): string {
  return [c.firstName, c.lastName].filter((s) => s && s.trim()).join(' ').trim();
}

export class EzyPortalGateway implements CustomerDirectoryPort, TaskTargetPort {
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
  // contract test distinguish them (R45). Idempotency-Key is minted per POST.

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
      title: input.title.slice(0, TITLE_MAX),
      description: input.description.slice(0, DESC_MAX),
      priority: input.priority,
      sourceService: input.source.service,
      sourceEntityType: input.source.entityType,
      sourceEntityId: input.source.entityId,
      sourceDisplay: input.source.display,
      sourceUrl: input.source.url,
      tags: input.tags.slice(0, TAGS_MAX).map((t) => t.slice(0, TAG_MAX)),
    });
    return { ref: created.id, display: created.title };
  }

  async addComment(task: TaskRef, body: string): Promise<void> {
    await this.http.post(`/api/projects/tasks/${task.ref}/comments`, { body });
  }

  async findOpenTasks(q: {
    customerRef?: string;
    projectRef?: string;
    sourceEntity?: { type: string; id: string };
    text?: string;
  }): Promise<TargetTask[]> {
    const res = await this.http.get<Paged<EzyTask>>('/api/projects/tasks', {
      projectId: q.projectRef,
      // dedup lookup: our created tasks all carry sourceService='agent-orchestrator'
      sourceService: q.sourceEntity ? SOURCE_SERVICE : undefined,
      sourceEntityType: q.sourceEntity?.type,
      sourceEntityId: q.sourceEntity?.id,
      search: q.text, // ⚠ the portal param is `search`, NOT `text` (unknown params are ignored)
      status: OPEN_STATUSES, // server-side non-terminal filter
    });
    return res.data.map((t) => ({
      ref: t.id,
      title: t.title,
      status: t.status,
      projectRef: t.projectId,
      updatedAt: t.updatedAt ? new Date(t.updatedAt) : undefined,
      // the task API has no url field — leave undefined (M1.5b/change-04 can deep-link)
    }));
  }

  async setStatus(task: TaskRef, status: string): Promise<void> {
    // Dedicated endpoint — POST /:id/status, NOT PATCH /:id (task_update.go).
    await this.http.post(`/api/projects/tasks/${task.ref}/status`, { status });
  }
}
