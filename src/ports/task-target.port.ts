// Task-target port (design.md D4/D5). Core stores target ids as opaque TEXT
// refs; only the EzyPortalGateway adapter knows they are UUIDs.

export interface TaskRef {
  ref: string;
  url?: string;
  display?: string;
} // opaque

/**
 * Result shape of a task lookup. Placeholder (blueprint decision #4) —
 * design.md references `TargetTask` without defining it; refine when the
 * TaskTargetPort adapter (EzyPortalGateway) lands (change 04 uses more of it).
 */
export interface TargetTask {
  ref: string;
  title: string;
  status: string;
  url?: string;
  projectRef?: string;
  updatedAt?: Date;
  /** Human task code (e.g. 'TSK-00214'); present on list reads. */
  code?: string;
  /** Task priority (low|medium|high|urgent); present on list reads. */
  priority?: string;
  /** Full description — only on a per-task detail read (absent from list rows). */
  description?: string;
}

/** A task's source-triple identity (D5) — (service, entityType, entityId) is the
 *  target's own uniqueness key, so lookups must supply the same `service` the
 *  task was created with (it varies per originating channel; not a constant). */
export interface SourceEntityRef {
  service: string;
  type: string;
  id: string;
}

export interface TaskTargetPort {
  createTask(input: {
    customerRef: string;
    projectRef: string;
    workItemTypeRef: string;
    title: string;
    description: string;
    priority: 'low' | 'medium' | 'high' | 'urgent';
    source: { service: string; entityType: string; entityId: string; display: string; url?: string };
    tags: string[];
  }): Promise<TaskRef>;
  addComment(task: TaskRef, body: string): Promise<void>;
  findOpenTasks(q: {
    customerRef?: string;
    projectRef?: string;
    sourceEntity?: SourceEntityRef;
    text?: string;
  }): Promise<TargetTask[]>;
  /** Find the task owning a source across ALL statuses (the target may enforce
   *  source uniqueness, so a closed task still blocks a new create) — used by the
   *  money-loop's thread dedup. At most one for a source-unique target. */
  findTasksBySource(q: { projectRef?: string; sourceEntity: SourceEntityRef }): Promise<TargetTask[]>;
  /** Every task for a project across EVERY status, paginated to completion — the
   *  content-keyed source for the task-inventory sync (distinct from findOpenTasks,
   *  which is page-1 + open-only). Includes code/priority so a status/priority change
   *  re-embeds. Does NOT fetch descriptions (a per-task detail read). */
  listAllTasks(projectRef: string): Promise<TargetTask[]>;
  /** Drain a project's tasks that moved to a TERMINAL status (done/cancelled) since
   *  `updatedAfter` (INCLUSIVE), paginated to completion — the M4 proactive
   *  "your request is resolved" detector. `nextCursor` = max(updatedAt) over the
   *  drained set, or the passed `updatedAfter` on an empty drain (never null). */
  listChangedTasks(
    projectRef: string,
    updatedAfter: string,
  ): Promise<{ tasks: TargetTask[]; nextCursor: string }>;
  listWorkItemTypes(projectRef: string): Promise<Array<{ ref: string; name: string }>>;
  setStatus(task: TaskRef, status: string): Promise<void>; // used from change 04
  /** Attach a binary file to a task (M2 group-mention media path). Best-effort at
   *  the call site — the adapter uploads the caller-supplied bytes (already fetched
   *  from the source channel) as multipart/form-data. */
  attachFileToTask(task: TaskRef, bytes: Uint8Array, filename: string, contentType: string): Promise<void>;
}
