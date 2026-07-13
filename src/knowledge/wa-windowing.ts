// CORE (pure, ports-free): split one WhatsApp chat's messages into discussion "windows" so the
// backfill reconciles a bounded, topically-coherent segment at a time — NOT a months-long chat as
// one muddled unit. A window boundary is drawn when the gap between consecutive messages exceeds
// `idleGapMs` (a fresh conversation), or when a burst hits `maxPerWindow` (hard length cap). This
// keeps each classifier call focused and lets the same subject discussed in two sittings surface as
// two candidates (later de-duplicated by the sweep-wide collapse), instead of being lost.

export interface WaWindowMessage {
  from: string;
  body: string;
  at: Date;
}

export interface WaWindow {
  /** Timestamp of the window's first message — the stable idempotency suffix for its threadKey. */
  startAt: Date;
  messages: WaWindowMessage[];
}

export interface WaWindowConfig {
  /** A gap longer than this between consecutive messages starts a new window. */
  idleGapMs: number;
  /** Hard cap on messages per window (a long unbroken burst is split). */
  maxPerWindow: number;
}

/** Window a single chat. Input need not be pre-sorted (sorted by `at` ascending here). Messages
 *  with an empty/whitespace body are dropped before windowing. Returns windows oldest-first. */
export function windowChat(messages: WaWindowMessage[], config: WaWindowConfig): WaWindow[] {
  const clean = messages
    .filter((m) => m.body?.trim())
    .slice()
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  if (clean.length === 0) return [];

  const windows: WaWindow[] = [];
  let current: WaWindowMessage[] = [];
  let prevAt: number | null = null;

  for (const m of clean) {
    const t = m.at.getTime();
    const gapExceeded = prevAt !== null && t - prevAt > config.idleGapMs;
    const full = current.length >= config.maxPerWindow;
    if (current.length > 0 && (gapExceeded || full)) {
      windows.push({ startAt: current[0].at, messages: current });
      current = [];
    }
    current.push(m);
    prevAt = t;
  }
  if (current.length > 0) windows.push({ startAt: current[0].at, messages: current });
  return windows;
}
