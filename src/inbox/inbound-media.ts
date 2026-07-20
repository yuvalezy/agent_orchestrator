import type { LlmImage } from '../ports/llm.port';

// M-vision: a PURE, injected loader that turns ONE inbound WhatsApp media descriptor into the
// LlmImage[] the triage extractor reads. The fetch + gate are INJECTED (D1: this core module
// never imports an adapter) so triage.service can wire it with the real whatsapp_manager media
// fetch. Best-effort by contract: any gate miss OR fetch error yields [] — triage must always be
// able to proceed text-only. NEVER logs or persists the bytes (fetched transiently, base64-encoded
// in place, handed back to the caller as image blocks).

/** Fetch one media ref → its raw bytes + content type, or null when unavailable. Injected by the
 *  caller — reuse GroupSummaryPort.fetchMedia (drop `filename`) or WhatsAppHttp.getBytes(waMediaPath(ref)). */
export type InboundMediaFetch = (ref: string) => Promise<{ bytes: Uint8Array; contentType: string } | null>;

/** The only gate value the loader needs: the max declared filesize (bytes) it will fetch. */
export interface ScreenshotGate {
  maxBytes: number;
}

// The image mimetypes a vision model accepts (Anthropic image blocks). A media descriptor with
// any other mimetype (audio/video/document) is NOT a screenshot → dropped, never fetched.
const IMAGE_MIMETYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/**
 * Decode ONE inbound message's media descriptor into image blocks for the extractor. Returns []
 * (never throws) unless ALL hold: mediaType is an image, mimetype is a supported image type, status
 * is 'downloaded' (whatsapp_manager already has the bytes), and the declared filesize is within the
 * gate. On a pass it fetches the bytes via `fetch(ref)` and base64-encodes them into a single-element
 * LlmImage[]. Any fetch failure (throw OR null OR empty) degrades to [] so triage proceeds text-only.
 */
export async function loadInboundScreenshots(
  input: { ref: string; mediaType?: string | null; mimetype?: string | null; status?: string | null; filesize?: number | null },
  fetch: InboundMediaFetch,
  gate: ScreenshotGate,
): Promise<LlmImage[]> {
  const mimetype = input.mimetype?.toLowerCase() ?? '';
  const passesGate =
    input.mediaType?.toLowerCase() === 'image' &&
    IMAGE_MIMETYPES.has(mimetype) &&
    input.status === 'downloaded' &&
    input.filesize != null &&
    input.filesize <= gate.maxBytes;
  if (!passesGate) return [];

  let fetched: { bytes: Uint8Array; contentType: string } | null;
  try {
    fetched = await fetch(input.ref);
  } catch {
    return []; // best-effort: a media-fetch failure NEVER blocks triage
  }
  if (!fetched || fetched.bytes.length === 0) return [];

  // Use the gated (validated) mimetype for the block, not the fetched content-type — it already
  // cleared IMAGE_MIMETYPES, so it is a type the vision model accepts.
  return [{ mediaType: mimetype, dataBase64: Buffer.from(fetched.bytes).toString('base64') }];
}
