import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MeetingTimeReply } from './MeetingTimeReply';
import { api } from './lib/api';

vi.mock('./lib/api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

function open(): HTMLInputElement {
  render(<MeetingTimeReply messageId="m1" />);
  fireEvent.click(screen.getByRole('button', { name: /Another time/ }));
  return screen.getByLabelText('Pick a time') as HTMLInputElement;
}

describe('MeetingTimeReply', () => {
  beforeEach(() => mockApi.mockReset());

  it('posts the chosen wall-clock to /meeting-time and confirms a booking', async () => {
    mockApi.mockResolvedValue({ data: { status: 'booked' } });
    const input = open();
    fireEvent.change(input, { target: { value: '2026-08-01T15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));

    await waitFor(() => expect(screen.getByText(/Booking that time/)).toBeInTheDocument());
    expect(mockApi).toHaveBeenCalledWith('/meeting-time', { method: 'POST', body: JSON.stringify({ messageId: 'm1', localTime: '2026-08-01T15:00' }) });
  });

  it('keeps the picker open with a note when the time is unavailable', async () => {
    mockApi.mockResolvedValue({ data: { status: 'unavailable' } });
    const input = open();
    fireEvent.change(input, { target: { value: '2026-08-01T15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));

    await waitFor(() => expect(screen.getByText(/busy then/i)).toBeInTheDocument());
    // Still bookable — the input is present so the founder can pick again.
    expect(screen.getByLabelText('Pick a time')).toBeInTheDocument();
  });

  it('reports "already handled" when the meeting is no longer pending', async () => {
    mockApi.mockResolvedValue({ data: { status: 'not_pending' } });
    const input = open();
    fireEvent.change(input, { target: { value: '2026-08-01T15:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));

    expect(await screen.findByText(/already handled/i)).toBeInTheDocument();
  });
});
