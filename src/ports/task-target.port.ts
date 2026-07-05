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
    sourceEntity?: { type: string; id: string };
    text?: string;
  }): Promise<TargetTask[]>;
  /** Find the task owning a source across ALL statuses (the target may enforce
   *  source uniqueness, so a closed task still blocks a new create) — used by the
   *  money-loop's thread dedup. At most one for a source-unique target. */
  findTasksBySource(q: { projectRef?: string; sourceEntity: { type: string; id: string } }): Promise<TargetTask[]>;
  listWorkItemTypes(projectRef: string): Promise<Array<{ ref: string; name: string }>>;
  setStatus(task: TaskRef, status: string): Promise<void>; // used from change 04
}
