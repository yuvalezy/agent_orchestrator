import { type ReactElement } from 'react';
import { cn } from './lib/utils';
import { relativeTime } from './lib/time';
import type { DetailKind, TimelineRow } from './types';

/** The customer conversation as a real thread: inbound messages left, outbound replies
 *  (with delivery status) right, and decision/notification events as centered markers.
 *  Any row backed by a detail item is tappable. */
export function Timeline({
  rows,
  onOpen,
}: {
  rows: TimelineRow[];
  onOpen: (kind: DetailKind, id: string) => void;
}): ReactElement {
  return (
    <div className="space-y-2.5 px-3 py-3">
      {rows.map((row) => {
        const tappable = row.itemKind && row.itemId;
        const open = () => { if (row.itemKind && row.itemId) onOpen(row.itemKind, row.itemId); };
        if (row.kind === 'inbound' || row.kind === 'outbound') {
          const mine = row.kind === 'outbound';
          // Rows can arrive with no subject/snippet (null on both title and snippet);
          // show a friendly placeholder rather than a bare dash.
          const hasBody = Boolean(row.snippet);
          const body = row.snippet ?? (mine ? 'Outbound reply' : 'Inbound message');
          return (
            <div key={row.id} className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
              <button
                onClick={open}
                disabled={!tappable}
                className={cn(
                  'max-w-[82%] rounded-3xl px-4 py-2.5 text-left shadow-sm transition disabled:cursor-default',
                  mine
                    ? 'rounded-br-lg bg-ember-500/15 active:bg-ember-500/25'
                    : 'rounded-bl-lg bg-zinc-800/90 active:bg-zinc-800',
                )}
              >
                {row.title && <p className="text-xs font-semibold text-zinc-300">{row.title}</p>}
                <p className={cn('whitespace-pre-wrap break-words text-[0.9rem] leading-relaxed', hasBody ? 'text-zinc-200' : 'italic text-zinc-500')}>{body}</p>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-[0.65rem] text-zinc-500">{relativeTime(row.createdAt)}</span>
                  {mine && row.status && <StatusChip status={row.status} />}
                </div>
              </button>
            </div>
          );
        }
        // decision / notification: centered inline marker. Notifications are task links,
        // whose backend title is a raw task ref UUID — label them instead of showing it.
        const markerLabel = row.kind === 'notification' ? 'Task linked' : (row.title ?? row.snippet ?? row.kind);
        return (
          <div key={row.id} className="flex justify-center">
            <button
              onClick={open}
              disabled={!tappable}
              className="max-w-[90%] rounded-full bg-zinc-900 px-3.5 py-1.5 text-center disabled:cursor-default active:bg-zinc-800"
            >
              <span className="text-[0.72rem] text-zinc-400">
                {row.kind === 'decision' ? '● ' : '◆ '}
                {markerLabel}
                {row.status ? ` · ${row.status}` : ''}
                <span className="text-zinc-600"> · {relativeTime(row.createdAt)}</span>
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

function StatusChip({ status }: { status: string }): ReactElement {
  const bad = ['failed', 'cancelled', 'rejected'].includes(status);
  const sent = ['sent', 'delivered', 'approved'].includes(status);
  return (
    <span className={cn(
      'rounded-full px-1.5 py-0.5 text-[0.62rem] font-medium',
      bad ? 'bg-rose-400/15 text-rose-300' : sent ? 'bg-emerald-400/15 text-emerald-300' : 'bg-zinc-700/60 text-zinc-400',
    )}>
      {status}
    </span>
  );
}
