// The console read models (console-repo.ts / console-urgency-repo.ts) return snake_case
// columns because the console frontend consumes snake_case. The AO Founder app's contract
// is camelCase (blueprint v2), so cockpit endpoints that REUSE those SQL functions (DRY —
// never fork the query) transform only the PRESENTATION here at the app boundary.

function toCamel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/**
 * Recursively convert object keys from snake_case to camelCase. Values are untouched
 * (Dates/strings/numbers pass through — res.json serializes a pg Date to an ISO string).
 * Nested objects (e.g. a timeline row's `metadata` jsonb) are converted too, so the whole
 * response is uniformly camelCase.
 */
export function camelizeDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelizeDeep);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [toCamel(k), camelizeDeep(v)]),
    );
  }
  return value;
}
