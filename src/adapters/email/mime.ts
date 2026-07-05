// Gmail MIME helpers (M1.6, pure). Parse a `messages.get(format=full)` payload
// into the best text body + headers/addresses. Gmail encodes body data as
// base64url (NOT base64). No adapter/db deps — unit-tested off fixtures.

export interface GmailPayload {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number };
  parts?: GmailPayload[];
}

export function decodeB64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

/** Case-insensitive header lookup. */
export function header(payload: GmailPayload, name: string): string | undefined {
  return payload.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Depth-first search for the first part of a mime type that carries body data.
 *  Starts at the ROOT (a single-part email has its body at payload.body.data with
 *  no `parts` — DA note 3), so the leaf case is covered. */
function findPart(p: GmailPayload, mime: string): GmailPayload | undefined {
  if ((p.mimeType ?? '').toLowerCase().startsWith(mime) && p.body?.data) return p;
  for (const part of p.parts ?? []) {
    const found = findPart(part, mime);
    if (found) return found;
  }
  return undefined;
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best text body: prefer text/plain, else stripped text/html, else null. */
export function extractText(payload: GmailPayload): string | null {
  const plain = findPart(payload, 'text/plain');
  if (plain?.body?.data) return decodeB64Url(plain.body.data).trim() || null;
  const html = findPart(payload, 'text/html');
  if (html?.body?.data) return stripHtml(decodeB64Url(html.body.data)) || null;
  return null;
}

/** One address value → bare lowercased email, or null. */
export function parseOneAddress(value: string): string | null {
  const m = value.match(/<([^>]+)>/);
  const email = (m ? m[1] : value).trim().toLowerCase();
  return email.includes('@') ? email : null;
}

/** "Name <a@b>, c@d" → ['a@b','c@d']. */
export function parseAddresses(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(',').map(parseOneAddress).filter((e): e is string => e !== null);
}
