import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronRight, Loader2, Search, Users } from 'lucide-react';
import { api } from './lib/api';
import { useAppData } from './AppData';
import { ScreenHeader } from './ScreenHeader';
import { relativeTime } from './lib/time';
import type { CustomerPage, CustomerRow } from './types';

export function CustomersScreen(): ReactElement {
  const navigate = useNavigate();
  const { feed } = useAppData();
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const page = await api<CustomerPage>(`/customers?${new URLSearchParams(query ? { search: query } : {})}`);
      setRows(page.data);
      setCursor(page.nextCursor);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // Debounce the search box; also reload when a live event may have changed a badge.
  useEffect(() => {
    clearTimeout(debounce.current);
    debounce.current = setTimeout(() => void load(search.trim()), 200);
    return () => clearTimeout(debounce.current);
  }, [search, load, feed.eventToken]);

  const loadMore = () => {
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    const params = new URLSearchParams({ cursor, ...(search.trim() ? { search: search.trim() } : {}) });
    void api<CustomerPage>(`/customers?${params}`)
      .then((page) => { setRows((current) => [...current, ...page.data]); setCursor(page.nextCursor); })
      .catch(() => { /* leave the list as-is */ })
      .finally(() => setLoadingMore(false));
  };

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Customers" subtitle="Everyone you're running" settings />
      <div className="safe-x px-3 pt-3">
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-3.5 py-2.5 focus-within:border-ember-500/60">
          <Search size={17} className="shrink-0 text-zinc-500" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers"
            aria-label="Search customers"
            className="min-w-0 flex-1 bg-transparent text-[0.95rem] text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-3">
        {loading && rows.length === 0 && (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin text-zinc-600" size={22} /></div>
        )}
        {!loading && rows.length === 0 && (
          <div className="flex flex-col items-center justify-center px-8 py-24 text-center text-zinc-500">
            <Users size={30} className="text-zinc-600" />
            <p className="mt-4 text-sm">{search.trim() ? 'No customers match that search.' : 'No customers yet.'}</p>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
            {rows.map((row, i) => (
              <button
                key={row.id}
                onClick={() => navigate(`/customer/${row.id}`)}
                className={`flex w-full items-center gap-3 px-4 py-3.5 text-left active:bg-zinc-800/60 ${i === 0 ? '' : 'border-t border-zinc-800'}`}
              >
                <div className="grid size-10 shrink-0 place-items-center rounded-full bg-zinc-800 text-sm font-semibold text-zinc-300">
                  {initials(row.displayName)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium text-zinc-100">{row.displayName}</p>
                    <span className="shrink-0 text-[0.7rem] text-zinc-500">{relativeTime(row.lastActivityAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-xs text-zinc-500">{row.lastActivitySnippet ?? 'No recent activity'}</p>
                </div>
                {row.pendingCount > 0 && (
                  <span className="grid min-w-5 shrink-0 place-items-center rounded-full bg-ember-400 px-1.5 text-[0.7rem] font-bold text-zinc-950">
                    {row.pendingCount}
                  </span>
                )}
                <ChevronRight size={16} className="shrink-0 text-zinc-600" />
              </button>
            ))}
          </div>
        )}

        {cursor && (
          <button onClick={loadMore} disabled={loadingMore} className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl border border-zinc-800 py-2.5 text-sm text-zinc-400 active:bg-zinc-900">
            {loadingMore ? <Loader2 size={15} className="animate-spin" /> : 'Load more'}
          </button>
        )}
      </div>
    </div>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
