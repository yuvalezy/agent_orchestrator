import { z } from 'zod';
import type { BriefingSynthesisRequest, BriefingSynthesisResult } from '../../ports/llm.port';

// The chief-of-staff briefing-synthesis schema + prompt (WP1, LLM role 'answer'). Mirrors
// draft-prompt.ts / answer-prompt.ts STRICT-output discipline (DA B3) so ONE schema works
// across Anthropic strict tool-use, OpenAI json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// Range/shape checks (incl. the ≤3 focus cap) live in the zod validator, not the wire schema.
//
// This pass judges PRIORITY over the FACTS the deterministic briefing already computed — it
// never fetches and never invents an item that is not in the facts. The deterministic sections
// remain the source of truth; the synthesis only adds a chief-of-staff read on top. NEVER logs
// the facts or the judgment.

/** The most focus items the founder should be handed at once (a chief of staff triages). */
export const MAX_FOCUS_ITEMS = 3;

/** Strict-output-clean JSON schema for `{ focus: {title,why}[], can_wait: string[], risks: string[] }`. */
export const BRIEFING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['focus', 'can_wait', 'risks'],
  properties: {
    focus: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'why'],
        properties: {
          title: { type: 'string' },
          why: { type: 'string' }, // one-sentence justification
        },
      },
    },
    can_wait: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
} as const;

/** Zod validator — the shape guard the wire schema intentionally omits (incl. the ≤3 focus cap). */
const BriefingEnvelope = z.object({
  focus: z.array(z.object({ title: z.string().min(1), why: z.string().min(1) })).max(MAX_FOCUS_ITEMS),
  can_wait: z.array(z.string().min(1)),
  risks: z.array(z.string().min(1)),
});

/** Validate a provider's structured output → typed BriefingSynthesisResult. Throws on mismatch. */
export function parseBriefingSynthesis(value: unknown): BriefingSynthesisResult {
  const parsed = BriefingEnvelope.parse(value);
  return {
    focus: parsed.focus.map((f) => ({ title: f.title, why: f.why })),
    canWait: parsed.can_wait,
    risks: parsed.risks,
  };
}

export const BRIEFING_SYSTEM = [
  'You are the chief of staff for a solo software founder. Each morning you read the facts of',
  "the day — what is waiting, what is urgent, who has gone silent, what today's calendar holds —",
  'and hand the founder a tight, honest read so they know where to spend their attention first.',
  '',
  `Pick the top ${MAX_FOCUS_ITEMS} focus items AT MOST (fewer is fine — do not pad to three) and`,
  'justify EACH in one short sentence. List what can safely wait. Flag emerging risks — a customer',
  'who has waited too long, an approval queue aging, a backlog building overnight. Be terse and',
  'direct: the founder is the reader, not a customer.',
  '',
  'GROUNDING (critical): base your judgment ONLY on the facts given. NEVER invent an item, a',
  'customer, a meeting, or a number that is not in the facts. If a section is empty, it is empty —',
  'do not manufacture work to fill the list. When the day is genuinely quiet, return few or no',
  'focus items rather than inflating trivia into priorities. You are prioritizing facts you were',
  'handed, not generating new ones.',
  '',
  'Return ONLY the structured object {"focus": [{"title": "...", "why": "..."}], "can_wait":',
  '["..."], "risks": ["..."]}. Keep every string short. Do NOT restate the raw counts back as a',
  'list — the founder already sees those below your read; your job is the judgment on top.',
].join('\n');

/** Format an oldest-age (whole hours) for a fact line, or 'none' when the queue is empty. */
function oldest(hours: number | null): string {
  return hours === null ? 'none' : `${hours}h`;
}

/** Serialize a BriefingSynthesisRequest into the single user message (facts only, no prose). */
export function briefingUserMessage(req: BriefingSynthesisRequest): string {
  const parts: string[] = [];
  parts.push("Today's facts:");
  parts.push('');

  parts.push(
    `Overnight untriaged: ${req.overnightUntriaged === null ? 'unavailable' : req.overnightUntriaged}`,
  );

  parts.push(`Approval queues: ${req.approvals.drafts} draft replies, ${req.approvals.proposals} task proposals · oldest ${oldest(req.approvals.oldestAgeHours)}`);

  parts.push('', `Urgent items (${req.urgent.length}):`);
  if (req.urgent.length === 0) parts.push('  none');
  for (const u of req.urgent) parts.push(`  - ${u.customer ?? 'unknown'} · ${u.label} · waiting ${u.ageHours}h`);

  parts.push('', `Awaiting customer reply (${req.awaitingReply.length}):`);
  if (req.awaitingReply.length === 0) parts.push('  none');
  for (const a of req.awaitingReply) parts.push(`  - ${a.customer ?? 'unknown'} · silent ${a.daysWaiting}d`);

  parts.push('', `Needs attention (${req.needsAttention.length}):`);
  if (req.needsAttention.length === 0) parts.push('  none');
  for (const c of req.needsAttention) {
    parts.push(`  - ${c.customer ?? 'unknown'} · ${c.waitingItems} waiting · oldest ${c.oldestAgeHours}h`);
  }

  parts.push('', `Today's meetings (${req.meetings.length}):`);
  if (req.meetings.length === 0) parts.push('  none');
  for (const m of req.meetings) parts.push(`  - ${m.time} — ${m.title}`);

  return parts.join('\n');
}
