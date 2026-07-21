import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ContactPicker } from './ContactPicker';
import { api } from './lib/api';

vi.mock('./lib/api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);

const scopedContacts = [
  { name: 'Alice', email: 'alice@acme.com', isPrimary: true },
  { name: 'Bob', email: 'bob@acme.com', isPrimary: false },
];

const dirContacts = [
  { customerId: 'c1', customerName: 'Acme', name: 'Alice', email: 'alice@acme.com', isPrimary: true },
  { customerId: 'c2', customerName: 'Globex', name: 'Carol', email: 'carol@globex.com', isPrimary: false },
];

/** Route the api mock by path: scoped customer contacts vs the full directory. */
function route(): void {
  mockApi.mockImplementation((path?: string) => {
    if (typeof path === 'string' && path.startsWith('/customers/')) {
      return Promise.resolve({ data: scopedContacts });
    }
    if (path === '/contacts') return Promise.resolve({ data: dirContacts });
    return Promise.resolve({ data: [] });
  });
}

function rowFor(email: string): HTMLElement {
  return screen.getByText(email).closest('button')!;
}

describe('ContactPicker', () => {
  beforeEach(() => mockApi.mockReset());

  it('renders scoped contacts and marks the selected ones', async () => {
    route();
    render(
      <ContactPicker
        selected={new Set(['alice@acme.com'])}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        scopedCustomerId="c1"
        scopedCustomerName="Acme"
      />,
    );
    expect(await screen.findByText('Alice')).toBeInTheDocument();
    expect(rowFor('alice@acme.com')).toHaveAttribute('aria-pressed', 'true');
    expect(rowFor('bob@acme.com')).toHaveAttribute('aria-pressed', 'false');
    expect(mockApi).toHaveBeenCalledWith('/customers/c1/contacts');
  });

  it('fires onToggle with the tapped email', async () => {
    route();
    const onToggle = vi.fn();
    render(
      <ContactPicker
        selected={new Set()}
        onToggle={onToggle}
        onClose={vi.fn()}
        scopedCustomerId="c1"
      />,
    );
    await screen.findByText('Bob');
    fireEvent.click(rowFor('bob@acme.com'));
    expect(onToggle).toHaveBeenCalledWith('bob@acme.com');
  });

  it('re-fetches from the directory endpoint when "Show all customers" is toggled', async () => {
    route();
    render(
      <ContactPicker
        selected={new Set()}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        scopedCustomerId="c1"
        scopedCustomerName="Acme"
      />,
    );
    await screen.findByText('Alice');
    expect(mockApi).toHaveBeenCalledWith('/customers/c1/contacts');
    expect(screen.queryByText('Globex')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Show all customers'));

    await waitFor(() => expect(mockApi).toHaveBeenCalledWith('/contacts'));
    expect(await screen.findByText('Globex')).toBeInTheDocument();
  });

  it('does not show the "Show all" toggle when no scope is provided', async () => {
    route();
    render(<ContactPicker selected={new Set()} onToggle={vi.fn()} onClose={vi.fn()} />);
    await screen.findByText('Carol');
    expect(screen.queryByLabelText('Show all customers')).not.toBeInTheDocument();
    expect(mockApi).toHaveBeenCalledWith('/contacts');
  });

  it('filters rows by the search query (case-insensitive)', async () => {
    route();
    render(
      <ContactPicker
        selected={new Set()}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        scopedCustomerId="c1"
      />,
    );
    await screen.findByText('Alice');
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'BOB' } });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
    expect(screen.getByText('Bob')).toBeInTheDocument();
  });

  it('renders the empty state when no contacts match', async () => {
    route();
    render(
      <ContactPicker
        selected={new Set()}
        onToggle={vi.fn()}
        onClose={vi.fn()}
        scopedCustomerId="c1"
      />,
    );
    await screen.findByText('Alice');
    fireEvent.change(screen.getByLabelText('Search contacts'), { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
  });
});
