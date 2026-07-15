import { type ReactElement, useEffect, useState } from 'react';
import { Bell, BellOff, CircleAlert } from 'lucide-react';
import { api, type ApiError } from './lib/api';

type PushStatus = { data: { configured: boolean; registrationAvailable: boolean; publicKey: string | null } };
type BrowserState = 'unsupported' | 'denied' | 'default' | 'granted';

const button = 'rounded-lg px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40';

function base64UrlBytes(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const raw = atob(padded);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes.buffer;
}

function browserState(): BrowserState {
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission;
}

export function PushNotificationsPanel(): ReactElement {
  const [state, setState] = useState<BrowserState>(browserState);
  const [registered, setRegistered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [server, setServer] = useState<PushStatus | null>(null);

  useEffect(() => { void api<PushStatus>('/push/status').then(setServer).catch(() => setMessage('Could not check web-push availability.')); }, []);
  useEffect(() => {
    if (state === 'unsupported') return;
    void navigator.serviceWorker.ready.then((registration) => registration.pushManager.getSubscription()).then((subscription) => setRegistered(subscription !== null));
  }, [state]);

  const enable = async (): Promise<void> => {
    if (!server?.data.publicKey || state === 'unsupported') return;
    setBusy(true); setMessage(null);
    try {
      const permission = await Notification.requestPermission();
      setState(permission);
      if (permission !== 'granted') { setMessage('Permission was not granted. Telegram remains active.'); return; }
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(server.data.publicKey) });
      await api('/push/subscription', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
      setRegistered(true); setMessage('This browser can now receive urgent, privacy-safe alerts.');
    } catch (err) { setMessage((err as ApiError).message || 'Could not enable web push.'); }
    finally { setBusy(false); }
  };

  const disable = async (): Promise<void> => {
    setBusy(true); setMessage(null);
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api('/push/subscription', { method: 'DELETE', body: JSON.stringify(subscription.toJSON()) });
        await subscription.unsubscribe();
      }
      setRegistered(false); setMessage('Web-push registration removed from this browser.');
    } catch (err) { setMessage((err as ApiError).message || 'Could not disable web push.'); }
    finally { setBusy(false); }
  };

  const unavailable = !server?.data.configured || !server?.data.registrationAvailable;
  return <section className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-5"><div className="flex items-start justify-between gap-4"><div><p className="text-sm font-semibold text-zinc-100">Urgent web notifications</p><p className="mt-1 max-w-2xl text-xs leading-5 text-zinc-500">Optional alerts for urgent orchestrator failures. Lock screens show only a generic alert and open this private console—never a customer name, message, task, or decision. Telegram remains the default.</p></div>{registered ? <Bell className="shrink-0 text-emerald-300" size={20} /> : <BellOff className="shrink-0 text-zinc-500" size={20} />}</div>{state === 'unsupported' && <p className="mt-4 text-sm text-zinc-500">This browser does not support web push. Telegram remains active.</p>}{state === 'denied' && <p className="mt-4 text-sm text-amber-200">Browser notification permission is denied. Change it in browser settings if you want alerts here.</p>}{state !== 'unsupported' && state !== 'denied' && unavailable && <p className="mt-4 text-sm text-zinc-500">Web push is not configured on this server.</p>}{message && <p className="mt-4 flex items-center gap-2 text-sm text-zinc-300"><CircleAlert size={16} />{message}</p>}{state !== 'unsupported' && state !== 'denied' && !unavailable && <div className="mt-4"><button disabled={busy} onClick={() => void (registered ? disable() : enable())} className={`${button} ${registered ? 'border border-zinc-700 text-zinc-200' : 'bg-emerald-400 text-zinc-950'}`}>{registered ? 'Disable on this browser' : 'Enable urgent alerts'}</button></div>}</section>;
}
