# `src/adapters/` — the outbound edge (D1)

Adapters implement the port interfaces in `src/ports/` against concrete external
systems. **Core domain modules (`inbox`, `triage`, `customers`, `outbound`,
`decisions`, `ports`) must never import anything from here** — this boundary is
the load-bearing hexagonal invariant (D1) and is enforced by the ESLint
`import/no-restricted-paths` rule in `eslint.config.mjs`. A committed negative
fixture (`src/inbox/__illegal_import_fixture__.ts`) lives in a real core dir, so
the MAIN config's own `src/inbox → src/adapters` zone rejects it: `npm run
lint:boundary` lints just that file with the main config via `--no-ignore` and
passes (exit 0) when the rule fires, failing (non-zero) if it ever stops
(fail-closed). `npm run lint` / `typecheck` / `build` exclude the fixture and stay
green.

Adapters are wired to ports **only** in `src/main.ts` (the composition root).

## Landing schedule

| Adapter | Port(s) | Milestone |
|---|---|---|
| `EzyPortalGateway` | `TaskTargetPort`, `CustomerDirectoryPort`, `TicketingPort` | M1.2 |
| `WhatsAppManagerAdapter` | `ChannelAdapter` | M1.3 |
| `EmailChannelAdapter` (`EmailProviderClient`: Gmail ×2) | `ChannelAdapter` | M1.3 |
| `ServiceDeskAdapter` | `ChannelAdapter` (+ `TicketingPort` for ops) | M1.3 |
| `TelegramNotifier` | `FounderNotifierPort` | M1.x |
| `LlmRouter` (Anthropic / OpenAI / DeepSeek) | `AgentLlmPort`, `LlmProviderClient` | M1.4 |

## Credentials note (DA ruling b)

Until M1.4 builds the sealed `credentials` store + resolver, M1.2's EZY key and
M1.3's WhatsApp credential resolve their `credentials_ref` **via env** (D10
env-fallback). Do not assume the sealed table exists before M1.4.

## `index.ts`

`index.ts` is an intentionally empty barrel. Besides marking the future adapter
surface, it is the resolvable target for the D1 boundary regression fixture — see
its header comment.
