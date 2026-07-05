import { z } from 'zod';
import type { Intent, TriageContext } from '../../ports/llm.port';

// The golden Intent schema + prompt (DM4-7). The WIRE schema is strict-output
// clean (DA B3) so ONE schema works across Anthropic strict tool-use, OpenAI
// json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • nullable via type-union ({type:["string","null"]}), never an omitted optional
//   • NO minimum/maximum/minLength/maxLength/multipleOf/format  ← would 400 strict
// Range/format checks live in the zod validator, not the wire schema.

const CATEGORIES = [
  'new_feature_request',
  'custom_development',
  'bug_report',
  'question_existing',
  'follow_up',
  'info_provided',
  'compliment',
  'unclear',
  'new_contact',
] as const;

const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

/** Strict-output-clean JSON schema for `{ intents: Intent[] }`. */
export const INTENTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['intents'],
  properties: {
    intents: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['category', 'summary', 'suggested_title', 'priority', 'confidence', 'related_open_task_ref'],
        properties: {
          category: { type: 'string', enum: [...CATEGORIES] },
          summary: { type: 'string' },
          suggested_title: { type: 'string' },
          priority: { type: 'string', enum: [...PRIORITIES] },
          confidence: { type: 'number' }, // 0..1 enforced in zod, NOT the wire schema (B3)
          related_open_task_ref: { type: ['string', 'null'] },
        },
      },
    },
  },
} as const;

/** Zod validator — the range/format guard the wire schema intentionally omits. */
const IntentSchema = z.object({
  category: z.enum(CATEGORIES),
  summary: z.string().min(1),
  suggested_title: z.string().min(1),
  priority: z.enum(PRIORITIES),
  confidence: z.number().min(0).max(1),
  related_open_task_ref: z.string().nullable(),
});
const IntentsEnvelope = z.object({ intents: z.array(IntentSchema) });

/** Validate a provider's structured output → typed Intent[]. Throws on mismatch. */
export function parseIntents(value: unknown): Intent[] {
  return IntentsEnvelope.parse(value).intents;
}

export const TRIAGE_SYSTEM = [
  'You are a triage assistant for a solo software founder. Read one inbound customer',
  'message (with light context) and extract the distinct actionable intents.',
  '',
  'Return ONLY the structured object {"intents": [...]}. Each intent:',
  `- category: one of ${CATEGORIES.join(', ')}.`,
  '- summary: one concise sentence describing the request.',
  '- suggested_title: a short imperative task title.',
  `- priority: one of ${PRIORITIES.join(', ')} (urgency to the customer).`,
  '- confidence: 0.0–1.0, your certainty in the category. Use < 0.5 or category',
  '  "unclear" when the message is ambiguous or not actionable.',
  '- related_open_task_ref: an open-task ref from context this clearly relates to, else null.',
  '',
  'One message may yield multiple intents, or none (return an empty array). Do not',
  'invent tasks for greetings/acknowledgements — use "compliment" or "info_provided".',
].join('\n');

/** Serialize a canned/loaded TriageContext into the single user message. */
export function triageUserMessage(ctx: TriageContext): string {
  const parts: string[] = [];
  if (ctx.customer) {
    parts.push(`Customer: ${ctx.customer.displayName} (lang: ${ctx.customer.preferredLanguage ?? 'unknown'})`);
  }
  if (ctx.recentTasks?.length) {
    parts.push('Open tasks:');
    for (const t of ctx.recentTasks) parts.push(`- [${t.ref}] ${t.title}`);
  }
  if (ctx.message.subject) parts.push(`Subject: ${ctx.message.subject}`);
  parts.push(`Message: ${ctx.message.body ?? '(no text)'}`);
  return parts.join('\n');
}
