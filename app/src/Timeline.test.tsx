import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReactElement, useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Timeline } from './Timeline';
import { DetailSheet } from './DetailSheet';
import type { DetailKind, TimelineRow } from './types';

function row(overrides: Partial<TimelineRow>): TimelineRow {
  return {
    id: 'r', kind: 'inbound', itemKind: null, itemId: null, title: null, snippet: 'body',
    status: null, createdAt: '2026-07-16T10:00:00.000Z', ...overrides,
  };
}

describe('Timeline', () => {
  it('renders inbound left, outbound right (with status), and events as centered markers', () => {
    render(<Timeline onOpen={vi.fn()} rows={[
      row({ id: 'in', kind: 'inbound', snippet: 'Customer asked a question' }),
      row({ id: 'out', kind: 'outbound', snippet: 'We replied', status: 'sent' }),
      row({ id: 'dec', kind: 'decision', title: 'Approved draft' }),
    ]} />);

    expect(screen.getByText('Customer asked a question').closest('.justify-start')).not.toBeNull();
    const outbound = screen.getByText('We replied');
    expect(outbound.closest('.justify-end')).not.toBeNull();
    expect(screen.getByText('sent')).toBeInTheDocument();
    expect(screen.getByText(/Approved draft/).closest('.justify-center')).not.toBeNull();
  });

  it('shows friendly fallbacks instead of a bare dash or a raw task ref', () => {
    render(<Timeline onOpen={vi.fn()} rows={[
      row({ id: 'in-empty', kind: 'inbound', snippet: null, title: null }),
      row({ id: 'out-empty', kind: 'outbound', snippet: null, title: null, status: 'sent' }),
      row({ id: 'tasklink', kind: 'notification', itemKind: null, itemId: null, title: 'a13a3055-2e72-4631-aa1e-54744385e093', snippet: null, status: 'contributed_to' }),
    ]} />);

    expect(screen.getByText('Inbound message')).toBeInTheDocument();
    expect(screen.getByText('Outbound reply')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
    // Task-link marker reads "Task linked · contributed_to", never the raw UUID.
    expect(screen.getByText(/Task linked/)).toBeInTheDocument();
    expect(screen.queryByText(/a13a3055/)).not.toBeInTheDocument();
  });

  it('calls onOpen with the row kind and item id when a backed row is tapped', () => {
    const onOpen = vi.fn();
    render(<Timeline onOpen={onOpen} rows={[
      row({ id: 'out', kind: 'outbound', snippet: 'tap me', itemKind: 'outbound', itemId: 'o-42' }),
    ]} />);
    fireEvent.click(screen.getByText('tap me'));
    expect(onOpen).toHaveBeenCalledWith('outbound', 'o-42');
  });
});

function mockFetch(handler: (url: string) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string) => handler(url));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function Harness(): ReactElement {
  const [target, setTarget] = useState<{ kind: DetailKind; id: string } | null>(null);
  return (
    <>
      <Timeline rows={[row({ id: 'in', kind: 'inbound', snippet: 'open the sheet', itemKind: 'inbox', itemId: 'inbox-7' })]} onOpen={(kind, id) => setTarget({ kind, id })} />
      <DetailSheet target={target} onClose={() => setTarget(null)} />
    </>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Timeline → DetailSheet', () => {
  it('fetches the detail item on tap and renders its fields', async () => {
    const fetchMock = mockFetch((url) => {
      expect(url).toBe('/app/api/items/inbox/inbox-7');
      return new Response(JSON.stringify({ data: { subject: 'Invoice question', status: 'processed' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    render(<Harness />);
    fireEvent.click(screen.getByText('open the sheet'));

    await waitFor(() => expect(screen.getByText('Invoice question')).toBeInTheDocument());
    expect(screen.getByText('processed')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/app/api/items/inbox/inbox-7', expect.objectContaining({ credentials: 'include' }));
  });
});
