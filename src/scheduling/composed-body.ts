// Code-level bounds on a COMPOSED customer-facing body.
//
// While the model only copied the founder's words, `exactBody` was the real control:
// an injected instruction could be obeyed in full and still die, because the resulting
// body was not a substring of the founder's command. The prompt rule about untrusted
// context was never load-bearing. Composition removes that control, so these checks are
// its replacement — the point is that they live in CODE, not in a prompt the same model
// is free to ignore. The composer is also structurally blind to customer text (see
// ComposeMessageRequest); this is the belt to that pair of braces.

/** Hard cap on a composed body. Keeps the preview readable in full (Telegram folds long
 *  messages behind "Show more", where an unnoticed line is exactly the risk), and keeps a
 *  model-controlled string far from the 4096-char send limit. Lives in core because it is
 *  policy, not prompt text; the prompt adapter imports it to state the same number. */
export const COMPOSE_MAX_CHARS = 600;

/** Tokens shared with untrusted text before we call it laundering rather than coincidence.
 *  Stock pleasantries reach six ("thanks for getting back to me"), and this is the SECOND
 *  line of defence — the composer never receives untrusted text at all — so the threshold
 *  favours not rejecting honest drafts. Anything worth laundering runs far longer. */
const OVERLAP_TOKENS = 8;

/** Shapes a pleasantry never needs, and an injection almost always wants. */
const CONTACT_PATTERNS: Array<{ label: string; re: RegExp }> = [
  { label: 'a link', re: /\b(?:https?:\/\/|www\.)\S+/i },
  { label: 'an email address', re: /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/ },
  { label: 'an account number', re: /\b[A-Z]{2}\d{2}[A-Z0-9]{8,}\b/ },
  { label: 'a phone number', re: /(?:\+\d[\d\s().-]{7,}\d)/ },
];

export type ComposedBodyCheck =
  | { ok: true; body: string }
  | { ok: false; reason: string };

const normalize = (s: string): string[] =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

/** True when `body` reproduces a run of >= OVERLAP_TOKENS consecutive tokens from `untrusted`. */
function sharesLongSpan(body: string, untrusted: string): boolean {
  const a = normalize(body);
  const b = normalize(untrusted);
  if (a.length < OVERLAP_TOKENS || b.length < OVERLAP_TOKENS) return false;
  const spans = new Set<string>();
  for (let i = 0; i + OVERLAP_TOKENS <= b.length; i += 1) {
    spans.add(b.slice(i, i + OVERLAP_TOKENS).join(' '));
  }
  for (let i = 0; i + OVERLAP_TOKENS <= a.length; i += 1) {
    if (spans.has(a.slice(i, i + OVERLAP_TOKENS).join(' '))) return true;
  }
  return false;
}

/**
 * Gate a composed body before it is ever shown as an approvable draft.
 *
 * `untrusted` is customer-authored text (replied message, mapped outbound draft). The
 * composer never receives it, so any long overlap means it leaked in by another route —
 * fail closed instead of asking the founder to spot it in a preview.
 */
export function checkComposedBody(
  body: string,
  opts: { maxChars: number; founderText: string; untrusted: Array<string | null | undefined> },
): ComposedBodyCheck {
  const trimmed = body.trim();
  if (!trimmed) return { ok: false, reason: 'the model returned nothing' };
  if (trimmed.length > opts.maxChars) {
    return { ok: false, reason: `the draft ran past ${opts.maxChars} characters` };
  }

  for (const { label, re } of CONTACT_PATTERNS) {
    const hit = re.exec(trimmed)?.[0];
    // Allowed only when the founder supplied it themselves — then it is their words,
    // not the model's invention.
    if (hit && !opts.founderText.toLowerCase().includes(hit.toLowerCase())) {
      return { ok: false, reason: `the draft invented ${label}` };
    }
  }

  for (const source of opts.untrusted) {
    if (source && sharesLongSpan(trimmed, source)) {
      return { ok: false, reason: 'the draft echoed text from the customer message' };
    }
  }

  return { ok: true, body: trimmed };
}
