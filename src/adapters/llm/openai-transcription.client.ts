import { logger } from '../../logger';
import type { AudioTranscriptionInput, AudioTranscriptionPort } from '../../ports/audio-transcription.port';
import { DEFAULT_RETRY, withRetry } from '../shared/retry';

export class TranscriptionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'TranscriptionError';
  }
}

// OpenAI infers the audio container from the upload FILENAME's extension, not from
// the part's Content-Type. The gpt-4o transcribe models accept a NARROWER set than
// whisper-1 does — notably `.oga` is fine on whisper-1 but 400s on gpt-4o*, and
// Telegram names every voice note `file_<n>.oga`. So the raw Telegram filename must
// be rewritten to the mime type's canonical extension before upload.
const SUPPORTED_EXTENSIONS = new Set(['flac', 'm4a', 'mp3', 'mp4', 'mpeg', 'mpga', 'ogg', 'wav', 'webm']);

const MIME_EXTENSIONS: Record<string, string> = {
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
};

/** Rewrite `name` so its extension is one OpenAI accepts, preferring the mime type's
 *  canonical extension and leaving an already-supported extension untouched. */
export function normalizeAudioFilename(name: string, mimeType: string): string {
  const base = name.replace(/\.[^./\\]+$/, '') || 'audio';
  const current = /\.([^./\\]+)$/.exec(name)?.[1]?.toLowerCase();
  // `audio/ogg; codecs=opus` -> `audio/ogg`
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  const fromMime = MIME_EXTENSIONS[mime];
  if (fromMime) return `${base}.${fromMime}`;
  if (current && SUPPORTED_EXTENSIONS.has(current)) return name;
  return `${base}.ogg`;
}

/** Pull `error.message` out of an OpenAI error body, falling back to a raw snippet.
 *  Capped so a stray HTML error page cannot flood the log or a Telegram reply. */
function parseOpenAiErrorMessage(body: string): string {
  if (!body.trim()) return '';
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    const message = parsed.error?.message;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 300);
  } catch {
    // Not JSON — fall through to the raw snippet.
  }
  return body.trim().slice(0, 300);
}

export interface OpenAiTranscriptionOptions {
  resolveKey: () => string | undefined;
  baseUrl: string;
  /** Resolved per call, not captured at build: the model is settings-managed with
   *  applyMode 'live', so a console change must reach the next voice note without a
   *  restart. Mirrors the lazy `resolveKey`. */
  resolveModel?: () => string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The most accurate tier, deliberately — NOT the cheapest. A misheard name or time in a
 *  founder voice note flows into a scheduled CUSTOMER message, and the per-minute
 *  difference is noise next to the LLM calls that follow. */
export const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-transcribe';

export function buildOpenAiTranscriptionClient(opts: OpenAiTranscriptionOptions): AudioTranscriptionPort {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    async transcribe(input: AudioTranscriptionInput): Promise<string> {
      const key = opts.resolveKey();
      if (!key) throw new TranscriptionError('OpenAI transcription is not configured', false);

      // Per attempt, so a mid-flight settings change is picked up on the retry too.
      const model = opts.resolveModel?.() || DEFAULT_TRANSCRIBE_MODEL;
      const response = await withRetry(
        async () => {
          const form = new FormData();
          form.append('model', model);
          const bytes = new Uint8Array(input.data.byteLength);
          bytes.set(input.data);
          form.append(
            'file',
            new Blob([bytes.buffer], { type: input.mimeType }),
            normalizeAudioFilename(input.filename, input.mimeType),
          );
          const started = Date.now();
          const res = await fetchImpl(`${baseUrl}/audio/transcriptions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${key}` },
            body: form,
            signal: AbortSignal.timeout(timeoutMs),
          });
          const durationMs = Date.now() - started;
          if (!res.ok) {
            const retryAfter = Number(res.headers.get('retry-after'));
            const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;
            const retryable = res.status === 429 || res.status >= 500;
            // The body carries the only actionable detail (e.g. "Unsupported file
            // format oga"); without it a 400 reaches the user as a bare status code.
            const body = await res.text().catch(() => '');
            const detail = parseOpenAiErrorMessage(body);
            logger.warn(
              { provider: 'openai', model, status: res.status, durationMs, detail },
              'audio transcription failed',
            );
            throw new TranscriptionError(
              detail ? `OpenAI transcription HTTP ${res.status}: ${detail}` : `OpenAI transcription HTTP ${res.status}`,
              retryable,
              res.status,
              retryAfterMs,
            );
          }
          logger.info({ provider: 'openai', model, status: res.status, durationMs }, 'audio transcription ok');
          return (await res.json()) as { text?: unknown };
        },
        {
          ...DEFAULT_RETRY,
          isRetryable: (err) => !(err instanceof TranscriptionError) || err.retryable,
          retryAfterMs: (err) => err instanceof TranscriptionError ? err.retryAfterMs : undefined,
        },
      );
      const text = typeof response.text === 'string' ? response.text.trim() : '';
      if (!text) throw new TranscriptionError('OpenAI returned an empty transcription', false);
      return text;
    },
  };
}
