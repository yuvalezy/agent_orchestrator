# founder-operations-console — Spec Delta

## ADDED Requirements

### Requirement: Private same-origin founder console
The system SHALL serve one responsive React/Vite founder console at `/console`, including its mobile-browser layout, only when valid console application secrets are configured. Production deployment SHALL expose it only over Tailscale Serve/MagicDNS HTTPS; it SHALL not require or create a public listener, tunnel, or port-forward. Installable/offline PWA capability is deferred to a future change.

#### Scenario: Secrets are absent
- **WHEN** either required console secret is absent or invalid at boot
- **THEN** the console API and static route are not mounted, while the existing public `/health` endpoint retains its Docker health-check behavior

#### Scenario: Founder opens the console from an enrolled device
- **WHEN** the founder reaches `/console` through the tailnet and authenticates
- **THEN** the same application supplies the desktop operations view and the responsive mobile view without a separate frontend

### Requirement: Defense-in-depth session access
The console SHALL require an authenticated opaque server-side session in addition to the tailnet transport. Sessions SHALL use Secure HttpOnly SameSite cookies, expire after the configured TTL or process restart, be regenerated on login, and require a CSRF token for every state-changing request. All console API responses SHALL use `Cache-Control: no-store`.

#### Scenario: Cross-site mutation attempt
- **WHEN** a browser sends a console mutation with a valid session cookie but no valid CSRF token
- **THEN** the request is rejected and no database row or audit event is changed

### Requirement: Read-first bounded operations data
The console SHALL provide overview, worker health, inbox, outbound, customers/timelines, decisions, local task links, LLM costs, and local sync-freshness views through parameterized APIs with default cursor page size 50 and maximum 100. Lists SHALL use deterministic ordering and metadata-only search.

#### Scenario: Queue browsing
- **WHEN** the founder filters the inbox by failed status
- **THEN** the response returns at most the requested bounded page in deterministic order and contains no message body, provider payload, credential, or unrestricted raw metadata

### Requirement: Sensitive content appears only on deliberate detail reveal
The console SHALL return message `body`, decision `agent_output`, and any curated diagnostic content only from explicit authorized detail endpoints. It SHALL not include those fields in list payloads, search payloads, application logs, audit records, error responses, telemetry, or PWA caches.

#### Scenario: List response inspection
- **WHEN** the founder loads an inbox, outbound, or decision list
- **THEN** the browser receives only metadata required for the row and must request the selected record’s detail separately to display sensitive content

### Requirement: Accurate worker registration state
The worker-health view SHALL distinguish registered-but-idle, healthy, failing/backing-off, and not-registered states. A not-registered worker SHALL include a safe reason such as feature flag off, missing configuration, or no ready channel instance. Worker failure reporting SHALL use an allowlisted safe category/message and SHALL NOT expose or log a raw exception message from an upstream dependency.

#### Scenario: Outbound kill switch is off
- **WHEN** `OUTBOUND_ENABLED` is disabled and no outbound drainer is registered
- **THEN** the worker-health view shows it as not registered due to the kill switch, not as a silently failed worker

#### Scenario: Upstream dependency returns sensitive error text
- **WHEN** a worker dependency returns an error response containing customer data
- **THEN** neither `/health`, the console, nor worker logs return that response text; they expose only the projected safe failure category

### Requirement: Local-only customer history and task status
Customer timelines and task status views SHALL be assembled from the orchestrator’s local database only. The console SHALL label mirrored task state as cached and may deep-link to the portal, but SHALL not live-query the portal or any other external system from the UI request path.

#### Scenario: Customer timeline
- **WHEN** the founder opens a customer timeline
- **THEN** inbox, decision, outbound, and local task-link events are merged deterministically from local records and portal navigation uses a deep link

### Requirement: Safe operational corrections
The console SHALL support only these v1 mutations: requeue an inbox row from terminal `failed` to `pending` with retry count reset, and cancel a non-draft outbound row from `approved` to `cancelled`. Each mutation SHALL be conditional, transactional, CSRF-protected, and recorded in immutable safe audit metadata.

#### Scenario: Requeue races with a worker
- **WHEN** the founder tries to requeue a failed inbox item after another actor has already changed its status
- **THEN** the console returns `409 Conflict`, makes no additional change, and tells the founder to refresh the row

#### Scenario: Ambiguous delivery cannot be resent
- **WHEN** an outbound row is `sending`, `sent`, or in a possibly-delivered failure state
- **THEN** the console exposes no cancel or resend action and no state-changing endpoint accepts the request

### Requirement: Responsive mobile console; PWA deferred
The console SHALL provide responsive mobile operations views. Installable/offline PWA support is deferred to a future approved change and SHALL not be implied by the presence of a notification-only service worker.

#### Scenario: Founder opens the console on a mobile browser
- **WHEN** the founder opens `/console` from an enrolled mobile browser
- **THEN** the responsive UI remains usable without relying on install or offline caching

### Requirement: Optional push and cross-surface convergence
When web push is enabled, the system SHALL use a `FounderNotifierPort` implementation and keep Telegram as the default founder notification surface. A decision made in Telegram or the console SHALL target the same persisted decision/queue state; the first successful action wins and a subsequent action is a no-op.

#### Scenario: Telegram resolves an app-visible decision first
- **WHEN** the founder resolves a decision in Telegram and then opens the corresponding console action
- **THEN** the console refreshes to the handled state and cannot create a duplicate task, queue mutation, or notification

## REMOVED Requirements

### Requirement: Separate mobile handoff frontend
**Reason:** The former mobile-inbox-only plan is superseded by one responsive founder operations console. A separate mobile frontend SHALL NOT be created.
