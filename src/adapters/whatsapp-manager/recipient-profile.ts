import { logger } from '../../logger';
import type { RecipientGender, RecipientProfilePort } from '../../ports/recipient-profile.port';
import type { WaWhitelistEntry } from './directory-client';

// Gender lives ONLY in whatsapp_manager's whitelist, which the founder curates per
// contact. Invariant #5 forbids reading that service's database, so it comes over its
// HTTP API — and `GET /whitelist` is the only route it exposes (whitelist.service has a
// getGender(phone), but no endpoint publishes it), so a lookup means fetching the list
// and matching locally.
//
// Hence the cache: without it every composed message would re-fetch the whole list. The
// list is one founder's contacts and gender effectively never changes, so a short TTL is
// generous. This sits on the compose path, which already costs two LLM round-trips — one
// cached localhost GET is noise beside it.
//
// EVERY failure resolves to null. A missing gender degrades a message to neutral
// phrasing; a throw here would take down a draft. Never worth it.

const DEFAULT_TTL_MS = 5 * 60_000;

/** Digits-only, matching whatsapp_manager's own normalizeNumber() and the digits-only
 *  `address` this service stores for WhatsApp contacts. Handles '+1 (415) 555-0100' and
 *  '14155550100@c.us' collapsing to the same key. */
export function phoneKey(input: string): string {
  return input.split('@')[0].replace(/\D/g, '');
}

export interface RecipientProfileDeps {
  listWhitelist: () => Promise<WaWhitelistEntry[]>;
  now?: () => number;
  ttlMs?: number;
}

export function buildRecipientProfile(deps: RecipientProfileDeps): RecipientProfilePort {
  const now = deps.now ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;

  let byPhone: Map<string, RecipientGender> | null = null;
  let loadedAt = 0;
  let inFlight: Promise<Map<string, RecipientGender>> | null = null;

  const load = async (): Promise<Map<string, RecipientGender>> => {
    const rows = await deps.listWhitelist();
    const map = new Map<string, RecipientGender>();
    for (const r of rows) {
      // 'unknown' is stored, but it carries no information — leave it out so a miss and
      // an explicit 'unknown' are the same thing to callers.
      if (r.gender === 'male' || r.gender === 'female') {
        const key = phoneKey(r.phone_number);
        if (key) map.set(key, r.gender);
      }
    }
    return map;
  };

  const fresh = async (): Promise<Map<string, RecipientGender>> => {
    if (byPhone && now() - loadedAt < ttlMs) return byPhone;
    // Collapse concurrent misses onto one fetch — a batch of inbound messages would
    // otherwise each fire their own.
    if (!inFlight) {
      inFlight = load()
        .then((map) => {
          byPhone = map;
          loadedAt = now();
          return map;
        })
        .finally(() => { inFlight = null; });
    }
    return inFlight;
  };

  return {
    async resolveGender(channelType, address) {
      // Only WhatsApp contacts are in the whitelist. An email-only customer has no
      // gender source at all, and that is fine — neutral phrasing.
      if (channelType !== 'whatsapp') return null;
      const key = phoneKey(address ?? '');
      if (!key) return null;
      try {
        return (await fresh()).get(key) ?? null;
      } catch (err) {
        // Serve a stale map rather than lose the gender over one blip; only fall back to
        // null when we have never loaded successfully.
        logger.warn({ reason: (err as Error)?.message }, 'recipient profile: whitelist lookup failed');
        return byPhone?.get(key) ?? null;
      }
    },
  };
}
