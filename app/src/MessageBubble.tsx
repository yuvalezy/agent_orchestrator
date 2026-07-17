import { type ReactElement } from 'react';
import { AlertTriangle, Info, Zap } from 'lucide-react';
import { cn } from './lib/utils';
import { messageTime } from './lib/time';
import { CardActions, ThreadTap, threadPath } from './CardActions';
import { DecisionChips, type DecideHandler } from './DecisionChips';
import { DraftControls, isDraftCard } from './DraftControls';
import type { Message, Severity } from './types';

export type { DecideHandler };

const severityMeta: Record<Severity, { marker: string; label: string; icon: typeof Info; text: string }> = {
  info: { marker: 'bg-sky-400', label: 'Heads up', icon: Info, text: 'text-sky-300' },
  action: { marker: 'bg-emerald-400', label: 'Action', icon: Zap, text: 'text-emerald-300' },
  warning: { marker: 'bg-rose-400', label: 'Attention', icon: AlertTriangle, text: 'text-rose-300' },
};

export function MessageBubble({
  message,
  onDecide,
}: {
  message: Message;
  onDecide: DecideHandler;
}): ReactElement {
  const mine = message.direction === 'in';
  return mine ? <FounderBubble message={message} /> : <AssistantBubble message={message} onDecide={onDecide} />;
}

function FounderBubble({ message }: { message: Message }): ReactElement {
  return (
    <div className="bubble-in flex justify-end px-3">
      <div className="flex max-w-[82%] flex-col items-end">
        <div
          className={cn(
            'rounded-3xl rounded-br-lg bg-gradient-to-br from-ember-400 to-ember-600 px-4 py-2.5',
            'text-[0.95rem] leading-relaxed text-zinc-950 shadow-lg shadow-ember-500/20',
            message.pending && 'opacity-60',
          )}
        >
          <p className="whitespace-pre-wrap break-words font-medium">{message.body}</p>
        </div>
        <span className="mt-1 pr-1 text-[0.68rem] text-zinc-500">
          {message.pending ? 'Sending…' : messageTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  onDecide,
}: {
  message: Message;
  onDecide: DecideHandler;
}): ReactElement {
  const severity = message.severity ? severityMeta[message.severity] : null;
  const SeverityIcon = severity?.icon;
  // Buttons ride on notifications too (draft Approve/Edit/Reject/Revise, task Cancel),
  // not just kind:'question' — render chips whenever the row carries any.
  const hasButtons = Boolean(message.buttons && message.buttons.length > 0);
  const path = threadPath(message);

  // Title + body are the tap target; chips and actions sit below it as siblings.
  const content = (
    <>
      {(message.title || severity) && (
        <div className="mb-1 flex items-center gap-1.5">
          {SeverityIcon && severity && <SeverityIcon size={13} className={severity.text} />}
          {message.title && <p className="text-sm font-semibold text-zinc-100">{message.title}</p>}
          {!message.title && severity && (
            <p className={cn('text-[0.7rem] font-semibold uppercase tracking-wide', severity.text)}>{severity.label}</p>
          )}
        </div>
      )}
      <p className="whitespace-pre-wrap break-words text-[0.95rem] leading-relaxed text-zinc-200">{message.body}</p>
    </>
  );

  return (
    <div className="bubble-in flex justify-start px-3">
      <div className="flex max-w-[86%] flex-col items-start">
        <div className="relative overflow-hidden rounded-3xl rounded-bl-lg bg-zinc-800/90 shadow-lg shadow-black/20">
          {severity && <span className={cn('absolute inset-y-0 left-0 w-1', severity.marker)} aria-hidden />}
          <div className={cn('px-4 py-2.5', severity && 'pl-5')}>
            {path ? <ThreadTap path={path} className="active:opacity-70">{content}</ThreadTap> : content}
            <CardActions card={message} className="mt-2.5" />
            {hasButtons && (
              <div className="mt-3">
                {/* A draft notification appears in the feed too — swap in the Edit/Revise controls
                    so those never dead-end on this surface either. */}
                {isDraftCard(message.buttons) ? (
                  <DraftControls card={message} decidedOptionId={message.decidedOptionId} onDecide={onDecide} />
                ) : (
                  <DecisionChips messageId={message.id} buttons={message.buttons!} decidedOptionId={message.decidedOptionId} onDecide={onDecide} />
                )}
              </div>
            )}
          </div>
        </div>
        <span className="mt-1 pl-1 text-[0.68rem] text-zinc-500">{messageTime(message.createdAt)}</span>
      </div>
    </div>
  );
}
