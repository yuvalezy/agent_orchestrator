# task-target

Task destination port + EZY Portal adapter. Shipped by change 01 (M1.5a), in `agent_orchestrator`.

## Requirements

### Requirement: Task destination behind a port with opaque refs
All work-management operations SHALL go through `TaskTargetPort` (createTask, addComment, findTasksBySource, listWorkItemTypes, setStatus). Core SHALL store returned refs as opaque strings; only the adapter maps them to EZY Portal UUIDs and URLs.

#### Scenario: Target swap
- **WHEN** a hypothetical future adapter implements `TaskTargetPort` for a different system
- **THEN** triage, bridging, and notifications compile and run against it without modification

### Requirement: EZY Portal adapter contract
The EZY adapter SHALL call `POST /api/projects/tasks` including `projectId`, a valid `workItemTypeId` (from customer config, validated at onboarding via the two-hop lookup — project → `projectTypeId` → work item types for that project type, since the portal's `projectId` filter on that endpoint is silently ignored), and the source fields `sourceService='agent-orchestrator'`, `sourceEntityType=<channel type>`, `sourceEntityId=<thread key>`, `sourceDisplay`, `sourceUrl`; comments via `POST /api/projects/tasks/:id/comments`; status changes via `POST /api/projects/tasks/:id/status`. Auth SHALL use the scoped `ten_` API key with `Idempotency-Key` on writes; retriable failures (5xx/429) SHALL be retried with backoff.

#### Scenario: Task traceable back to its conversation
- **WHEN** a task is created from a WhatsApp group message
- **THEN** querying the portal task list with `sourceService=agent-orchestrator&sourceEntityId=<group id>` returns it

#### Scenario: Missing work item type is impossible at runtime
- **WHEN** `createTask` is invoked for an onboarded customer
- **THEN** the payload always carries the customer's validated `workItemTypeId` and the portal does not return 422

### Requirement: One task per thread, for the life of the thread — across all statuses
The portal enforces `UNIQUE(sourceService, sourceEntityType, sourceEntityId)` across every task status, not just open ones — a second `createTask` for a thread whose task is already `done`/`cancelled` is rejected. `findTasksBySource` SHALL therefore query **all** statuses (`backlog,todo,in-progress,review,done,cancelled`), and dedup SHALL run this lookup before every `createTask` call: any match, regardless of status, is commented on instead of creating a new task (the portal allows comments on closed tasks). This supersedes the earlier open-tasks-only assumption.

#### Scenario: Same thread reopens after its task was closed
- **WHEN** a customer messages again in a thread whose task was already marked `done`
- **THEN** the system finds the existing (closed) task via `findTasksBySource` and adds a comment to it — it does not attempt to create a second task, which the portal would reject with 400

#### Scenario: Idempotency-Key is not honored by this endpoint
- **WHEN** a `createTask` call is retried after a network timeout with the same `Idempotency-Key`
- **THEN** the portal's task-creation endpoint does not deduplicate on it (only the BP module does) — the pre-create `findTasksBySource` reconcile is what prevents a duplicate task, not the header

### Requirement: Customer directory behind a port
BP and contact lookups SHALL go through `CustomerDirectoryPort` (getCustomer, searchCustomers, listContacts) implemented by the same gateway; contact channel data (email/phone/whatsapp/telegram) SHALL be usable to seed the customer registry.

#### Scenario: Onboarding imports contacts
- **WHEN** onboarding runs for BP X
- **THEN** each directory contact with an email or phone yields an `agent_customer_contacts` row of the matching channel type

### Requirement: Ticketing operations behind a port
Ticket listing (incremental via the portal's `updatedAfter` filter from change 00, cursor persisted per instance, inclusive `>=` paginated drain), thread reads (`getThread ?visibility=public`), public replies, and status changes SHALL go through `TicketingPort` implemented by the gateway.

#### Scenario: Polling detects a new external reply
- **WHEN** a customer adds a reply to ticket T between polls
- **THEN** the next `listChangedTickets` call surfaces T and the new thread entry is emitted for ingestion exactly once
