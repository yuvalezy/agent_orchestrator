import { type ReactElement, useState } from 'react';
import { ChevronRight, CircleCheck, Flame, Loader2 } from 'lucide-react';
import { useAppData } from './AppData';
import { AttentionCard } from './AttentionCard';
import { DetailSheet } from './DetailSheet';
import { ScreenHeader } from './ScreenHeader';
import { useOptimisticDecide } from './useOptimisticDecide';
import { relativeTime } from './lib/time';
import type { DetailKind, UrgencyItem } from './types';

export function AttentionScreen(): ReactElement {
  const { attention, attentionLoading } = useAppData();
  const { decide, decidedFor } = useOptimisticDecide();
  const [detail, setDetail] = useState<{ kind: DetailKind; id: string } | null>(null);

  const decisions = attention?.decisions ?? [];
  const urgency = attention?.urgency ?? [];
  const pending = decisions.length;

  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Attention" subtitle={pending > 0 ? `${pending} waiting on you` : 'Your action queue'} settings />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-2">
        {attentionLoading && !attention && (
          <div className="flex justify-center py-16"><Loader2 className="animate-spin text-zinc-600" size={22} /></div>
        )}

        {attention && decisions.length === 0 && urgency.length === 0 && (
          <div className="flex flex-col items-center justify-center px-8 py-24 text-center">
            <div className="grid size-16 place-items-center rounded-full bg-emerald-400/10 text-emerald-300">
              <CircleCheck size={32} />
            </div>
            <p className="mt-5 text-lg font-semibold">All clear</p>
            <p className="mt-1.5 text-sm leading-relaxed text-zinc-500">Nothing needs a decision right now. New requests land here the moment they arrive.</p>
          </div>
        )}

        {decisions.length > 0 && (
          <section className="space-y-2.5">
            {decisions.map((card) => (
              <AttentionCard key={card.id} card={card} decidedOptionId={decidedFor(card)} onDecide={decide} />
            ))}
          </section>
        )}

        {urgency.length > 0 && (
          <section className="mt-6">
            <div className="mb-2 flex items-center gap-1.5 px-1">
              <Flame size={14} className="text-amber-400" />
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Needs a look</h2>
            </div>
            <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/40">
              {urgency.map((item, i) => (
                <UrgencyRow key={item.id} item={item} first={i === 0} onOpen={item.itemKind && item.itemId ? () => setDetail({ kind: item.itemKind!, id: item.itemId! }) : undefined} />
              ))}
            </div>
          </section>
        )}
      </div>

      <DetailSheet target={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

function UrgencyRow({ item, first, onOpen }: { item: UrgencyItem; first: boolean; onOpen?: () => void }): ReactElement {
  const inner = (
    <>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="truncate text-sm font-medium text-zinc-100">{item.title ?? item.customerName ?? 'Urgent item'}</p>
          <span className="shrink-0 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[0.65rem] font-semibold text-amber-300">{Math.round(item.score)}</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-zinc-500">
          {[item.customerName, item.snippet].filter(Boolean).join(' · ') || relativeTime(item.createdAt)}
        </p>
      </div>
      {onOpen && <ChevronRight size={16} className="shrink-0 text-zinc-600" />}
    </>
  );
  const className = `flex w-full items-center gap-3 px-4 py-3 text-left ${first ? '' : 'border-t border-zinc-800'}`;
  return onOpen
    ? <button onClick={onOpen} className={`${className} active:bg-zinc-800/60`}>{inner}</button>
    : <div className={className}>{inner}</div>;
}
