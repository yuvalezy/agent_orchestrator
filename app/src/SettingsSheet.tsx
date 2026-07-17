import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { BellRing, Check, Download, LogOut, Smartphone, X } from 'lucide-react';
import { cn } from './lib/utils';
import { disablePush, enablePush, pushLocallyEnabled } from './push';
import type { AppConfig } from './types';

export interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function SettingsSheet({
  open,
  onClose,
  config,
  deviceLabel,
  installPrompt,
  onLogout,
}: {
  open: boolean;
  onClose: () => void;
  config: AppConfig | null;
  deviceLabel: string;
  installPrompt: InstallPrompt | null;
  onLogout: () => void;
}): ReactElement {
  return (
    <div className={cn('fixed inset-0 z-40 transition-opacity', open ? 'opacity-100' : 'pointer-events-none opacity-0')}>
      <button aria-label="Close settings" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className={cn(
          // max-h + scroll so the top rows stay reachable on a short viewport (mirrors DetailSheet);
          // without it a bottom-anchored panel pushes its first row off the top edge.
          'safe-bottom absolute inset-x-0 bottom-0 max-h-[85dvh] overflow-y-auto rounded-t-3xl border-t border-zinc-800 bg-zinc-950 px-4 pb-4 pt-3 shadow-2xl transition-transform duration-300 ease-out',
          open ? 'translate-y-0' : 'translate-y-full',
        )}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Settings</h2>
          <button aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
            <X size={20} />
          </button>
        </div>

        <PushToggle config={config} />

        <Row icon={<Smartphone size={18} className="text-zinc-400" />} title="This device" subtitle={deviceLabel || 'Signed-in device'} />

        {installPrompt && (
          <button
            onClick={() => void installPrompt.prompt()}
            className="mt-2 flex w-full items-center gap-3 rounded-2xl bg-zinc-900 px-4 py-3.5 text-left active:bg-zinc-800"
          >
            <Download size={18} className="text-ember-400" />
            <div>
              <p className="text-sm font-medium text-zinc-100">Add to home screen</p>
              <p className="text-xs text-zinc-500">Install AO Founder for full-screen, app-like access.</p>
            </div>
          </button>
        )}

        <button
          onClick={onLogout}
          className="mt-2 flex min-h-12 w-full items-center gap-3 rounded-2xl bg-zinc-900 px-4 py-3.5 text-left text-rose-300 active:bg-zinc-800"
        >
          <LogOut size={18} />
          <span className="text-sm font-medium">Sign out this device</span>
        </button>
      </div>
    </div>
  );
}

function PushToggle({ config }: { config: AppConfig | null }): ReactElement {
  const configured = Boolean(config?.firebase && config?.vapidKey);
  const denied = typeof Notification !== 'undefined' && Notification.permission === 'denied';
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { setEnabled(pushLocallyEnabled()); }, []);

  const toggle = async () => {
    if (!configured || busy || denied) return;
    setBusy(true); setNote(null);
    try {
      if (enabled) {
        await disablePush();
        setEnabled(false);
      } else {
        await enablePush(config!.firebase!, config!.vapidKey!);
        setEnabled(true);
        setNote('Push notifications are on for this device.');
      }
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'Could not update push notifications.');
    } finally {
      setBusy(false);
    }
  };

  const subtitle = !configured
    ? 'Push not configured on server'
    : denied
      ? 'Blocked in browser settings'
      : enabled
        ? 'On — all alerts reach this phone'
        : 'Off — Telegram still delivers everything';

  return (
    <div className="mb-2 rounded-2xl bg-zinc-900 px-4 py-3.5">
      <div className="flex items-center gap-3">
        <BellRing size={18} className={enabled && configured ? 'text-ember-400' : 'text-zinc-400'} />
        <div className="flex-1">
          <p className="text-sm font-medium text-zinc-100">Push notifications</p>
          <p className="text-xs text-zinc-500">{subtitle}</p>
        </div>
        <button
          role="switch"
          aria-checked={enabled}
          aria-label="Push notifications"
          disabled={!configured || busy || denied}
          onClick={() => void toggle()}
          className={cn(
            'relative h-7 w-12 shrink-0 rounded-full transition-colors disabled:opacity-40',
            enabled && configured ? 'bg-ember-500' : 'bg-zinc-700',
          )}
        >
          <span className={cn('absolute top-0.5 grid size-6 place-items-center rounded-full bg-white transition-transform', enabled && configured ? 'translate-x-[1.375rem]' : 'translate-x-0.5')}>
            {enabled && configured && <Check size={13} className="text-ember-600" />}
          </span>
        </button>
      </div>
      {note && <p className="mt-2 text-xs leading-5 text-zinc-400">{note}</p>}
    </div>
  );
}

function Row({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle: string }): ReactElement {
  return (
    <div className="mt-2 flex items-center gap-3 rounded-2xl bg-zinc-900 px-4 py-3.5">
      {icon}
      <div>
        <p className="text-sm font-medium text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
    </div>
  );
}
