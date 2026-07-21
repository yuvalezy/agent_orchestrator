import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { DevicesView } from './DevicesView';

function stubApi(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/subscribers/devices')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    if (url.endsWith('/subscribers/browsers')) return new Response(JSON.stringify({ data: [] }), { status: 200 });
    return new Response(JSON.stringify({ error: 'unexpected' }), { status: 404 });
  }));
}

afterEach(() => vi.unstubAllGlobals());

describe('DevicesView', () => {
  it('renders the page header and both empty subsections', async () => {
    stubApi();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={client}><DevicesView /></QueryClientProvider>);

    expect(screen.getByText('Push delivery')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Devices' })).toBeInTheDocument();
    expect(await screen.findByText('No phones in this view.')).toBeInTheDocument();
    expect(screen.getByText('No subscriptions in this view.')).toBeInTheDocument();
  });
});
