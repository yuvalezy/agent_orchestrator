import { type HTMLAttributes, type ReactElement, forwardRef } from 'react';
import { cn } from './lib/utils';

/**
 * Layout primitives that make the app's fixed-viewport scroll chain correct BY CONSTRUCTION.
 *
 * The shell is `h-[100dvh]` (App.tsx) and `<main>` is a definite-height `overflow-hidden` block, so
 * document/body scroll is impossible — EVERY screen must own a bounded inner scroller. The height
 * chain from that 100dvh source down to a scroll region only holds if every ancestor is a flex-col
 * that carries `min-h-0`; a single plain-block link collapses the scroller to content height and the
 * bottom of the list becomes unreachable (the bug that silently hid the customer Ask chat's tail).
 *
 * These three are the sanctioned way to build a screen, so that chain can't be broken by accident:
 *   Screen     — a top-level screen host (`h-full min-h-0 flex-col`). ScreenHeader first, then a
 *                ScrollArea (or a Pane). Hangs off `<main>`'s definite height.
 *   Pane       — a nested column that fills the remaining space (`flex-1 min-h-0 flex-col`), for a
 *                region that itself hosts a header/scroller/footer (a chat) or a tab body that must
 *                hand a bounded height to whichever tab is active. MUST live inside a flex-col.
 *   ScrollArea — THE bounded vertical scroller (`flex-1 min-h-0 overflow-y-auto`). Scrolls only
 *                inside a Screen/Pane. Forwards ref + all div props so thread components
 *                (useThreadScroll) can drive it via ref/onScroll.
 */

/** A top-level screen: fills the shell's `<main>` and stacks its children in a column. */
export function Screen({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)} {...rest}>
      {children}
    </div>
  );
}

/** A nested column that fills the remaining height of a Screen/Pane. Uses `flex-1`, so — unlike
 *  Screen — it MUST sit inside a flex-col parent (another Screen/Pane). */
export function Pane({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>): ReactElement {
  return (
    <div className={cn('flex min-h-0 flex-1 flex-col', className)} {...rest}>
      {children}
    </div>
  );
}

/** The bounded vertical scroll region. Scrolls only inside a Screen/Pane (both flex-col + min-h-0).
 *  Forwards a ref (for scroll hooks) and passes through onScroll/role/aria-* via rest props. */
export const ScrollArea = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ScrollArea({ className, children, ...rest }, ref): ReactElement {
    return (
      <div ref={ref} className={cn('min-h-0 flex-1 overflow-y-auto', className)} {...rest}>
        {children}
      </div>
    );
  },
);
