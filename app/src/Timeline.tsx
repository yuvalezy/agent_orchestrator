import { type ReactElement, type ReactNode, useEffect, useMemo, useState } from 'react';
import { Loader2, Sparkles, SquareCheckBig } from 'lucide-react';
import { cn } from './lib/utils';
import { dayKey, dayLabel, messageTime } from './lib/time';
import { OpenTaskButton } from './CardActions';
import { useThreadScroll } from './useThreadScroll';
import type { DetailKind, TimelineRow } from './types';

/** How long the ring stays on the row a card sent us to, before it fades back into the thread. */
const FLASH_MS = 2600;

/**
 * The customer conversation as a real thread: customer messages left, the founder's own and the
 * assistant's replies right, assistant decisions as inline event cards. Owns its scroll container,
 * because reading a thread is a scroll behaviour: rows are rendered ASCENDING and pinned to the
 * bottom, and "Load earlier" prepends history at the top without moving what you are reading.
 *
 * `rows` arrives newest-first (exactly as the API pages it) and is reversed here — the caller
 * keeps paging in the API's terms, this keeps the founder's.
 */
export function Timeline({
  rows,
  hasMore,
  loadingOlder,
  onLoadOlder,
  onOpen,
  focusId,
}: {
  rows: TimelineRow[];
  hasMore: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  onOpen: (kind: DetailKind, id: string) => void;
  focusId: string | null;
}): ReactElement {
  const ordered = useMemo(() => [...rows].reverse(), [rows]);
  const { scrollRef, bottomRef, focusRef, onScroll, loadOlder } = useThreadScroll({
    count: ordered.length,
    lastKey: ordered[ordered.length - 1]?.id ?? null,
    hasMore,
    loading: loadingOlder,
    onLoadOlder,
    focusKey: focusId,
  });

  // The ring is an arrival cue, not a state: it says "here", then gets out of the way.
  // `aria-current` is what durably marks the row, since a fading ring says nothing to a reader.
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    setFlashId(focusId);
    if (!focusId) return;
    const timer = setTimeout(() => setFlashId(null), FLASH_MS);
    return () => clearTimeout(timer);
  }, [focusId]);

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      role="log"
      aria-label="Conversation timeline"
      className="feed-scroll h-full overflow-y-auto overscroll-contain px-3 py-3 pb-6"
    >
      {hasMore && (
        <div className="flex justify-center">
          <button
            onClick={loadOlder}
            disabled={loadingOlder}
            className="flex min-h-11 items-center gap-1.5 rounded-full border border-zinc-800 px-4 text-xs text-zinc-400 active:bg-zinc-900 disabled:opacity-60"
          >
            {loadingOlder && <Loader2 className="animate-spin" size={13} />}
            Load earlier
          </button>
        </div>
      )}

      {ordered.length === 0 && !hasMore && (
        <p className="py-10 text-center text-sm text-zinc-500">No activity recorded yet.</p>
      )}

      {renderRows(ordered, { focusId, flashId, focusRef, onOpen })}
      <div ref={bottomRef} className="h-px" />
    </div>
  );
}

interface RowChrome {
  focusId: string | null;
  flashId: string | null;
  focusRef: ReturnType<typeof useThreadScroll>['focusRef'];
  onOpen: (kind: DetailKind, id: string) => void;
}

/** Day separators plus the rows themselves, in one pass — the thread's only chronological chrome. */
function renderRows(ordered: TimelineRow[], chrome: RowChrome): ReactNode {
  const out: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const row of ordered) {
    const key = dayKey(row.createdAt);
    if (key !== lastDay) {
      out.push(
        <div key={`sep-${key}`} className="my-4 flex items-center justify-center">
          <span className="rounded-full bg-zinc-800/70 px-3 py-1 text-[0.68rem] font-medium uppercase tracking-wide text-zinc-400">
            {dayLabel(row.createdAt)}
          </span>
        </div>,
      );
      lastDay = key;
    }
    const focused = row.id === chrome.focusId;
    const isMessage = row.kind === 'inbound' || row.kind === 'outbound';
    out.push(
      // An article per row, named for whoever spoke: which side a bubble sits on is the whole
      // of that information visually, and none of it otherwise.
      <article key={row.id} ref={focused ? chrome.focusRef : null} aria-label={speaker(row)} className="mt-1.5">
        {isMessage
          ? <MessageRow row={row} flash={row.id === chrome.flashId} focused={focused} onOpen={chrome.onOpen} />
          : <EventRow row={row} flash={row.id === chrome.flashId} focused={focused} onOpen={chrome.onOpen} />}
      </article>,
    );
  }
  return out;
}

/** Who this row is attributed to. An `agent_inbox` row with direction='outbound' is the founder's
 *  OWN message (kind 'outbound', itemKind still 'inbox') — never the customer's. */
function speaker(row: TimelineRow): string {
  if (row.kind === 'inbound') return row.senderName ?? 'Customer';
  if (row.kind === 'outbound') return row.itemKind === 'outbound' ? 'Reply' : 'You';
  return row.kind === 'decision' ? 'Assistant' : 'Task';
}

/** Rides on rows that already carry `transition`, so it fades in and back out on its own. */
const ringClass = 'ring-2 ring-ember-400/70';

