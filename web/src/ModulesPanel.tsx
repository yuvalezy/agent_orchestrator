import { type ReactElement, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Boxes, CheckCircle2, Globe, Search } from 'lucide-react';
import { api, type ApiError } from './lib/api';

// Module scoping (C): declare which portal modules a customer actually uses. A multi-select over the
// corpus vocabulary, pre-checked from the customer's current ACTIVE modules (auto-seeded rows look
// pre-checked). Saving turns scoping ON; leaving it untouched keeps the customer unscoped (sees all
// modules). Self-contained + customer-id driven, so it drops into the Customers screen (primary home)
// or anywhere else. Reuses the existing /onboarding/* module endpoints (invisible URL prefix). Every
// option is keyed by its non-empty module_key.

interface ModuleRow { moduleKey: string; source: 'auto' | 'operator' | 'portal'; active: boolean }
interface ModulesState { modules: ModuleRow[]; moduleScopingEnabled: boolean }

export function ModulesPanel({ customerId }: { customerId: string }): ReactElement {
  const vocabulary = useQuery({
    queryKey: ['modules-vocab'],
    queryFn: () => api<{ data: string[] }>('/onboarding/modules/vocabulary'),
  });
  const current = useQuery({
    queryKey: ['customer-modules', customerId],
    queryFn: () => api<{ data: ModulesState }>(`/onboarding/${customerId}/modules`),
  });

  // `null` = not yet seeded from the server. Seed once from the customer's current ACTIVE modules,
  // then the operator's edits are authoritative (a refetch after save never clobbers them). Re-seeds
  // when the selected customer changes (customerId in the deps).
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => { setSelected(null); setFilter(''); }, [customerId]);
  useEffect(() => {
    if (current.data && selected === null) {
      setSelected(new Set(current.data.data.modules.filter((m) => m.active).map((m) => m.moduleKey)));
    }
  }, [current.data, selected]);

  const save = useMutation({
    mutationFn: (keys: string[]) => api(`/onboarding/${customerId}/modules`, { method: 'PUT', body: JSON.stringify({ moduleKeys: keys }) }),
    onSuccess: () => void current.refetch(),
  });

  const rows = current.data?.data.modules ?? [];
  const sourceOf = useMemo(() => new Map(rows.map((r) => [r.moduleKey, r.source])), [rows]);
  const scopingEnabled = current.data?.data.moduleScopingEnabled ?? false;

  // Options = the corpus vocabulary ∪ the customer's own rows (so a custom/auto-seeded key not in the
  // shared corpus — e.g. 'pilates-gal' — still shows). Empty keys are never offered.
  const options = useMemo(() => {
    const union = new Set<string>([...(vocabulary.data?.data ?? []), ...rows.map((r) => r.moduleKey)]);
    return [...union].map((k) => k.trim()).filter((k) => k.length > 0).sort((a, b) => a.localeCompare(b));
  }, [vocabulary.data, rows]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? options.filter((k) => k.toLowerCase().includes(q)) : options;
  }, [options, filter]);

  const toggle = (key: string): void => {
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const loading = vocabulary.isLoading || current.isLoading || selected === null;
  const count = selected?.size ?? 0;
  const err = (e: unknown): string => (e as ApiError)?.message ?? 'Request failed';

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold"><Boxes size={15} className="text-emerald-300" />Modules this customer uses</h2>
      <p className="mb-4 text-sm leading-6 text-zinc-400">
        Check only the portal modules this customer actually uses. The agent then never references, explains, or attributes behavior to a module they don't have. Auto-detected modules are pre-checked — deselect any that don't apply.
      </p>

      {!scopingEnabled && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-sky-800/60 bg-sky-950/30 p-4 text-sm text-sky-100">
          <Globe size={16} className="mt-0.5 shrink-0" />
          <span>Currently <span className="font-medium">unscoped</span> — this customer sees all modules. Save a selection below to narrow them.</span>
        </div>
      )}

      {vocabulary.isError && <p className="mb-2 text-sm text-red-400">{err(vocabulary.error)}</p>}
      {current.isError && <p className="mb-2 text-sm text-red-400">{err(current.error)}</p>}

      {loading && !vocabulary.isError && !current.isError ? (
        <p className="text-sm text-zinc-500">Loading modules…</p>
      ) : (
        <>
          <div className="mb-3 flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2">
            <Search size={14} className="shrink-0 text-zinc-500" />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              maxLength={60}
              placeholder="Filter modules…"
              className="w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
            />
          </div>

          <div className="grid max-h-72 grid-cols-1 gap-1 overflow-y-auto rounded-lg border border-zinc-800 p-1 sm:grid-cols-2">
            {shown.length === 0 && <p className="px-3 py-4 text-sm text-zinc-500">No modules match “{filter}”.</p>}
            {shown.map((key) => {
              const src = sourceOf.get(key);
              const checked = selected?.has(key) ?? false;
              return (
                <label key={key} className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-zinc-900/60">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(key)}
                    className="size-4 shrink-0 accent-emerald-400"
                  />
                  <span className="min-w-0 truncate font-mono text-[13px] text-zinc-200">{key}</span>
                  {src && <span className="ml-auto shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{src}</span>}
                </label>
              );
            })}
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button
              disabled={selected === null || save.isPending}
              onClick={() => save.mutate([...(selected ?? [])])}
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 enabled:hover:bg-emerald-300 disabled:opacity-50"
            >
              <Boxes size={16} />{save.isPending ? 'Saving…' : 'Save modules'}
            </button>
            <span className="text-xs text-zinc-500">{count} selected</span>
            {save.isSuccess && !save.isPending && <span className="inline-flex items-center gap-1 text-xs text-emerald-300"><CheckCircle2 size={14} />Saved — scoping is on.</span>}
          </div>
          {save.isError && <p className="mt-2 text-sm text-red-400">{err(save.error)}</p>}
        </>
      )}
    </section>
  );
}
