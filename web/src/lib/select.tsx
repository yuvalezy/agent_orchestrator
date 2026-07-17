import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { cn } from './utils';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Show a search box that filters options; auto-focused when the menu opens. */
  searchable?: boolean;
  /** Sort options ascending by label. Options with an empty value stay pinned on top. */
  sort?: boolean;
  disabled?: boolean;
  required?: boolean;
  className?: string;
  /** Minimum width of the trigger. */
  minWidthClassName?: string;
  id?: string;
  'aria-label'?: string;
}

/**
 * A styled, searchable dropdown that replaces the native <select>.
 * Self-contained (no Radix/cmdk): click-outside + Escape to close,
 * arrow/enter keyboard navigation, and an auto-focused search box.
 */
export function Select({
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchable = false,
  sort = false,
  disabled = false,
  required = false,
  className,
  minWidthClassName,
  id,
  'aria-label': ariaLabel,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const sorted = useMemo(() => {
    if (!sort) return options;
    const pinned = options.filter((o) => o.value === '');
    const rest = options
      .filter((o) => o.value !== '')
      .slice()
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
    return [...pinned, ...rest];
  }, [options, sort]);

  const filtered = useMemo(() => {
    if (!searchable || !query.trim()) return sorted;
    const q = query.trim().toLowerCase();
    return sorted.filter((o) => o.label.toLowerCase().includes(q));
  }, [sorted, searchable, query]);

  const selected = options.find((o) => o.value === value);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Focus the search box (or keep the active option in view) when opening.
  useLayoutEffect(() => {
    if (!open) return;
    setQuery('');
    const index = Math.max(0, filtered.findIndex((o) => o.value === value));
    setActive(index);
    if (searchable) inputRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const commit = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!open) {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => Math.min(filtered.length - 1, i + 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = filtered[active];
      if (option) commit(option);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', minWidthClassName)}>
      <button
        type="button"
        id={id}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-required={required}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-left text-sm outline-none ring-emerald-400 focus:ring-2 disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <span className={cn('truncate', !selected && 'text-zinc-500')}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={16} className="shrink-0 opacity-50" />
      </button>

      {open && (
        <div
          className="absolute z-50 mt-1 max-h-72 w-full min-w-max overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl shadow-black/40"
          onKeyDown={onKeyDown}
        >
          {searchable && (
            <div className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2">
              <Search size={14} className="shrink-0 text-zinc-500" />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                placeholder="Search…"
                className="w-full bg-transparent text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
              />
            </div>
          )}
          <div ref={listRef} role="listbox" className="max-h-60 overflow-y-auto p-1">
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-zinc-500">No options found</p>
            )}
            {filtered.map((option, index) => {
              const isSelected = option.value === value;
              return (
                <button
                  key={option.value || `__empty__${index}`}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  disabled={option.disabled}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => commit(option)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm',
                    option.disabled && 'cursor-not-allowed opacity-40',
                    !option.disabled && index === active && 'bg-emerald-400 text-zinc-950',
                    !option.disabled && index !== active && 'text-zinc-200',
                  )}
                >
                  <Check size={14} className={cn('shrink-0', isSelected ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{option.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
