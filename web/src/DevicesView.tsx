import { type ReactElement } from 'react';
import { SubscribersPanel } from './SubscribersPanel';

// Top-level "Devices" nav target. Owns the page header; SubscribersPanel renders the two
// sections (Phones, Browsers) and the per-row actions. Filtered to Active by default so the
// founder sees what is currently receiving push, not historical noise.
export function DevicesView(): ReactElement {
  return (
    <section>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Push delivery</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Phones and browsers receiving founder push notifications. Disable push to stop notifications on a row that stays logged in; revoke a device to fully sign it out. Filter defaults to Active — switch to All to see history.</p>
      </div>
      <div className="mt-6"><SubscribersPanel /></div>
    </section>
  );
}
