import { type ReactElement } from 'react';
import { NavLink } from 'react-router-dom';
import { Activity, Inbox, Sparkles, Users, type LucideIcon } from 'lucide-react';
import { cn } from './lib/utils';
import { useAppData } from './AppData';

const tabs: ReadonlyArray<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/attention', label: 'Attention', icon: Inbox },
  { to: '/customers', label: 'Customers', icon: Users },
  { to: '/activity', label: 'Activity', icon: Activity },
  { to: '/assistant', label: 'Assistant', icon: Sparkles },
];

export function TabBar(): ReactElement {
  const { attention } = useAppData();
  const pending = attention?.decisions.length ?? 0;

  return (
    <nav className="safe-bottom safe-x z-20 flex shrink-0 border-t border-zinc-800/80 bg-zinc-950/90 backdrop-blur-xl">
      {tabs.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) => cn(
            'relative flex flex-1 flex-col items-center gap-0.5 py-2 pt-2.5 text-[0.65rem] font-medium transition',
            isActive ? 'text-ember-300' : 'text-zinc-500 active:text-zinc-300',
          )}
        >
          <span className="relative">
            <Icon size={22} strokeWidth={2} />
            {to === '/attention' && pending > 0 && (
              <span className="absolute -right-2 -top-1.5 grid min-w-4 place-items-center rounded-full bg-ember-400 px-1 text-[0.6rem] font-bold text-zinc-950">
                {pending > 9 ? '9+' : pending}
              </span>
            )}
          </span>
          {label}
        </NavLink>
      ))}
    </nav>
  );
}
