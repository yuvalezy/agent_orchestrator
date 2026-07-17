import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReactElement } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useFeed } from './useFeed';
import type { Message } from './types';

function row(overrides: Partial<Message>): Message {
  return {
    id: 'x', direction: 'out', kind: 'chat', title: null, body: 'b', severity: null,
    customerRef: null, notificationRef: null, buttons: null, decidedOptionId: null,
    createdAt: '2026-07-16T09:00:00.000Z', ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Routes fetch by "METHOD path" so each test states only what it needs. */
function routeFetch(handlers: Record<string, () => Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    const handler = handlers[key];
    if (!handler) throw new Error(`unexpected fetch: ${key}`);
    return handler();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Harness(): ReactElement {
  const feed = useFeed();
  return (
    <div>
      {feed.messages.map((m) => (
        <div key={m.id} data-testid="row">{m.body}{m.pending ? ' (pending)' : ''}</div>
      ))}
      <button onClick={() => void feed.send('ship the release').catch(() => {})}>send</button>
      <button onClick={() => void feed.decide('q1', 'yes').catch(() => {})}>decide</button>
    </div>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('useFeed', () => {
  it('loads the first page newest-first and renders it', async () => {
    routeFetch({
      'GET /app/api/messages': () => jsonResponse({ data: [row({ id: 'a', body: 'first line' })], nextCursor: null }),
    });
    render(<Harness />);
    expect(await screen.findByText('first line')).toBeInTheDocument();
  });

  it('optimistically appends a sent message, then reconciles with the server rows', async () => {
    const fetchMock = routeFetch({
      'GET /app/api/messages': () => jsonResponse({ data: [row({ id: 'a', body: 'first line' })], nextCursor: null }),
      'POST /app/api/messages': () => jsonResponse({ data: [
        row({ id: 'in-1', direction: 'in', kind: 'chat', body: 'ship the release', createdAt: '2026-07-16T09:01:00.000Z' }),
        row({ id: 'out-1', direction: 'out', kind: 'chat', body: 'On it — release queued.', createdAt: '2026-07-16T09:01:01.000Z' }),
      ] }),
    });
    render(<Harness />);
    await screen.findByText('first line');

    fireEvent.click(screen.getByText('send'));
    // Optimistic row shows immediately, before the POST resolves.
    expect(screen.getByText('ship the release (pending)')).toBeInTheDocument();

    // Then the server's confirmed pair replaces the optimistic row.
    await waitFor(() => expect(screen.getByText('On it — release queued.')).toBeInTheDocument());
    expect(screen.queryByText('ship the release (pending)')).not.toBeInTheDocument();
    expect(screen.getByText('ship the release')).toBeInTheDocument();

    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ text: 'ship the release' });
  });

  it('posts a decision with the message id and option id when a chip is decided', async () => {
    const fetchMock = routeFetch({
      'GET /app/api/messages': () => jsonResponse({ data: [row({
        id: 'q1', kind: 'question', body: 'Approve?', buttons: [{ id: 'yes', label: 'Yes' }],
      })], nextCursor: null }),
      'POST /app/api/decisions': () => jsonResponse({ data: row({ id: 'q1', kind: 'question', body: 'Approve?', decidedOptionId: 'yes' }) }),
    });
    render(<Harness />);
    await screen.findByText('Approve?');

    fireEvent.click(screen.getByText('decide'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => url === '/app/api/decisions' && (init as RequestInit)?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ messageId: 'q1', optionId: 'yes' });
    });
  });
});
