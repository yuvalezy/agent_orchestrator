import { OpenAiCompatibleClient } from './openai-compatible';

// OpenAI provider (DM4-4). Strict json_schema structured output — the provider
// ENFORCES the schema, so an OpenAI fallback is schema-guaranteed. Raw fetch.
export function buildOpenAiClient(resolveKey: () => string | undefined, baseUrl: string, fetchImpl?: typeof fetch) {
  return new OpenAiCompatibleClient({
    provider: 'openai',
    baseUrl, // e.g. https://api.openai.com/v1
    resolveKey,
    structuredMode: 'json_schema',
    supportsReasoningEffort: true, // reasoning models only; opt-in via LLM_OPENAI_EFFORT
    fetchImpl,
  });
}
