import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { InviteesSection } from './InviteesSection';

// Isolate from the picker's own network layer — we only care about the section's wiring here.
vi.mock('./ContactPicker', () => ({
  ContactPicker: (props: { onClose: () => void; onToggle: (email: string) => void }) => (
    <div data-testid="contact-picker">
      <button onClick={() => props.onToggle('new@acme.com')}>Toggle new</button>
      <button onClick={() => props.onClose()}>Done</button>
    </div>
  ),
}));

describe('InviteesSection', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders one chip with a remove button per email', () => {
    const onChange = vi.fn();
    render(<InviteesSection emails={['a@x.com', 'b@x.com']} onChange={onChange} />);
    expect(screen.getByText('a@x.com')).toBeInTheDocument();
    expect(screen.getByText('b@x.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove a@x.com')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove b@x.com')).toBeInTheDocument();
  });

  it('shows the muted placeholder when there are no invitees', () => {
    render(<InviteesSection emails={[]} onChange={vi.fn()} />);
    expect(screen.getByText('No invitees — tap Add below.')).toBeInTheDocument();
  });

  it('fires onChange with the filtered list when a chip X is tapped', () => {
    const onChange = vi.fn();
    render(<InviteesSection emails={['a@x.com', 'b@x.com']} onChange={onChange} />);
    fireEvent.click(screen.getByLabelText('Remove a@x.com'));
    expect(onChange).toHaveBeenCalledWith(['b@x.com']);
  });

  it('opens the picker when "Add from contacts" is tapped', () => {
    render(<InviteesSection emails={[]} onChange={vi.fn()} />);
    expect(screen.queryByTestId('contact-picker')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Add from contacts/ }));
    expect(screen.getByTestId('contact-picker')).toBeInTheDocument();
  });

  it('threads picker toggles through onChange (add + dedupe)', () => {
    const onChange = vi.fn();
    render(<InviteesSection emails={['a@x.com']} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Add from contacts/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Toggle new' }));
    expect(onChange).toHaveBeenCalledWith(['a@x.com', 'new@acme.com']);
  });

  it('marks the organizer chip as a non-removable host with no X', () => {
    render(
      <InviteesSection
        emails={['host@x.com', 'guest@x.com']}
        onChange={vi.fn()}
        organizerEmail="host@x.com"
      />,
    );
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove host@x.com')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Remove guest@x.com')).toBeInTheDocument();
  });

  it('matches the organizer case-insensitively', () => {
    render(
      <InviteesSection
        emails={['Host@X.com']}
        onChange={vi.fn()}
        organizerEmail="host@x.com"
      />,
    );
    expect(screen.getByText('Host')).toBeInTheDocument();
    expect(screen.queryByLabelText('Remove Host@X.com')).not.toBeInTheDocument();
  });
});
