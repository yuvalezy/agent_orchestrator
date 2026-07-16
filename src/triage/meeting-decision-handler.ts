import { logger } from '../logger';
import type { DecisionEvent } from '../ports/founder-notifier.port';
import { parseMeetingOption, type MeetingScheduler } from './meeting-scheduler';

// Routes a founder's meeting button tap to the scheduler (CORE — no adapter, D1).
//
// The callback_data contract (decision-handler.ts::parseOptionData) is `<optionId>:<ref>`, split
// on the FIRST colon. So the meeting ids carry no colon of their own (md30, ms1, mso, mtask) and
// the ref is the meeting-request uuid — 40 bytes all-in, inside Telegram's 64-byte cap. The slot
// INSTANTS never travel in the button; they live in the request row's `slots` JSONB and the
// button carries only an index into it.
//
// This is also why the flow survives the 30-minute marker TTL: a tap is a self-contained
// DecisionEvent, and the row it points at has no expiry. The founder can answer tomorrow.

export interface MeetingDecisionHandler {
  isMeetingOption(optionId: string): boolean;
  handle(d: DecisionEvent): Promise<void>;
}

export function buildMeetingDecisionHandler(scheduler: MeetingScheduler): MeetingDecisionHandler {
  return {
    isMeetingOption: (optionId) => parseMeetingOption(optionId) !== null,
    async handle(d: DecisionEvent): Promise<void> {
      const opt = parseMeetingOption(d.optionId);
      const meetingId = d.notificationRef;
      if (!opt || !meetingId) return;

      switch (opt.kind) {
        case 'duration':
          return scheduler.onDuration(meetingId, opt.minutes);
        case 'slot':
          return scheduler.onSlot(meetingId, opt.index, `telegram:${d.by}`);
        case 'task':
          return scheduler.onDecline(meetingId);
        case 'other':
          // Not offered today (see MEETING_OTHER_TIME) — this only catches a tap on a stale
          // keyboard. Swallowing it is the point: without this branch the id would fall past the
          // router to the free-text query engine, which answers anything fluently and would
          // convince the founder they'd been understood.
          logger.info({ meetingId }, 'meeting: stale "other time" tap — not offered in this build');
          return;
      }
    },
  };
}
