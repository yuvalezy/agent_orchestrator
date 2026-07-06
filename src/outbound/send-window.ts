import { DateTime } from 'luxon';

// Core, PURE send-window computation (M1.8, D-D). No db / adapter / clock-of-its-own
// — the caller passes `nowUtc` and the loaded schedule so this is fully testable.
// luxon is the only dependency (a pure date lib). The D1 boundary holds trivially.
//
// Rules (from changes/01/specs/outbound-delivery/spec.md:19-24):
//   • Business hours ALWAYS apply. agent_business_hours.day_of_week is 0=Sunday..6=Sat;
//     luxon DateTime.weekday is 1=Mon..7=Sun → index by `weekday % 7` (Sun 7%7=0). (F5)
//   • A MISSING day_of_week row → non-working (fail-safe). (F5)
//   • A holiday defers iff holiday.faith==='global' OR holiday.faith===customer.faith;
//     faith null/'none' → only global holidays defer.
//   • nextOpenUtc forward-scans working days to the next open window start in the
//     customer tz, CAPPED at 14 iterations — none found → null so the caller alerts
//     + defers 24h rather than looping. (F5)

export interface BusinessHour {
  dayOfWeek: number; // 0=Sunday..6=Saturday (agent_business_hours.day_of_week)
  startTime: string; // 'HH:MM' or 'HH:MM:SS'
  endTime: string;
  isWorkingDay: boolean;
}

export interface Holiday {
  date: string; // 'YYYY-MM-DD' (customer-local calendar date)
  faith: string; // 'global' | 'jewish' | ... ('global' sentinel, never null)
}

export interface SendWindowInput {
  nowUtc: Date;
  tz: string;
  businessHours: BusinessHour[];
  holidays: Holiday[];
  faith: string | null; // customer faith; null/'none' → only global holidays defer
}

export interface SendWindowResult {
  allowed: boolean;
  nextOpenUtc: Date | null;
  reason?: 'off_hours' | 'holiday';
}

const SCAN_CAP_DAYS = 14;

/** 'HH:MM[:SS]' → { hour, minute } (seconds ignored — windows are minute-grained). */
function parseTime(t: string): { hour: number; minute: number } {
  const [h, m] = t.split(':');
  return { hour: Number(h), minute: Number(m ?? 0) };
}

/** Does a customer-local calendar date fall on a relevant holiday? */
function isHoliday(dateIso: string, holidays: Holiday[], faith: string | null): boolean {
  const effFaith = faith && faith !== 'none' ? faith : null;
  return holidays.some(
    (h) => h.date === dateIso && (h.faith === 'global' || (effFaith !== null && h.faith === effFaith)),
  );
}

export function computeSendWindow(input: SendWindowInput): SendWindowResult {
  const { nowUtc, tz, businessHours, holidays, faith } = input;
  const byDow = new Map<number, BusinessHour>();
  for (const bh of businessHours) byDow.set(bh.dayOfWeek, bh);

  const zone = DateTime.local().setZone(tz).isValid ? tz : 'utc';
  const now = DateTime.fromJSDate(nowUtc, { zone });

  // Is `now` inside an open window today?
  const todayDow = now.weekday % 7; // luxon 1=Mon..7=Sun → 0=Sun..6=Sat
  const todayRow = byDow.get(todayDow);
  const todayIsHoliday = isHoliday(now.toISODate() ?? '', holidays, faith);
  let allowed = false;
  let reason: 'off_hours' | 'holiday' | undefined;

  if (todayIsHoliday) {
    reason = 'holiday';
  } else if (!todayRow || !todayRow.isWorkingDay) {
    reason = 'off_hours';
  } else {
    const s = parseTime(todayRow.startTime);
    const e = parseTime(todayRow.endTime);
    const open = now.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 });
    const close = now.set({ hour: e.hour, minute: e.minute, second: 0, millisecond: 0 });
    if (now >= open && now < close) allowed = true;
    else reason = 'off_hours';
  }

  if (allowed) return { allowed: true, nextOpenUtc: null };

  // Forward-scan (capped) for the next open window start.
  for (let d = 0; d < SCAN_CAP_DAYS; d += 1) {
    const day = now.plus({ days: d }).startOf('day');
    const dow = day.weekday % 7;
    const row = byDow.get(dow);
    if (!row || !row.isWorkingDay) continue;
    if (isHoliday(day.toISODate() ?? '', holidays, faith)) continue;
    const s = parseTime(row.startTime);
    const open = day.set({ hour: s.hour, minute: s.minute, second: 0, millisecond: 0 });
    if (open > now) {
      return { allowed: false, nextOpenUtc: open.toUTC().toJSDate(), reason };
    }
  }

  // No open window within the cap → caller alerts + defers 24h (fail-safe, no loop).
  return { allowed: false, nextOpenUtc: null, reason };
}
