import { type ReactElement, type ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Loader2 } from 'lucide-react';
import { MessageBubble } from './MessageBubble';
import { Pane, ScrollArea } from './Layout';
import { dayKey, dayLabel } from './lib/time';
import type { Feed } from './useFeed';
import type { Message } from './types';

const NEAR_BOTTOM_PX = 80;
const LOAD_OLDER_PX = 120;

/** `filter` narrows the shared feed client-side (e.g. Assistant shows internal chat
 *  turns only) without a separate provider or fetch. `emptyLabel` tailors the copy
 *  shown when the (filtered) view has nothing to render. */
export function ChatFeed({
  feed,
  filter,
  emptyLabel = 'No messages yet. Say hello, and everything the assistant flags will land here.',
}: {
  feed: Feed;
  filter?: (message: Message) => boolean;
  emptyLabel?: string;
}): ReactElement {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [showNewPill, setShowNewPill] = useState(false);

  const messages = useMemo(() => (filter ? feed.messages.filter(filter) : feed.messages), [feed.messages, filter]);

  const atBottom = useRef(true);
  const prevLastId = useRef<string | null>(null);
  const prevLen = useRef(0);
  const prependAnchor = useRef<number | null>(null);

  const scrollToBottom = (behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior, block: 'end' });
    setShowNewPill(false);
  };

  // Decide how to react whenever the message list changes: jump on first paint,
  // keep the viewport pinned when older history is prepended, follow new lines
  // when already at the bottom, otherwise raise the "new messages" pill.
  useLayoutEffect(() => {
    const node = scrollRef.current;
    const last = messages[messages.length - 1] ?? null;

    if (prevLen.current === 0 && messages.length > 0) {
      scrollToBottom('auto');
    } else if (prependAnchor.current !== null && node) {
      node.scrollTop += node.scrollHeight - prependAnchor.current;
    } else if (last && last.id !== prevLastId.current) {
      const mine = last.direction === 'in';
      if (mine || atBottom.current) scrollToBottom('smooth');
      else setShowNewPill(true);
    }

    prependAnchor.current = null;
    prevLastId.current = last?.id ?? null;
    prevLen.current = messages.length;
  }, [messages]);

  const onScroll = () => {
    const node = scrollRef.current;
    if (!node) return;
    atBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight <= NEAR_BOTTOM_PX;
    if (atBottom.current) setShowNewPill(false);
    if (node.scrollTop <= LOAD_OLDER_PX && feed.hasMore && !feed.loadingMore) {
      prependAnchor.current = node.scrollHeight;
      feed.loadOlder();
    }
  };

  if (feed.loading) return <Centered><Loader2 className="animate-spin text-zinc-500" size={22} /></Centered>;
  if (feed.error && feed.messages.length === 0) {
    return <Centered><p className="max-w-xs text-center text-sm text-zinc-400">{feed.error}</p></Centered>;
  }
  if (messages.length === 0) {
    return <Centered><p className="max-w-xs text-center text-sm leading-relaxed text-zinc-500">{emptyLabel}</p></Centered>;
  }

  return (
    <Pane className="relative">
      <ScrollArea ref={scrollRef} onScroll={onScroll} className="feed-scroll overscroll-contain py-3">
        {feed.loadingMore && (
          <div className="flex justify-center py-2"><Loader2 className="animate-spin text-zinc-600" size={16} /></div>
        )}
        {renderRows(messages, feed.decide)}
        <div ref={bottomRef} className="h-px" />
      </ScrollArea>

      {showNewPill && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full bg-ember-400 px-4 py-2 text-sm font-semibold text-zinc-950 shadow-lg shadow-black/40 active:scale-95"
        >
          <ArrowDown size={16} />
          New messages
        </button>
      )}
    </Pane>
  );
}

function renderRows(messages: Feed['messages'], decide: Feed['decide']): ReactNode {
  const rows: ReactNode[] = [];
  let lastDay: string | null = null;
  for (const message of messages) {
    const key = dayKey(message.createdAt);
    if (key !== lastDay) {
      rows.push(
        <div key={`sep-${key}`} className="my-4 flex items-center justify-center">
          <span className="rounded-full bg-zinc-800/70 px-3 py-1 text-[0.68rem] font-medium uppercase tracking-wide text-zinc-400">
            {dayLabel(message.createdAt)}
          </span>
        </div>,
      );
      lastDay = key;
    }
    rows.push(
      <div key={message.id} className="mt-1.5">
        <MessageBubble message={message} onDecide={decide} />
      </div>,
    );
  }
  return rows;
}

function Centered({ children }: { children: ReactNode }): ReactElement {
  return <div className="grid min-h-0 flex-1 place-items-center p-8">{children}</div>;
}
