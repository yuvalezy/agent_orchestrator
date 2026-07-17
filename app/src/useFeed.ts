import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ApiError } from './lib/api';
import type { Message, MessagePage } from './types';

const PAGE = 50;

function byCreatedAt(a: Message, b: Message): number {
  if (a.createdAt === b.createdAt) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  return a.createdAt < b.createdAt ? -1 : 1;
}

/** Insert-or-replace each incoming row by id, then keep the feed oldest-first. */
function merge(current: Message[], incoming: Message[]): Message[] {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const row of incoming) map.set(row.id, row);
  return [...map.values()].sort(byCreatedAt);
}

export interface Feed {
  messages: Message[];
  loading: boolean;
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  sending: boolean;
  /** Increments on every live SSE row and every focus refetch; cockpit screens
   *  watch it to re-pull their own read models when the world changes. */
  eventToken: number;
  loadOlder: () => void;
  send: (text: string) => Promise<void>;
  decide: (messageId: string, optionId: string) => Promise<void>;
  refetch: () => void;
}

export function useFeed(): Feed {
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [sending, setSending] = useState(false);
  const [eventToken, setEventToken] = useState(0);
  const oldestCursor = useRef<string | null>(null);

  const loadFirst = useCallback(async () => {
    try {
      const page = await api<MessagePage>(`/messages?limit=${PAGE}`);
      setMessages(merge([], page.data));
      oldestCursor.current = page.nextCursor;
      setCursor(page.nextCursor);
      setHasMore(page.nextCursor !== null);
      setError(null);
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadFirst(); }, [loadFirst]);

  // Live feed rows over SSE, with capped exponential backoff on drop.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let closed = false;

    const connect = () => {
      source = new EventSource('/app/api/events', { withCredentials: true });
      source.onopen = () => { attempts = 0; };
      source.onmessage = (event) => {
        try {
          const row = JSON.parse(event.data) as Message;
          if (row?.id) { setMessages((current) => merge(current, [row])); setEventToken((t) => t + 1); }
        } catch { /* ignore malformed frame */ }
      };
      source.onerror = () => {
        source?.close();
        if (closed) return;
        attempts += 1;
        const delay = Math.min(1000 * 2 ** (attempts - 1), 30_000);
        retry = setTimeout(connect, delay);
      };
    };
    connect();
    return () => { closed = true; source?.close(); if (retry) clearTimeout(retry); };
  }, []);

  // Catch up on anything missed while the app was backgrounded.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') { void loadFirst(); setEventToken((t) => t + 1); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [loadFirst]);

  const loadOlder = useCallback(() => {
    if (loadingMore || !hasMore || cursor === null) return;
    setLoadingMore(true);
    void api<MessagePage>(`/messages?before=${encodeURIComponent(cursor)}&limit=${PAGE}`)
      .then((page) => {
        setMessages((current) => merge(current, page.data));
        oldestCursor.current = page.nextCursor;
        setCursor(page.nextCursor);
        setHasMore(page.nextCursor !== null);
      })
      .catch(() => { /* a failed scroll-back just leaves older history unloaded */ })
      .finally(() => setLoadingMore(false));
  }, [cursor, hasMore, loadingMore]);

  const send = useCallback(async (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const tempId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: Message = {
      id: tempId, direction: 'in', kind: 'chat', title: null, body: trimmed,
      severity: null, customerRef: null, notificationRef: null, buttons: null,
      decidedOptionId: null, createdAt: new Date().toISOString(), pending: true,
    };
    setMessages((current) => merge(current, [optimistic]));
    setSending(true);
    try {
      const result = await api<{ data: Message[] }>('/messages', { method: 'POST', body: JSON.stringify({ text: trimmed }) });
      setMessages((current) => merge(current.filter((m) => m.id !== tempId), result.data));
    } catch (err) {
      // Surface the failure inline by keeping the row but dropping the pending state.
      setMessages((current) => current.map((m) => (m.id === tempId ? { ...m, pending: false } : m)));
      throw err;
    } finally {
      setSending(false);
    }
  }, []);

  const decide = useCallback(async (messageId: string, optionId: string) => {
    const previous = messages.find((m) => m.id === messageId)?.decidedOptionId ?? null;
    setMessages((current) => current.map((m) => (m.id === messageId ? { ...m, decidedOptionId: optionId } : m)));
    try {
      const result = await api<{ data: Message }>('/decisions', { method: 'POST', body: JSON.stringify({ messageId, optionId }) });
      if (result?.data?.id) setMessages((current) => merge(current, [result.data]));
    } catch (err) {
      setMessages((current) => current.map((m) => (m.id === messageId ? { ...m, decidedOptionId: previous } : m)));
      throw err;
    }
  }, [messages]);

  const refetch = useCallback(() => { void loadFirst(); }, [loadFirst]);

  return { messages, loading, error, hasMore, loadingMore, sending, eventToken, loadOlder, send, decide, refetch };
}
