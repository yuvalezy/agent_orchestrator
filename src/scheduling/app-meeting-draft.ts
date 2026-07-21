import { validatedExecution, stillFuture, type MeetingCommandDeps } from './schedule-handler';
import { meansEveryone, resolveInvitees, type ContactCandidate } from './meeting-invitees';
import type { ScheduleInterpreterPort } from '../ports/llm.port';
import type { MeetingDraftAttendee, MeetingDraftRepo, MeetingDraftRow } from '../adapters/founder-app/meeting-draft-repo';
import { meetingCalendarTitle, normalizedMeetingTopic } from './meeting-title';

// Iterative meeting scheduling in the Founder PWA's per-customer chat (M6). The founder proposes a
// meeting in natural language, REFINES it on a card ("add Dana", "make it 15:00 Thursday", "45 min"),
// then explicitly books it. Two properties are load-bearing and mirror the Telegram meeting lane
// (schedule-handler.ts proposeMeeting / bookPendingMeeting):
//
//   1. BOOKING IS SEPARATE AND UN-RECALLABLE. A refine NEVER books — it only re-interprets and
//      re-persists the one active draft. Only `book()` calls the calendar, and it re-checks the
//      time is still future first (an "at 2pm" can lapse while the founder edits the card).
//
//   2. THE MODEL READS NAMES; THE CODE RESOLVES THEM. interpret returns the names the founder said;
//      resolveInvitees matches them to the customer's email contacts. A name we cannot place stays
//      `unresolved` and BLOCKS booking — guessing would email the wrong person an invitation.
//
// Pure logic: every I/O is an injected dep, so this is unit-tested with spies (no db/network).

export type { MeetingDraftAttendee } from '../adapters/founder-app/meeting-draft-repo';

/** One of the customer's email contacts, offered on the card so the founder can PICK who an
 *  unresolved name ("Shlomo") really is (the stored contact is "Salomon Kortovich") — the exact
 *  matcher can't bridge a familiar name, but a tap can. */
export interface MeetingContact {
  name: string;
  email: string;
}

/** The JSON a card renders + the endpoints return (frozen shared contract). */
export interface MeetingDraftView {
  id: string;
  status: 'drafting' | 'booked' | 'cancelled';
  title: string;
  startsAt: string | null; // ISO instant; null until a time is set
  durationMinutes: number;
  timezone: string; // IANA, founder tz (env.CALENDAR_TZ)
  attendees: MeetingDraftAttendee[];
  conflicts: string[]; // best-effort busy warnings; [] if none/unknown
  needs: string[]; // what still blocks booking; empty ⇒ ready to book
  /** The customer's email contacts to PICK from — populated only while an attendee is unresolved,
   *  so the card can offer "did you mean …?" one-tap resolution. Empty otherwise. */
  candidates: MeetingContact[];
  messageId: string | null; // the founder_app_messages card row (router manages)
  meetLink: string | null; // set once booked
  htmlLink: string | null; // set once booked
}

