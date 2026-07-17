import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { AttentionCard } from './AttentionCard';
import type { AttentionCard as AttentionCardData } from './types';

function card(overrides: Partial<AttentionCardData>): AttentionCardData {
  return {
    id: 'c1', direction: 'out', kind: 'notification', title: 'Draft ready', body: 'Short draft.',
    severity: 'action', customerRef: 'cust-1', customerName: 'Acme Corp', notificationRef: 'ref-1',
    buttons: [{ id: 'approve', label: 'Approve' }, { id: 'reject', label: 'Reject' }],
    decidedOptionId: null, createdAt: '2026-07-16T10:00:00.000Z', ...overrides,
  };
}

describe('AttentionCard', () => {
  it('shows the customer name, title, and decision chips', () => {
    render(<AttentionCard card={card({})} decidedOptionId={null} onDecide={vi.fn()} />);
    expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    expect(screen.getByText('Draft ready')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
  });

  it('fires onDecide with the card id and chosen option', () => {
    const onDecide = vi.fn();
    render(<AttentionCard card={card({ id: 'c9' })} decidedOptionId={null} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('c9', 'approve');
  });

  it('collapses a long draft behind a toggle and expands it on tap', () => {
    const long = 'x'.repeat(400);
    render(<AttentionCard card={card({ body: long })} decidedOptionId={null} onDecide={vi.fn()} />);
    // Collapsed: an ellipsis-truncated preview and a reveal toggle.
    const toggle = screen.getByRole('button', { name: /Show full draft/ });
    expect(screen.queryByText(long)).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByText(long)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show less/ })).toBeInTheDocument();
  });

  it('locks the chips and checkmarks the chosen option once decided', () => {
    render(<AttentionCard card={card({})} decidedOptionId="approve" onDecide={vi.fn()} />);
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Reject/ })).toBeDisabled();
  });
});
