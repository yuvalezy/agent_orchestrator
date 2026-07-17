import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ComponentProps, type ReactElement, useState } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Timeline } from './Timeline';
import { DetailSheet } from './DetailSheet';
import type { DetailKind, TimelineRow } from './types';

function row(overrides: Partial<TimelineRow>): TimelineRow {
  return {
    id: 'r', kind: 'inbound', itemKind: null, itemId: null, title: null, snippet: 'body',
    status: null, createdAt: '2026-07-16T10:00:00.000Z', senderName: null, taskRef: null,
    linkUrl: null, category: null, priority: null, ...overrides,
  };
}

/** The timeline owns its scroll container, so every test drives the full component API. */
function renderTimeline(props: Partial<ComponentProps<typeof Timeline>> = {}): void {
  render(
    <Timeline
      rows={[]}
      hasMore={false}
      loadingOlder={false}
      onLoadOlder={vi.fn()}
      onOpen={vi.fn()}
      focusId={null}
      {...props}
    />,
  );
}

/** True when `later` really does come after `earlier` in the document. */
function comesAfter(earlier: Element, later: Element): boolean {
  return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe('Timeline', () => {
  it('renders oldest-first, though the API pages newest-first', () => {
    renderTimeline({ rows: [
      row({ id: 'inbox:3', snippet: 'and this is the newest', createdAt: '2026-07-16T12:00:00.000Z' }),
      row({ id: 'inbox:2', snippet: 'this came second', createdAt: '2026-07-16T11:00:00.000Z' }),
      row({ id: 'inbox:1', snippet: 'this was said first', createdAt: '2026-07-16T10:00:00.000Z' }),
    ] });

    expect(comesAfter(screen.getByText('this was said first'), screen.getByText('this came second'))).toBe(true);
    expect(comesAfter(screen.getByText('this came second'), screen.getByText('and this is the newest'))).toBe(true);
  });

  it("attributes the founder's own inbox row to them, not to the customer", () => {
    renderTimeline({ rows: [
      // An agent_inbox row with direction='outbound' is the founder's own sent message: kind
      // 'outbound', but itemKind stays 'inbox'. It used to render as an incoming bubble.
      row({ id: 'inbox:2', kind: 'outbound', itemKind: 'inbox', itemId: '2', snippet: 'Looking into it now', status: 'skipped' }),
      row({ id: 'inbox:1', kind: 'inbound', senderName: 'Jane Roe', snippet: 'Login is broken' }),
    ] });

    expect(within(screen.getByRole('article', { name: 'You' })).getByText('Looking into it now')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Jane Roe' })).getByText('Login is broken')).toBeInTheDocument();
    // 'skipped' is inbox bookkeeping for a message that was never ours to send — not a delivery state.
    expect(screen.queryByText('skipped')).not.toBeInTheDocument();
  });

  it('renders the real message text, its sender and its subject — never a placeholder', () => {
    renderTimeline({ rows: [
      row({ id: 'inbox:9', itemKind: 'inbox', itemId: '9', senderName: 'Jane Roe', title: 'Login is broken', snippet: 'I cannot log in since this morning' }),
      row({ id: 'outbound:4', kind: 'outbound', itemKind: 'outbound', itemId: '4', snippet: 'We have shipped a fix', status: 'sent' }),
    ] });

    expect(screen.getByText('I cannot log in since this morning')).toBeInTheDocument();
    expect(screen.getByText('Jane Roe')).toBeInTheDocument();
    expect(screen.getByText('Login is broken')).toBeInTheDocument();
    expect(within(screen.getByRole('article', { name: 'Reply' })).getByText('sent')).toBeInTheDocument();
    expect(screen.queryByText('Inbound message')).not.toBeInTheDocument();
    expect(screen.queryByText('Outbound reply')).not.toBeInTheDocument();
  });

  it('falls back to a label only when a row genuinely carries no text', () => {
    renderTimeline({ rows: [
      // Media carries its own snippet now, so a textless row is a real rarity rather than the
      // rule — which is exactly why the fallback must not read like content.
      row({ id: 'inbox:2', snippet: '📷 Photo' }),
      row({ id: 'inbox:1', snippet: null, title: null }),
    ] });

    expect(screen.getByText('📷 Photo')).toBeInTheDocument();
    expect(screen.getByText('No message text')).toBeInTheDocument();
    expect(screen.queryByText('—')).not.toBeInTheDocument();
  });

  it('reads a decision as the event it is: what was decided, and why', () => {
    renderTimeline({ rows: [row({
      id: 'decision:4', kind: 'decision', itemKind: 'decision', itemId: '4',
      title: 'Fix SSO login for Jane', snippet: 'Jane cannot log in since this morning; likely SSO.',
      status: 'accepted', category: 'support', priority: 'urgent', taskRef: 'task-7',
    })] });

    expect(screen.getByText('Fix SSO login for Jane')).toBeInTheDocument();
    expect(screen.getByText('Jane cannot log in since this morning; likely SSO.')).toBeInTheDocument();
    // Classification is a chip, not something concatenated into the title.
    expect(screen.getByText('support')).toBeInTheDocument();
    expect(screen.getByText('urgent')).toBeInTheDocument();
    expect(screen.getByText('accepted')).toBeInTheDocument();
    // The old row was a bare "● triage · accepted" pill, which said nothing at all.
    expect(screen.queryByText(/triage/i)).not.toBeInTheDocument();
  });

  it('shows a linked task by its title, never by its raw ref', () => {
    renderTimeline({ rows: [
      row({ id: 'task_link:2', kind: 'notification', title: 'Fix SSO login for Acme', snippet: null, status: 'contributed_to', taskRef: 'task-7' }),
      // An untriaged task link has no title anywhere local; the backend hands back the ref.
      row({ id: 'task_link:3', kind: 'notification', title: 'a13a3055-2e72-4631-aa1e-54744385e093', snippet: null, status: 'linked', taskRef: 'a13a3055-2e72-4631-aa1e-54744385e093' }),
    ] });

    expect(screen.getByText('Fix SSO login for Acme')).toBeInTheDocument();
    expect(screen.getAllByText('Task linked')).toHaveLength(2);
    expect(screen.queryByText(/a13a3055/)).not.toBeInTheDocument();
  });

  it('calls onOpen with the row kind and item id when a backed row is tapped', () => {
    const onOpen = vi.fn();
    renderTimeline({ rows: [row({ id: 'outbound:42', kind: 'outbound', snippet: 'tap me', itemKind: 'outbound', itemId: 'o-42' })], onOpen });

    fireEvent.click(screen.getByText('tap me'));
    expect(onOpen).toHaveBeenCalledWith('outbound', 'o-42');
  });

  it('opens a decision row into its detail sheet', () => {
    const onOpen = vi.fn();
    renderTimeline({ rows: [row({ id: 'decision:4', kind: 'decision', itemKind: 'decision', itemId: '4', title: 'Draft reply', snippet: null, taskRef: 'task-7' })], onOpen });

    fireEvent.click(screen.getByText('Draft reply'));
    expect(onOpen).toHaveBeenCalledWith('decision', '4');
  });
});

const TASK_URL = 'https://account.ezyts.com/projects/tasks/eded778a-587b-4fd7-ae32-ccc4fcb94bab';

describe('Timeline → Open Task', () => {
  it('opens the portal task the server linked, in a new tab', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    // A task link has no detail sheet at all, so this is the row's only way through.
    renderTimeline({ rows: [row({ id: 'task_link:2', kind: 'notification', title: 'Fix SSO login for Acme', snippet: null, status: 'linked', taskRef: 'task-7', linkUrl: TASK_URL })] });

    fireEvent.click(screen.getByRole('button', { name: 'Open Task' }));
    expect(open).toHaveBeenCalledWith(TASK_URL, '_blank', 'noopener,noreferrer');
  });

  it('offers the task and the drill-down as separate actions, neither nested in the other', () => {
    const open = vi.fn();
    const onOpen = vi.fn();
    vi.stubGlobal('open', open);
    renderTimeline({ rows: [row({ id: 'decision:4', kind: 'decision', itemKind: 'decision', itemId: '4', title: 'Fix SSO login for Jane', snippet: null, taskRef: 'task-7', linkUrl: TASK_URL })], onOpen });

    // Were the button a child of the tappable card, this click would fire both.
    fireEvent.click(screen.getByRole('button', { name: 'Open Task' }));
    expect(open).toHaveBeenCalledWith(TASK_URL, '_blank', 'noopener,noreferrer');
    expect(onOpen).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('Fix SSO login for Jane'));
    expect(onOpen).toHaveBeenCalledWith('decision', '4');
    expect(open).toHaveBeenCalledOnce();
  });

  it('renders no Open Task button when the server linked no task', () => {
    // linkUrl fails closed server-side: no task, or no configured portal base. Never guess one.
    renderTimeline({ rows: [
      row({ id: 'decision:4', kind: 'decision', itemKind: 'decision', itemId: '4', title: 'Draft reply', snippet: null, taskRef: 'task-7', linkUrl: null }),
      row({ id: 'inbox:1', snippet: 'Login is broken' }),
    ] });

    expect(screen.queryByRole('button', { name: 'Open Task' })).not.toBeInTheDocument();
    // We still know a task exists — we just cannot reach it — so the chip stays.
    expect(screen.getByText('Task')).toBeInTheDocument();
  });
});