export interface AppMeetingDraftDeps {
  meetings: MeetingCommandDeps; // from src/scheduling/schedule-handler.ts
  interpret: Pick<ScheduleInterpreterPort, 'interpretSchedule'>; // src/ports/llm.port.ts
  repo: MeetingDraftRepo;
  timezone: string; // env.CALENDAR_TZ
  now: () => Date;
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

export interface AppMeetingDraftService {
  proposeOrRefine(input: {
    chatSessionId: string;
    customerId: string;
    customerName: string;
    utterance: string;
  }): Promise<MeetingDraftView>;
  book(
    input: { draftId: string },
  ): Promise<{ ok: true; view: MeetingDraftView } | { ok: false; reason: string; view: MeetingDraftView }>;
  /** Resolve an unresolved attendee by PICKING one of the customer's email contacts — the founder
   *  taps "Salomon Kortovich" for the "Shlomo" they typed. `email` MUST be one of the customer's
   *  contacts (never an arbitrary address); the guess named `name` is replaced by the real contact. */
  resolveAttendee(input: { draftId: string; name: string; email: string }): Promise<MeetingDraftView>;
  /** Abandon the active draft (the card's Cancel). Idempotent — a non-drafting/absent row just
   *  returns a cancelled view. Frees the session's active-draft slot so a new meeting can start. */
  cancel(input: { draftId: string }): Promise<MeetingDraftView>;
}

/** Accumulate founder utterances across refine turns (mirrors mergeCommandText's "both halves are
 *  founder speech" join). Space-joined here — the card's refines are terse fragments, not commands. */
function mergeText(prior: string, incoming: string): string {
  const p = prior.trim();
  const n = incoming.trim();
  if (!p) return n;
  if (!n) return p;
  return `${p} ${n}`;
}

/** What still BLOCKS booking, derived from the persisted row so `proposeOrRefine` and `book` agree.
 *  A future time AND at least one resolved attendee are both required — a meeting with no valid
 *  attendee isn't bookable, and an unresolved name is a question, not an invitee. */
function computeNeeds(row: MeetingDraftRow): string[] {
  const needs: string[] = [];
  if (!row.starts_at) needs.push('time'); // time first: book() keys its reason off needs[0]
  for (const a of row.attendees) if (a.unresolved) needs.push(`attendee: ${a.name}`);
  if (!row.attendees.some((a) => !a.unresolved)) needs.push('attendee');
  return needs;
}

export function buildAppMeetingDraft(deps: AppMeetingDraftDeps): AppMeetingDraftService {
  const buildView = (row: MeetingDraftRow, conflicts: string[], needs: string[], candidates: MeetingContact[] = []): MeetingDraftView => ({
    id: row.id,
    status: row.status,
    title: row.title,
    startsAt: row.starts_at ? row.starts_at.toISOString() : null,
    durationMinutes: row.duration_minutes,
    timezone: row.timezone,
    attendees: row.attendees,
    conflicts,
    needs,
    // Only offer pick-candidates while a name is still in question — a fully-resolved card needs none.
    candidates: row.attendees.some((a) => a.unresolved) ? candidates : [],
    messageId: row.message_id,
    meetLink: row.meet_link,
    htmlLink: row.html_link,
  });

  /** A total fallback so the primitive always returns a view, even for a draftId with no row. */
  const stubView = (id: string): MeetingDraftView => ({
    id,
    status: 'cancelled',
    title: '',
    startsAt: null,
    durationMinutes: 0,
    timezone: deps.timezone,
    attendees: [],
    conflicts: [],
    needs: ['time', 'attendee'],
    candidates: [],
    messageId: null,
    meetLink: null,
    htmlLink: null,
  });

  /** The customer's email contacts, deduped — the pool the card offers when a name is unresolved. */
  const emailCandidates = (contacts: ContactCandidate[]): MeetingContact[] => {
    const seen = new Set<string>();
    const out: MeetingContact[] = [];
    for (const c of contacts) {
      const email = c.email?.trim();
      if (!email) continue;
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: c.name, email });
    }
    return out;
  };

  /** MERGE the names an utterance introduced INTO the draft's existing attendees — a refine ADDS
   *  ("add Dana" keeps Salomon), it does not replace. A silent turn (no names) keeps the set as-is;
   *  an "everyone" turn REPLACES it with the customer's full email-contact list (the founder asked
   *  for the whole room). Each name is resolved one at a time so placed chips can sit next to the
   *  ones still in question, and a newly-resolved contact supersedes an earlier unresolved guess of
   *  the same name (so "Dana" going from a question to a real invitee clears the block). */
  const mergeAttendees = (
    prior: MeetingDraftAttendee[],
    requestedNames: string[],
    contacts: ContactCandidate[],
    founderEmails: string[],
  ): MeetingDraftAttendee[] => {
    const requested = requestedNames.map((a) => a.trim()).filter(Boolean);
    if (requested.length === 0) return prior; // the utterance named nobody → attendees unchanged

    if (requested.some(meansEveryone)) {
      // "everyone" is every known email contact of the customer, minus the founder's own addresses.
      const res = resolveInvitees({ requested: [], all: true, contacts, founderEmails });
      return res.kind === 'resolved'
        ? res.invitees.map((i) => ({ name: i.name, email: i.email, unresolved: false }))
        : prior;
    }

    const out = [...prior];
    for (const name of requested) {
      const res = resolveInvitees({ requested: [name], all: false, contacts, founderEmails });
      const inv = res.kind === 'resolved' && res.invitees.length === 1 ? res.invitees[0] : null;
      if (inv) {
        if (out.some((p) => p.email?.toLowerCase() === inv.email.toLowerCase())) continue; // already placed
        // Supersede an unresolved guess of the same spoken name (its word matches), else append.
        const gi = out.findIndex((p) => p.unresolved && p.name.toLowerCase().split(/\s+/).includes(name.toLowerCase()));
        const entry: MeetingDraftAttendee = { name: inv.name, email: inv.email, unresolved: false };
        if (gi >= 0) out[gi] = entry;
        else out.push(entry);
      } else if (!out.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
        out.push({ name, email: null, unresolved: true });
      }
    }
    return out;
  };

  const proposeOrRefine: AppMeetingDraftService['proposeOrRefine'] = async ({
    chatSessionId,
    customerId,
    customerName,
    utterance,
  }) => {
    const prior = await deps.repo.getActive(chatSessionId);
    const now = deps.now();

    // Interpret the NEW utterance in the CONTEXT of what's been said (priorCommandText), NOT a
    // concatenated blob as commandText. Mashing "meeting with X at 2pm" + "add Y, 3pm thursday" into
    // one command reliably confused the model into dropping fields — so a refine would WIPE the draft
    // instead of evolving it. Each utterance is interpreted cleanly and PATCHED onto the held draft:
    // a field the utterance is silent on is KEPT, never re-derived from scratch.
    const interp = await deps.interpret.interpretSchedule(
      {
        commandText: utterance,
        priorCommandText: prior?.command_text ?? null,
        priorClarification: null,
        customerName,
        nowIso: now.toISOString(),
        timezone: deps.timezone,
      },
      customerId,
    );

    // TIME: a fresh valid time wins; silence KEEPS the prior time (an "add Dana" turn must not un-set
    // 2pm). validatedExecution carries the DST-aware roll + offset guard, exactly as the Telegram lane.
    const newStartsAt = validatedExecution(interp.execute_at, deps.timezone, now, interp.explicit_date);
    const startsAt = newStartsAt ?? prior?.starts_at ?? null;

    // ATTENDEES: additively merged onto the prior set (see mergeAttendees). Fetch the customer's
    // contacts ONCE — the merge needs them, and so do the pick-candidates when a name won't resolve.
    const contacts = await deps.meetings.listContacts(customerId);
    const founderEmails = await deps.meetings.founderEmails();
    const attendees = mergeAttendees(prior?.attendees ?? [], interp.attendees ?? [], contacts, founderEmails);

    // A topic named on THIS turn replaces the old title; a time/attendee-only refine preserves it.
    // On the first turn, a correctly-abstaining model gets the deterministic customer fallback.
    const topic = normalizedMeetingTopic(interp.meeting_topic);
    const title = topic ? meetingCalendarTitle({ topic, customerName }) : prior?.title || meetingCalendarTitle({ customerName });
    const durationMinutes =
      interp.duration_minutes && interp.duration_minutes > 0
        ? Math.min(Math.round(interp.duration_minutes), 480)
        : prior?.duration_minutes ?? deps.meetings.defaultDurationMinutes;

    // Best-effort, exactly like proposeMeeting: the founder NAMED this time, so a calendar we cannot
    // read costs them a warning, never the booking.
    let conflicts: string[] = [];
    if (startsAt) {
      const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
      conflicts = await deps.meetings.conflictsAt(startsAt, endsAt).catch(() => [] as string[]);
    }

    const row = await deps.repo.upsertActive({
      chatSessionId,
      customerRef: customerId,
      title,
      startsAt,
      durationMinutes,
      timezone: deps.timezone,
      attendees,
      // Keep accumulating the founder's words so the NEXT turn's interpret has full context to
      // resolve references ("him", "that time") even though each turn is interpreted on its own.
      commandText: mergeText(prior?.command_text ?? '', utterance),
    });
    const needs = computeNeeds(row);
    deps.log.info({ draftId: row.id, customerId, blocked: needs.length }, 'meeting draft: proposed/refined');
    return buildView(row, conflicts, needs, emailCandidates(contacts));
  };

  const book: AppMeetingDraftService['book'] = async ({ draftId }) => {
    const row = await deps.repo.getById(draftId);
    if (!row || row.status !== 'drafting') {
      const view = row ? buildView(row, [], computeNeeds(row)) : stubView(draftId);
      return { ok: false, reason: 'not_pending', view };
    }

    const needs = computeNeeds(row);
    if (needs.length > 0) {
      return { ok: false, reason: needs[0] === 'time' ? 'needs_time' : 'needs_attendee', view: buildView(row, [], needs) };
    }

    // Re-check the ALREADY-validated instant: it can lapse while the card sits unbooked.
    const startsAt = row.starts_at ? stillFuture(row.starts_at.toISOString(), deps.now()) : null;
    if (!startsAt) {
      return { ok: false, reason: 'lapsed', view: buildView(row, [], computeNeeds(row)) };
    }

    const endsAt = new Date(startsAt.getTime() + row.duration_minutes * 60_000);
    const attendeeEmails = row.attendees
      .map((a) => a.email)
      .filter((e): e is string => e !== null);

    // idempotencyKey = the draft id, so a double-tapped "Book it" derives the SAME deterministic
    // calendar eventId and collides at Google (409) instead of creating a second event.
    const res = await deps.meetings.book({
      startsAt,
      endsAt,
      title: row.title,
      attendeeEmails,
      idempotencyKey: draftId,
    });
    await deps.repo.markBooked(draftId, { meetLink: res.meetLink, htmlLink: res.htmlLink });
    deps.log.info({ draftId, customerId: row.customer_ref, alreadyExisted: res.alreadyExisted }, 'meeting draft: booked');

    return {
      ok: true,
      view: { ...buildView(row, [], []), status: 'booked', meetLink: res.meetLink, htmlLink: res.htmlLink, needs: [] },
    };
  };

  const resolveAttendee: AppMeetingDraftService['resolveAttendee'] = async ({ draftId, name, email }) => {
    const row = await deps.repo.getById(draftId);
    if (!row || row.status !== 'drafting') {
      return row ? buildView(row, [], computeNeeds(row)) : stubView(draftId);
    }
    const contacts = await deps.meetings.listContacts(row.customer_ref);
    const contact = contacts.find((c) => c.email.trim().toLowerCase() === email.trim().toLowerCase());
    // Never invent an invitee: the picked email MUST be one of THIS customer's contacts. An unknown
    // email is a no-op that just re-offers the candidates (a raced/forged pick can't add a stranger).
    if (!contact) return buildView(row, [], computeNeeds(row), emailCandidates(contacts));

    const picked: MeetingDraftAttendee = { name: contact.name, email: contact.email, unresolved: false };
    const attendees: MeetingDraftAttendee[] = [];
    for (const a of row.attendees) {
      if (a.unresolved && a.name.toLowerCase() === name.trim().toLowerCase()) continue; // drop the guess being resolved
      if (a.email?.toLowerCase() === contact.email.toLowerCase()) continue; // and any existing copy of the pick
      attendees.push(a);
    }
    attendees.push(picked);

    const updated = await deps.repo.upsertActive({
      chatSessionId: row.chat_session_id,
      customerRef: row.customer_ref,
      title: row.title,
      startsAt: row.starts_at,
      durationMinutes: row.duration_minutes,
      timezone: row.timezone,
      attendees,
      commandText: row.command_text,
    });
    let conflicts: string[] = [];
    if (updated.starts_at) {
      const endsAt = new Date(updated.starts_at.getTime() + updated.duration_minutes * 60_000);
      conflicts = await deps.meetings.conflictsAt(updated.starts_at, endsAt).catch(() => [] as string[]);
    }
    deps.log.info({ draftId, blocked: computeNeeds(updated).length }, 'meeting draft: attendee resolved by pick');
    return buildView(updated, conflicts, computeNeeds(updated), emailCandidates(contacts));
  };

  const cancel: AppMeetingDraftService['cancel'] = async ({ draftId }) => {
    const row = await deps.repo.getById(draftId);
    if (!row) return stubView(draftId);
    if (row.status === 'drafting') await deps.repo.markCancelled(draftId);
    deps.log.info({ draftId, customerId: row.customer_ref }, 'meeting draft: cancelled');
    return { ...buildView(row, [], []), status: 'cancelled', needs: [] };
  };

  return { proposeOrRefine, book, resolveAttendee, cancel };
}
