import { logger } from '../../logger';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';
import type { EmailProviderClient, ProviderEmail } from '../../ports/channel.port';
import { extractText, header, parseAddresses, parseOneAddress, type GmailPayload } from './mime';

// GmailProviderClient (tasks.md 3.4) — raw fetch, no SDK. OAuth2 refresh-token →
// access token; History-API incremental pull with FULL pagination + a dynamic
// bootstrap window (DA R51 binding notes). Never logs body/token/headers.

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const OAUTH = 'https://oauth2.googleapis.com/token';
const BOOTSTRAP_CAP_MS = 30 * 24 * 3600_000; // never bootstrap further back than 30d
const FIRST_RUN_MS = 2 * 24 * 3600_000; // first-ever bootstrap window

interface OAuthCred {
  client_id: string;
  client_secret: string;
  refresh_token: string;
}
/** sync_cursor encodes both the historyId AND the last successful poll time (for a
 *  dynamic re-bootstrap window). */
interface EmailCursor {
  historyId?: string;
  lastPollMs?: number;
}

class HistoryExpired extends Error {}

export class GmailClient implements EmailProviderClient {
  private accessToken: string | null = null;
  private tokenExpiresMs = 0;

  constructor(
    private readonly resolveCred: () => string, // JSON {client_id,client_secret,refresh_token}
    private readonly nowMs: () => number = () => Date.now(),
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private cred(): OAuthCred {
    const c = JSON.parse(this.resolveCred()) as OAuthCred;
    if (!c.refresh_token) throw new Error('gmail credential missing refresh_token');
    return c;
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.nowMs() < this.tokenExpiresMs) return this.accessToken;
    const c = this.cred();
    const res = await this.fetchImpl(OAUTH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret, refresh_token: c.refresh_token, grant_type: 'refresh_token' }),
    });
    if (!res.ok) throw new Error(`gmail token refresh failed (${res.status})`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = j.access_token;
    this.tokenExpiresMs = this.nowMs() + (j.expires_in - 60) * 1000;
    return this.accessToken;
  }

  /** GET a Gmail API path. 401 → refresh once + retry; 404 → null; 429/5xx → retry. */
  private async get<T>(path: string, allow404 = false): Promise<T | null> {
    return withRetry(
      async () => {
        const res = await this.fetchImpl(`${GMAIL}${path}`, { headers: { Authorization: `Bearer ${await this.token()}` } });
        if (res.status === 401) {
          this.accessToken = null; // force refresh + retry
          throw new Error('gmail 401 (token) — retrying');
        }
        if (res.status === 404) {
          if (allow404) return null as T;
          throw new HistoryExpired('gmail 404'); // historyId too old
        }
        if (!res.ok) throw new Error(`gmail GET ${path.split('?')[0]} → ${res.status}`);
        return (await res.json()) as T;
      },
      { ...DEFAULT_RETRY, isRetryable: (e) => !(e instanceof HistoryExpired) },
    );
  }

  private async messageToEmail(id: string): Promise<ProviderEmail | null> {
    const m = await this.get<{ id: string; threadId: string; internalDate?: string; payload?: GmailPayload }>(
      `/messages/${id}?format=full`,
      true, // 404 (deleted between history + get) → skip (DA note 4)
    );
    if (!m?.payload) return null;
    const p = m.payload;
    return {
      id: m.id,
      threadId: m.threadId,
      from: parseOneAddress(header(p, 'From') ?? '') ?? header(p, 'From') ?? '',
      to: parseAddresses(header(p, 'To')),
      cc: parseAddresses(header(p, 'Cc')),
      subject: header(p, 'Subject'),
      bodyText: extractText(p),
      messageIdHeader: header(p, 'Message-ID'),
      inReplyTo: header(p, 'In-Reply-To'),
      references: header(p, 'References')?.split(/\s+/).filter(Boolean),
      sentAt: m.internalDate ? new Date(Number(m.internalDate)) : new Date(this.nowMs()),
      raw: m,
    };
  }

  async listChanges(cursor: string | null): Promise<{ messages: ProviderEmail[]; nextCursor: string }> {
    const parsed: EmailCursor = cursor ? (JSON.parse(cursor) as EmailCursor) : {};
    if (!parsed.historyId) return this.bootstrap(parsed.lastPollMs);
    try {
      return await this.incremental(parsed.historyId);
    } catch (err) {
      if (err instanceof HistoryExpired) {
        logger.warn('gmail: historyId expired — re-bootstrapping from last poll');
        return this.bootstrap(parsed.lastPollMs);
      }
      throw err;
    }
  }

  /** Bootstrap: capture the profile historyId BEFORE listing (dup-safe overlap),
   *  then list inbox since the persisted last poll (capped 30d) — DA R51 note 2. */
  private async bootstrap(lastPollMs?: number): Promise<{ messages: ProviderEmail[]; nextCursor: string }> {
    const now = this.nowMs();
    const profile = await this.get<{ historyId: string }>('/profile');
    const sinceMs = Math.max(lastPollMs ?? now - FIRST_RUN_MS, now - BOOTSTRAP_CAP_MS);
    const afterSec = Math.floor(sinceMs / 1000);
    const ids = await this.drainList(`/messages?q=${encodeURIComponent(`in:inbox after:${afterSec}`)}&maxResults=100`);
    const messages = await this.mapIds(ids);
    return { messages, nextCursor: JSON.stringify({ historyId: profile?.historyId, lastPollMs: now } satisfies EmailCursor) };
  }

  /** Incremental: paginate EVERY /history page (full drain) before advancing —
   *  DA R51 note 1 (a >1-page burst would otherwise drop pages 2+). */
  private async incremental(historyId: string): Promise<{ messages: ProviderEmail[]; nextCursor: string }> {
    const now = this.nowMs();
    const ids = new Set<string>();
    let latest = historyId;
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ startHistoryId: historyId, historyTypes: 'messageAdded', labelId: 'INBOX' });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = await this.get<{ history?: Array<{ messagesAdded?: Array<{ message: { id: string } }> }>; historyId?: string; nextPageToken?: string }>(
        `/history?${qs.toString()}`,
      );
      for (const h of page?.history ?? []) for (const a of h.messagesAdded ?? []) ids.add(a.message.id);
      if (page?.historyId) latest = page.historyId;
      pageToken = page?.nextPageToken;
    } while (pageToken);
    const messages = await this.mapIds([...ids]);
    return { messages, nextCursor: JSON.stringify({ historyId: latest, lastPollMs: now } satisfies EmailCursor) };
  }

  /** Drain a messages.list query across every nextPageToken page → ids. */
  private async drainList(path: string): Promise<string[]> {
    const ids: string[] = [];
    let pageToken: string | undefined;
    do {
      const sep = path.includes('?') ? '&' : '?';
      const page = await this.get<{ messages?: Array<{ id: string }>; nextPageToken?: string }>(
        pageToken ? `${path}${sep}pageToken=${pageToken}` : path,
      );
      for (const m of page?.messages ?? []) ids.push(m.id);
      pageToken = page?.nextPageToken;
    } while (pageToken);
    return ids;
  }

  private async mapIds(ids: string[]): Promise<ProviderEmail[]> {
    const out: ProviderEmail[] = [];
    for (const id of ids) {
      const email = await this.messageToEmail(id);
      if (email) out.push(email);
    }
    return out;
  }

  async getThread(threadId: string): Promise<ProviderEmail[]> {
    const t = await this.get<{ messages?: Array<{ id: string }> }>(`/threads/${threadId}?format=full`, true);
    return this.mapIds((t?.messages ?? []).map((m) => m.id));
  }

  /**
   * READ-ONLY search → the unique thread ids matching a Gmail query (e.g.
   * `from:acme.com OR to:acme.com`), capped at `maxThreads`. Gmail's messages.list
   * returns `threadId` per hit, so no per-message fetch is needed to group. Used by the
   * backfill history reader; NEVER mutates. Drains nextPageToken until the cap.
   */
  async searchThreadIds(query: string, maxThreads = 100): Promise<string[]> {
    const threadIds = new Set<string>();
    let pageToken: string | undefined;
    do {
      const qs = new URLSearchParams({ q: query, maxResults: '100' });
      if (pageToken) qs.set('pageToken', pageToken);
      const page = await this.get<{ messages?: Array<{ id: string; threadId: string }>; nextPageToken?: string }>(
        `/messages?${qs.toString()}`,
      );
      for (const m of page?.messages ?? []) threadIds.add(m.threadId);
      pageToken = page?.nextPageToken;
    } while (pageToken && threadIds.size < maxThreads);
    return [...threadIds].slice(0, maxThreads);
  }

  async send(input: { to: string; subject?: string; bodyText: string; threadId?: string; inReplyTo?: string; references?: string[] }): Promise<{ messageId: string }> {
    const lines = [`To: ${input.to}`, `Subject: ${input.subject ?? ''}`, 'Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0'];
    if (input.inReplyTo) lines.push(`In-Reply-To: ${input.inReplyTo}`);
    if (input.references?.length) lines.push(`References: ${input.references.join(' ')}`);
    const raw = Buffer.from(`${lines.join('\r\n')}\r\n\r\n${input.bodyText}`).toString('base64url');
    const res = await this.fetchImpl(`${GMAIL}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw, ...(input.threadId ? { threadId: input.threadId } : {}) }),
    });
    if (!res.ok) throw new Error(`gmail send → ${res.status}`);
    return { messageId: ((await res.json()) as { id: string }).id };
  }
}
