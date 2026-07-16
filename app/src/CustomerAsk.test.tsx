import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerAsk } from './CustomerAsk';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('CustomerAsk', () => {
  it('posts {text, customerId} and threads the optimistic question with the scoped answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ data: [
      { id: 'in-1', direction: 'in', kind: 'chat', title: null, body: 'What did Acme last order?', severity: null, customerRef: 'cust-7', notificationRef: null, buttons: null, decidedOptionId: null, createdAt: '2026-07-16T10:00:01.000Z' },
      { id: 'out-1', direction: 'out', kind: 'chat', title: null, body: 'Two pallets of widgets on Jul 2.', severity: null, customerRef: 'cust-7', notificationRef: null, buttons: null, decidedOptionId: null, createdAt: '2026-07-16T10:00:02.000Z' },
    ] }));
    vi.stubGlobal('fetch', fetchMock);

    render(<CustomerAsk customerId="cust-7" />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'What did Acme last order?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    // Optimistic question shows immediately.
    expect(screen.getByText('What did Acme last order?')).toBeInTheDocument();
    // Scoped answer arrives.
    await waitFor(() => expect(screen.getByText('Two pallets of widgets on Jul 2.')).toBeInTheDocument());

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/app/api/messages');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ text: 'What did Acme last order?', customerId: 'cust-7' });
  });
});
