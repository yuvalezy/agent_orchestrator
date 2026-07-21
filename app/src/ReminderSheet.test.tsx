import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ReminderSheet } from './ReminderSheet';
import { api } from './lib/api';

vi.mock('./lib/api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const reminder = {
  id: 'r1',
  body: 'Call Acme',
  executeAt: '2026-08-01T15:00:00.000Z',
  customerId: null,
  customerName: null,
};

/** Route the mock by path + method: GET /reminders lists, POST creates, DELETE cancels.
 *  A stray no-arg call (vitest invokes the spy once during teardown) resolves to nothing. */
function route(overrides: { list?: unknown[]; del?: string } = {}) {
  mockApi.mockImplementation((path?: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (path === '/reminders' && method === 'GET') return Promise.resolve({ data: overrides.list ?? [] });
    if (path === '/reminders' && method === 'POST') return Promise.resolve({ data: { id: 'new' } });
    if (typeof path === 'string' && path.startsWith('/reminders/') && method === 'DELETE') {
      return Promise.resolve({ data: { status: overrides.del ?? 'cancelled' } });
    }
    return Promise.resolve(undefined);
  });
}

function openSheet(): void {
  render(<ReminderSheet open onClose={() => {}} />);
}

describe('ReminderSheet', () => {
  beforeEach(() => mockApi.mockReset());

  it('fetches and renders the upcoming reminders list on open', async () => {
    route({ list: [reminder] });
    openSheet();
    expect(await screen.findByText('Call Acme')).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith('/reminders');
  });

  it('posts the text + wall-clock to /reminders when a reminder is created', async () => {
    route({ list: [] });
    openSheet();
    await screen.findByText('No upcoming reminders.');

    fireEvent.change(screen.getByLabelText('Reminder text'), { target: { value: 'Call Acme' } });
    fireEvent.change(screen.getByLabelText('Reminder time'), { target: { value: '2026-08-01T15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Set reminder' }));

    await waitFor(() =>
      expect(mockApi).toHaveBeenCalledWith('/reminders', {
        method: 'POST',
        body: JSON.stringify({ text: 'Call Acme', localTime: '2026-08-01T15:00' }),
      }),
    );
    expect(await screen.findByText('Reminder set.')).toBeInTheDocument();
  });

  it('cancels a reminder via DELETE and shows the returned status', async () => {
    route({ list: [reminder], del: 'cancelled' });
    openSheet();
    await screen.findByText('Call Acme');

    fireEvent.click(screen.getByRole('button', { name: /Cancel reminder/ }));

    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/reminders/r1', { method: 'DELETE' }));
    expect(await screen.findByText('Cancelled.')).toBeInTheDocument();
  });

  it('shows the unavailable message when the list 503s', async () => {
    mockApi.mockImplementation((path?: string) => {
      if (typeof path !== 'string') return Promise.resolve(undefined);
      const err = new Error('unavailable') as Error & { status?: number };
      err.status = 503;
      return Promise.reject(err);
    });
    openSheet();
    expect(await screen.findByText("Reminders aren't available right now.")).toBeInTheDocument();
  });
});
