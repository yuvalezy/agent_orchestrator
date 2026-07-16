import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppDataProvider } from './AppData';
import { CustomersScreen } from './CustomersScreen';

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Serve the three GETs the screen + provider fire, keyed by path. */
function routeFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/app/api/messages') return jsonResponse({ data: [], nextCursor: null });
    if (path === '/app/api/attention') return jsonResponse({ decisions: [], urgency: [] });
    if (path === '/app/api/customers') {
      return jsonResponse({ data: [
        { id: 'cust-1', displayName: 'Acme Corp', lastActivityAt: '2026-07-16T09:00:00.000Z', lastActivitySnippet: 'Asked about the invoice', pendingCount: 3 },
        { id: 'cust-2', displayName: 'Globex', lastActivityAt: null, lastActivitySnippet: null, pendingCount: 0 },
      ], nextCursor: null });
    }
    throw new Error(`unexpected fetch: ${path}`);
  }));
}

function renderScreen(): void {
  render(
    <MemoryRouter initialEntries={['/customers']}>
      <AppDataProvider config={null} deviceLabel="Test device">
        <Routes><Route path="/customers" element={<CustomersScreen />} /></Routes>
      </AppDataProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('CustomersScreen', () => {
  it('lists customers and renders a pending-decisions badge only when there are pending items', async () => {
    routeFetch();
    renderScreen();

    await waitFor(() => expect(screen.getByText('Acme Corp')).toBeInTheDocument());
    expect(screen.getByText('Asked about the invoice')).toBeInTheDocument();
    // Acme has 3 pending → badge; Globex has 0 → no badge.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Globex')).toBeInTheDocument();
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});
