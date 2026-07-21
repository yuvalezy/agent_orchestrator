# agent-orchestrator

A production-oriented chief-of-staff service for a solo founder. It ingests customer
conversations from Gmail, WhatsApp, and EZY Portal, enriches them with customer and
project context, uses routed LLMs to triage and draft actions, and keeps delivery,
scheduling, decisions, reminders, knowledge, and follow-up work durable in Postgres.

The service includes two founder surfaces: an operations console in `web/` and the
AO Founder PWA in `app/`. See `docs/plan/project.md` for the architecture invariants
and `docs/plan/blueprints/` for feature-level decisions.

## Architecture

- Core domains (`inbox`, `triage`, `customers`, `outbound`, `decisions`,
  `knowledge`, `scheduling`, `query`) depend on port interfaces, not adapters.
- Adapters for Gmail, Google Calendar, WhatsApp Manager, EZY Portal, Telegram,
  LLM providers, the console, and the founder app are composed at the application edge.
- All inbound work lands in `agent_inbox`; all customer-facing delivery goes through
  `agent_outbound_queue`. Workers claim durable rows with `FOR UPDATE SKIP LOCKED`.
- Channel instances are data, not enums. Adding an account or provider does not
  require a channel-type schema migration.
- Message content and credentials must never be logged. Database references remain
  opaque to the core domain.

The import boundary is enforced by ESLint and the fail-closed `lint:boundary` check.

## Prerequisites

- Node.js 20 or newer
- Docker, for the dedicated development Postgres and mandatory database tests
- Provider credentials for whichever connectors are enabled

The development database is a dedicated pgvector/Postgres instance defined in
`docker-compose.db.yml` and published on `localhost:55432` by default.

## Local setup

```bash
cp .env.example .env
docker compose -f docker-compose.db.yml up -d
npm install
npm run db:create
npm run migrate
npm run dev
```

The API listens on `http://localhost:3100` by default. Migrations also run during
normal service startup. The migration runner serializes concurrent replicas, records
SHA-256 checksums, rejects edited history, and requires unique versions for new files.

For a containerized application process:

```bash
docker compose -f docker-compose.db.yml up -d
docker compose up --build
```

## Operational endpoints

- `GET /health` — public liveness/readiness report with database, queue-age, and
  worker-runtime state; returns 503 when a critical dependency or worker is unhealthy.
- `/console` — password/session-protected founder operations console.
- `/app` — device-authenticated AO Founder PWA.
- `/admin` — API-key-protected administration API when `ADMIN_API_KEY` is configured.
- `/webhooks/whatsapp` — raw-body, signature-verified WhatsApp webhook receiver.

Only configured surfaces are mounted. Review `.env.example` for connector flags,
credentials, limits, and safe defaults.

## Development commands

| Command | Purpose |
|---|---|
| `npm run dev` | Run the server with `tsx` watch mode |
| `npm run migrate` | Apply immutable forward-only migrations |
| `npm run typecheck` | Type-check the backend |
| `npm run lint` | Run ESLint and architecture rules |
| `npm run lint:boundary` | Prove the core-to-adapter import guard fails closed |
| `npm test` | Run backend unit and local integration tests |
| `npm run test:containers` | Run mandatory disposable-Postgres concurrency tests |
| `npm run build` | Build the backend and copy SQL migrations |
| `npm run build:console` | Build the founder operations console |
| `npm run build:app` | Build the AO Founder PWA |
| `npm run ci` | Run all typechecks, lints, tests, database tests, and builds |

Additional operational and reconciliation commands are listed in `package.json`.

## Repository layout

```text
src/main.ts          composition root
src/app.ts           Express application factory
src/config/          validated environment and runtime settings
src/db/              pool, migration runner, and migrations
src/ports/           external-system interfaces
src/adapters/        provider and UI adapters
src/workers/         bounded worker execution and health registry
src/health/          readiness, backlog, and operational state
src/{domain}/        core domain services and repositories
web/                 founder operations console
app/                 AO Founder PWA
scripts/             onboarding, reconciliation, backfill, and smoke tools
```
