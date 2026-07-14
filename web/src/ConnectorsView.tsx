import { type ReactElement, type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, ExternalLink, KeyRound, Link2, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api, type ApiError } from './lib/api';

// Connectors surface (Contract B3): Google OAuth connectors (server-side redirect) + plain API-key
// secrets. Secret values never leave the server; the UI only ever shows last4. When the encrypted
// store is off, a secret PUT/DELETE returns 409 and we surface a "set CREDENTIALS_ENCRYPTION_KEY" state.

type Kind = 'google-oauth' | 'secret';
interface Connector {
  id: string; label: string; kind: Kind; credentialName: string;
  scopes?: string[]; connected: boolean; last4: string | null; updatedAt: string | null;
}
interface ConnectorsPayload { data: Connector[] }
interface OauthStart { data: { authUrl: string } }

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (v: string | null): string => (v ? fmt.format(new Date(v)) : '—');

function Loading(): ReactElement { return <div className="mt-8 rounded-xl border border-zinc-800 p-8 text-sm text-zinc-400">Loading connectors…</div>; }
function ErrorState({ message }: { message: string }): ReactElement { return <div className="mt-8 flex items-center gap-3 rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200"><CircleAlert size={18} />{message}</div>; }
function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }): ReactElement {
  return <section><div className="mb-3 flex items-center gap-2 text-sm font-semibold text-zinc-300">{icon}{title}</div><div className="grid gap-4 sm:grid-cols-2">{children}</div></section>;
}

export function ConnectorsView(): ReactElement {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorsPayload>('/connectors') });
  // Set once any secret mutation returns 409 — the encrypted store is off until CREDENTIALS_ENCRYPTION_KEY is set.
  const [storeDisabled, setStoreDisabled] = useState(false);
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ['connectors'] }).then(() => undefined);
  const onSecretError = (err: ApiError): void => { if (err.status === 409) setStoreDisabled(true); };

  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} />;
  const connectors = query.data?.data ?? [];
  const google = connectors.filter((c) => c.kind === 'google-oauth');
  const secrets = connectors.filter((c) => c.kind === 'secret');

  return (
    <section className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Credentials</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Connectors</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Connect Google accounts over OAuth and store provider API keys. Secret values are encrypted at rest and never displayed — only the last four characters are shown.</p>
      </div>

      {google.length > 0 && (
        <Section icon={<Link2 size={16} className="text-emerald-300" />} title="Google accounts">
          {google.map((c) => <GoogleCard key={c.id} connector={c} />)}
        </Section>
      )}

      {secrets.length > 0 && (
        <Section icon={<KeyRound size={16} className="text-emerald-300" />} title="Provider secrets">
          {storeDisabled && (
            <div className="sm:col-span-2 flex items-start gap-3 rounded-xl border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-100">
              <ShieldCheck size={18} className="mt-0.5 shrink-0" />
              <div><p className="font-medium">Secret store disabled</p><p className="mt-1 text-amber-100/80">Set <code className="rounded bg-zinc-950 px-1.5 py-0.5 text-xs">CREDENTIALS_ENCRYPTION_KEY</code> in the environment and restart to store or remove secrets.</p></div>
            </div>
          )}
          {secrets.map((c) => <SecretCard key={c.id} connector={c} onError={onSecretError} refresh={refresh} disabled={storeDisabled} />)}
        </Section>
      )}

      {connectors.length === 0 && <div className="rounded-xl border border-zinc-800 p-8 text-sm text-zinc-500">No connectors are registered.</div>}
    </section>
  );
}

