import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReactElement } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { AppDataProvider } from './AppData';
import { ActivityScreen } from './ActivityScreen';
import { AssistantScreen } from './AssistantScreen';
import type { Message } from './types';

function row(overrides: Partial<Message>): Message {
  return {
    id: 'x', direction: 'out', kind: 'chat', title: null, body: 'b', severity: null,
    customerRef: null, notificationRef: null, buttons: null, decidedOptionId: null,
    createdAt: '2026-07-16T09:00:00.000Z', ...overrides,
  };
}

const FEED: Message[] = [
  row({ id: 'notif', direction: 'out', kind: 'notification', title: 'Draft ready', body: 'Notification body', customerRef: 'cust-1', createdAt: '2026-07-16T09:03:00.000Z' }),
  row({ id: 'chat-cust', direction: 'in', kind: 'chat', body: 'Customer scoped question', customerRef: 'cust-1', createdAt: '2026-07-16T09:02:00.000Z' }),
  row({ id: 'chat-internal', direction: 'in', kind: 'chat', body: 'Internal question', customerRef: null, createdAt: '2026-07-16T09:01:00.000Z' }),
];

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/app/api/messages') return new Response(JSON.stringify({ data: FEED, nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/app/api/chat') return new Response(JSON.stringify({
      data: FEED.filter((message) => message.kind === 'chat' && !message.customerRef),
      nextCursor: null,
      conversationId: 'internal-session',
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/app/api/attention') return new Response(JSON.stringify({ decisions: [], urgency: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch: ${path}`);
  }));
}

function renderScreen(node: ReactElement): void {
  render(<AppDataProvider config={null} deviceLabel="dev">{node}</AppDataProvider>);
}

afterEach(() => vi.unstubAllGlobals());

describe('Assistant vs Activity feed filtering', () => {
  it('Assistant shows only internal chat turns (no customer-scoped chat, no notifications)', async () => {
    stubFetch();
    renderScreen(<AssistantScreen />);

    await waitFor(() => expect(screen.getByText('Internal question')).toBeInTheDocument());
    expect(screen.queryByText('Customer scoped question')).not.toBeInTheDocument();
    expect(screen.queryByText('Notification body')).not.toBeInTheDocument();
  });

  it('Activity shows every kind — internal chat, customer-scoped chat, and notifications', async () => {
    stubFetch();
    renderScreen(<ActivityScreen />);

    await waitFor(() => expect(screen.getByText('Internal question')).toBeInTheDocument());
    expect(screen.getByText('Customer scoped question')).toBeInTheDocument();
    expect(screen.getByText('Notification body')).toBeInTheDocument();
  });
});
