import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';
import type { Message } from './types';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'id', direction: 'out', kind: 'chat', title: null, body: 'body',
    severity: null, customerRef: null, notificationRef: null, buttons: null,
    decidedOptionId: null, createdAt: '2026-07-16T10:00:00.000Z', ...overrides,
  };
}

describe('MessageBubble', () => {
  it('renders decision chips on a kind:notification row, not only on questions', () => {
    // The money-loop buttons (draft Approve/Edit/Reject/Revise, task Cancel) arrive as
    // notifications — they must still be tappable.
    render(<MessageBubble onDecide={vi.fn()} message={message({
      kind: 'notification', title: 'Draft ready', body: 'Reply drafted for Acme.', severity: 'action',
      buttons: [{ id: 'approve', label: 'Approve' }, { id: 'edit', label: 'Edit' }, { id: 'reject', label: 'Reject' }],
    })} />);

    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
  });

  it('fires onDecide with the row id and chosen option when a notification chip is tapped', () => {
    const onDecide = vi.fn();
    render(<MessageBubble onDecide={onDecide} message={message({
      id: 'n1', kind: 'notification', body: 'Cancel this task?',
      buttons: [{ id: 'cancel', label: 'Cancel task' }],
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    expect(onDecide).toHaveBeenCalledWith('n1', 'cancel');
  });

  it('disables every chip and checkmarks the chosen one once decided', () => {
    render(<MessageBubble onDecide={vi.fn()} message={message({
      kind: 'notification', body: 'Draft ready',
      buttons: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
      decidedOptionId: 'approve',
    })} />);

    const approve = screen.getByRole('button', { name: /Approve/ });
    const reject = screen.getByRole('button', { name: /Reject/ });
    expect(approve).toBeDisabled();
    expect(reject).toBeDisabled();
    expect(approve).toHaveAttribute('aria-pressed', 'true');
    expect(reject).toHaveAttribute('aria-pressed', 'false');
  });

  it('does not swallow a rejected decision as an unhandled rejection', async () => {
    const onDecide = vi.fn().mockRejectedValue(new Error('409'));
    render(<MessageBubble onDecide={onDecide} message={message({
      id: 'n2', kind: 'notification', body: 'Approve?', buttons: [{ id: 'yes', label: 'Yes' }],
    })} />);

    fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    // The handler wraps onDecide in a caught promise; awaiting a tick surfaces any leak.
    await Promise.resolve();
    expect(onDecide).toHaveBeenCalledWith('n2', 'yes');
  });
});
