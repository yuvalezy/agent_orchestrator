import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api } from './lib/api';
import { useAppData } from './AppData';
import { ScreenHeader } from './ScreenHeader';
import { Timeline } from './Timeline';
import { AttentionCard } from './AttentionCard';
import { CustomerAsk } from './CustomerAsk';
import { DetailSheet } from './DetailSheet';
import { cn } from './lib/utils';
import type { CustomerDetail, DetailKind, TimelinePage, TimelineRow } from './types';

type Tab = 'timeline' | 'pending' | 'ask';
const tabs: ReadonlyArray<readonly [Tab, string]> = [['timeline', 'Timeline'], ['pending', 'Pending'], ['ask', 'Ask']];

export function CustomerScreen(): ReactElement {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { attention, feed } = useAppData();
  const [tab, setTab] = useState<Tab>('timeline');
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);

  useEffect(() => {
    let live = true;
    void api<{ data: CustomerDetail }>(`/customers/${id}`).then((res) => { if (live) setCustomer(res.data); }).catch(() => {});
    return () => { live = false; };
  }, [id]);

  // Group by the customers-list id; prefer an explicit customerId, fall back to customerRef.
  const pending = (attention?.decisions ?? []).filter((card) => (card.customerId ?? card.customerRef) === id);

  return (
    <div className="flex h-full flex-col">
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

      <div className="min-h-0 flex-1 overflow-hidden">
        {tab === 'timeline' && <TimelineTab customerId={id} />}
        {tab === 'pending' && <PendingTab customerId={id} pending={pending} decide={feed.decide} />}
        {tab === 'ask' && <CustomerAsk customerId={id} />}
      </div>
    </div>
  );
}

function TimelineTab({ customerId }: { customerId: string }): ReactElement {
  const { feed } = useAppData();
  const [rows, setRows] = useState<TimelineRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  // Reload the thread when a live event might touch this customer.
  useEffect(() => { void load(); }, [load, feed.eventToken]);

  const loadOlder = () => {
    if (!cursor) return;
    void api<TimelinePage>(`/customers/${customerId}/timeline?cursor=${encodeURIComponent(cursor)}`)
      .then((page) => { setRows((current) => [...page.data, ...current]); setCursor(page.nextCursor); })
      .catch(() => {});
  };

  if (loading && rows.length === 0) return <Center><Loader2 className="animate-spin text-zinc-600" size={20} /></Center>;
  if (rows.length === 0) return <Center><p className="text-sm text-zinc-500">No activity recorded yet.</p></Center>;

  return (
    <div className="h-full overflow-y-auto pb-6">
      {cursor && (
        <button onClick={loadOlder} className="mx-auto my-2 block rounded-full border border-zinc-800 px-4 py-1.5 text-xs text-zinc-400 active:bg-zinc-900">
          Load earlier
        </button>
      )}
      <Timeline rows={rows} onOpen={(kind, itemId) => setDetail({ kind, id: itemId })} />
      <DetailSheet target={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function PendingTab({
  customerId,
  pending,
  decide,
}: {
  customerId: string;
  pending: import('./types').AttentionCard[];
  decide: (messageId: string, optionId: string) => Promise<void>;
}): ReactElement {
  const [optimistic, setOptimistic] = useState<Record<string, string>>({});
  const onDecide = async (messageId: string, optionId: string) => {
    setOptimistic((m) => ({ ...m, [messageId]: optionId }));
    try {
      await decide(messageId, optionId);
    } catch (err) {
      setOptimistic((m) => { const next = { ...m }; delete next[messageId]; return next; });
      throw err;
    }
  };

  if (pending.length === 0) return <Center><p className="text-sm text-zinc-500">Nothing pending for this customer.</p></Center>;
  return (
    <div className="h-full space-y-2.5 overflow-y-auto px-3 py-3 pb-6" key={customerId}>
      {pending.map((card) => (
        <AttentionCard key={card.id} card={card} decidedOptionId={card.decidedOptionId ?? optimistic[card.id] ?? null} onDecide={onDecide} />
      ))}
    </div>
  );
}

function Center({ children }: { children: ReactElement }): ReactElement {
  return <div className="grid h-full place-items-center p-8">{children}</div>;
}
