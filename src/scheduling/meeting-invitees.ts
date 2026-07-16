// Resolving "invite Idan and Karen" / "invite everyone" to actual addresses (CORE, pure —
// no db, no adapter; the caller supplies the contact list).
//
// ⚠️ WHAT "EVERYONE" CAN AND CANNOT MEAN
// It does NOT mean "every member of the WhatsApp group". A group is ONE row in
// agent_customer_contacts (is_group=true, address = the group jid); there are no participant
// rows anywhere, and whatsapp_manager's HTTP API exposes only /whitelist and /groups — neither
// returns a roster (and invariant #5 forbids reading that service's database). Even a roster
// would give phone numbers, and an invitation needs an email, which only exists for contacts
// carrying a directory_contact_ref.
//
// So "everyone" means EVERY KNOWN EMAIL CONTACT OF THE CUSTOMER THAT OWNS THE TOPIC. That is a
// real, honest capability — it is just not the group's membership. The founder is always shown
// the resolved list before anything is booked, because that is the only thing standing between
// a fuzzy name match and a real person receiving an invitation.
//
// Matching NEVER guesses: an unmatched or ambiguous name yields a clarification, not a best
// effort. Inviting the wrong person is not recallable — Google emails them the moment the event
// is created, and nothing in this system can un-send that.

/** One candidate invitee: a customer's email contact. */
export interface ContactCandidate {
  name: string;
  email: string;
  isPrimary: boolean;
}

export interface Invitee {
  name: string;
  email: string;
}

export type InviteeResolution =
  /** Every requested name matched exactly one contact. `invitees` may be empty (the founder
   *  asked for nobody — a solo hold on the calendar). */
  | { kind: 'resolved'; invitees: Invitee[] }
  /** At least one name could not be resolved to exactly one contact. The caller must ASK. */
  | { kind: 'ambiguous'; unresolved: string[]; candidates: ContactCandidate[] };

/** Fold case + collapse whitespace, so "  Idan  " and "idan" are one name. */
const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** The founder's own addresses must never be invited to their own meeting — Google would email
 *  them an invitation to a slot it already blocked. Compared case-insensitively. */
function isSelf(email: string, founderEmails: string[]): boolean {
  const e = norm(email);
  return founderEmails.some((f) => norm(f) === e);
}

/** Does this contact answer to `name`? Exact full-name first, then a whole-word prefix match
 *  ("idan" → "Idan Yelinkek"). Deliberately NOT substring/fuzzy: "an" must not match "Idan",
 *  and a near-miss must surface as a question rather than a confident wrong invitation. */
function nameMatches(contact: ContactCandidate, name: string): boolean {
  const n = norm(name);
  const full = norm(contact.name);
  if (!n) return false;
  if (full === n) return true;
  // Also allow the local-part of the email ("iyelinek").
  if (norm(contact.email.split('@')[0]) === n) return true;
  return full.split(' ').some((word) => word === n);
}

export interface ResolveInviteesInput {
  /** The founder's raw phrasing, as the model read it back: names, or an "everyone" token.
   *  Null/empty = they named nobody. */
  requested: string[];
  /** Whether the founder asked for everyone on the customer's contact list. */
  all: boolean;
  contacts: ContactCandidate[];
  /** Addresses belonging to the founder (the connected mail accounts). */
  founderEmails: string[];
}

/**
 * Resolve the founder's requested invitees against a customer's contacts.
 *
 * `all` wins over individual names (asking for "everyone and Idan" is just everyone). Self
 * addresses are dropped from `all` — but NOT from an explicitly named request, because naming
 * yourself is a deliberate act and silently ignoring it would be confusing.
 */
export function resolveInvitees(input: ResolveInviteesInput): InviteeResolution {
  const usable = input.contacts.filter((c) => c.email.trim());

  if (input.all) {
    const invitees = usable
      .filter((c) => !isSelf(c.email, input.founderEmails))
      .map((c) => ({ name: c.name, email: c.email }));
    return { kind: 'resolved', invitees: dedupe(invitees) };
  }

  const names = input.requested.map((r) => r.trim()).filter(Boolean);
  if (names.length === 0) return { kind: 'resolved', invitees: [] };

  const invitees: Invitee[] = [];
  const unresolved: string[] = [];
  for (const name of names) {
    const hits = usable.filter((c) => nameMatches(c, name));
    // 0 hits → unknown; >1 → genuinely ambiguous ("smilovich" matches two brothers). Both are
    // questions, never a coin flip.
    if (hits.length === 1) invitees.push({ name: hits[0].name, email: hits[0].email });
    else unresolved.push(name);
  }

  if (unresolved.length > 0) return { kind: 'ambiguous', unresolved, candidates: usable };
  return { kind: 'resolved', invitees: dedupe(invitees) };
}

function dedupe(list: Invitee[]): Invitee[] {
  const seen = new Set<string>();
  return list.filter((i) => {
    const k = norm(i.email);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Words that mean "everyone on this customer's contact list". Kept here (not in the prompt)
 *  so the model reports what it read and the CODE decides what it means — the same rule that
 *  removed `body_source` from the schedule schema. */
const ALL_TOKENS = new Set(['all', 'everyone', 'todos', 'todas', 'everybody', 'the group', 'el grupo', 'group', 'grupo']);

export function meansEveryone(token: string): boolean {
  return ALL_TOKENS.has(norm(token));
}
