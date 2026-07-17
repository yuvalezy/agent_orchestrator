import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from './lib/api';
import { useAppData } from './AppData';
import { ScreenHeader } from './ScreenHeader';
import { Timeline } from './Timeline';
import { AttentionCard } from './AttentionCard';
import { CustomerAsk } from './CustomerAsk';
import { DetailSheet } from './DetailSheet';
import { Screen, Pane, ScrollArea } from './Layout';
import { useOptimisticDecide } from './useOptimisticDecide';
import { cn } from './lib/utils';
import type { AttentionCard as AttentionCardData, CustomerDetail, DetailKind, TimelinePage, TimelineRow } from './types';

type Tab = 'timeline' | 'pending' | 'ask';
const tabs: ReadonlyArray<readonly [Tab, string]> = [['timeline', 'Timeline'], ['pending', 'Pending'], ['ask', 'Ask']];

export function CustomerScreen(): ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { attention } = useAppData();
  const [tab, setTab] = useState<Tab>('timeline');
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);

  // `?focus=<eventType>:<entityId>` is a card asking for the thread behind it (from anywhere:
  // Attention, Pending, Activity, a push tap). Answering it means being on the timeline.
  const focusId = params.get('focus');
  useEffect(() => { if (focusId) setTab('timeline'); }, [focusId]);

  useEffect(() => {
    let live = true;
    void api<{ data: CustomerDetail }>(`/customers/${id}`).then((res) => { if (live) setCustomer(res.data); }).catch(() => {});
    return () => { live = false; };
  }, [id]);

  // Group by the customers-list id; prefer an explicit customerId, fall back to customerRef.
  const pending = (attention?.decisions ?? []).filter((card) => (card.customerId ?? card.customerRef) === id);

  return (
    <Screen>
      <ScreenHeader title={customer?.displayName ?? 'Customer'} subtitle={pending.length > 0 ? `${pending.length} pending` : undefined} onBack={() => navigate('/customers')} />

      <div className="safe-x px-3 pt-3">
        <div className="flex gap-1 rounded-2xl bg-zinc-900 p-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={cn(
                'flex-1 rounded-xl py-2 text-sm font-medium transition',
                tab === key ? 'bg-zinc-800 text-zinc-100 shadow' : 'text-zinc-500 active:text-zinc-300',
              )}
            >
              {label}
              {key === 'pending' && pending.length > 0 && (
                <span className="ml-1.5 rounded-full bg-ember-400 px-1.5 text-[0.65rem] font-bold text-zinc-950">{pending.length}</span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Pane = a bounded flex-col, so the active tab (esp. the flex-1 Ask chat) gets a real
          height to scroll inside instead of growing to content and hiding its tail. */}
      <Pane className="overflow-hidden">
        {tab === 'timeline' && <TimelineTab customerId={id} focusId={focusId} />}
        {tab === 'pending' && <PendingTab customerId={id} pending={pending} />}
        {tab === 'ask' && <CustomerAsk customerId={id} />}
      </Pane>
    </Screen>
  );
}

/**
 * Insert-or-replace by id, keeping the thread NEWEST-first (the API's order; `Timeline` reverses
 * it to render). Mirrors `useFeed`'s merge — same job, opposite sort — so a live refresh adds
 * what is new and updates what changed without discarding the pages already loaded.
 */
function mergeRows(current: TimelineRow[], incoming: TimelineRow[]): TimelineRow[] {
  const map = new Map(current.map((row) => [row.id, row]));
  for (const row of incoming) map.set(row.id, row);
  return [...map.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });
}

function TimelineTab({ customerId, focusId }: { customerId: string; focusId: string | null }): ReactElement {
  const { feed } = useAppData();
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [detail, setDetail] = useState<{ kind: DetailKind; id: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api<TimelinePage>(`/customers/${customerId}/timeline`);
      setRows(page.data);
      setCursor(page.nextCursor);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  // Opening this customer (or switching to another) starts the thread fresh.
  useEffect(() => { void load(); }, [load]);

  // A live refresh MERGES; it must never re-seed. `feed.eventToken` bumps on EVERY row of the
  // global SSE stream — including other customers' — so a full replace here would throw away the
  // founder's paged-back history the moment the assistant did anything for anyone else, and
  // strand their viewport (the reload is not routed through the hook's prepend pin). Merging
  // keeps every loaded page, picks up status changes in place, and leaves `cursor` alone: it
  // already points past the OLDEST page we hold, which a first-page refetch knows nothing about.
  const token = feed.eventToken;
  const seenToken = useRef(token);
  useEffect(() => {
    if (token === seenToken.current) return; // the mount tick — `load` above already ran
    seenToken.current = token;
    let live = true;
    void api<TimelinePage>(`/customers/${customerId}/timeline`)
      .then((page) => { if (live) setRows((current) => mergeRows(current, page.data)); })
      .catch(() => { /* a dropped refresh just leaves the thread as it was */ });
    return () => { live = false; };
  }, [token, customerId]);

  const loadOlder = () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    void api<TimelinePage>(`/customers/${customerId}/timeline?cursor=${encodeURIComponent(cursor)}`)
      // `rows` is newest-first (the API's own order; Timeline reverses it to read as a thread),
      // so an older page APPENDS. Prepending — the shape this had while the list rendered
      // newest-first — puts the oldest history below the newest once reversed.
      .then((page) => { setRows((current) => [...current, ...page.data]); setCursor(page.nextCursor); })
      .catch(() => { /* a failed scroll-back just leaves older history unloaded */ })
      .finally(() => setLoadingOlder(false));
  };

  if (loading && rows.length === 0) return <Center><Loader2 className="animate-spin text-zinc-600" size={20} /></Center>;
  if (rows.length === 0) return <Center><p className="text-sm text-zinc-500">No activity recorded yet.</p></Center>;

  // The thread owns its own scroll container (it has to: it pins the viewport on prepend and
  // opens at the bottom), so this tab hands it the page state and stays out of the way.
  return (
    <Screen>
      <Timeline
        rows={rows}
        hasMore={cursor !== null}
        loadingOlder={loadingOlder}
        onLoadOlder={loadOlder}
        onOpen={(kind, itemId) => setDetail({ kind, id: itemId })}
        focusId={focusId}
      />
      <DetailSheet target={detail} onClose={() => setDetail(null)} />
    </Screen>
  );
}

function PendingTab({ customerId, pending }: { customerId: string; pending: AttentionCardData[] }): ReactElement {
  const { decide, decidedFor } = useOptimisticDecide();

  if (pending.length === 0) return <Center><p className="text-sm text-zinc-500">Nothing pending for this customer.</p></Center>;
  return (
    <ScrollArea className="space-y-2.5 px-3 py-3 pb-6" key={customerId}>
      {pending.map((card) => (
        <AttentionCard key={card.id} card={card} decidedOptionId={decidedFor(card)} onDecide={decide} />
      ))}
    </ScrollArea>
  );
}

function Center({ children }: { children: ReactElement }): ReactElement {
  return <div className="grid h-full place-items-center p-8">{children}</div>;
}
