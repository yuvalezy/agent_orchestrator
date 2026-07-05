# agent-orchestrator

Solo-founder chief-of-staff service: normalizes inbound customer messages
(WhatsApp via whatsapp_manager, Gmail ×2, EZY Portal service desk) into an inbox,
triages them into EZY Portal tasks/comments, and notifies the founder on
Telegram. This repo is the **M1.1 service skeleton** — DB schema, ports, worker
framework, `/health`, and the D1 import boundary. No channel adapters, LLM
router, or credentials store yet (those are M1.2+).

See the plan in `/mnt/dev/tools/yuval_dev_manager/plan/` (project invariants in
`project.md`, this milestone's contract in
`blueprints/M1.1-orchestrator-scaffold.md`).

## Architecture invariants (do not violate)

- **Ports & adapters (D1).** Core (`inbox`, `triage`, `customers`, `outbound`,
  `decisions`, `ports`) depends only on port interfaces in `src/ports/`. Adapters
  live in `src/adapters/` and are wired **only** in `src/main.ts`. Enforced by
  ESLint `import/no-restricted-paths` + the fail-closed `lint:boundary` guard.
- **Channels are pluggable instances, not enums.** No `CHECK (channel IN …)`
  anywhere; everything references `channel_instances(id)`. Adding a channel = new
  adapter + new row, zero schema change.
- **Own database.** Separate `agent_orchestrator` DB on the shared Postgres. Never
  reads/writes the whatsapp_manager DB — WhatsApp I/O is HTTP-only (D3).
- **Inbox pattern.** All inbound lands in `agent_inbox`; all outbound goes through
  `agent_outbound_queue`. Workers claim rows with `FOR UPDATE SKIP LOCKED`.
- **No message content in logs** — IDs and metadata only.
- **Opaque refs.** `bp_ref` / `project_ref` / `work_item_type_ref` / `task_ref`
  stay `TEXT`; core never parses them.

## Prerequisites

- Node ≥ 20
- The shared `ezy-postgres` running (via `/mnt/dev/tools/ops-dev`), host-published
  on **localhost:42016**.

## Boot (host)

```bash
cp .env.example .env          # defaults already target localhost:42016
npm install
npm run db:create             # one-off: CREATE DATABASE agent_orchestrator (idempotent)
npm run migrate               # apply migrations 001–008
npm run dev                   # tsx watch → http://localhost:3100/health
```

## Boot (docker)

```bash
npm run db:create             # DB bootstrap still runs from the host (localhost:42016)
docker compose up --build     # network_mode: host, binds :3100 directly
curl localhost:3100/health
```

`db:create` connects to the `postgres` maintenance DB to `CREATE DATABASE`; it is
idempotent. Migrations run automatically on every boot (`src/db/migrate.ts`,
tracked in `schema_migrations`).

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | `tsc` → `dist/`, then copy `*.sql` migrations into `dist/` |
| `npm run dev` | `tsx watch src/main.ts` |
| `npm run migrate` | apply pending migrations |
| `npm run db:create` | one-off `CREATE DATABASE agent_orchestrator` (idempotent) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (includes the D1 import-boundary rule over `src/`) |
| `npm run lint:boundary` | fidelity guard: lints `src/inbox/__illegal_import_fixture__.ts` (a real core dir) with the MAIN config via `--no-ignore`; **exit 0** when the `src/inbox→src/adapters` rule rejects it, **non-zero** if the rule ever stops firing (fail-closed). `lint`/`typecheck`/`build` exclude the fixture and stay green |

## `/health`

`GET /health` → 200 (`status:"ok"`) when the DB probe passes, 503
(`status:"degraded"`) when it fails (independently of backlog). Payload exposes
`backlog` (inbox + outbound queue `pending`/`failed`/`oldestPendingAgeSeconds` —
makes the R22 5-min SLA measurable) and `workers[]` (each worker's last run,
duration, error message, consecutive failures).

## Layout

```
src/
  main.ts            composition root (env → migrate → listen → workers → shutdown)
  app.ts             pure Express factory (/health)
  config/env.ts      zod-validated env (M1.1-scoped)
  db/                pool + forward-only SQL migration runner + migrations 001–008
  ports/             D1 port interfaces (channel, task-target, customer-directory,
                     ticketing, founder-notifier, llm, embedding) — no runtime code
  workers/           generic interval/backoff runner + registry + heartbeat + CLAIM_TEMPLATE.md
  health/            backlog queries + worker registry read
  inbox|triage|customers|outbound|decisions/   core domain placeholders (M1.2+)
  adapters/          outbound edge — empty until M1.2/M1.3/M1.4 (README documents the boundary)
```