function Card({ children }: { children: ReactNode }): ReactElement { return <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">{children}</div>; }

function ConnectedBadge({ connected, last4 }: { connected: boolean; last4: string | null }): ReactElement {
  return connected
    ? <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-xs font-medium text-emerald-300">connected{last4 ? ` · ••••${last4}` : ''}</span>
    : <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-400">not connected</span>;
}

function GoogleCard({ connector }: { connector: Connector }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const start = useMutation({
    mutationFn: () => api<OauthStart>(`/connectors/${connector.id}/oauth/start`, { method: 'POST' }),
    onMutate: () => setError(null),
    onSuccess: ({ data }) => window.location.assign(data.authUrl),
    onError: (err: ApiError) => setError(err.message),
  });
  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">{connector.label}</p>
          <p className="mt-1 font-mono text-[11px] text-zinc-600">{connector.credentialName}</p>
        </div>
        <ConnectedBadge connected={connector.connected} last4={connector.last4} />
      </div>
      {connector.scopes && connector.scopes.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">{connector.scopes.map((s) => <span key={s} className="rounded bg-zinc-950 px-2 py-0.5 text-[11px] text-zinc-400">{s.replace('https://www.googleapis.com/auth/', '')}</span>)}</div>
      )}
      {connector.connected && <p className="mt-3 text-xs text-zinc-500">Updated {when(connector.updatedAt)}</p>}
      {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
      <button
        disabled={start.isPending}
        onClick={() => start.mutate()}
        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-zinc-950 enabled:hover:bg-emerald-300 disabled:opacity-50"
      >
        <ExternalLink size={14} />{start.isPending ? 'Redirecting…' : connector.connected ? 'Reconnect' : 'Connect'}
      </button>
    </Card>
  );
}

function SecretCard({ connector, onError, refresh, disabled }: { connector: Connector; onError: (err: ApiError) => void; refresh: () => Promise<void>; disabled: boolean }): ReactElement {
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const save = useMutation({
    mutationFn: () => api(`/connectors/${connector.id}`, { method: 'PUT', body: JSON.stringify({ value }) }),
    onMutate: () => setError(null),
    onSuccess: () => { setValue(''); return refresh(); },
    onError: (err: ApiError) => { setError(err.message); onError(err); },
  });
  const remove = useMutation({
    mutationFn: () => api(`/connectors/${connector.id}`, { method: 'DELETE' }),
    onMutate: () => setError(null),
    onSuccess: () => { setConfirmRemove(false); return refresh(); },
    onError: (err: ApiError) => { setError(err.message); setConfirmRemove(false); onError(err); },
  });

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-100">{connector.label}</p>
          <p className="mt-1 font-mono text-[11px] text-zinc-600">{connector.credentialName}</p>
        </div>
        <ConnectedBadge connected={connector.connected} last4={connector.last4} />
      </div>
      {connector.connected && <p className="mt-3 text-xs text-zinc-500">Updated {when(connector.updatedAt)}</p>}
      <div className="mt-4 flex gap-2">
        <input
          type="password"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          placeholder={connector.connected ? 'Replace secret…' : 'Set secret…'}
          className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none ring-emerald-400 focus:ring-2 disabled:opacity-50"
        />
        <button
          disabled={disabled || !value.trim() || save.isPending}
          onClick={() => save.mutate()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-zinc-950 enabled:hover:bg-emerald-300 disabled:opacity-50"
        >
          <Save size={14} />{save.isPending ? 'Saving…' : connector.connected ? 'Replace' : 'Save'}
        </button>
      </div>
      {connector.connected && (
        confirmRemove ? (
          <div className="mt-3 flex items-center gap-2">
            <span className="text-xs text-zinc-400">Remove this secret?</span>
            <button disabled={remove.isPending} onClick={() => remove.mutate()} className="rounded-lg bg-red-400 px-2.5 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-50">{remove.isPending ? 'Removing…' : 'Remove'}</button>
            <button onClick={() => setConfirmRemove(false)} className="rounded-lg bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300">Cancel</button>
          </div>
        ) : (
          <button disabled={disabled} onClick={() => setConfirmRemove(true)} className="mt-3 inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200 disabled:opacity-50"><Trash2 size={13} />Remove secret</button>
        )
      )}
      {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
    </Card>
  );
}
