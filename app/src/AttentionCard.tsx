import { type ReactElement, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from './lib/utils';
import { relativeTime } from './lib/time';
import { CardActions, ThreadTap, threadPath } from './CardActions';
import { DecisionChips, type DecideHandler } from './DecisionChips';
import type { AttentionCard as AttentionCardData, Severity } from './types';

const accent: Record<Severity, string> = {
  info: 'bg-sky-400',
  action: 'bg-emerald-400',
  warning: 'bg-rose-400',
};

const PREVIEW_CHARS = 160;

export function AttentionCard({
  card,
  decidedOptionId,
  onDecide,
}: {
  card: AttentionCardData;
  decidedOptionId: string | null;
  onDecide: DecideHandler;
}): ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = card.body.length > PREVIEW_CHARS;
  const shown = expanded || !long ? card.body : `${card.body.slice(0, PREVIEW_CHARS).trimEnd()}…`;
  const dot = card.severity ? accent[card.severity] : 'bg-zinc-500';
  const path = threadPath(card);

  // The tappable region stops at the body: the expander, the actions and the chips are all
  // siblings below it, so nothing interactive is ever nested inside the card tap.
  const summary = (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('size-2 shrink-0 rounded-full', dot)} aria-hidden />
          <p className="truncate text-sm font-medium text-ember-300">{card.customerName ?? 'Assistant'}</p>
        </div>
        <span className="shrink-0 text-[0.7rem] text-zinc-500">{relativeTime(card.createdAt)}</span>
      </div>

      {card.title && <h3 className="mt-1.5 font-semibold leading-snug text-zinc-100">{card.title}</h3>}

      <p className="mt-1.5 whitespace-pre-wrap break-words text-[0.9rem] leading-relaxed text-zinc-300">{shown}</p>
    </>
  );

  return (
    <article className="overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
      <div className="p-4">
        {path ? <ThreadTap path={path} className="active:opacity-70">{summary}</ThreadTap> : summary}

        {long && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium text-zinc-400 active:text-zinc-200"
          >
            {expanded ? <><ChevronUp size={14} /> Show less</> : <><ChevronDown size={14} /> Show full draft</>}
          </button>
        )}

        <CardActions card={card} className="mt-3" />

        {card.buttons && card.buttons.length > 0 && (
          <div className="mt-3">
            <DecisionChips messageId={card.id} buttons={card.buttons} decidedOptionId={decidedOptionId} onDecide={onDecide} />
          </div>
        )}
      </div>
    </article>
  );
}
