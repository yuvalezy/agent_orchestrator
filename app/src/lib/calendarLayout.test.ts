import { describe, expect, it } from 'vitest';
import { clockLabel, freeGaps, localTimeAt, makeLocalTime, minuteInDay, packColumns, shiftDay, splitIsoInTz, tapMinuteInGap } from './calendarLayout';

describe('calendarLayout', () => {
  it('reads an instant as a minute-of-day in the given tz, clamping other days', () => {
    // 2026-07-20T13:30:00Z is 09:30 in America/New_York (UTC-4 in July) → 570 minutes.
    expect(minuteInDay('2026-07-20T13:30:00.000Z', '2026-07-20', 'America/New_York')).toBe(9 * 60 + 30);
    // An instant on the following NY day clamps to end-of-day.
    expect(minuteInDay('2026-07-21T13:30:00.000Z', '2026-07-20', 'America/New_York')).toBe(1440);
    // An instant on the previous NY day clamps to start-of-day.
    expect(minuteInDay('2026-07-19T13:30:00.000Z', '2026-07-20', 'America/New_York')).toBe(0);
  });

  it('shifts a bare date by whole days without DST rollover', () => {
    expect(shiftDay('2026-07-20', 1)).toBe('2026-07-21');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
  });

  it('formats a minute-of-day as a bare wall-clock and a founder-facing label', () => {
    expect(localTimeAt('2026-07-20', 9 * 60 + 5)).toBe('2026-07-20T09:05');
    expect(localTimeAt('2026-07-20', 0)).toBe('2026-07-20T00:00');
    expect(clockLabel(9 * 60)).toBe('9 AM');
    expect(clockLabel(13 * 60 + 30)).toBe('1:30 PM');
    expect(clockLabel(0)).toBe('12 AM');
  });

  it('packs overlapping spans into side-by-side lanes and leaves disjoint ones single-lane', () => {
    const packed = packColumns([
      { s: 540, e: 600 }, // 9:00–10:00
      { s: 570, e: 630 }, // 9:30–10:30 (overlaps the first)
      { s: 720, e: 780 }, // 12:00–13:00 (disjoint)
    ]);
    const a = packed.find((p) => p.s === 540)!;
    const b = packed.find((p) => p.s === 570)!;
    const c = packed.find((p) => p.s === 720)!;
    expect(a.lanes).toBe(2);
    expect(b.lanes).toBe(2);
    expect(a.lane).not.toBe(b.lane);
    expect(c.lanes).toBe(1);
    expect(c.lane).toBe(0);
  });

  it('books the TAPPED position inside a gap, not the gap start', () => {
    // Gap 9:00–20:00 (540–1200) at 1.1 px/min. A tap 150 min down (≈165px) lands on 11:30 — the
    // start the sheet must show and post, NOT the gap's 9:00 start (which on today would be `now`).
    expect(tapMinuteInGap(540, 1200, 150 * 1.1, 1.1)).toBe(690); // 11:30
    // Snaps to 5-min granularity: an offset landing on 11:32 rounds to 11:30.
    expect(tapMinuteInGap(540, 1200, 152 * 1.1, 1.1)).toBe(690);
    // A tap at the very top stays at the gap start; a tap past the end clamps inside the gap.
    expect(tapMinuteInGap(540, 1200, 0, 1.1)).toBe(540);
    expect(tapMinuteInGap(540, 1200, 5000, 1.1)).toBe(1195);
  });

  it('subtracts busy spans from the business band, dropping slivers below the minimum', () => {
    // 9:00–17:00 with a 10:00–11:00 meeting → free 9–10 and 11–17.
    const gaps = freeGaps(540, 1020, [{ s: 600, e: 660 }], 15);
    expect(gaps).toEqual([{ s: 540, e: 600 }, { s: 660, e: 1020 }]);
    // A 5-minute remainder is not offered as a slot.
    expect(freeGaps(540, 605, [{ s: 545, e: 600 }], 15)).toEqual([]);
  });

  it('splits an ISO instant into the date + HH:MM wall-clock parts the edit inputs read', () => {
    // 2026-07-21T14:30:00Z in America/Panama (UTC-5, no DST) is 09:30 local on the same day.
    expect(splitIsoInTz('2026-07-21T14:30:00.000Z', 'America/Panama')).toEqual({ date: '2026-07-21', time: '09:30' });
    // The same instant in UTC is 14:30.
    expect(splitIsoInTz('2026-07-21T14:30:00.000Z', 'UTC')).toEqual({ date: '2026-07-21', time: '14:30' });
    // Midnight folds '24' back to '00'.
    expect(splitIsoInTz('2026-07-21T00:00:00.000Z', 'UTC')).toEqual({ date: '2026-07-21', time: '00:00' });
  });

  it('combines a YYYY-MM-DD date + HH:MM time into a datetime-local string', () => {
    expect(makeLocalTime('2026-07-21', '09:30')).toBe('2026-07-21T09:30');
    expect(makeLocalTime('2026-12-31', '00:00')).toBe('2026-12-31T00:00');
  });
});
