import { getAppState, setAppState, clearAppState } from '../../db/app-state';
import { buildThreadMarkers } from '../../triage/thread-markers';

// THE process-wide marker set for the whole founder surface, backed by app_state.
//
// Extracted from callback-poller.factory.ts (where it was a module-level const) because a
// SECOND composition site now needs the SAME instance: the Telegram notifier arms an
// askFounder question's marker at send time (telegram/factory.ts), while the callback
// poller reads and clears it. Two separately-built marker sets over the same store would
// still "work" — they share app_state — but the arrangement invites a future variant with
// a different clock or store, and thread-markers' mutual-exclusion invariant (arming any
// kind clears every OTHER kind on that thread) is only meaningful if every marker kind
// goes through one set. One instance makes that structural rather than a convention.
//
// Kept in adapters/: it binds the core marker logic to the real app_state store and the
// real clock, which is composition, not domain.
export const threadMarkers = buildThreadMarkers(
  { get: getAppState, set: setAppState, clear: clearAppState },
  () => new Date(),
);
