// Early-warning failure tracker (M1.9 / §9.5). The inbox-processor logs per-row
// triage failures but only ALERTS the founder via the ~30-min failStuck terminal
// path — too late to notice a dependency outage (portal/LLM/DB down). This tracks
// a failure EPISODE so the founder gets ONE early admin notice as soon as failures
// cross a threshold, and a recovery notice when triage resumes. Pure (no I/O) →
// core, unit-testable; the adapter (inbox-processor.factory) wires the notifier.

export class FailureEpisodeTracker {
  private failures = 0;
  private alerted = false;

  constructor(private readonly threshold: number) {}

  /** Record a triage failure. Returns `{ alert: true }` exactly once per episode —
   *  on the failure that first reaches the threshold — so a dependency outage
   *  raises a single early warning, not one per failing row. */
  recordFailure(): { alert: boolean; count: number } {
    this.failures += 1;
    if (this.failures >= this.threshold && !this.alerted) {
      this.alerted = true;
      return { alert: true, count: this.failures };
    }
    return { alert: false, count: this.failures };
  }

  /** Record a triage success. Resets the episode (re-arming the early warning for
   *  the next outage). Returns `recovered: true` iff an early warning had fired —
   *  the caller then posts a "recovered" notice. */
  recordSuccess(): { recovered: boolean; priorFailures: number } {
    const recovered = this.alerted;
    const priorFailures = this.failures;
    this.failures = 0;
    this.alerted = false;
    return { recovered, priorFailures };
  }
}
