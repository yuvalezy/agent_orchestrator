// Portal UI URL formatters (ADAPTER-shared). Lives here — not in an adapter that
// owns a transport — because TWO unrelated adapters need the identical string: the
// console (task links on decisions/timeline rows) and the EZY gateway (the `url` on
// a freshly-created TaskRef, which the Telegram confirmation renders). Importing the
// console's router into the gateway would drag express + the whole console
// composition into the portal adapter, so the helper moved down to `adapters/shared`
// (alongside retry.ts) and both call sites import it. Core never imports this — a
// TaskRef's url is produced HERE and threaded through as data (D1).
//
// ⚠ The base is EZY_PORTAL_BASE_URL, which is BOTH the portal-business API base and
// the UI origin (nginx routes /api/* to the services and everything else to the
// frontend). That is why the gateway can derive a UI link from its own http client's
// baseUrl. Under the localhost DEFAULT (:5040 = the Go API, which serves no UI) the
// link is not browsable — a pre-existing property of the console's links too, not a
// regression introduced here.

/** Build a portal UI URL from a mirrored task reference; this never contacts the portal. */
export function portalTaskUrl(portalBaseUrl: string | null, taskRef: unknown): string | null {
  if (!portalBaseUrl || typeof taskRef !== 'string' || !taskRef.trim() || taskRef.length > 200) return null;
  return `${portalBaseUrl.replace(/\/+$/, '')}/projects/tasks/${encodeURIComponent(taskRef)}`;
}

/**
 * The same link in the shape TriageDeps.deepLink asks for (`string | undefined`). The two triage
 * factories bind their `deepLink` to this: each had hand-rolled its own template literal and both
 * had drifted off the canonical builder above (no trailing-slash trim, no encoding, and a
 * "${undefined}/projects/tasks/…" string instead of no link at all when the base is unset).
 *
 * The null→undefined bridge lives HERE, in the adapter layer, rather than widening the core port
 * to accept null: "no link" is already spelled `undefined` on the port, and portalTaskUrl already
 * spells it `null` for its own callers. One place converts.
 */
export function taskDeepLink(portalBaseUrl: string | null, taskRef: string): string | undefined {
  return portalTaskUrl(portalBaseUrl, taskRef) ?? undefined;
}
