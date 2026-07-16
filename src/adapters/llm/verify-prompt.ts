import { z } from 'zod';
import type { DraftVerdict, VerifyDraftRequest } from '../../ports/llm.port';

// The draft self-critique schema + prompt (WP3 draft verifier, LLM role 'classify'). Grades a
// drafted customer reply against the question, the numbered knowledge sources, the required
// language, and optional voice guidance — it returns a VERDICT, never a rewrite. STRICT-output
// clean (DA B3) so ONE schema works across Anthropic strict tool-use, OpenAI json_schema strict,
// and DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// Range/shape/clamp checks live in the zod validator, not the wire schema. NEVER logs bodies.

/** Strict-output-clean JSON schema for `{ pass: boolean, failures: [{ code, detail }] }`. */
export const VERIFY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['pass', 'failures'],
  properties: {
    pass: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['code', 'detail'],
        properties: {
          code: {
            type: 'string',
            enum: ['ungrounded_claim', 'wrong_language', 'style_violation', 'invented_capability', 'other'],
          },
          detail: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Zod validator — the shape guard the wire schema intentionally omits. An out-of-enum `code`
 *  degrades to 'other' rather than throwing (a failover on a benign miss would be wasteful). */
const VerifyEnvelope = z.object({
  pass: z.boolean(),
  failures: z
    .array(
      z.object({
        code: z
          .enum(['ungrounded_claim', 'wrong_language', 'style_violation', 'invented_capability', 'other'])
          .catch('other'),
        detail: z.string(),
      }),
    )
    .default([]),
});

/** Collapse a detail to ONE sentence: whitespace-normalized, up to the first sentence terminator,
 *  hard-capped so a runaway string can never bloat the founder notification. */
function oneSentence(detail: string): string {
  const collapsed = detail.trim().replace(/\s+/g, ' ');
  if (!collapsed) return '';
  const match = collapsed.match(/^.*?[.!?](?=\s|$)/);
  const sentence = (match ? match[0] : collapsed).trim();
  return sentence.length > 240 ? `${sentence.slice(0, 240).trimEnd()}…` : sentence;
}

/**
 * Validate a provider's structured output → typed DraftVerdict. Throws on a malformed envelope
 * (the router fails over / the caller treats a throw as "skip verification"). Two clamps the wire
 * schema cannot express: `detail` is squeezed to one sentence, and `pass` is DERIVED from the
 * failure list (true only when zero non-empty failures) — a model that reports pass:true next to a
 * failure never slips a bad draft through.
 */
export function parseVerdict(value: unknown): DraftVerdict {
  const parsed = VerifyEnvelope.parse(value);
  const failures = parsed.failures
    .map((f) => ({ code: f.code, detail: oneSentence(f.detail) }))
    .filter((f) => f.detail.length > 0);
  return { pass: failures.length === 0, failures };
}

export const VERIFY_SYSTEM = [
  'You are a strict reviewer of a DRAFT reply a solo software founder is about to review before it',
  'is sent to a customer. You do NOT rewrite the draft — you GRADE it and report concrete failures',
  'so the founder (or an auto-revise pass) can fix it. Be precise and conservative: only flag a real',
  'problem, and give exactly one sentence per failure.',
  '',
  'Check the draft against these rules and record a failure for each that is violated:',
  '  • ungrounded_claim — a factual claim in the draft (a capability, feature, price, limit, step,',
  '    URL, date) that is NOT traceable to one of the numbered knowledge sources. The ABSENCE of a',
  '    source is NOT evidence a capability exists: if the draft asserts something no source confirms,',
  '    that is a failure.',
  '  • invented_capability — the draft claims we support / offer / integrate with something that no',
  '    numbered source establishes. (A specific, egregious kind of ungrounded_claim — use this code',
  '    when the fabricated thing is a product capability, feature, or integration.)',
  '  • wrong_language — the reply is not written in the requested language.',
  '  • style_violation — a voice/tone/style directive listed under "Style directives" is clearly',
  '    disregarded (e.g. told to be warm/informal but the draft is curt and formal).',
  '  • other — any other clear defect that makes the draft unsafe to send (contradiction, an unfilled',
  '    placeholder, an obviously wrong salutation).',
  '',
  'A draft that abstains honestly ("we do not currently offer that; I will confirm with the founder")',
  'is CORRECT, not a failure — abstaining in the absence of a source is exactly right.',
  '',
  'Return ONLY the structured object {"pass": <bool>, "failures": [{"code": "...", "detail": "..."}]}.',
  'Set pass=true and failures=[] when the draft is clean. When you list ANY failure, pass MUST be',
  'false. Each detail is ONE sentence naming the specific problem — never the whole draft, never a',
  'rewrite.',
].join('\n');

/** Serialize a VerifyDraftRequest into the single user message (numbered [i] sources). Mirrors the
 *  draft prompt's layout so the verifier reads the SAME numbered sources the drafter grounded on. */
export function verifyUserMessage(req: VerifyDraftRequest): string {
  const parts: string[] = [];
  parts.push(`Required reply language: ${req.language}`);
  parts.push('', 'Customer message:', req.question);
  parts.push('', 'Draft reply under review:', req.draftBody);
  const voice = (req.voiceGuidance ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  if (voice.length > 0) {
    parts.push('', 'Style directives the draft was required to honor:');
    voice.forEach((g) => parts.push(`- ${g}`));
  }
  parts.push('', 'Numbered knowledge sources (every factual claim must trace to one of these):');
  if (req.knowledge.length === 0) {
    parts.push('(none — the draft had no grounding sources; any factual product claim is ungrounded)');
  } else {
    req.knowledge.forEach((k, i) => {
      const cite = [k.title, k.section].filter((s): s is string => !!s).join(' › ') || 'untitled';
      const route = k.route ? ` (${k.route})` : '';
      parts.push(`[${i}] ${cite}${route}`);
      parts.push(k.content);
    });
  }
  return parts.join('\n');
}
