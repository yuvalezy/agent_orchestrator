import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { type ReactElement } from 'react';
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

/** Renders the URL the card navigated to, so a tap is asserted on behaviour, not on a spy. */
function Probe(): ReactElement {
  const { pathname, search } = useLocation();
  return <p data-testid="url">{`${pathname}${search}`}</p>;
}

function renderRouted(node: ReactElement): void {
  render(<MemoryRouter initialEntries={['/attention']}>{node}<Probe /></MemoryRouter>);
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

  it('opens the thread behind the card, focused on the row it was raised from', () => {
    renderRouted(
      <AttentionCard
        card={card({ customerId: 'cust-list-1', context: { contextRef: { kind: 'inbox', ref: 'i-9' } } })}
        decidedOptionId={null}
        onDecide={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
    // `focus` is a TimelineRow.id, so the thread can scroll to this exact row.
    expect(screen.getByTestId('url')).toHaveTextContent('/customer/cust-list-1?focus=inbox%3Ai-9');
  });

  it('is not tappable when the card carries no origin — there is no thread to open', () => {
    renderRouted(<AttentionCard card={card({ context: null })} decidedOptionId={null} onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open thread' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /View thread/ })).not.toBeInTheDocument();
  });

  it('keeps the draft expander OUT of the card tap — no button inside a button', () => {
    renderRouted(
      <AttentionCard
        card={card({ body: 'x'.repeat(400), context: { contextRef: { kind: 'inbox', ref: 'i-9' } } })}
        decidedOptionId={null}
        onDecide={vi.fn()}
      />,
    );

    const tap = screen.getByRole('button', { name: 'Open thread' });
    expect(tap.querySelector('button')).toBeNull();
    // Expanding still works, and does not navigate.
    fireEvent.click(screen.getByRole('button', { name: /Show full draft/ }));
    expect(screen.getByTestId('url')).toHaveTextContent('/attention');
  });
});
