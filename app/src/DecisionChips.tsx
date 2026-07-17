import { type ReactElement } from 'react';
import { Check } from 'lucide-react';
import { cn } from './lib/utils';
import type { Button } from './types';

export type DecideHandler = (messageId: string, optionId: string) => void | Promise<void>;

/** Tappable decision chips shared by message bubbles and attention cards. Once the
 *  row is decided, every chip locks and the chosen one is checkmarked. */
export function DecisionChips({
  messageId,
  buttons,
  decidedOptionId,
  onDecide,
}: {
  messageId: string;
  buttons: Button[];
  decidedOptionId: string | null;
  onDecide: DecideHandler;
}): ReactElement {
  // Swallow a 409/503 rejection here; callers revert their own optimistic state.
  const decide = (optionId: string) => { void Promise.resolve(onDecide(messageId, optionId)).catch(() => {}); };
  const decided = decidedOptionId;
  return (
    <div className="flex flex-wrap gap-2">
      {buttons.map((button) => {
        const chosen = decided === button.id;
        return (
          <button
            key={button.id}
            type="button"
            disabled={decided !== null}
            onClick={() => decide(button.id)}
            aria-pressed={chosen}
            className={cn(
              'inline-flex min-h-11 items-center gap-1.5 rounded-full px-4 text-sm font-medium transition disabled:cursor-default',
              chosen
                ? 'bg-ember-400 text-zinc-950'
                : decided !== null
                  ? 'bg-zinc-700/40 text-zinc-500'
                  : 'bg-zinc-700 text-zinc-100 hover:bg-zinc-600 active:scale-[0.97]',
            )}
          >
            {chosen && <Check size={15} />}
            {button.label}
          </button>
        );
      })}
    </div>
  );
}
