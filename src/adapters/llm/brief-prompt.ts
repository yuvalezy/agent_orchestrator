import { z } from 'zod';
import type { CustomerBriefRequest, CustomerBriefResult } from '../../ports/llm.port';

// The golden relationship-brief schema + prompt (WP6, LLM role 'answer'). Mirrors briefing-prompt.ts
// STRICT-output discipline (DA B3) so ONE schema works across Anthropic strict tool-use, OpenAI
// json_schema strict, AND DeepSeek json_object:
//   • additionalProperties:false on every object; every property in `required`
//   • NO minimum/maximum/minLength/format  ← would 400 strict
// The ≤900-char length clamp lives in the zod validator, not the wire schema.
//
// This pass reads a customer's structured recent FACTS and writes ONE neutral, factual paragraph —
// who they are, what's live, how the relationship feels, any commitments in flight. It grounds ONLY
// in the facts and never invents. The brief is later injected as CONTEXT-ONLY side information into
// triage + drafting (never a citation source). NEVER logs the facts or the brief.

/** Hard char ceiling on the one-paragraph brief (≈120 words). Enforced loosely in zod, clamped at
 *  the call site too. */
export const BRIEF_MAX_CHARS = 900;

/** Strict-output-clean JSON schema for `{ brief: string }`. */
export const BRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['brief'],
  properties: {
    brief: { type: 'string' }, // ≤900 chars enforced in zod, NOT the wire schema (B3)
  },
} as const;

/** Zod validator — the length guard the wire schema intentionally omits. A model that overruns is
 *  hard-truncated (never rejected) so a slightly-long paragraph still yields a usable brief. */
const BriefEnvelope = z.object({
  brief: z.string().min(1).transform((s) => (s.length > BRIEF_MAX_CHARS ? s.slice(0, BRIEF_MAX_CHARS).trimEnd() : s)),
});

/** Validate a provider's structured output → typed CustomerBriefResult. Throws on an empty brief. */
export function parseBrief(value: unknown): CustomerBriefResult {
  return { brief: BriefEnvelope.parse(value).brief };
}

export const BRIEF_SYSTEM = [
  'You maintain a rolling relationship brief for a solo software founder — one short paragraph per',
  'customer that captures, at a glance, who they are, what is live with them right now, how the',
  'relationship feels, and any commitments in flight.',
  '',
  'Write ONE paragraph, at most 120 words. Neutral, factual, plain — this is an internal note for the',
  'founder, not a message to the customer and not marketing copy. Do not address the customer, do not',
  'use bullet points or headings, do not add a greeting or sign-off.',
  '',
  'GROUNDING (critical): base every word ONLY on the facts given. NEVER invent a fact, a number, a',
  'task, or a sentiment the facts do not support. If there is little to say, say little — a terse',
  'honest brief beats an inflated one. Note NEGATIVE signals honestly and specifically when the facts',
  'show them (e.g. "three pricing corrections this month", "silent for 12 days with a reply owed") —',
  'the brief is only useful if it tells the truth.',
  '',
  'Return ONLY the structured object {"brief": "..."}.',
].join('\n');

/** Serialize a CustomerBriefRequest into the single user message (facts only, no prose). */
export function briefUserMessage(req: CustomerBriefRequest): string {
  const parts: string[] = [];
  parts.push(`Customer: ${req.customerName}`);
  const contact = req.lastContactDaysAgo === null ? 'never' : `${req.lastContactDaysAgo}d ago`;
  parts.push(`Last ${req.windowDays} days: ${req.inbound} in / ${req.outbound} out · last contact ${contact}`);
  parts.push(`Pending drafts awaiting your approval: ${req.pendingDrafts}`);

  parts.push('', `Open tasks (${req.openTasks.length}):`);
  if (req.openTasks.length === 0) parts.push('  none');
  for (const t of req.openTasks) parts.push(`  - ${t.title} (${t.ageDays}d old)`);

  parts.push('', `Recent notes & corrections (${req.recentMemories.length}, newest first):`);
  if (req.recentMemories.length === 0) parts.push('  none');
  for (const m of req.recentMemories) parts.push(`  - ${m}`);

  return parts.join('\n');
}
