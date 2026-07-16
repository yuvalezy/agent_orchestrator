import { z } from 'zod';
import type { CommitmentExtractionResult } from '../../ports/llm.port';

// The commitment-extraction schema + prompt (WP7(b), LLM role 'classify'). Strict-output-clean
// (additionalProperties:false, every prop required, no min/max/format) so ONE schema works across
// providers. Reads a batch of the founder's OWN outbound messages to one customer and returns ONLY
// the explicit promises the SENDER (the founder) made to deliver/do/send something — a customer's
// ask, a pleasantry, or a hypothetical is NOT a commitment, so the array is EMPTY for most messages.
// `due_hint` carries the founder's own deadline phrasing verbatim ("by Friday", "next week") or null;
// it is resolved to a concrete due_at IN CODE (never by the model). NEVER logs the message body.

/** Strict-output-clean JSON schema for `{ commitments: [{ text, due_hint }] }`. `due_hint` is
 *  nullable (type ['string','null']) but stays in `required` so the object is strict-clean. */
export const COMMITMENT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['commitments'],
  properties: {
    commitments: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'due_hint'],
        properties: {
          text: { type: 'string' },
          due_hint: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** Zod validator. An item with a blank `text` is dropped (a promise with no content is noise); a
 *  blank or whitespace `due_hint` normalizes to null so code-side resolution sees a clean absence. */
const CommitmentEnvelope = z.object({
  commitments: z.array(
    z.object({
      text: z.string(),
      due_hint: z.string().nullable().optional(),
    }),
  ),
});

/** Validate a provider's structured output → typed CommitmentExtractionResult. Throws on a malformed
 *  envelope (the router fails over / the caller treats a throw as "skip this batch"). */
export function parseCommitmentExtraction(value: unknown): CommitmentExtractionResult {
  const parsed = CommitmentEnvelope.parse(value);
  const commitments = parsed.commitments
    .map((c) => ({ text: c.text.trim(), dueHint: c.due_hint?.trim() ? c.due_hint.trim() : null }))
    .filter((c) => c.text.length > 0);
  return { commitments };
}

export const COMMITMENT_SYSTEM = [
  'You read a solo software founder\'s OWN outgoing messages to one customer and extract the explicit',
  'PROMISES the founder made — things they said THEY would deliver, do, or send. The founder is the',
  'SENDER; you are tracking what the founder committed to, so they never drop a promise.',
  '',
  'Extract a commitment ONLY when the sender explicitly promises a concrete future action of their own',
  '("I\'ll send the invoice tomorrow", "we\'ll have the fix deployed by Friday", "I\'ll get you the',
  'quote next week"). Preserve the founder\'s OWN phrasing of what was promised.',
  '',
  'Do NOT extract:',
  '  • a CUSTOMER\'s request or question (that is an ask, not the sender\'s promise);',
  '  • pleasantries, acknowledgements, or thanks ("sounds good", "will do" with no object);',
  '  • hypotheticals or conditionals the sender did not actually commit to ("we could look at X");',
  '  • something already done ("I sent it yesterday").',
  'Most messages contain NO commitment — return an empty array in that case. Do not manufacture one.',
  '',
  'For each commitment also return "due_hint": the sender\'s OWN deadline phrasing VERBATIM if one was',
  'stated ("by Friday", "tomorrow", "next week", "end of month"), else null. Do NOT compute a date —',
  'copy the phrasing only; the deadline is resolved elsewhere.',
  '',
  'Return ONLY {"commitments": [{"text": "...", "due_hint": "..." | null}]}.',
].join('\n');

/** Serialize the extractor user message from one customer's outbound message batch (bodies only). */
export function commitmentUserMessage(input: { customerName: string; messages: string[] }): string {
  const parts: string[] = [`Customer: ${input.customerName}`, '', 'Messages you (the founder) sent:'];
  input.messages.forEach((m, i) => parts.push(`${i + 1}. ${m}`));
  return parts.join('\n');
}
