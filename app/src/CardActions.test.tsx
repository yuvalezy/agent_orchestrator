import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ReactElement } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { AppDataProvider } from './AppData';
import { CardActions } from './CardActions';
import type { Message } from './types';

function message(overrides: Partial<Message>): Message {
  return {
    id: 'm1', direction: 'out', kind: 'notification', title: 'Draft ready', body: 'body',
    severity: null, customerRef: 'cust-1', notificationRef: 'ref-1', buttons: null,
    decidedOptionId: null, createdAt: '2026-07-16T10:00:00.000Z', ...overrides,
  };
}

function stubFetch(): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = url.split('?')[0];
    if (path === '/app/api/messages') return new Response(JSON.stringify({ data: [], nextCursor: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/app/api/attention') return new Response(JSON.stringify({ decisions: [], urgency: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`unexpected fetch: ${path}`);
  }));
}

/** The real tree: inside the router (cards navigate) and inside the data layer (cards dismiss). */
function renderCard(node: ReactElement): void {
  stubFetch();
  render(
    <MemoryRouter>
      <AppDataProvider config={null} deviceLabel="dev">{node}</AppDataProvider>
    </MemoryRouter>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('CardActions', () => {
  it('opens the portal task in a new tab when the card carries a link', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    renderCard(<CardActions card={message({ linkUrl: 'https://account.ezyts.com/projects/tasks/abc' })} />);

    fireEvent.click(screen.getByRole('button', { name: /Open Task/ }));
    expect(open).toHaveBeenCalledWith('https://account.ezyts.com/projects/tasks/abc', '_blank', 'noopener,noreferrer');
  });

  it('never invents a link: no Open Task without a linkUrl', () => {
    renderCard(<CardActions card={message({ linkUrl: null })} />);
    expect(screen.queryByRole('button', { name: /Open Task/ })).not.toBeInTheDocument();
  });

  it('offers Dismiss on a notification', () => {
    renderCard(<CardActions card={message({ kind: 'notification' })} />);
    expect(screen.getByRole('button', { name: /Dismiss/ })).toBeEnabled();
  });

  it('never offers Dismiss on a question — a fork must be answered, and the server 409s it', () => {
    renderCard(<CardActions card={message({ kind: 'question' })} />);
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it('drops Dismiss once the card is already dismissed', () => {
    renderCard(<CardActions card={message({ dismissedAt: '2026-07-16T11:00:00.000Z' })} />);
    expect(screen.queryByRole('button', { name: /Dismiss/ })).not.toBeInTheDocument();
  });

  it('offers View thread only when the card knows where it came from', () => {
    renderCard(<CardActions card={message({ context: { contextRef: { kind: 'inbox', ref: 'i1' } } })} />);
    expect(screen.getByRole('button', { name: /View thread/ })).toBeInTheDocument();
  });

  it('has no View thread when the card carries no origin', () => {
    renderCard(<CardActions card={message({ context: null })} />);
    expect(screen.queryByRole('button', { name: /View thread/ })).not.toBeInTheDocument();
  });
});
