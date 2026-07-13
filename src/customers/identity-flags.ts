// Pure identity-audit flagging (no I/O, no adapters) for the customer-identity
// diagnostic (scripts/customer-identity.ts). Extracted here so the mismatch heuristic
// is unit-tested and the boundary guard stays green (a core dir, adapter-free).
//
// Two coverage gaps this surfaces: (a) a customer whose real correspondence lives on
// an UNMAPPED mailbox/domain → 0 threads; (b) a display_name that does not match its
// email_domain (e.g. "Golden Baby" ↔ cottoncandyint.com) → onboarded onto the wrong
// domain. Neither is an error — each is a ⚠️ FLAG for a human to eyeball.

export interface IdentityAuditInput {
  bpRef: string | null;
  displayName: string;
  emailDomain: string | null;
  /** whatsapp_manager message count for this customer's mapped chats; null = source unavailable. */
  waMessageCount: number | null;
  /** Gmail thread count across the configured accounts; null = source unavailable. */
  gmailThreadCount: number | null;
}

export interface IdentityFlag {
  code: string;
  message: string;
}

const MIN_TOKEN_LEN = 3;

/** Lowercase alphanumeric tokens of a display name, dropping short/noise tokens
 *  (1–2 char connectors like "de"/"y" that would match almost any domain). */
export function nameTokens(displayName: string): string[] {
  return displayName
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LEN);
}

/** True when a domain exists AND none of the name's tokens appears in it — a POSSIBLE
 *  onboarding mismatch (e.g. "Golden Baby" ↔ cottoncandyint.com). A null/empty domain
 *  is NOT a mismatch here (that is the separate "no email domain" flag), and a name with
 *  no usable tokens can't be judged, so it is not flagged. */
export function nameDomainMismatch(displayName: string, emailDomain: string | null): boolean {
  if (!emailDomain?.trim()) return false;
  const domain = emailDomain.toLowerCase();
  const tokens = nameTokens(displayName);
  if (tokens.length === 0) return false;
  return !tokens.some((t) => domain.includes(t));
}

/** Compute the ⚠️ FLAGS for an identity audit. A count of `null` means its source was
 *  unavailable (a failing probe never fabricates a 0), so it is NOT flagged as zero. */
export function computeIdentityFlags(input: IdentityAuditInput): IdentityFlag[] {
  const flags: IdentityFlag[] = [];
  if (!input.bpRef?.trim()) {
    flags.push({ code: 'no_bp_ref', message: 'no bp_ref — WhatsApp chats cannot be mapped to this customer' });
  }
  if (!input.emailDomain?.trim()) {
    flags.push({ code: 'no_email_domain', message: 'no email_domain — Gmail history search finds nothing by domain' });
  }
  if (input.waMessageCount === 0) {
    flags.push({ code: 'zero_wa_messages', message: '0 whatsapp_manager messages found for the mapped chats' });
  }
  if (input.gmailThreadCount === 0) {
    flags.push({ code: 'zero_gmail_threads', message: '0 Gmail threads matched — wrong/missing domain or an unmapped mailbox' });
  }
  if (nameDomainMismatch(input.displayName, input.emailDomain)) {
    flags.push({
      code: 'name_domain_mismatch',
      message: `display_name "${input.displayName}" shares no token with email_domain "${input.emailDomain}" — possible wrong domain`,
    });
  }
  return flags;
}
