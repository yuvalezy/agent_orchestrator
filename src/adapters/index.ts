// Adapter barrel — intentionally empty in M1.1. Real adapters
// (WhatsAppManagerAdapter, EmailChannelAdapter, ServiceDeskAdapter,
// EzyPortalGateway, TelegramNotifier, LlmRouter) land here starting M1.2/M1.3/M1.4
// and are wired only in src/main.ts (D1 — the composition root).
//
// This module also serves as the resolvable target of the D1 import-boundary
// regression fixture (src/inbox/__illegal_import_fixture__.ts):
// import/no-restricted-paths only fires on imports that RESOLVE to a real file in
// the `from` zone, so this barrel must exist for `npm run lint:boundary` to flag
// the illegal import. See src/adapters/README.md.
export {};
