import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatFeed } from './ChatFeed';
import type { Feed } from './useFeed';
import type { Message } from './types';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'id', direction: 'out', kind: 'chat', title: null, body: 'body',
    severity: null, customerRef: null, notificationRef: null, buttons: null,
    decidedOptionId: null, createdAt: '2026-07-16T10:00:00.000Z', ...overrides,
  };
}

function feed(messages: Message[], decide = vi.fn()): Feed {
  return {
    messages, loading: false, error: null, hasMore: false, loadingMore: false, sending: false, eventToken: 0,
    loadOlder: vi.fn(), send: vi.fn(), decide, refetch: vi.fn(),
  };
}

describe('ChatFeed', () => {
  it('renders founder messages on the right and assistant notifications on the left with title and severity', () => {
    render(<ChatFeed feed={feed([
      message({ id: 'a', direction: 'in', kind: 'chat', body: 'Where are we on the deal?' }),
      message({ id: 'b', direction: 'out', kind: 'notification', title: 'Payment failed', body: 'Acme card was declined.', severity: 'warning' }),
    ])} />);

    const mine = screen.getByText('Where are we on the deal?');
    expect(mine.closest('.justify-end')).not.toBeNull();

    const assistant = screen.getByText('Acme card was declined.');
    expect(assistant.closest('.justify-start')).not.toBeNull();
    expect(screen.getByText('Payment failed')).toBeInTheDocument();
  });

  it('shows a decided question as checkmarked and disables every chip', () => {
    render(<ChatFeed feed={feed([
      message({
        id: 'q', direction: 'out', kind: 'question', body: 'Approve the refund?',
        buttons: [{ id: 'yes', label: 'Approve' }, { id: 'no', label: 'Decline' }],
        decidedOptionId: 'yes',
      }),
    ])} />);

    const approve = screen.getByRole('button', { name: /Approve/ });
    const decline = screen.getByRole('button', { name: /Decline/ });
    expect(approve).toBeDisabled();
    expect(decline).toBeDisabled();
    expect(approve).toHaveAttribute('aria-pressed', 'true');
    expect(decline).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls decide with the message id and chosen option when an open chip is tapped', () => {
    const decide = vi.fn();
    render(<ChatFeed feed={feed([
      message({
        id: 'q1', direction: 'out', kind: 'question', body: 'Book the call?',
        buttons: [{ id: 'book', label: 'Book it' }, { id: 'skip', label: 'Skip' }],
      }),
    ], decide)} />);

    fireEvent.click(screen.getByRole('button', { name: /Book it/ }));
    expect(decide).toHaveBeenCalledWith('q1', 'book');
  });
});
