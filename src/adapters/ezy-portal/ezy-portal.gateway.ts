import { CustomerDirectoryPort } from '../../ports';
import { EzyPortalHttpClient } from './http-client';

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

interface Paged<T> {
  data: T[];
}

function fullName(c: EzyContact): string {
  return [c.firstName, c.lastName].filter((s) => s && s.trim()).join(' ').trim();
}

export class EzyPortalGateway implements CustomerDirectoryPort {
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
}
