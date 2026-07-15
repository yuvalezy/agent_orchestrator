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

export interface OpenAiTranscriptionOptions {
  resolveKey: () => string | undefined;
  baseUrl: string;
  model?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function buildOpenAiTranscriptionClient(opts: OpenAiTranscriptionOptions): AudioTranscriptionPort {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl.replace(/\/$/, '');
  const model = opts.model ?? 'gpt-4o-mini-transcribe';
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return {
    async transcribe(input: AudioTranscriptionInput): Promise<string> {
      const key = opts.resolveKey();
      if (!key) throw new TranscriptionError('OpenAI transcription is not configured', false);

      const response = await withRetry(
        async () => {
          const form = new FormData();
          form.append('model', model);
          const bytes = new Uint8Array(input.data.byteLength);
          bytes.set(input.data);
          form.append('file', new Blob([bytes.buffer], { type: input.mimeType }), input.filename);
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
            logger.warn({ provider: 'openai', model, status: res.status, durationMs }, 'audio transcription failed');
            throw new TranscriptionError(`OpenAI transcription HTTP ${res.status}`, retryable, res.status, retryAfterMs);
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
