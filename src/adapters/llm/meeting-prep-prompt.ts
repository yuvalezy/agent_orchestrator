import { z } from 'zod';
import type { MeetingPrepRequest, MeetingPrepResult } from '../../ports/llm.port';

// The meeting-prep talking-points schema + prompt (WP7(a), LLM role 'answer'). Mirrors
// briefing-prompt.ts / brief-prompt.ts STRICT-output discipline (DA B3) so ONE schema works
// across Anthropic strict tool-use, OpenAI json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minItems/format  ← would 400 strict
// The ≤3 cap lives in the zod validator, not the wire schema.
//
// This pass reads the FACTS assembled for ONE upcoming meeting (who, what's open, what's owed, the
// last few messages, any commitments) and writes AT MOST 3 short talking points — grounded ONLY in
// the facts, never inventing an agenda item. It is best-effort at the call site: a failure posts the
// deterministic prep pack without bullets. NEVER logs the facts or the talking points.

/** The most talking points the founder should be handed before a meeting (a tight glance, not a doc). */
export const MAX_TALKING_POINTS = 3;

/** Strict-output-clean JSON schema for `{ talking_points: string[] }`. */
export const MEETING_PREP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['talking_points'],
  properties: {
    talking_points: { type: 'array', items: { type: 'string' } }, // ≤3 enforced in zod, NOT the wire schema (B3)
  },
} as const;

/** Zod validator — the shape guard the wire schema intentionally omits (incl. the ≤3 cap). */
const MeetingPrepEnvelope = z.object({
  talking_points: z.array(z.string().min(1)).max(MAX_TALKING_POINTS),
});

/** Validate a provider's structured output → typed MeetingPrepResult. Throws on mismatch. */
export function parseMeetingPrep(value: unknown): MeetingPrepResult {
  return { talkingPoints: MeetingPrepEnvelope.parse(value).talking_points };
}

export const MEETING_PREP_SYSTEM = [
  'You are the chief of staff for a solo software founder. Minutes before a meeting with one of their',
  'customers you read the facts — what is open, what is owed, the last few messages, any commitments —',
  `and hand the founder AT MOST ${MAX_TALKING_POINTS} short talking points so they walk in prepared.`,
  '',
  'Be terse and concrete: each point is one short line the founder can glance at (an open item to',
  'raise, a promise to confirm, a decision to close). Fewer is fine — do not pad to three. The founder',
  'is the reader, not the customer; do not address the customer and do not write a script.',
  '',
  'GROUNDING (critical): base every point ONLY on the facts given. NEVER invent a task, a commitment, a',
  'number, or an agenda item the facts do not support. If there is little to say, say little — a couple',
  'of honest points beat three padded ones. You are prioritizing facts you were handed, not generating',
  'new ones.',
  '',
  'Return ONLY the structured object {"talking_points": ["..."]}. Keep every string short.',
].join('\n');

/** Serialize a MeetingPrepRequest into the single user message (facts only, no prose). */
export function meetingPrepUserMessage(req: MeetingPrepRequest): string {
  const parts: string[] = [];
  parts.push(`Meeting: ${req.meetingTitle} — ${req.meetingTime}`);
  parts.push(`Customer: ${req.customerName}`);
  parts.push(`Awaiting your reply: ${req.awaitingReplyCount} · pending drafts: ${req.pendingDraftCount}`);

  parts.push('', `Open tasks (${req.openTasks.length}):`);
  if (req.openTasks.length === 0) parts.push('  none');
  for (const t of req.openTasks) parts.push(`  - ${t.title} (${t.ageDays}d old)`);

  parts.push('', `Open commitments you made (${req.openCommitments.length}):`);
  if (req.openCommitments.length === 0) parts.push('  none');
  for (const c of req.openCommitments) parts.push(`  - ${c}`);

  parts.push('', `Recent messages (${req.recentSnippets.length}, newest first):`);
  if (req.recentSnippets.length === 0) parts.push('  none');
  for (const s of req.recentSnippets) parts.push(`  - ${s.direction === 'outbound' ? 'you' : req.customerName}: ${s.text}`);

  return parts.join('\n');
}
