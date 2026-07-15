import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('keeps non-conflicting classes and drops falsy values', () => {
    expect(cn('rounded-lg', false && 'hidden', undefined, 'text-sm')).toBe('rounded-lg text-sm');
  });

  it('lets a later tailwind class win over an earlier one in the same group', () => {
    expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
  });

  it('resolves conditional objects and arrays through to the merged result', () => {
    expect(cn(['text-zinc-400', 'text-sm'], { 'text-white': true, 'opacity-50': false })).toBe('text-sm text-white');
  });
});
