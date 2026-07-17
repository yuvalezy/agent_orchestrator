import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { type ReactElement } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppDataProvider } from './AppData';
import { CustomerScreen } from './CustomerScreen';
import type { AttentionCard } from './types';

const CARD: AttentionCard = {
  id: 'c1', direction: 'out', kind: 'notification', title: 'Draft ready', body: 'Reply drafted for Acme.',
  severity: 'action', customerRef: 'cust-1', customerName: 'Acme Corp', notificationRef: 'ref-1',
  buttons: [{ id: 'approve', label: 'Approve' }], decidedOptionId: null,
  createdAt: '2026-07-16T10:00:00.000Z',
  context: { contextRef: { kind: 'inbox', ref: 'i-9' } },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** A timeline row, terse — only what the ordering assertions read. */
function row(id: string, snippet: string, createdAt: string) {
  return {
    id: `inbox:${id}`, kind: 'inbound', itemKind: 'inbox', itemId: id, title: null, snippet,
    status: 'processed', createdAt, senderName: 'Victor G', taskRef: null, linkUrl: null,
    category: null, priority: null,
  };
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/app/api/messages') return json({ data: [], nextCursor: null });
    if (path === '/app/api/attention') return json({ decisions: [CARD], urgency: [] });
    if (path === '/app/api/customers/cust-1') return json({ data: { id: 'cust-1', displayName: 'Acme Corp' } });
    if (path === '/app/api/customers/cust-1/timeline') return json({ data: [], nextCursor: null });
    throw new Error(`unexpected fetch: ${path}`);
  }));
}

function Probe(): ReactElement {
  const { pathname, search } = useLocation();
  return <p data-testid="url">{`${pathname}${search}`}</p>;
}

afterEach(() => vi.unstubAllGlobals());

describe('CustomerScreen', () => {
  it('takes a tap on a Pending card to that card\'s thread, focused on its row', async () => {
    stubFetch();
    render(
      <MemoryRouter initialEntries={['/customer/cust-1']}>
        <AppDataProvider config={null} deviceLabel="dev">
          <Routes><Route path="/customer/:id" element={<CustomerScreen />} /></Routes>
          <Probe />
        </AppDataProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: /Pending/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'Open thread' }));

    // The card's origin rides in the URL...
    expect(screen.getByTestId('url')).toHaveTextContent('/customer/cust-1?focus=inbox%3Ai-9');
    // ...and answering it means being on the thread, not still on Pending.
    await waitFor(() => expect(screen.getByText('No activity recorded yet.')).toBeInTheDocument());
  });

  // The API pages the timeline NEWEST-first and `Timeline` reverses that to read as a thread, so
  // an older page belongs at the END of `rows` — prepending it (the shape a newest-first list
  // wants) lands the oldest history BELOW the newest, which is the opposite of a thread.
  it('keeps the thread chronological when older history is paged in', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/app/api/messages') return json({ data: [], nextCursor: null });
      if (path === '/app/api/attention') return json({ decisions: [], urgency: [] });
      if (path === '/app/api/customers/cust-1') return json({ data: { id: 'cust-1', displayName: 'Acme Corp' } });
      if (path === '/app/api/customers/cust-1/timeline') {
        // Newest-first, exactly as the server pages it; the cursor fetches the OLDER page.
        return url.includes('cursor=')
          ? json({ data: [row('2', 'second oldest', '2026-07-14T10:00:00.000Z'), row('1', 'the oldest', '2026-07-13T10:00:00.000Z')], nextCursor: null })
          : json({ data: [row('4', 'the newest', '2026-07-16T10:00:00.000Z'), row('3', 'second newest', '2026-07-15T10:00:00.000Z')], nextCursor: 'cur-1' });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }));

    render(
      <MemoryRouter initialEntries={['/customer/cust-1']}>
        <AppDataProvider config={null} deviceLabel="dev">
          <Routes><Route path="/customer/:id" element={<CustomerScreen />} /></Routes>
        </AppDataProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }));
    await screen.findByText('the oldest');

    const order = screen.getAllByRole('article').map((el) => el.textContent);
    expect(order.map((t) => t?.match(/the oldest|second oldest|second newest|the newest/)?.[0])).toEqual([
      'the oldest', 'second oldest', 'second newest', 'the newest',
    ]);
  });

  // `feed.eventToken` bumps on EVERY row of the global SSE stream, including other customers'.
  // A refresh that re-seeded from the first page would throw the founder's scroll-back away
  // whenever the assistant did anything for anyone else — routinely, in normal use.
  it('keeps paged-back history when an unrelated live event refreshes the thread', async () => {
    let events: ((e: MessageEvent) => void) | null = null;
    class FakeSource {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      close(): void {}
      constructor() { setTimeout(() => { events = (e) => this.onmessage?.(e); }, 0); }
    }
    vi.stubGlobal('EventSource', FakeSource);
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/app/api/messages') return json({ data: [], nextCursor: null });
      if (path === '/app/api/attention') return json({ decisions: [], urgency: [] });
      if (path === '/app/api/customers/cust-1') return json({ data: { id: 'cust-1', displayName: 'Acme Corp' } });
      if (path === '/app/api/customers/cust-1/timeline') {
        return url.includes('cursor=')
          ? json({ data: [row('1', 'the oldest', '2026-07-13T10:00:00.000Z')], nextCursor: null })
          : json({ data: [row('4', 'the newest', '2026-07-16T10:00:00.000Z')], nextCursor: 'cur-1' });
      }
      throw new Error(`unexpected fetch: ${path}`);
    }));

    render(
      <MemoryRouter initialEntries={['/customer/cust-1']}>
        <AppDataProvider config={null} deviceLabel="dev">
          <Routes><Route path="/customer/:id" element={<CustomerScreen />} /></Routes>
        </AppDataProvider>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier' }));
    await screen.findByText('the oldest');

    // Something happens for a DIFFERENT customer — the SSE stream is global.
    await waitFor(() => expect(events).not.toBeNull());
    const elsewhere = { id: 'x', direction: 'out', kind: 'notification', body: 'for someone else', customerRef: 'cust-2', createdAt: '2026-07-17T10:00:00.000Z' };
    await act(async () => { events!(new MessageEvent('message', { data: JSON.stringify(elsewhere) })); });

    // The founder's scroll-back survives it.
    await waitFor(() => expect(screen.getByText('the newest')).toBeInTheDocument());
    expect(screen.getByText('the oldest')).toBeInTheDocument();
  });
});
