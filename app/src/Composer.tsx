import { type FormEvent, type KeyboardEvent, type ReactElement, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp } from 'lucide-react';
import { cn } from './lib/utils';

const MAX_HEIGHT = 128; // ~4 lines before the textarea starts scrolling.

export function Composer({ onSend, sending }: { onSend: (text: string) => void; sending: boolean }): ReactElement {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (and soft keyboards) keep the newline.
    if (event.key === 'Enter' && !event.shiftKey && !('ontouchstart' in window)) {
      event.preventDefault();
      submit();
    }
  };

  const canSend = text.trim().length > 0;
  return (
    <form
      onSubmit={submit}
      className="safe-bottom safe-x sticky bottom-0 z-10 border-t border-zinc-800/80 bg-zinc-950/85 px-3 pt-2.5 backdrop-blur-xl"
    >
      <div className="flex items-end gap-2 pb-2.5">
        <textarea
          ref={ref}
          value={text}
          rows={1}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message the assistant…"
          aria-label="Message"
          className="feed-scroll max-h-32 min-h-11 flex-1 resize-none rounded-3xl border border-zinc-700 bg-zinc-900 px-4 py-2.5 text-[0.95rem] leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40"
        />
        <button
          type="submit"
          disabled={!canSend || sending}
          aria-label="Send"
          className={cn(
            'grid size-11 shrink-0 place-items-center rounded-full transition',
            canSend && !sending
              ? 'bg-gradient-to-br from-ember-400 to-ember-600 text-zinc-950 active:scale-95'
              : 'bg-zinc-800 text-zinc-600',
          )}
        >
          <ArrowUp size={20} strokeWidth={2.5} />
        </button>
      </div>
    </form>
  );
}
