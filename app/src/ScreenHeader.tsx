import { type ReactElement, type ReactNode } from 'react';
import { ChevronLeft, Settings } from 'lucide-react';
import { useOpenSettings } from './Ui';

/** The sticky top bar every cockpit screen shares: optional back button, title +
 *  subtitle, and either a custom trailing slot or (on top-level screens) a settings gear. */
export function ScreenHeader({
  title,
  subtitle,
  onBack,
  settings = false,
  trailing,
}: {
  title: string;
  subtitle?: string;
  onBack?: () => void;
  settings?: boolean;
  trailing?: ReactNode;
}): ReactElement {
  const openSettings = useOpenSettings();
  return (
    <header className="safe-top safe-x z-10 flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/85 px-3 py-3 backdrop-blur-xl">
      {onBack && (
        <button aria-label="Back" onClick={onBack} className="grid size-9 shrink-0 place-items-center rounded-full text-zinc-300 active:bg-zinc-800">
          <ChevronLeft size={22} />
        </button>
      )}
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-lg font-semibold leading-tight">{title}</h1>
        {subtitle && <p className="truncate text-[0.72rem] text-zinc-500">{subtitle}</p>}
      </div>
      {trailing}
      {settings && !trailing && (
        <button aria-label="Settings" onClick={openSettings} className="grid size-10 shrink-0 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
          <Settings size={20} />
        </button>
      )}
    </header>
  );
}
