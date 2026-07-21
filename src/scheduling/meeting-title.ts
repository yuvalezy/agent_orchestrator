// Calendar meeting titles cross a public boundary: Google sends them to every attendee. Keep the
// model responsible for a useful topic, but make the final formatting deterministic and prevent a
// transport/database identifier from becoming attendee-visible when no topic was available.

const MAX_TOPIC_CHARS = 80;
const MAX_CUSTOMER_CHARS = 120;
const MAX_TITLE_CHARS = MAX_TOPIC_CHARS + MAX_CUSTOMER_CHARS + 3; // `topic — customer`

const GENERIC_TOPICS = new Set([
  'call',
  'meeting',
  'customer call',
  'customer meeting',
  'schedule a call',
  'schedule a meeting',
  'set up a call',
  'set up a meeting',
  'video call',
]);

function oneLine(value: string): string | null {
  if (/[\r\n\u2028\u2029]/u.test(value)) return null;
  const cleaned = value.trim().replace(/[\t ]+/g, ' ');
  return cleaned || null;
}

/** Raw channel/thread ids we must never echo into an attendee-visible Calendar summary. */
export function isOpaqueMeetingIdentifier(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(v)) return true;
  if (/^\d+@(?:g\.us|s\.whatsapp\.net|c\.us)$/iu.test(v)) return true;
  if (/^[+\d][\d\s().-]*$/u.test(v) && (v.match(/\d/g)?.length ?? 0) >= 7) return true;
  return false;
}

/** A model topic is useful only when it adds an actual subject beyond "call/meeting". */
export function normalizedMeetingTopic(value: string | null | undefined): string | null {
  if (!value) return null;
  const topic = oneLine(value);
  if (!topic || topic.length > MAX_TOPIC_CHARS) return null;
  if (GENERIC_TOPICS.has(topic.toLocaleLowerCase('en-US'))) return null;
  if (isOpaqueMeetingIdentifier(topic)) return null;
  return topic;
}

function normalizedCustomerName(value: string | null | undefined): string | null {
  if (!value) return null;
  const customer = oneLine(value);
  if (!customer || customer.length > MAX_CUSTOMER_CHARS || isOpaqueMeetingIdentifier(customer)) return null;
  return customer;
}

/** Format a grounded topic, or the safe customer-name fallback when the model correctly abstains. */
export function meetingCalendarTitle(input: {
  topic?: string | null;
  customerName?: string | null;
}): string {
  const topic = normalizedMeetingTopic(input.topic);
  const customer = normalizedCustomerName(input.customerName);
  if (topic && customer) return `${topic} — ${customer}`;
  if (topic) return topic;
  if (customer) return `Call — ${customer}`;
  return 'Call';
}

/**
 * Defense-in-depth at the irreversible Calendar-write boundary. This also protects a pending
 * marker/draft created by an older deployment whose stored title was `Call — <thread id>`.
 */
export function safeMeetingCalendarTitle(value: string | null | undefined): string {
  if (!value) return 'Call';
  const title = oneLine(value);
  if (!title || title.length > MAX_TITLE_CHARS || isOpaqueMeetingIdentifier(title)) return 'Call';

  const split = /^(.*?)\s+[\u2014-]\s+(.+)$/u.exec(title);
  if (!split) return title;
  const left = split[1].trim();
  const right = split[2].trim();
  if (!isOpaqueMeetingIdentifier(right)) return title;
  return normalizedMeetingTopic(left) ?? 'Call';
}
