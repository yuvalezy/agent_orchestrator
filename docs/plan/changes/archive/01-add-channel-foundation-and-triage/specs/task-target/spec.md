# task-target — Spec Delta

## ADDED Requirements

### Requirement: Task destination behind a port with opaque refs
All work-management operations SHALL go through `TaskTargetPort` (createTask, addComment, findOpenTasks, listWorkItemTypes, setStatus). Core SHALL store returned refs as opaque strings; only the adapter maps them to EZY Portal UUIDs and URLs.

#### Scenario: Target swap
- **WHEN** a hypothetical future adapter implements `TaskTargetPort` for a different system
- **THEN** triage, bridging, and notifications compile and run against it without modification

### Requirement: EZY Portal adapter contract
The EZY adapter SHALL call `POST /api/projects/tasks` including `projectId`, a valid `workItemTypeId` (from customer config, validated at onboarding), and the source fields `sourceService='agent-orchestrator'`, `sourceEntityType=<channel type>`, `sourceEntityId=<thread key>`, `sourceDisplay`, `sourceUrl`; comments via `POST /api/projects/tasks/:id/comments`; open-task queries via list filters (`status`, `projectId`, `sourceService/Type/Id`, `search`). Auth SHALL use the scoped `ten_` API key; retriable failures (5xx/429) SHALL be retried with backoff and idempotency preserved.

#### Scenario: Task traceable back to its conversation
- **WHEN** a task is created from a WhatsApp group message
- **THEN** querying the portal task list with `sourceService=agent-orchestrator&sourceEntityId=<group id>` returns it

#### Scenario: Missing work item type is impossible at runtime
- **WHEN** `createTask` is invoked for an onboarded customer
- **THEN** the payload always carries the customer's validated `workItemTypeId` and the portal does not return 422

### Requirement: Customer directory behind a port
BP and contact lookups SHALL go through `CustomerDirectoryPort` (getCustomer, searchCustomers, listContacts) implemented by the same gateway; contact channel data (email/phone/whatsapp/telegram) SHALL be usable to seed the customer registry.

#### Scenario: Onboarding imports contacts
- **WHEN** onboarding runs for BP X
- **THEN** each directory contact with an email or phone yields an `agent_customer_contacts` row of the matching channel type

### Requirement: Ticketing operations behind a port
Ticket listing (incremental via the portal's `updatedAfter` filter from change 00, cursor persisted per instance), thread reads, public replies, and status changes SHALL go through `TicketingPort` implemented by the gateway.

#### Scenario: Polling detects a new external reply
- **WHEN** a customer adds a reply to ticket T between polls
- **THEN** the next `listChangedTickets` call surfaces T and the new thread entry is emitted for ingestion exactly once
