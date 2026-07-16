// How askFounder's inline buttons are packed into ROWS.
//
// Every option used to go into ONE row (`[options.map(...)]`). Telegram splits a row's width
// equally among its buttons and truncates each label to fit, so the meeting slot prompt —
// four "Thu 17 Jul 11:00" plus "Just make a task" — rendered as "Thu 1…  Thu 1…  Fri 17 …
// Fri 17 …  Just …". The founder was asked to choose between five buttons that no longer said
// what they meant, which is worse than a longer message: a mis-tap here books a real meeting
// and emails a real customer.
//
// Packing is by LABEL LENGTH against a width budget rather than a fixed columns-per-row,
// because the same askFounder serves both shapes: four 6-char durations fit one row
// comfortably, while two 16-char slots do not. A budget expresses the actual constraint
// (how much text fits across a phone), so both lay out correctly without the caller
// declaring a preference it has no way to compute.

/** Roughly how many label characters read comfortably across one row on a narrow phone.
 *  Telegram gives no width API, so this is a heuristic — deliberately conservative, since
 *  the cost of one row too few is a truncated label and the cost of one too many is a
 *  slightly taller message. */
const ROW_CHAR_BUDGET = 24;
/** Hard cap regardless of length: five 2-char buttons in a row are unmistakable but tiny. */
const MAX_PER_ROW = 4;

export interface KeyboardButton {
  text: string;
  callback_data: string;
}

/**
 * Pack options into rows, greedily, preserving the caller's order.
 *
 * Order is preserved rather than optimized (e.g. bin-packing by length) because the option
 * order is meaningful — escapes like "Just make a task" are listed last on purpose, and
 * reordering would move a destructive-ish choice under the founder's thumb.
 */
export function layoutInlineKeyboard(
  options: ReadonlyArray<{ id: string; label: string }>,
): KeyboardButton[][] {
  const rows: KeyboardButton[][] = [];
  let row: KeyboardButton[] = [];
  let width = 0;

  for (const o of options) {
    const btn = { text: o.label, callback_data: o.id };
    const len = o.label.length;
    // A label longer than the whole budget can't share a row with anything — give it its own
    // rather than letting it drag a neighbour into truncation with it.
    const wouldOverflow = row.length > 0 && (width + len > ROW_CHAR_BUDGET || row.length >= MAX_PER_ROW);
    if (wouldOverflow) {
      rows.push(row);
      row = [];
      width = 0;
    }
    row.push(btn);
    width += len;
  }
  if (row.length) rows.push(row);
  return rows;
}