describe('Timeline paging', () => {
  it('loads earlier history from the affordance at the top of the thread', () => {
    const onLoadOlder = vi.fn();
    renderTimeline({ rows: [row({})], hasMore: true, onLoadOlder });

    fireEvent.click(screen.getByRole('button', { name: 'Load earlier' }));
    expect(onLoadOlder).toHaveBeenCalledOnce();
  });

  it('loads earlier history when the founder scrolls to the top of the thread', () => {
    const onLoadOlder = vi.fn();
    renderTimeline({ rows: [row({})], hasMore: true, onLoadOlder });

    // jsdom has no layout: the container's scrollTop is 0, i.e. pinned to the top.
    fireEvent.scroll(screen.getByRole('log'));
    expect(onLoadOlder).toHaveBeenCalled();
  });

  it('offers no earlier history when the thread is exhausted', () => {
    const onLoadOlder = vi.fn();
    renderTimeline({ rows: [row({})], hasMore: false, onLoadOlder });

    expect(screen.queryByRole('button', { name: 'Load earlier' })).not.toBeInTheDocument();
    fireEvent.scroll(screen.getByRole('log'));
    expect(onLoadOlder).not.toHaveBeenCalled();
  });

  it('does not ask for another page while one is already in flight', () => {
    const onLoadOlder = vi.fn();
    renderTimeline({ rows: [row({})], hasMore: true, loadingOlder: true, onLoadOlder });

    fireEvent.scroll(screen.getByRole('log'));
    expect(onLoadOlder).not.toHaveBeenCalled();
  });
});

describe('Timeline focus', () => {
  const rows = [
    row({ id: 'inbox:2', snippet: 'the newest thing said' }),
    row({ id: 'inbox:1', snippet: 'the message the card was raised from' }),
  ];

  it('marks the row a card pointed at', () => {
    renderTimeline({ rows, focusId: 'inbox:1' });

    expect(screen.getByText('the message the card was raised from').closest('[aria-current="true"]')).not.toBeNull();
    expect(screen.getByText('the newest thing said').closest('[aria-current="true"]')).toBeNull();
  });

  it('tolerates a focus id that is not in the loaded page', () => {
    renderTimeline({ rows, focusId: 'inbox:404' });

    expect(screen.getByText('the newest thing said')).toBeInTheDocument();
    expect(document.querySelector('[aria-current="true"]')).toBeNull();
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
      <Timeline
        rows={[row({ id: 'inbox:7', snippet: 'open the sheet', itemKind: 'inbox', itemId: 'inbox-7' })]}
        hasMore={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        focusId={null}
        onOpen={(kind, id) => setTarget({ kind, id })}
      />
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
