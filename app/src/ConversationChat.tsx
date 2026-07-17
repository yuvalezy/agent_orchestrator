import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, MessageSquarePlus, MessagesSquare } from 'lucide-react';
import { api } from './lib/api';
import { useOptionalAppData } from './AppData';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import { Pane, ScrollArea } from './Layout';
import { useThreadScroll } from './useThreadScroll';
import type { ChatPage, ChatPost, Message } from './types';

const PAGE = 50;
const noop = () => {};

function byCreatedAt(a: Message, b: Message): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}

function merge(current: Message[], incoming: Message[]): Message[] {
  const map = new Map(current.map((message) => [message.id, message]));
  for (const message of incoming) map.set(message.id, message);
  return [...map.values()].sort(byCreatedAt);
}

function chatPath(customerId?: string): string {
  return customerId ? `/chat?customerId=${encodeURIComponent(customerId)}&limit=${PAGE}` : `/chat?limit=${PAGE}`;
}

/** One persisted conversation UI reused by customer Ask and internal Assistant. */
export function ConversationChat({
  customerId,
  emptyLabel,
}: {
  customerId?: string;
  emptyLabel: string;
}): ReactElement {
  const appData = useOptionalAppData();
  const eventToken = appData?.feed.eventToken ?? 0;
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [sending, setSending] = useState(false);
  const [resetting, setResetting] = useState(false);
  const seenEvent = useRef(eventToken);
  const conversationRef = useRef<string | null>(null);

  const applyFirstPage = useCallback((page: ChatPage, replace = false) => {
    const changed = conversationRef.current !== null && conversationRef.current !== page.conversationId;
    conversationRef.current = page.conversationId;
    setConversationId(page.conversationId);
    setMessages((current) => replace || changed ? merge([], page.data) : merge(current, page.data));
    // A live first-page refresh knows nothing about pages already loaded above it.
    // Preserve their oldest cursor; replacing/changing sessions starts paging afresh.
    if (replace || changed) setCursor(page.nextCursor);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api<ChatPage>(chatPath(customerId));
      applyFirstPage(page, true);
    } catch {
      setMessages([]);
      setCursor(null);
    } finally {
      setLoading(false);
    }
  }, [applyFirstPage, customerId]);

  useEffect(() => { void load(); }, [load]);

  // The shared SSE feed carries every committed chat pair. Refetching the first page
  // keeps another device visible; merge preserves pages already loaded in this view.
  useEffect(() => {
    if (eventToken === seenEvent.current) return;
    seenEvent.current = eventToken;
    void api<ChatPage>(chatPath(customerId)).then((page) => applyFirstPage(page)).catch(() => {});
  }, [applyFirstPage, customerId, eventToken]);

  const loadOlder = useCallback(() => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true);
    const join = chatPath(customerId).includes('?') ? '&' : '?';
    void api<ChatPage>(`${chatPath(customerId)}${join}before=${encodeURIComponent(cursor)}`)
      .then((page) => {
        if (page.conversationId !== conversationId) {
          applyFirstPage(page, true);
        } else {
          setMessages((current) => merge(current, page.data));
          setCursor(page.nextCursor);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingOlder(false));
  }, [applyFirstPage, conversationId, cursor, customerId, loadingOlder]);

  const scroll = useThreadScroll({
    count: messages.length,
    lastKey: messages[messages.length - 1]?.id ?? null,
    hasMore: cursor !== null,
    loading: loadingOlder,
    onLoadOlder: loadOlder,
  });

  const send = async (text: string) => {
    const tempId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: Message = {
      id: tempId, direction: 'in', kind: 'chat', title: null, body: text,
      severity: null, customerRef: customerId ?? null, notificationRef: null,
      buttons: null, decidedOptionId: null, createdAt: new Date().toISOString(), pending: true,
    };
    setMessages((current) => merge(current, [optimistic]));
    setSending(true);
    try {
      const result = await api<ChatPost>('/messages', {
        method: 'POST',
        body: JSON.stringify(customerId ? { text, customerId } : { text }),
      });
      const sameConversation = result.conversationId === conversationRef.current;
      setMessages((current) => {
        const withoutOptimistic = current.filter((message) => message.id !== tempId);
        return sameConversation
          ? merge(withoutOptimistic, result.data)
          : merge([], result.data);
      });
      conversationRef.current = result.conversationId;
      setConversationId(result.conversationId);
      if (!sameConversation) setCursor(null);
    } catch {
      setMessages((current) => current.map((message) => message.id === tempId ? { ...message, pending: false } : message));
    } finally {
      setSending(false);
    }
  };

  const reset = async () => {
    if (sending || resetting) return;
    setResetting(true);
    try {
      const result = await api<{ data: { conversationId: string } }>('/chat/reset', {
        method: 'POST',
        body: JSON.stringify(customerId ? { customerId } : {}),
      });
      conversationRef.current = result.data.conversationId;
      setConversationId(result.data.conversationId);
      setMessages([]);
      setCursor(null);
    } finally {
      setResetting(false);
    }
  };

  return (
    <Pane>
      <div className="safe-x flex justify-end border-b border-zinc-900 px-3 py-2">
        <button
          type="button"
          onClick={() => void reset().catch(() => {})}
          disabled={sending || resetting}
          className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-zinc-400 active:bg-zinc-800 disabled:opacity-40"
        >
          {resetting ? <Loader2 size={14} className="animate-spin" /> : <MessageSquarePlus size={14} />}
          New chat
        </button>
      </div>

      <ScrollArea ref={scroll.scrollRef} onScroll={scroll.onScroll} className="py-3">
        {loading ? (
          <div className="grid h-full place-items-center"><Loader2 size={20} className="animate-spin text-zinc-600" /></div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-8 py-20 text-center text-zinc-500">
            <MessagesSquare size={28} className="text-zinc-600" />
            <p className="mt-4 text-sm leading-relaxed">{emptyLabel}</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {cursor && (
              <div className="flex justify-center py-2">
                <button type="button" onClick={scroll.loadOlder} disabled={loadingOlder} className="text-xs text-zinc-500">
                  {loadingOlder ? 'Loading…' : 'Load earlier'}
                </button>
              </div>
            )}
            {messages.map((message) => <MessageBubble key={message.id} message={message} onDecide={noop} />)}
          </div>
        )}
        <div ref={scroll.bottomRef} className="h-px" />
      </ScrollArea>
      <Composer onSend={(text) => void send(text)} sending={sending || resetting || loading} />
    </Pane>
  );
}
