import { z } from 'zod';
import type { DraftRequest, DraftResult } from '../../ports/llm.port';

// The golden draft schema + prompt (change 02 sub-milestone c, LLM role 'draft').
// STRICT-output clean (DA B3) so ONE schema works across Anthropic strict tool-use,
// OpenAI json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// Range/shape checks live in the zod validator, not the wire schema. The model
// answers ONLY from the numbered sources and reports the indexes it relied on — it
// NEVER emits free-text citations (the drafter renders those from our own chunks).

/** Strict-output-clean JSON schema for `{ reply: string, used_sources: number[] }`. */
export const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'used_sources'],
  properties: {
    reply: { type: 'string' },
    used_sources: { type: 'array', items: { type: 'integer' } }, // 0-based indexes into the numbered sources
  },
} as const;

/** Zod validator — the shape guard the wire schema intentionally omits. */
const DraftEnvelope = z.object({
  reply: z.string().min(1),
  used_sources: z.array(z.number().int()),
});

/** Validate a provider's structured output → typed DraftResult. Throws on mismatch. */
export function parseDraft(value: unknown): DraftResult {
  const parsed = DraftEnvelope.parse(value);
  return { body: parsed.reply, usedSourceIndexes: parsed.used_sources };
}

export const DRAFT_SYSTEM = [
  'You draft a reply to one customer message for a solo software founder. The reply',
  'is a DRAFT the founder reviews before it is ever sent — be helpful, concise, and',
  'accurate.',
  '',
  'STRICT grounding: answer ONLY from the numbered [n] knowledge sources provided.',
  'Never invent facts, URLs, prices, or steps that are not in the sources. If the',
  'sources do not fully answer the question, say what IS known and that you will',
  'follow up — do not fabricate.',
  '',
  'CITE-OR-ABSTAIN (this is critical). Assert a product capability, feature,',
  'integration, price, limit, or fact ONLY when it is explicitly present in the',
  'numbered sources. When the customer asks whether we support / offer / integrate',
  'with something and NO source confirms it exists, you MUST ABSTAIN — do NOT claim',
  'it exists and do NOT invent one. Instead say we do not currently offer that (or',
  'that you are not certain and will confirm with the founder). Absence of a source',
  'is NOT evidence a capability exists — never fabricate a feature or integration to',
  'be helpful. When in doubt, defer to the founder rather than assert.',
  '',
  'VOICE & TONE GUIDANCE (when a "Persistent voice & tone guidance" section is present):',
  'those lines are STANDING directives about HOW to write for this customer — warmth,',
  'formality, greeting, sign-off, length, persona. Apply them to the wording and tone of',
  'the reply. They are NOT knowledge sources and NOT facts: never treat a voice directive',
  'as evidence of a capability, never cite it, and NEVER list its number in used_sources',
  '(it has no source number). Grounding still comes ONLY from the numbered knowledge',
  'sources; voice guidance shapes phrasing, never content.',
  '',
  'Write the reply in the requested language. Return ONLY the structured object',
  '{"reply": "...", "used_sources": [n, ...]} where used_sources lists the 0-based',
  'indexes of the KNOWLEDGE sources you actually relied on (empty if none applied). Do NOT',
  'put citation markers, source numbers, or a "Based on" list inside the reply text —',
  'the founder-facing citations are rendered separately from used_sources.',
].join('\n');

/** Serialize a DraftRequest into the single user message (numbered [i] sources). */
export function draftUserMessage(req: DraftRequest): string {
  const parts: string[] = [];
  parts.push(`Reply language: ${req.language}`);
  parts.push(`Customer: ${req.customerName}`);
  parts.push('', 'Customer message:', req.question);
  // Always-on style lane: persistent voice/tone directives for this customer. A DISTINCT,
  // UN-numbered section (not a source) so the model can never cite it or fold it into used_sources.
  const voice = (req.voiceGuidance ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  if (voice.length > 0) {
    parts.push('', 'Persistent voice & tone guidance (HOW to write — directive, NOT a source, do NOT cite):');
    voice.forEach((g) => parts.push(`- ${g}`));
  }
  parts.push('', 'Knowledge sources (answer ONLY from these):');
  req.knowledge.forEach((k, i) => {
    const cite = [k.title, k.section].filter((s): s is string => !!s).join(' › ') || 'untitled';
    const route = k.route ? ` (${k.route})` : '';
    parts.push(`[${i}] ${cite}${route}`);
    parts.push(k.content);
  });
  return parts.join('\n');
}
