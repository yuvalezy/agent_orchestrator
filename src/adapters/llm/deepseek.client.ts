import { OpenAiCompatibleClient } from './openai-compatible';

// DeepSeek provider (DM4-4). OpenAI-compatible, but only json_object mode (NO
// schema enforcement) — the schema is embedded in the prompt and validated
// client-side (zod). Therefore DeepSeek is the LAST link in the fallback chain
// (DA: prompt-only schema is the flakiest). Base has no /v1 in DeepSeek's URL
// convention; append /chat/completions works against the root.
export function buildDeepSeekClient(resolveKey: () => string | undefined, baseUrl: string, fetchImpl?: typeof fetch) {
  return new OpenAiCompatibleClient({
    provider: 'deepseek',
    baseUrl, // e.g. https://api.deepseek.com
    resolveKey,
    structuredMode: 'json_object',
    fetchImpl,
  });
}
