import { type FormEvent, type ReactElement, useState } from 'react';
import { Loader2, MessagesSquare } from 'lucide-react';
import { api, type ApiError } from './lib/api';

const LABEL_KEY = 'ao_device_label';

export function Login({ onSuccess }: { onSuccess: (label: string) => void }): ReactElement {
  const [password, setPassword] = useState('');
  const [label, setLabel] = useState(() => localStorage.getItem(LABEL_KEY) ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!password) return;
    setBusy(true); setError(null);
    const deviceLabel = label.trim() || 'My phone';
    try {
      await api('/login', { method: 'POST', body: JSON.stringify({ password, label: deviceLabel }) });
      localStorage.setItem(LABEL_KEY, deviceLabel);
      onSuccess(deviceLabel);
    } catch (err) {
      const status = (err as ApiError).status;
      setError(
        status === 401 ? 'That password did not match. Try again.'
          : status === 429 ? 'Too many attempts. Wait a moment and try again.'
            : (err as ApiError).message || 'Could not sign in.',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="safe-top safe-bottom safe-x grid min-h-[100dvh] place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="grid size-16 place-items-center rounded-3xl bg-gradient-to-br from-ember-400 to-ember-600 text-zinc-950 shadow-xl shadow-ember-500/25">
            <MessagesSquare size={30} strokeWidth={2.2} />
          </div>
          <h1 className="mt-5 text-2xl font-semibold tracking-tight">AO Founder</h1>
          <p className="mt-1.5 text-sm text-zinc-500">Your assistant, one conversation.</p>
        </div>

        <label className="block text-sm font-medium text-zinc-300">
          Password
          <input
            autoFocus
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="mt-1.5 min-h-12 w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-zinc-100 outline-none focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40"
          />
        </label>

        <label className="mt-4 block text-sm font-medium text-zinc-300">
          Device name
          <input
            type="text"
            value={label}
            placeholder="Yuval's Pixel"
            onChange={(e) => setLabel(e.target.value)}
            className="mt-1.5 min-h-12 w-full rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-ember-500/70 focus:ring-1 focus:ring-ember-500/40"
          />
        </label>

        {error && <p className="mt-3 text-sm text-rose-300">{error}</p>}

        <button
          type="submit"
          disabled={busy || !password}
          className="mt-6 flex min-h-12 w-full items-center justify-center gap-2 rounded-2xl bg-gradient-to-br from-ember-400 to-ember-600 px-4 font-semibold text-zinc-950 transition active:scale-[0.99] disabled:opacity-50"
        >
          {busy ? <><Loader2 size={18} className="animate-spin" /> Signing in…</> : 'Sign in'}
        </button>
        <p className="mt-5 text-center text-xs text-zinc-600">This phone stays signed in until you sign out.</p>
      </form>
    </main>
  );
}
