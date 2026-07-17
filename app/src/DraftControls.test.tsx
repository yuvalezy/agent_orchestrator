import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DraftControls } from './DraftControls';
import { api } from './lib/api';
import type { Button } from './types';

// Resolve-based mocks by default; the one rejection case (409) is caught by the component's own
// .catch, so nothing is ever left as a floating rejection for vitest's guard to trip on.
vi.mock('./lib/api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const { refetchAttention } = vi.hoisted(() => ({ refetchAttention: vi.fn() }));
vi.mock('./AppData', () => ({ useOptionalAppData: () => ({ refetchAttention }) }));

const DA: Button = { id: 'da', label: 'Approve' };
const DE: Button = { id: 'de', label: 'Edit' };
const DR: Button = { id: 'dr', label: 'Reject' };
const DV: Button = { id: 'dv', label: 'Revise' };

interface CardLike { id: string; body: string; notificationRef: string | null; buttons: Button[] | null }
function card(overrides: Partial<CardLike> = {}): CardLike {
  return { id: 'c1', body: 'COMPOSED presentation body', notificationRef: 'ref-1', buttons: [DA, DE, DR, DV], ...overrides };
}

describe('DraftControls', () => {
  beforeEach(() => { mockApi.mockReset(); refetchAttention.mockReset(); });

  it('renders Approve/Edit/Reject, and Revise only when `dv` is present', () => {
    const { rerender } = render(<DraftControls card={card({ buttons: [DA, DE, DR] })} decidedOptionId={null} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Revise' })).not.toBeInTheDocument();

    rerender(<DraftControls card={card({ buttons: [DA, DE, DR, DV] })} decidedOptionId={null} onDecide={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Revise' })).toBeInTheDocument();
  });

  it('keeps Approve/Reject on the optimistic onDecide path', () => {
    const onDecide = vi.fn();
    render(<DraftControls card={card({ id: 'c9' })} decidedOptionId={null} onDecide={onDecide} />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onDecide).toHaveBeenCalledWith('c9', 'da');
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(onDecide).toHaveBeenCalledWith('c9', 'dr');
  });

  it('prefetches the CLEAN body from the outbound detail into the Edit textarea (not card.body)', async () => {
    mockApi.mockResolvedValueOnce({ data: { body: 'clean reply text' } });
    render(<DraftControls card={card()} decidedOptionId={null} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));

    expect(mockApi).toHaveBeenCalledWith('/items/outbound/ref-1');
    const textarea = (await screen.findByLabelText('Edit reply')) as HTMLTextAreaElement;
    expect(textarea.value).toBe('clean reply text');
    expect(textarea.value).not.toContain('COMPOSED');
  });

  it('Save & send POSTs to /drafts/{card.id}/edit and refetches', async () => {
    mockApi
      .mockResolvedValueOnce({ data: { body: 'clean reply' } })
      .mockResolvedValueOnce({ data: { queueId: 'ref-1', status: 'approved' } });
    render(<DraftControls card={card()} decidedOptionId={null} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    await screen.findByLabelText('Edit reply');

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));
    await waitFor(() => expect(refetchAttention).toHaveBeenCalled());
    // Path keys off the app UUID `c1`, NOT the queueId `ref-1`.
    expect(mockApi).toHaveBeenCalledWith('/drafts/c1/edit', { method: 'POST', body: JSON.stringify({ body: 'clean reply' }) });
    expect(await screen.findByText(/Edited and sent/)).toBeInTheDocument();
  });

  it('Revise → Regenerate POSTs the instruction, shows the generating state, then refetches', async () => {
    let resolve!: (v: unknown) => void;
    mockApi.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    render(<DraftControls card={card()} decidedOptionId={null} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }));

    const input = screen.getByLabelText('Revision instruction') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'be concise' } });
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));

    // Pending: the generating affordance is shown while the await is outstanding.
    expect(await screen.findByText(/Generating…/)).toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith('/drafts/c1/revise', { method: 'POST', body: JSON.stringify({ instruction: 'be concise' }) });

    resolve({ data: { queueId: 'ref-1', revised: true } });
    await waitFor(() => expect(refetchAttention).toHaveBeenCalled());
    expect(await screen.findByText(/review the regenerated draft/)).toBeInTheDocument();
  });

  it('shows a "handled on another surface" note and refetches on 409', async () => {
    mockApi.mockRejectedValueOnce(Object.assign(new Error('already decided'), { status: 409 }));
    render(<DraftControls card={card()} decidedOptionId={null} onDecide={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Revise' }));
    fireEvent.change(screen.getByLabelText('Revision instruction'), { target: { value: 'redo' } });
    fireEvent.click(screen.getByRole('button', { name: /Regenerate/ }));

    expect(await screen.findByText(/Handled on another surface/)).toBeInTheDocument();
    expect(refetchAttention).toHaveBeenCalled();
  });

  it('locks — hides the Edit/Revise triggers once the card is decided', () => {
    render(<DraftControls card={card()} decidedOptionId="da" onDecide={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revise' })).not.toBeInTheDocument();
    // The Approve/Reject chips remain, locked (parity with DecisionChips).
    expect(screen.getByRole('button', { name: /Approve/ })).toBeDisabled();
  });
});
