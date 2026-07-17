import { type FormEvent, type KeyboardEvent, type ReactElement, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Loader2, Mic, Square } from 'lucide-react';
import { cn } from './lib/utils';
import { canRecordAudio, useAudioRecorder } from './useAudioRecorder';

const MAX_HEIGHT = 128; // ~4 lines before the textarea starts scrolling.

export function Composer({ onSend, sending }: { onSend: (text: string) => void; sending: boolean }): ReactElement {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const recorder = useAudioRecorder();
  // Older browsers lack MediaRecorder/getUserMedia — hide the button rather than show a dead control.
  const micAvailable = canRecordAudio();

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, MAX_HEIGHT)}px`;
  }, [text]);

  // Append (never overwrite) so a half-typed message survives a voice note; the founder edits, then sends.
  const appendTranscript = (transcript: string | null): void => {
    if (!transcript) return;
    setText((current) => {
      const spacer = current && !/\s$/.test(current) ? ' ' : '';
      return current + spacer + transcript;
    });
    ref.current?.focus();
  };

  const toggleMic = (): void => {
    if (recorder.state === 'idle') recorder.start();
    else if (recorder.state === 'recording') void recorder.stopAndTranscribe().then(appendTranscript);
  };

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
      {recorder.error && <p className="px-1 pb-1.5 text-xs text-amber-300">{recorder.error}</p>}
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
        {micAvailable && (
          <button
            type="button"
            onClick={toggleMic}
            disabled={recorder.state === 'transcribing' || sending}
            aria-label={
              recorder.state === 'recording'
                ? 'Stop recording'
                : recorder.state === 'transcribing'
                  ? 'Transcribing'
                  : 'Record voice message'
            }
            className={cn(
              'grid size-11 shrink-0 place-items-center rounded-full transition',
              recorder.state === 'recording'
                ? 'animate-pulse bg-red-500/90 text-zinc-950'
                : 'bg-zinc-800 text-zinc-300 active:scale-95 disabled:text-zinc-600',
            )}
          >
            {recorder.state === 'recording' ? (
              <Square size={18} strokeWidth={2.5} />
            ) : recorder.state === 'transcribing' ? (
              <Loader2 size={20} className="animate-spin" />
            ) : (
              <Mic size={20} strokeWidth={2.5} />
            )}
          </button>
        )}
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
