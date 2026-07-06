// Group-summary port (M2 muted-group @-mention feature). Adapter-free contract:
// the muted-group triage branch depends ONLY on this shape; the whatsapp_manager
// GroupSummaryAdapter implements it. No runtime code / no imports (D1 — a port is
// a pure type surface, like the other src/ports/* modules).
//
// The founder is in several WhatsApp groups, some muted on purpose. When a muted
// group @-mentions the founder, the orchestrator pulls the group's last hour,
// asks whatsapp_manager to summarize it (its OWN vision model reads the images —
// no orchestrator-side vision), triages the summary TEXT, and attaches the raw
// last-hour images to the created task.

/** whatsapp_manager's last-hour summary of a group (its vision model saw the
 *  images; only the TEXT crosses into triage). */
export interface GroupSummary {
  title: string;
  body: string;
  imageCount: number;
}

/** A reference to one downloadable media item. `ref` is the numeric media PK as a
 *  string (→ GET /messages/{ref}/media). */
export interface GroupImageRef {
  ref: string;
  mimeType?: string;
}

/** Fetched media bytes + the content-type/filename to forward to an attachment. */
export interface GroupMedia {
  bytes: Uint8Array;
  contentType: string;
  filename: string;
}

export interface GroupSummaryPort {
  /** Map a WhatsApp group id → its linked EZY BP ref (via the directory), or null
   *  when the group is not linked to a BP. */
  resolveGroupBpRef(groupId: string): Promise<string | null>;
  /** Summarize the group's last hour. Returns null on no-content or failure (the
   *  caller then skips the row) — never throws for a summarize miss. */
  summarizeLastHour(groupId: string): Promise<GroupSummary | null>;
  /** Enumerate downloaded image/sticker media from the last `sinceMinutes` of the
   *  group thread (newest-first), for best-effort attach / founder reference. */
  listRecentImages(groupId: string, sinceMinutes: number): Promise<GroupImageRef[]>;
  /** Fetch one media item's raw bytes (+ a content-type/filename) by ref. */
  fetchMedia(ref: string): Promise<GroupMedia>;
  /** A founder-facing REFERENCE url for a media item. SECRECY (plan risk #1): this
   *  deliberately does NOT embed the read api_key — the real fetch requires the key
   *  in an `x-api-key` HEADER, and a keyed query URL would leak the secret if it
   *  reached Telegram. This returns only a keyless path form; following it without
   *  the key 401s. Never put an api-keyed media URL in a notification. */
  mediaUrl(ref: string): string;
}
