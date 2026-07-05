// EZY Portal adapter barrel. Wired to ports only in composition roots
// (src/main.ts, scripts/onboard-customer.ts) — never imported by core (D1).
export { EzyPortalGateway } from './ezy-portal.gateway';
export { EzyPortalHttpClient, EzyHttpError } from './http-client';
export { buildEzyPortalGateway } from './factory';
