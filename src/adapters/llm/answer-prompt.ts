import { z } from 'zod';
import type { AnswerRequest, AnswerResult } from '../../ports/llm.port';

// The golden answer schema + prompt (M5(a), LLM role 'answer'). Mirrors draft-prompt.ts
// STRICT-output discipline (DA B3) so ONE schema works across Anthropic strict tool-use,
// OpenAI json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// Range/shape checks live in the zod validator, not the wire schema. The model answers
// ONLY from the numbered sources and reports the indexes it relied on — it NEVER emits
// free-text citations (the query engine renders those from our own sources).
//
// Unlike the customer DRAFT prompt (a reply a customer will read), this is a founder-
// facing internal Q&A: terse, factual, and honest about gaps. NEVER logs the question.

/** Strict-output-clean JSON schema for `{ answer: string, used_sources: number[] }`. */
export const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer', 'used_sources'],
  properties: {
    answer: { type: 'string' },
    used_sources: { type: 'array', items: { type: 'integer' } }, // 0-based indexes into the numbered sources
  },
} as const;

/** Zod validator — the shape guard the wire schema intentionally omits. */
const AnswerEnvelope = z.object({
  answer: z.string().min(1),
  used_sources: z.array(z.number().int()),
});

/** Validate a provider's structured output → typed AnswerResult. Throws on mismatch. */
export function parseAnswer(value: unknown): AnswerResult {
  const parsed = AnswerEnvelope.parse(value);
  return { body: parsed.answer, usedSourceIndexes: parsed.used_sources };
}

export const ANSWER_SYSTEM = [
  'You answer a question for a solo software founder from their own project /',
  'customer knowledge base. The founder is the reader — be terse, factual, and',
  'direct. This is an internal answer, not a customer-facing message.',
  '',
  'STRICT grounding: answer ONLY from the numbered [n] sources provided. Never invent',
  'facts, decisions, dates, or steps that are not in the sources. If the sources do',
  'not fully answer the question, say plainly what IS known and what is missing — do',
  'NOT fabricate to fill the gap.',
  '',
  'Return ONLY the structured object {"answer": "...", "used_sources": [n, ...]} where',
  'used_sources lists the 0-based indexes of the sources you actually relied on (empty',
  'if none applied). Do NOT put citation markers, source numbers, or a "Sources" list',
  'inside the answer text — the founder-facing citations are rendered separately from',
  'used_sources.',
].join('\n');

/** Serialize an AnswerRequest into the single user message (numbered [i] sources). */
export function answerUserMessage(req: AnswerRequest): string {
  const parts: string[] = [];
  parts.push('Question:', req.question);
  parts.push('', 'Sources (answer ONLY from these):');
  req.sources.forEach((s, i) => {
    parts.push(`[${i}] ${s.label || 'untitled'}`);
    parts.push(s.content);
  });
  return parts.join('\n');
}
