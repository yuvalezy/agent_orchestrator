import Holidays from 'date-holidays';
import { query } from '../../db';
import { logger } from '../../logger';

// @hebcal/core is ESM-only; this project compiles to CommonJS, so it is loaded via
// dynamic import() (Node supports importing ESM from CJS this way). date-holidays
// is CJS and imports statically.

// Holiday seeding at boot (M1.8, D-K/F9). Adapter layer: it runs OFFLINE libraries
// (no boot network) and writes the orchestrator's OWN agent_holidays table. Both
// current + next year, idempotent via ON CONFLICT (holiday_date, faith) DO NOTHING.
//   • date-holidays → national/public days for HOLIDAY_COUNTRY → faith='global'
//     (business closed for everyone).
//   • @hebcal/core  → melacha-forbidden yom-tov ONLY (major CHAG — NOT minor fasts,
//     Rosh Chodesh, or modern/observance days) → faith='jewish'.
// The 'global' sentinel (never NULL) makes the UNIQUE(holiday_date, faith) dedupe;
// a date that is both public and jewish inserts two distinct-faith rows (correct).
// muslim/buddhist are unseeded (R58).

type QueryFn = typeof query;

export interface HolidayRow {
  date: string; // 'YYYY-MM-DD'
  name: string;
  faith: 'global' | 'jewish';
}

/** Local-date 'YYYY-MM-DD' (NOT toISOString — that would tz-shift the calendar day). */
function toLocalIsoDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Compute the seed rows for one country + Gregorian year (over the offline libs). */
export async function collectHolidayRows(country: string, year: number): Promise<HolidayRow[]> {
  const rows: HolidayRow[] = [];

  const hd = new Holidays(country);
  for (const h of hd.getHolidays(year)) {
    if (h.type !== 'public') continue; // national closures only
    rows.push({ date: String(h.date).slice(0, 10), name: h.name, faith: 'global' });
  }

  const { HebrewCalendar, flags } = await import('@hebcal/core');
  const events = HebrewCalendar.calendar({ year, isHebrewYear: false, il: false });
  for (const ev of events) {
    if ((ev.getFlags() & flags.CHAG) === 0) continue; // melacha-forbidden yom-tov only
    rows.push({ date: toLocalIsoDate(ev.getDate().greg()), name: ev.render('en'), faith: 'jewish' });
  }

  return rows;
}

/** Insert rows idempotently. Returns how many were newly inserted (ON CONFLICT skips the rest). */
export async function insertHolidayRows(db: QueryFn, rows: HolidayRow[]): Promise<number> {
  let inserted = 0;
  for (const r of rows) {
    const res = await db(
      `INSERT INTO agent_holidays (holiday_date, name, faith)
       VALUES ($1::date, $2, $3)
       ON CONFLICT (holiday_date, faith) DO NOTHING`,
      [r.date, r.name, r.faith],
    );
    inserted += res.rowCount ?? 0;
  }
  return inserted;
}

/** Seed current + next year at boot. Non-fatal on failure (the drainer degrades to
 *  business-hours-only gating). `db`/`year` are injectable for tests. */
export async function seedHolidays(opts: { country: string; db?: QueryFn; year?: number }): Promise<void> {
  const db = opts.db ?? query;
  const year = opts.year ?? new Date().getFullYear();
  const rows = [
    ...(await collectHolidayRows(opts.country, year)),
    ...(await collectHolidayRows(opts.country, year + 1)),
  ];
  const inserted = await insertHolidayRows(db, rows);
  logger.info({ country: opts.country, years: [year, year + 1], candidates: rows.length, inserted }, 'holidays seeded');
}
