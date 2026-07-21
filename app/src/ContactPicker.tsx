import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Search, X } from 'lucide-react';
import { api } from './lib/api';
import { cn } from './lib/utils';
import type { CustomerContact, DirectoryContact } from './types';

export interface ContactPickerProps {
  /** Already-selected emails (drives checkmarks). Lowercase to match the wire shape. */
  selected: Set<string>;
  /** Fired with the email toggled when a row is tapped. */
  onToggle: (email: string) => void;
  /** Closes the picker. */
  onClose: () => void;
  /** When set, fetch ONLY this customer's contacts and show a "Show all customers" toggle.
   *  When null/undefined, fetch ALL contacts (no toggle — already unscoped). */
  scopedCustomerId?: string;
  scopedCustomerName?: string;
}

/** A normalized row used for both scoped and unscoped lists so filtering/grouping/render share one
 *  code path. `customerId`/`customerName` carry the grouping key in unscoped mode. */
interface ContactRow {
  name: string;
  email: string;
  isPrimary: boolean;
  customerId: string;
  customerName: string;
}

interface CustomerGroup {
  customerId: string;
  customerName: string;
  contacts: ContactRow[];
}

/**
 * A bottom-sheet multi-select for picking email contacts. Mounted on demand by `InviteesSection`
 * (no `open` prop — the parent conditionally renders it). Selection is LIVE: each row tap fires
 * `onToggle` immediately, so the parent's invitee list reflects the picker's state in real time;
 * the footer "Done" button simply closes the sheet.
 *
 * Two fetch modes keyed off `scopedCustomerId`: scoped hits `/customers/:id/contacts` (one
 * customer, flat list, primary badges); unscoped hits `/contacts` (all customers, grouped into
 * collapsible per-customer sections). When scoped, a "Show all customers" toggle swaps endpoints
 * and remembers the choice for the lifetime of the sheet.
 */
