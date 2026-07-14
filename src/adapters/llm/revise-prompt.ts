import { z } from 'zod';
import type { ReviseRequest, ReviseResult } from '../../ports/llm.port';

// The revise schema + prompt (Draft correction loop, LLM role 'draft'). REUSES the golden
// draft envelope { reply, used_sources } so the SAME strict-output discipline holds across
// Anthropic strict tool-use, OpenAI json_schema strict, and DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// Range/shape checks live in the zod validator, not the wire schema. The model regenerates
// the reply from the numbered sources + the founder's authoritative correction and reports
// the source indexes it relied on — it NEVER emits free-text citations (the reviser renders
// those from our own chunks, like the drafter). NEVER logs bodies.

/** Strict-output-clean JSON schema for `{ reply: string, used_sources: number[] }` (== draft). */
export const REVISE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'used_sources'],
  properties: {
    reply: { type: 'string' },
    used_sources: { type: 'array', items: { type: 'integer' } }, // 0-based indexes into the numbered sources
  },
} as const;

/** Zod validator — the shape guard the wire schema intentionally omits. */
const ReviseEnvelope = z.object({
  reply: z.string().min(1),
  used_sources: z.array(z.number().int()),
});

/** Validate a provider's structured output → typed ReviseResult. Throws on mismatch. */
export function parseRevise(value: unknown): ReviseResult {
  const parsed = ReviseEnvelope.parse(value);
  return { body: parsed.reply, usedSourceIndexes: parsed.used_sources };
}

export const REVISE_SYSTEM = [
  'You are REVISING a draft reply to one customer message for a solo software founder.',
  'The founder reviewed your previous draft and gave a CORRECTION instruction. Produce a',
  'NEW draft the founder reviews before it is ever sent.',
  '',
  "The founder's instruction is AUTHORITATIVE — the founder is the human-in-the-loop and",
  'the source of truth about their own product. Apply the instruction faithfully and',
  'completely. If the founder says a capability, feature, or integration does NOT exist,',
  'the new draft MUST reflect that (state we do not currently offer it) and MUST NOT claim',
  'it exists anywhere.',
  '',
  'STRICT grounding for everything else: use ONLY the numbered [n] knowledge sources for',
  'customer-facing facts, and the truths stated in the instruction. Never invent a NEW',
  'capability, integration, price, URL, or step that is not in the sources AND not stated',
  'by the founder. CITE-OR-ABSTAIN: when a fact is not in the sources and the instruction',
  "does not settle it, abstain — say we don't currently offer that / you'll confirm — do",
  'NOT fabricate to be helpful. Absence of a source is NOT evidence a capability exists.',
  '',
  'VOICE & TONE GUIDANCE (when a "Persistent voice & tone guidance" section is present):',
  'those lines are STANDING directives about HOW to write for this customer — warmth,',
  'formality, greeting, sign-off, length, persona. Apply them to the wording and tone of',
  'the new draft. They are NOT knowledge sources and NOT facts: never treat a voice directive',
  'as evidence of a capability, never cite it, and NEVER list its number in used_sources',
  '(it has no source number). Grounding still comes ONLY from the numbered knowledge sources',
  "and the founder's instruction; voice guidance shapes phrasing, never content.",
  '',
  'Write the reply in the requested language. Return ONLY the structured object',
  '{"reply": "...", "used_sources": [n, ...]} where used_sources lists the 0-based indexes',
  'of the sources you actually relied on (empty if none applied). Do NOT put citation',
  'markers, source numbers, or a "Based on" list inside the reply text — the founder-facing',
  'citations are rendered separately from used_sources.',
].join('\n');

/** Serialize a ReviseRequest into the single user message (prior draft + instruction +
 *  numbered [i] sources). */
export function reviseUserMessage(req: ReviseRequest): string {
  const parts: string[] = [];
  parts.push(`Reply language: ${req.language}`);
  if (req.customerName) parts.push(`Customer: ${req.customerName}`);
  parts.push('', 'Customer message:', req.question);
  parts.push('', 'Your PREVIOUS draft (being corrected):', req.priorDraft);
  parts.push('', "Founder's correction instruction (AUTHORITATIVE — apply it):", req.instruction);
  // Always-on style lane: persistent voice/tone directives for this customer. A DISTINCT,
  // UN-numbered section (not a source) so the model can never cite it or fold it into used_sources.
  const voice = (req.voiceGuidance ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  if (voice.length > 0) {
    parts.push('', 'Persistent voice & tone guidance (HOW to write — directive, NOT a source, do NOT cite):');
    voice.forEach((g) => parts.push(`- ${g}`));
  }
  parts.push('', 'Knowledge sources (use ONLY these for customer facts):');
  req.knowledge.forEach((k, i) => {
    const cite = [k.title, k.section].filter((s): s is string => !!s).join(' › ') || 'untitled';
    const route = k.route ? ` (${k.route})` : '';
    parts.push(`[${i}] ${cite}${route}`);
    parts.push(k.content);
  });
  return parts.join('\n');
}
