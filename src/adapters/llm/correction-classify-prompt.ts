import { z } from 'zod';
import type { CorrectionClass } from '../../ports/llm.port';

// The correction-scope classifier schema + prompt (Draft correction loop Phase 2, LLM role
// 'classify'). Strict-output-clean (additionalProperties:false, every prop required, no
// min/max/format) so ONE schema works across providers. Classifies a founder correction
// into { scope, fact }: 'shared' = a GLOBAL product/company fact true for every customer;
// 'customer' = specific to this customer. DEFAULTS TO 'customer' when uncertain — a
// mis-scoped customer secret leaking into the shared (every-customer) store is the bad case,
// so the SAFE bias is customer, and the founder can promote to global from the confirmation.
// NEVER logs bodies.

/** Strict-output-clean JSON schema for `{ scope: 'shared'|'customer', fact: string }`. */
export const CORRECTION_CLASS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['scope', 'fact'],
  properties: {
    scope: { type: 'string', enum: ['shared', 'customer'] },
    fact: { type: 'string' },
  },
} as const;

const CorrectionEnvelope = z.object({
  scope: z.enum(['shared', 'customer']),
  fact: z.string().min(1),
});

/**
 * Validate a provider's structured output → typed CorrectionClass. Throws on a malformed
 * envelope (the router fails over / the caller treats a throw as "skip learning" — a failed
 * classification must NEVER lose the regenerated draft).
 */
export function parseCorrectionClass(value: unknown): CorrectionClass {
  const parsed = CorrectionEnvelope.parse(value);
  return { scope: parsed.scope, fact: parsed.fact.trim() };
}

export const CORRECTION_CLASS_SYSTEM = [
  'You classify a solo software founder\'s CORRECTION to a drafted customer reply, so the',
  'agent learns it in the right SCOPE and never repeats the mistake.',
  '',
  'Decide the scope:',
  '  • "shared"   — a GLOBAL fact about the product/company, true for EVERY customer.',
  '                 Statements about whether a PRODUCT CAPABILITY, FEATURE, or INTEGRATION',
  '                 exists (e.g. "we have no QuickBooks integration", "we do not support X",',
  '                 "the export only runs nightly") are almost always shared.',
  '  • "customer" — specific to THIS one customer: their preference, negotiated terms,',
  '                 pricing, names, context, or a one-off instruction for this reply only.',
  '',
  'If you are genuinely UNSURE which scope applies, choose "customer" — it is the safe',
  'default (a customer-specific detail must never leak into every customer\'s knowledge).',
  '',
  'Also return "fact": a single normalized sentence stating the corrected truth (what the',
  'agent should remember), phrased generally, WITHOUT the customer\'s name or private data',
  'when scope is shared. Return ONLY {"scope": "...", "fact": "..."}.',
].join('\n');

/** Serialize the classifier user message from the correction instruction + prior draft. */
export function correctionClassifyUserMessage(input: { instruction: string; priorDraft: string; language?: string }): string {
  const parts: string[] = [];
  if (input.language) parts.push(`Reply language: ${input.language}`);
  parts.push('Prior draft (that the founder corrected):', input.priorDraft);
  parts.push('', "Founder's correction instruction:", input.instruction);
  return parts.join('\n');
}
