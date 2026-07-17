import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { Composer } from './Composer';

describe('Composer', () => {
  it('disables send while empty and enables once there is text', () => {
    render(<Composer onSend={vi.fn()} sending={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'hi' } });
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('submits the trimmed text and clears the field', () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} sending={false} />);
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '  ship it  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('ship it');
    expect(input.value).toBe('');
  });
});
