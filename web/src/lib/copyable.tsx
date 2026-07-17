import { useState, type ReactElement } from 'react';
import { Check, Copy } from 'lucide-react';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(value: unknown): value is string { return typeof value === 'string' && UUID_RE.test(value); }

function useCopyFeedback(): readonly [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const copy = (text: string): void => { navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };
  return [copied, copy] as const;
}

/**
 * Generic detail-row value: a UUID gets a click-to-copy affordance (cursor-copy pointer, Copy/Check
 * icon); every other value renders as read-only pre text. Shared by App.tsx and MemoryView.tsx so
 * both detail panels treat UUID fields the same way regardless of which endpoint they came from.
 */
export function DetailValue({ value }: { value: unknown }): ReactElement {
  const [copied, copy] = useCopyFeedback();
  if (!isUuid(value)) {
    const text = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—');
    return <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 text-xs text-zinc-300">{text}</pre>;
  }
  return <button type="button" onClick={() => copy(value)} title="Copy UUID" className="group mt-1 flex max-h-56 w-full cursor-copy items-center justify-between gap-3 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 text-left text-xs text-zinc-300 transition-colors hover:bg-zinc-900"><code className="font-mono">{value as string}</code>{copied ? <Check size={14} className="shrink-0 text-emerald-300" /> : <Copy size={14} className="shrink-0 text-zinc-500 group-hover:text-emerald-300" />}</button>;
}

/**
 * Inline UUID chip for compact text (reference lists, badges). Renders as a `span`, not a `button`,
 * so it stays valid HTML when nested inside a row's own clickable button — callers that need that
 * must stop the click/keydown from bubbling to the row (see DecisionReferences in App.tsx).
 */
export function CopyableUuid({ value, onClick, className }: { value: string; onClick?: (event: { stopPropagation: () => void }) => void; className?: string }): ReactElement {
  const [copied, copy] = useCopyFeedback();
  const trigger = (event: { stopPropagation: () => void }): void => { onClick?.(event); copy(value); };
  return <span role="button" tabIndex={0} title="Copy UUID" onClick={trigger} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); trigger(event); } }} className={`group inline-flex cursor-copy items-center gap-1 font-mono hover:text-emerald-300 ${className ?? ''}`}>{value}{copied ? <Check size={11} className="shrink-0 text-emerald-300" /> : <Copy size={11} className="shrink-0 text-zinc-500 group-hover:text-emerald-300" />}</span>;
}
