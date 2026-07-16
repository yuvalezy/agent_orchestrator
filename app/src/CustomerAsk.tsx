import { type ReactElement, useEffect, useRef, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { api } from './lib/api';
import { Composer } from './Composer';
import { MessageBubble } from './MessageBubble';
import type { Message } from './types';

const noop = () => {};

/** A query composer scoped to ONE customer's memory: POST /app/api/messages carries
 *  {text, customerId}, and the request/response pair renders as a small local thread
 *  (not the global feed). */
export function CustomerAsk({ customerId }: { customerId: string }): ReactElement {
  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [messages]);

  const send = async (text: string) => {
    const tempId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: Message = {
      id: tempId, direction: 'in', kind: 'chat', title: null, body: text, severity: null,
      customerRef: customerId, notificationRef: null, buttons: null, decidedOptionId: null,
      createdAt: new Date().toISOString(), pending: true,
    };
    setMessages((current) => [...current, optimistic]);
    setSending(true);
    try {
      const result = await api<{ data: Message[] }>('/messages', { method: 'POST', body: JSON.stringify({ text, customerId }) });
      setMessages((current) => [...current.filter((m) => m.id !== tempId), ...result.data]);
    } catch {
      setMessages((current) => current.map((m) => (m.id === tempId ? { ...m, pending: false } : m)));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto py-3">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-8 py-20 text-center text-zinc-500">
            <MessagesSquare size={28} className="text-zinc-600" />
            <p className="mt-4 text-sm leading-relaxed">Ask anything about this customer — the assistant answers from their history only.</p>
          </div>
        ) : (
          <div className="space-y-1.5">
            {messages.map((message) => <MessageBubble key={message.id} message={message} onDecide={noop} />)}
          </div>
        )}
        <div ref={bottomRef} className="h-px" />
      </div>
      <Composer onSend={(text) => void send(text)} sending={sending} />
    </div>
  );
}
