import type { WorkerDefinition } from '../../workers/worker-runner';
import type { SyncLogger } from '../../knowledge/sync';
import type { ReleaseNoteNotifier } from '../../outbound/release-note-notifier';
import type { ReleaseNoteSource } from './release-note-source';

// Release-note WORKER builder (ADAPTER — matches the knowledge-sync.worker convention).
// Each tick: list the release notes on disk and run the notifier over each one. The
// notifier is idempotent per (note, customer) via its ledger, so re-scanning the same
// corpus every interval only ever drafts for NEW notes / NEW matching customers.
// runImmediately:true → a boot picks up notes added while the service was down.
//
// ⚠︎ NOT wired into main.ts unless RELEASE_NOTE_DRAFTS_ENABLED (a dormant kill-switch);
// the advisory lock that serializes a double-boot lives at the wiring layer (main.ts),
// mirroring knowledge-sync — this builder only assembles the per-tick loop.

export interface ReleaseNoteWorkerDeps {
  source: ReleaseNoteSource;
  notifier: ReleaseNoteNotifier;
  log: SyncLogger;
  intervalMs: number;
}

export function buildReleaseNoteWorker(deps: ReleaseNoteWorkerDeps): WorkerDefinition {
  const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
  return {
    name: 'release-notes:notify',
    intervalMs: deps.intervalMs,
    runImmediately: true,
    run: async () => {
      const notes = await deps.source.listNotes();
      let drafted = 0;
      let skipped = 0;
      let failed = 0;
      for (const note of notes) {
        try {
          const res = await deps.notifier.notifyForReleaseNote(note);
          drafted += res.drafted;
          skipped += res.skipped;
          failed += res.failed;
        } catch (err) {
          // ⚠︎ per-note isolation: one unreadable/failed note never aborts the batch.
          failed += 1;
          deps.log.warn({ noteKey: note.key, reason: errMessage(err) }, 'release-notes: note failed');
        }
      }
      deps.log.info({ notes: notes.length, drafted, skipped, failed }, 'release-notes notify tick complete');
    },
  };
}