function MessageRow({
  row,
  flash,
  focused,
  onOpen,
}: {
  row: TimelineRow;
  flash: boolean;
  focused: boolean;
  onOpen: (kind: DetailKind, id: string) => void;
}): ReactElement {
  const mine = row.kind === 'outbound';
  // Delivery status belongs to the outbound QUEUE. The founder's own inbox rows carry status
  // 'skipped' (they were never ours to send) — a chip saying so is noise, so it stays off.
  const queuedReply = row.itemKind === 'outbound';
  const tappable = Boolean(row.itemKind && row.itemId);
  const body = row.snippet ?? row.title;
  return (
    <div className={cn('flex', mine ? 'justify-end' : 'justify-start')}>
      <button
        onClick={() => { if (row.itemKind && row.itemId) onOpen(row.itemKind, row.itemId); }}
        disabled={!tappable}
        aria-current={focused ? 'true' : undefined}
        className={cn(
          'max-w-[82%] rounded-3xl px-4 py-2.5 text-left shadow-sm transition disabled:cursor-default',
          mine ? 'rounded-br-lg bg-ember-500/15 active:bg-ember-500/25' : 'rounded-bl-lg bg-zinc-800/90 active:bg-zinc-800',
          flash && ringClass,
        )}
      >
        {row.kind === 'inbound' && row.senderName && (
          <p className="text-[0.68rem] font-semibold text-zinc-300">{row.senderName}</p>
        )}
        {row.title && row.snippet && <p className="text-xs font-semibold text-zinc-400">{row.title}</p>}
        <p
          className={cn(
            'whitespace-pre-wrap break-words text-[0.9rem] leading-relaxed',
            body ? 'text-zinc-200' : 'italic text-zinc-500',
          )}
        >
          {body ?? 'No message text'}
        </p>
        <div className="mt-1 flex items-center gap-2">
          <span className="text-[0.65rem] text-zinc-500">{messageTime(row.createdAt)}</span>
          {queuedReply && row.status && <StatusChip status={row.status} />}
        </div>
      </button>
    </div>
  );
}

/**
 * A decision or a task link. Both now carry real words — what triage decided, and why — so this is
 * a card and not the old "● triage · accepted" pill. It stays a card, never a bubble: nobody said
 * these things, the system did them.
 *
 * Two separate actions, deliberately siblings and never nested: the body opens the row's detail
 * sheet (where it has one), and "Open Task" leaves for the portal. A task link has no sheet at all,
 * so for those the button is the row's only way through — which is precisely what it lacked.
 */
function EventRow({
  row,
  flash,
  focused,
  onOpen,
}: {
  row: TimelineRow;
  flash: boolean;
  focused: boolean;
  onOpen: (kind: DetailKind, id: string) => void;
}): ReactElement {
  const decision = row.kind === 'decision';
  const tappable = Boolean(row.itemKind && row.itemId);
  const Icon = decision ? Sparkles : SquareCheckBig;
  // A task we never triaged has no title anywhere local, and the backend hands back its ref as the
  // honest last resort. A bare UUID is exactly the noise this screen is being rescued from.
  const title = decision ? row.title : row.title && !isUuid(row.title) ? row.title : null;
  const body = (
    <>
      <div className="flex items-center gap-1.5">
        <Icon size={12} className="shrink-0 text-zinc-500" aria-hidden />
        <span className="text-[0.62rem] font-semibold uppercase tracking-wide text-zinc-500">
          {decision ? 'Assistant' : 'Task linked'}
        </span>
        <span className="ml-auto text-[0.65rem] text-zinc-600">{messageTime(row.createdAt)}</span>
      </div>
      {title && <p className="mt-1 text-sm font-semibold text-zinc-200">{title}</p>}
      {row.snippet && <p className="mt-0.5 text-[0.82rem] leading-relaxed text-zinc-400">{row.snippet}</p>}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {row.category && <Chip>{row.category}</Chip>}
        {row.priority && <PriorityChip priority={row.priority} />}
        {row.status && <StatusChip status={row.status} />}
        {/* Only when the task cannot be reached: the button below says this better when it is there. */}
        {row.taskRef && !row.linkUrl && <Chip>Task</Chip>}
      </div>
    </>
  );
  return (
    <div
      aria-current={focused ? 'true' : undefined}
      className={cn('rounded-2xl border border-zinc-800 bg-zinc-900/60 transition', flash && ringClass)}
    >
      {tappable ? (
        <button
          type="button"
          onClick={() => onOpen(row.itemKind!, row.itemId!)}
          className="block w-full rounded-2xl px-3.5 py-2.5 text-left transition active:bg-zinc-900"
        >
          {body}
        </button>
      ) : (
        <div className="px-3.5 py-2.5">{body}</div>
      )}
      {row.linkUrl && (
        <div className="px-3.5 pb-2.5">
          <OpenTaskButton url={row.linkUrl} />
        </div>
      )}
    </div>
  );
}


function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

type Tone = 'bad' | 'good' | 'warn' | 'muted';

const toneClass: Record<Tone, string> = {
  bad: 'bg-rose-400/15 text-rose-300',
  good: 'bg-emerald-400/15 text-emerald-300',
  warn: 'bg-amber-400/15 text-amber-300',
  muted: 'bg-zinc-700/60 text-zinc-400',
};

function Chip({ tone = 'muted', children }: { tone?: Tone; children: ReactNode }): ReactElement {
  return <span className={cn('rounded-full px-1.5 py-0.5 text-[0.62rem] font-medium', toneClass[tone])}>{children}</span>;
}

function StatusChip({ status }: { status: string }): ReactElement {
  const bad = ['failed', 'cancelled', 'rejected'].includes(status);
  const sent = ['sent', 'delivered', 'approved'].includes(status);
  return <Chip tone={bad ? 'bad' : sent ? 'good' : 'muted'}>{status}</Chip>;
}

function PriorityChip({ priority }: { priority: string }): ReactElement {
  const level = priority.toLowerCase();
  return <Chip tone={level === 'urgent' ? 'bad' : level === 'high' ? 'warn' : 'muted'}>{priority}</Chip>;
}
