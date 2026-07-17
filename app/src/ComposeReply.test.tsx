import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComposeReply } from './ComposeReply';
import { api } from './lib/api';

// Resolve-based mocks by default; the error cases reject, and the component's own .catch handles
// them, so nothing is ever left as a floating rejection for vitest's guard to trip on.
vi.mock('./lib/api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const { refetchAttention } = vi.hoisted(() => ({ refetchAttention: vi.fn() }));
vi.mock('./AppData', () => ({ useOptionalAppData: () => ({ refetchAttention }) }));

function openAndType(text: string): void {
  render(<ComposeReply customerId="c1" />);
  fireEvent.click(screen.getByRole('button', { name: /Draft a reply/ }));
  fireEvent.change(screen.getByLabelText('Draft prompt'), { target: { value: text } });
}

describe('ComposeReply', () => {
  beforeEach(() => {
    mockApi.mockReset();
    refetchAttention.mockReset();
  });

  it('posts {customerId, prompt} to /drafts/compose and confirms the queued draft', async () => {
    mockApi.mockResolvedValue({ data: { queueId: 'q1' } });
    openAndType('thank them and confirm Tuesday');
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));

    await waitFor(() => expect(screen.getByText(/Draft queued/)).toBeInTheDocument());
    expect(mockApi).toHaveBeenCalledWith('/drafts/compose', {
      method: 'POST',
      body: JSON.stringify({ customerId: 'c1', prompt: 'thank them and confirm Tuesday' }),
    });
    expect(refetchAttention).toHaveBeenCalled();
  });

  it('maps 409 to "no email on file" and keeps the prompt for a retry', async () => {
    mockApi.mockRejectedValueOnce(Object.assign(new Error('no_email_route'), { status: 409 }));
    openAndType('follow up on the quote');
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));

    expect(await screen.findByText(/no email on file/i)).toBeInTheDocument();
    // Still composable — the textarea is present with the prompt so the founder can adjust.
    expect((screen.getByLabelText('Draft prompt') as HTMLTextAreaElement).value).toBe('follow up on the quote');
  });

  it('maps 503 to a drafting-disabled note', async () => {
    mockApi.mockRejectedValueOnce(Object.assign(new Error('draft compose unavailable'), { status: 503 }));
    openAndType('nudge them');
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));

    expect(await screen.findByText(/isn't enabled/i)).toBeInTheDocument();
  });

  it('maps 404 to a customer-not-found note', async () => {
    mockApi.mockRejectedValueOnce(Object.assign(new Error('customer not found'), { status: 404 }));
    openAndType('reply please');
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));

    expect(await screen.findByText(/Customer not found/i)).toBeInTheDocument();
  });

  it('does not submit an empty prompt', () => {
    render(<ComposeReply customerId="c1" />);
    fireEvent.click(screen.getByRole('button', { name: /Draft a reply/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Draft' }));
    expect(mockApi).not.toHaveBeenCalled();
  });
});
