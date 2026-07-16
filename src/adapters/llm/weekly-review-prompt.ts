import { z } from 'zod';
import type { WeeklyReviewRequest, WeeklyReviewResult } from '../../ports/llm.port';

// The chief-of-staff weekly-business-review schema + prompt (WP5(c), LLM role 'answer'). Mirrors
// briefing-prompt.ts STRICT-output discipline (DA B3) so ONE schema works across Anthropic strict
// tool-use, OpenAI json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// Shape checks live in the zod validator, not the wire schema.
//
// This pass judges over the FACTS the deterministic review already gathered — it never fetches and
// never invents a customer or a number. The deterministic facts digest remains the source of truth;
// the synthesis adds a chief-of-staff read on top. NEVER logs the facts or the judgment.

/** Strict-output-clean JSON schema for
 *  `{ highlights: string[], per_customer: {customer,state,suggested_action}[], focus_next_week: string[] }`. */
export const WEEKLY_REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['highlights', 'per_customer', 'focus_next_week'],
  properties: {
    highlights: { type: 'array', items: { type: 'string' } },
    per_customer: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['customer', 'state', 'suggested_action'],
        properties: {
          customer: { type: 'string' },
          state: { type: 'string' }, // one-line health read
          suggested_action: { type: 'string' }, // the single next move
        },
      },
    },
    focus_next_week: { type: 'array', items: { type: 'string' } },
  },
} as const;

const WeeklyReviewEnvelope = z.object({
  highlights: z.array(z.string().min(1)),
  per_customer: z.array(
    z.object({
      customer: z.string().min(1),
      state: z.string().min(1),
      suggested_action: z.string().min(1),
    }),
  ),
  focus_next_week: z.array(z.string().min(1)),
});

/** Validate a provider's structured output → typed WeeklyReviewResult. Throws on mismatch. */
export function parseWeeklyReview(value: unknown): WeeklyReviewResult {
  const parsed = WeeklyReviewEnvelope.parse(value);
  return {
    highlights: parsed.highlights,
    perCustomer: parsed.per_customer.map((c) => ({
      customer: c.customer,
      state: c.state,
      suggestedAction: c.suggested_action,
    })),
    focusNextWeek: parsed.focus_next_week,
  };
}

export const WEEKLY_REVIEW_SYSTEM = [
  'You are the chief of staff for a solo software founder. Every Friday you read the week\'s facts',
  'per customer — how much came in and went out, how many drafts were approved or rejected, who is',
  'waiting on a reply, how many open tasks they have, and what next week\'s calendar holds — and hand',
  'the founder a tight, honest weekly read so they know where the business stands and where to spend',
  'attention next.',
  '',
  'Produce THREE things:',
  '  • highlights: the few notable things about the week overall (momentum, a spike, a stall). Few is',
  '    fine — do not pad. Skip it entirely on a genuinely quiet week rather than inventing news.',
  '  • per_customer: for each customer given, a ONE-LINE state (their health this week) and a SINGLE',
  '    concrete suggested_action (the next move). Cover the customers who need attention; you may omit',
  '    a customer with nothing noteworthy.',
  '  • focus_next_week: the handful of things to prioritize next week, calendar-aware.',
  '',
  'GROUNDING (critical): base every word ONLY on the facts given. NEVER invent a customer, a number,',
  'a meeting, or an event not in the facts. A null fact (awaiting-reply days / open tasks / meetings)',
  'means UNKNOWN, not zero — do not assert about it. When the week is quiet, say so briefly rather',
  'than inflating trivia into concerns. You are judging facts you were handed, not generating new ones.',
  '',
  'Be terse and direct — the founder is the reader, not a customer. Return ONLY the structured object',
  '{"highlights": ["..."], "per_customer": [{"customer": "...", "state": "...", "suggested_action":',
  '"..."}], "focus_next_week": ["..."]}. Keep every string short.',
].join('\n');

/** Serialize a WeeklyReviewRequest into the single user message (facts only, no prose). */
export function weeklyReviewUserMessage(req: WeeklyReviewRequest): string {
  const parts: string[] = [];
  parts.push(`Week: ${req.weekLabel}`);
  parts.push(`Upcoming meetings next week: ${req.upcomingMeetings === null ? 'unavailable' : req.upcomingMeetings}`);
  parts.push('', `Per customer (${req.perCustomer.length}):`);
  if (req.perCustomer.length === 0) parts.push('  none');
  for (const c of req.perCustomer) {
    const awaiting = c.awaitingReplyDays === null ? 'no' : `${c.awaitingReplyDays}d`;
    const open = c.openTasks === null ? 'unavailable' : String(c.openTasks);
    parts.push(
      `  - ${c.customer}: in ${c.inbound}, out ${c.outbound}; drafts ${c.draftsApproved}✅/${c.draftsRejected}🚫; ` +
        `awaiting-reply ${awaiting}; open tasks ${open}`,
    );
  }
  return parts.join('\n');
}