export function ContactPicker({
  selected, onToggle, onClose, scopedCustomerId, scopedCustomerName,
}: ContactPickerProps): ReactElement {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<ContactRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [retryNonce, setRetryNonce] = useState(0);

  const scopedCapable = Boolean(scopedCustomerId);
  // When not scoped-capable, always 'all'. When scoped, 'all' only after the toggle is flipped.
  const mode: 'scoped' | 'all' = scopedCapable && !showAll ? 'scoped' : 'all';

  useEffect(() => {
    setLoading(true);
    setError(false);
    setRows([]);
    const scopedPath = `/customers/${scopedCustomerId}/contacts`;
    const promise =
      mode === 'scoped'
        ? api<{ data: CustomerContact[] }>(scopedPath).then((res) =>
            (res.data ?? []).map((c) => ({
              name: c.name, email: c.email, isPrimary: c.isPrimary,
              customerId: scopedCustomerId ?? '', customerName: scopedCustomerName ?? '',
            })),
          )
        : api<{ data: DirectoryContact[] }>('/contacts').then((res) =>
            (res.data ?? []).map((c) => ({
              name: c.name, email: c.email, isPrimary: c.isPrimary,
              customerId: c.customerId, customerName: c.customerName,
            })),
          );
    promise.then(setRows).catch(() => setError(true)).finally(() => setLoading(false));
    // Re-fetch when the effective endpoint changes (mode swap) or the user hits Retry.
  }, [mode, scopedCustomerId, scopedCustomerName, retryNonce]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      r.name.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      r.customerName.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const groups = useMemo<CustomerGroup[]>(() => {
    if (mode !== 'all') return [];
    const byId = new Map<string, CustomerGroup>();
    for (const r of filtered) {
      let g = byId.get(r.customerId);
      if (!g) { g = { customerId: r.customerId, customerName: r.customerName, contacts: [] }; byId.set(r.customerId, g); }
      g.contacts.push(r);
    }
    return [...byId.values()].sort((a, b) => a.customerName.localeCompare(b.customerName));
  }, [filtered, mode]);

  const toggleCollapse = (customerId: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(customerId)) next.delete(customerId); else next.add(customerId);
      return next;
    });
  };

  const rowCount = (row: ContactRow): ReactElement => {
    const checked = selected.has(row.email);
    return (
      <button
        key={row.email}
        type="button"
        onClick={() => onToggle(row.email)}
        aria-pressed={checked}
        className={cn(
          'flex min-h-11 w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition active:bg-zinc-800/70',
          checked ? 'bg-ember-400/10' : 'bg-transparent',
        )}
      >
        <span className={cn(
          'grid size-5 shrink-0 place-items-center rounded-full border transition',
          checked ? 'border-ember-400 bg-ember-400 text-zinc-950' : 'border-zinc-600 text-transparent',
        )}>
          <Check size={13} strokeWidth={3} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-zinc-100">
            {row.name || row.email}
            {row.isPrimary && (
              <span className="ml-1.5 rounded-full bg-zinc-800 px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-zinc-400">Primary</span>
            )}
          </span>
          <span className="block truncate text-xs text-zinc-500">{row.email}</span>
        </span>
      </button>
    );
  };

  return (
    <div className="fixed inset-0 z-50">
      <button aria-label="Cancel" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Add from contacts"
        className="safe-bottom absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col rounded-t-3xl border-t border-zinc-800 bg-zinc-950 px-4 pb-4 pt-3 shadow-2xl"
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Add from contacts</h2>
          <button aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
            <X size={20} />
          </button>
        </div>

        <div className="relative mb-3">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Search contacts"
            placeholder="Search name or email"
            className="min-h-11 w-full rounded-xl border border-zinc-700 bg-zinc-900 pl-9 pr-3 text-sm text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40"
          />
        </div>

        {scopedCapable && (
          <label className="mb-3 flex min-h-11 cursor-pointer items-center gap-2.5 rounded-xl bg-zinc-900 px-3">
            <input
              type="checkbox"
              checked={showAll}
              onChange={(e) => setShowAll(e.target.checked)}
              className="size-4 accent-ember-400"
            />
            <span className="text-sm text-zinc-300">Show all customers</span>
          </label>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {loading && <div className="flex justify-center py-10"><Loader2 className="animate-spin text-zinc-600" size={22} /></div>}

          {error && (
            <div className="py-8 text-center">
              <p className="mb-3 text-sm text-zinc-400">Couldn't load contacts</p>
              <button
                type="button"
                onClick={() => setRetryNonce((n) => n + 1)}
                className="inline-flex min-h-9 items-center rounded-full bg-zinc-800 px-3 text-xs font-medium text-zinc-200 active:bg-zinc-700"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && mode === 'scoped' && (
            filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-500">{query ? 'No matches' : 'No contacts'}</p>
            ) : (
              <div className="space-y-0.5">{filtered.map(rowCount)}</div>
            )
          )}

          {!loading && !error && mode === 'all' && (
            filtered.length === 0 ? (
              <p className="py-10 text-center text-sm text-zinc-500">{query ? 'No matches' : 'No contacts'}</p>
            ) : (
              <div className="space-y-3">
                {groups.map((g) => {
                  const isCollapsed = collapsed.has(g.customerId);
                  return (
                    <div key={g.customerId} className="rounded-xl bg-zinc-900/40">
                      <button
                        type="button"
                        onClick={() => toggleCollapse(g.customerId)}
                        aria-expanded={!isCollapsed}
                        className="flex min-h-11 w-full items-center gap-2 px-2 text-left"
                      >
                        <ChevronDown size={15} className={cn('shrink-0 text-zinc-500 transition-transform', isCollapsed && '-rotate-90')} />
                        <span className="truncate text-sm font-medium text-zinc-200">{g.customerName}</span>
                        <span className="ml-auto shrink-0 text-xs text-zinc-500">{g.contacts.length}</span>
                      </button>
                      {!isCollapsed && <div className="space-y-0.5 px-1 pb-1">{g.contacts.map(rowCount)}</div>}
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>

        <button
          type="button"
          onClick={onClose}
          className="mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-full bg-ember-400 px-4 text-sm font-medium text-zinc-950 active:scale-[0.98]"
        >
          Done
        </button>
      </div>
    </div>
  );
}
