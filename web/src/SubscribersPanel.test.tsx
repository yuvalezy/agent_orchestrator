import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SubscribersPanel } from './SubscribersPanel';

interface DeviceRow {
  id: string;
  label: string | null;
  pushEnabled: boolean;
  failureCount: number;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}
interface BrowserRow {
  id: string;
  endpointPrefix: string;
  disabledAt: string | null;
  failureCount: number;
  lastFailureKind: string | null;
  lastSeenAt: string;
  createdAt: string;
}

const activeDevice: DeviceRow = {
  id: 'dev-1', label: 'iPhone 15', pushEnabled: true, failureCount: 0,
  createdAt: '2025-01-01T00:00:00Z', lastSeenAt: '2025-06-01T00:00:00Z', revokedAt: null,
};
const pushOffDevice: DeviceRow = {
  id: 'dev-2', label: 'Muted phone', pushEnabled: false, failureCount: 1,
  createdAt: '2025-01-01T00:00:00Z', lastSeenAt: '2025-06-01T00:00:00Z', revokedAt: null,
};
const revokedDevice: DeviceRow = {
  id: 'dev-3', label: 'Old phone', pushEnabled: false, failureCount: 0,
  createdAt: '2025-01-01T00:00:00Z', lastSeenAt: '2025-05-01T00:00:00Z', revokedAt: '2025-05-02T00:00:00Z',
};
const activeBrowser: BrowserRow = {
  id: 'brw-1', endpointPrefix: 'https://fcm.googleapis.com/fcm/send/', disabledAt: null,
  failureCount: 0, lastFailureKind: null,
  lastSeenAt: '2025-06-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z',
};
const removedBrowser: BrowserRow = {
  id: 'brw-2', endpointPrefix: 'https://updates.push.services.mozilla.com/wpush/v2/', disabledAt: '2025-05-01T00:00:00Z',
  failureCount: 3, lastFailureKind: 'unsubscribe',
  lastSeenAt: '2025-05-01T00:00:00Z', createdAt: '2025-01-01T00:00:00Z',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

interface StubOpts {
  devices?: DeviceRow[];
  browsers?: BrowserRow[];
  // Per-URL override for mutating endpoints; returns [status, body].
  mutate?: (url: string) => [number, unknown] | undefined;
}

function stubApi(opts: StubOpts = {}): ReturnType<typeof vi.fn> {
  const devices = opts.devices ?? [activeDevice, pushOffDevice, revokedDevice];
  const browsers = opts.browsers ?? [activeBrowser, removedBrowser];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (method !== 'GET' && opts.mutate) {
      const out = opts.mutate(url);
      if (out) return json(out[1], out[0]);
    }
    if (url.endsWith('/subscribers/devices')) return json({ data: devices });
    if (url.endsWith('/subscribers/browsers')) return json({ data: browsers });
    return json({ error: `unexpected ${method} ${url}` }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderView(): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SubscribersPanel /></QueryClientProvider>);
  return client;
}

afterEach(() => vi.unstubAllGlobals());

describe('SubscribersPanel', () => {
  it('renders both sections with their active rows by default and all rows when the filter is widened', async () => {
    stubApi();
    renderView();

    // "Phones" section title appears, and the default Active filter shows only the active rows.
    expect(await screen.findByText('Phones')).toBeInTheDocument();
    expect(await screen.findByText('iPhone 15')).toBeInTheDocument();
    expect(screen.queryByText('Muted phone')).not.toBeInTheDocument();
    expect(screen.queryByText('Old phone')).not.toBeInTheDocument();
    expect(screen.getByText('https://fcm.googleapis.com/fcm/send/…')).toBeInTheDocument();
    expect(screen.queryByText('https://updates.push.services.mozilla.com/wpush/v2/…')).not.toBeInTheDocument();

    // Widen the phones filter to All — history rows appear.
    fireEvent.click(screen.getByRole('button', { name: 'Phones status filter' }));
    fireEvent.click(screen.getByRole('option', { name: 'All' }));
    await waitFor(() => expect(screen.getByText('Muted phone')).toBeInTheDocument());
    expect(screen.getByText('Old phone')).toBeInTheDocument();
  });

  it('renders the empty state when a section has no rows', async () => {
    stubApi({ devices: [], browsers: [] });
    renderView();

    expect(await screen.findByText('No phones in this view.')).toBeInTheDocument();
    expect(screen.getByText('No subscriptions in this view.')).toBeInTheDocument();
  });

  it('narrows the phone list when the filter is set to Revoked', async () => {
    stubApi();
    renderView();

    // Switch to All so the revoked row appears, then narrow to Revoked.
    fireEvent.click(await screen.findByRole('button', { name: 'Phones status filter' }));
    fireEvent.click(screen.getByRole('option', { name: 'All' }));
    await waitFor(() => expect(screen.getByText('iPhone 15')).toBeInTheDocument());
    expect(screen.getByText('Old phone')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Phones status filter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Revoked' }));

    await waitFor(() => expect(screen.queryByText('iPhone 15')).not.toBeInTheDocument());
    expect(screen.getByText('Old phone')).toBeInTheDocument();
  });

  it('narrows the browser list when the filter is set to Removed', async () => {
    stubApi();
    renderView();

    // Default Active shows only the live browser.
    expect(await screen.findByText('https://fcm.googleapis.com/fcm/send/…')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Browsers status filter' }));
    fireEvent.click(screen.getByRole('option', { name: 'Removed' }));

    await waitFor(() => expect(screen.queryByText('https://fcm.googleapis.com/fcm/send/…')).not.toBeInTheDocument());
    expect(screen.getByText('https://updates.push.services.mozilla.com/wpush/v2/…')).toBeInTheDocument();
  });

  it('disables Disable push when pushEnabled is false and Revoke device when already revoked', async () => {
    stubApi();
    renderView();

    // Widen to All so all three phone rows render.
    fireEvent.click(await screen.findByRole('button', { name: 'Phones status filter' }));
    fireEvent.click(screen.getByRole('option', { name: 'All' }));
    await waitFor(() => expect(screen.getByText('Old phone')).toBeInTheDocument());

    const disableButtons = screen.getAllByRole('button', { name: 'Disable push' });
    const revokeButtons = screen.getAllByRole('button', { name: 'Revoke device' });
    // 3 phone rows × (Disable push, Revoke device) — sanity check the counts.
    expect(disableButtons).toHaveLength(3);
    expect(revokeButtons).toHaveLength(3);

    // Order in the list: iPhone 15 (active), Muted phone (push off), Old phone (revoked).
    expect(disableButtons[0]).toBeEnabled();   // active
    expect(disableButtons[1]).toBeDisabled();  // push off
    expect(disableButtons[2]).toBeDisabled();  // revoked
    expect(revokeButtons[0]).toBeEnabled();
    expect(revokeButtons[1]).toBeEnabled();
    expect(revokeButtons[2]).toBeDisabled();   // already revoked
  });

  it('posts to the revoke URL and refetches when the action is confirmed', async () => {
    let devices: DeviceRow[] = [activeDevice];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/subscribers/devices/dev-1/revoke')) {
        devices = [{ ...activeDevice, revokedAt: '2025-06-02T00:00:00Z', pushEnabled: false }];
        return json({ data: { id: 'dev-1', revokedAt: '2025-06-02T00:00:00Z' } });
      }
      if (url.endsWith('/subscribers/devices')) return json({ data: devices });
      if (url.endsWith('/subscribers/browsers')) return json({ data: [] });
      return json({ error: 'unexpected' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderView();

    await screen.findByText('iPhone 15');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke device' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url, init]) => (init as RequestInit | undefined)?.method === 'POST' && String(url).endsWith('/subscribers/devices/dev-1/revoke'))).toBe(true);
    });
    // The revoked row disappears from the Active filter; the Revoke button goes with it.
    await waitFor(() => expect(screen.queryByText('iPhone 15')).not.toBeInTheDocument());
  });

  it('renders an error banner when a mutation rejects', async () => {
    stubApi({
      mutate: (url) => {
        if (url.endsWith('/subscribers/browsers/brw-1/remove')) return [500, { error: 'push service down' }];
        return undefined;
      },
    });
    renderView();

    await screen.findByText('https://fcm.googleapis.com/fcm/send/…');
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await screen.findByText('push service down');
  });

  it('treats a 404 from a mutation as success and refetches', async () => {
    let browsers: BrowserRow[] = [activeBrowser];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/subscribers/browsers/brw-1/remove')) {
        return json({ error: 'gone' }, 404);
      }
      if (url.endsWith('/subscribers/devices')) return json({ data: [] });
      if (url.endsWith('/subscribers/browsers')) return json({ data: browsers });
      return json({ error: 'unexpected' }, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    renderView();
    await screen.findByText('https://fcm.googleapis.com/fcm/send/…');

    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    // No error banner should appear even though the POST returned 404.
    await waitFor(() => expect(screen.queryByText('gone')).not.toBeInTheDocument());
    // The browser list GET was re-fetched.
    await waitFor(() => {
      const browserGets = fetchMock.mock.calls.filter(([url, init]) => String(url).endsWith('/subscribers/browsers') && (init as RequestInit | undefined)?.method !== 'POST');
      expect(browserGets.length).toBeGreaterThanOrEqual(2);
    });
  });
});
