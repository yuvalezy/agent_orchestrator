import { logger } from '../../logger';
import type {
  GroupSummaryPort,
  GroupSummary,
  GroupImageRef,
  GroupMedia,
} from '../../ports/group-summary.port';
import { WhatsAppHttp } from './http';
import { WhatsAppDirectoryClient, type WaGroupEntry } from './directory-client';

// GroupSummaryAdapter (M2) — the single adapter behind GroupSummaryPort. HTTP-only
// bridge to whatsapp_manager (invariant #5: never its DB). Keyed exactly like the
// rest of the WA edge: summarize is a WRITE (postJson → write key, scoped to
// POST /messages/:id/summarize); thread-read + media fetch are READS (getJson /
// getBytes → read key). NEVER logs a message body or image bytes.

/** POST /messages/:id/summarize → 201 {data:{...}} (only the fields we read). */
interface SummarizeResponse {
  data?: {
    id?: number;
    title?: string | null;
    body?: string | null;
    image_count?: number | null;
    message_count?: number | null;
  } | null;
}

/** One GET /messages/:groupId thread row (only the media-filter fields we read).
 *  The endpoint returns a raw newest-first ARRAY (verified contract); we also
 *  tolerate a {data:[...]} envelope defensively. */
interface ThreadRow {
  id: number;
  message_id?: string;
  media_type?: string | null;
  media_status?: string | null;
  media_mimetype?: string | null;
  timestamp?: string | null;
}

/** Media types that are image-like enough to attach to a task. */
const IMAGE_MEDIA_TYPES = new Set(['image', 'sticker']);
/** How many thread rows to page for image enumeration (no time-window GET exists —
 *  page generously, then client-filter by timestamp). */
const THREAD_PAGE_LIMIT = 100;
/** Short-TTL cache for listGroups() (plan risk: the set can grow → one call per
 *  summarize would be wasteful). */
const GROUPS_TTL_MS = 60_000;

/** content-type → a sensible file extension (defaults to bin). */
function extForMime(mime: string): string {
  const m = mime.split(';')[0]?.trim().toLowerCase() ?? '';
  switch (m) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    default:
      return 'bin';
  }
}

export class GroupSummaryAdapter implements GroupSummaryPort {
  private groupsCache?: { at: number; groups: WaGroupEntry[] };

  constructor(
    private readonly http: WhatsAppHttp,
    private readonly directory: WhatsAppDirectoryClient,
    /** whatsapp_manager base url — used ONLY to form the keyless media reference
     *  url (mediaUrl); the actual fetch presents the key via an x-api-key header. */
    private readonly baseUrl: string,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async resolveGroupBpRef(groupId: string): Promise<string | null> {
    const groups = await this.listGroupsCached();
    const match = groups.find((g) => g.group_id === groupId);
    return match?.ezy_bp_id ?? null;
  }

  async summarizeLastHour(groupId: string): Promise<GroupSummary | null> {
    try {
      // WRITE key (scoped to POST ^/messages/\d+/summarize$). Body {amount,unit}.
      const res = await this.http.postJson<SummarizeResponse>(
        `/messages/${encodeURIComponent(groupId)}/summarize`,
        { amount: 1, unit: 'hours' },
      );
      const d = res?.data;
      const title = d?.title ?? '';
      const body = d?.body ?? '';
      if (!d || (!title && !body)) {
        logger.info({ groupId }, 'group summarize: no content');
        return null;
      }
      return { title, body, imageCount: d.image_count ?? 0 };
    } catch (err) {
      // null on failure (plan): the caller skips the row rather than crashing the
      // batch. reason is a short non-body string.
      logger.warn({ groupId, reason: (err as Error)?.message }, 'group summarize failed');
      return null;
    }
  }

  async listRecentImages(groupId: string, sinceMinutes: number): Promise<GroupImageRef[]> {
    const raw = await this.http.getJson<ThreadRow[] | { data: ThreadRow[] }>(
      `/messages/${encodeURIComponent(groupId)}?limit=${THREAD_PAGE_LIMIT}`,
    );
    const rows: ThreadRow[] = Array.isArray(raw) ? raw : (raw?.data ?? []);
    const cutoff = Date.now() - sinceMinutes * 60_000;
    return rows
      .filter(
        (r) =>
          !!r.media_type && IMAGE_MEDIA_TYPES.has(r.media_type) && r.media_status === 'downloaded',
      )
      .filter((r) => {
        if (!r.timestamp) return true; // keep when we can't place it in time
        const t = new Date(r.timestamp).getTime();
        return Number.isNaN(t) ? true : t >= cutoff;
      })
      .map((r) => ({ ref: String(r.id), mimeType: r.media_mimetype ?? undefined }));
  }

  async fetchMedia(ref: string): Promise<GroupMedia> {
    // READ key. GET /messages/:id/media → binary body + Content-Type header.
    const { bytes, contentType } = await this.http.getBytes(
      `/messages/${encodeURIComponent(ref)}/media`,
    );
    return { bytes, contentType, filename: `wa-media-${ref}.${extForMime(contentType)}` };
  }

  mediaUrl(ref: string): string {
    // KEYLESS by design (see GroupSummaryPort.mediaUrl) — never embed the api_key.
    return `${this.baseUrl}/messages/${encodeURIComponent(ref)}/media`;
  }

  private async listGroupsCached(): Promise<WaGroupEntry[]> {
    const now = Date.now();
    if (this.groupsCache && now - this.groupsCache.at < GROUPS_TTL_MS) {
      return this.groupsCache.groups;
    }
    const groups = await this.directory.listGroups();
    this.groupsCache = { at: now, groups };
    return groups;
  }
}
