import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AppDataProvider } from './AppData';
import { AttentionScreen } from './AttentionScreen';
import type { AttentionCard } from './types';

function card(overrides: Partial<AttentionCard>): AttentionCard {
  return {
    id: 'c1', direction: 'out', kind: 'notification', title: 'Draft ready', body: 'Reply drafted for Acme.',
    severity: 'action', customerRef: 'cust-1', customerName: 'Acme Corp', notificationRef: 'ref-1',
    buttons: [{ id: 'approve', label: 'Approve' }], decidedOptionId: null,
    createdAt: '2026-07-16T10:00:00.000Z', ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** `dismiss` is what POST /app/api/dismiss answers with; anything else is an unexpected call. */
function stubFetch(decisions: AttentionCard[], dismiss: () => Response): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/app/api/messages') return json({ data: [], nextCursor: null });
    if (path === '/app/api/attention') return json({ decisions, urgency: [] });
    if (path === '/app/api/dismiss') return dismiss();
    throw new Error(`unexpected fetch: ${path}`);
  }));
}

function renderScreen(): void {
  render(
    <MemoryRouter>
      <AppDataProvider config={null} deviceLabel="dev"><AttentionScreen /></AppDataProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('AttentionScreen dismiss', () => {
  it('drops the card from the queue the moment it is dismissed', async () => {
    let dismissed = false;
    // Once dismissed, the server stops returning the row — exactly as /attention filters it.
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const path = url.split('?')[0];
      if (path === '/app/api/messages') return json({ data: [], nextCursor: null });
      if (path === '/app/api/attention') return json({ decisions: dismissed ? [] : [card({})], urgency: [] });
      if (path === '/app/api/dismiss') { dismissed = true; return json({ data: [] }); }
      throw new Error(`unexpected fetch: ${path}`);
    }));
    renderScreen();

    await waitFor(() => expect(screen.getByText('Draft ready')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));

    // Gone without waiting for the round-trip, and still gone once the server agrees.
    expect(screen.queryByText('Draft ready')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('All clear')).toBeInTheDocument());
  });

  it('also drops the sibling rows that mirror the same notification ref', async () => {
    stubFetch(
      [card({ id: 'c1', title: 'Task created', notificationRef: 'ref-1' }), card({ id: 'c2', title: 'Task (confirmed)', notificationRef: 'ref-1' })],
      () => json({ data: [] }),
    );
    renderScreen();

    await waitFor(() => expect(screen.getByText('Task created')).toBeInTheDocument());
    fireEvent.click(screen.getAllByRole('button', { name: /Dismiss/ })[0]);

    expect(screen.queryByText('Task created')).not.toBeInTheDocument();
    expect(screen.queryByText('Task (confirmed)')).not.toBeInTheDocument();
  });

  it('puts the card back when the dismiss fails', async () => {
    stubFetch([card({})], () => json({ error: 'not dismissible' }, 409));
    renderScreen();

    await waitFor(() => expect(screen.getByText('Draft ready')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }));
    expect(screen.queryByText('Draft ready')).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByText('Draft ready')).toBeInTheDocument());
    // The button is usable again, not stuck on "Dismissed".
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeEnabled();
  });
});
