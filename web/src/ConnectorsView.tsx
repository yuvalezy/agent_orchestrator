import { type ReactElement, type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, CircleAlert, ExternalLink, KeyRound, Mail, Pencil, Plus, Save, ShieldCheck, Trash2 } from 'lucide-react';
import { api, type ApiError } from './lib/api';

// Connectors surface (Contract B3): DYNAMIC, console-managed Google accounts (a Gmail list + a
// Calendar list — add / relabel / enable-disable / remove, each backed by its own OAuth grant)
// plus plain provider-key SECRETS. Secret values never leave the server; the UI only shows last4.
// Gmail activation is boot-built → a "restart required" note flags Gmail add/enable; Calendar is
// live. When the encrypted store is off, a secret PUT/DELETE returns 409 → we surface a
// "set CREDENTIALS_ENCRYPTION_KEY" state.

type Service = 'gmail' | 'calendar';
interface Secret { id: string; label: string; credentialName: string; connected: boolean; last4: string | null; updatedAt: string | null; }
interface Account { id: string; label: string; accountEmail: string | null; credentialName: string; connected: boolean; last4: string | null; updatedAt: string | null; enabled: boolean; }
interface ConnectorsPayload { data: { secrets: Secret[]; gmailAccounts: Account[]; calendarAccounts: Account[] } }
interface OauthStart { data: { authUrl: string } }

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (v: string | null): string => (v ? fmt.format(new Date(v)) : '—');

function Loading(): ReactElement { return <div className="mt-8 rounded-xl border border-zinc-800 p-8 text-sm text-zinc-400">Loading connectors…</div>; }
function ErrorState({ message }: { message: string }): ReactElement { return <div className="mt-8 flex items-center gap-3 rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200"><CircleAlert size={18} />{message}</div>; }
function Card({ children }: { children: ReactNode }): ReactElement { return <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">{children}</div>; }

function Section({ icon, title, action, children }: { icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }): ReactElement {
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-zinc-300">{icon}{title}</div>
        {action}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

function ConnectedBadge({ connected, last4 }: { connected: boolean; last4: string | null }): ReactElement {
  return connected
    ? <span className="rounded-full bg-emerald-400/15 px-2 py-1 text-xs font-medium text-emerald-300">connected{last4 ? ` · ••••${last4}` : ''}</span>
    : <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs font-medium text-zinc-400">not connected</span>;
}

export function ConnectorsView(): ReactElement {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorsPayload>('/connectors') });
  const [storeDisabled, setStoreDisabled] = useState(false);
  const refresh = (): Promise<void> => client.invalidateQueries({ queryKey: ['connectors'] }).then(() => undefined);
  const onSecretError = (err: ApiError): void => { if (err.status === 409) setStoreDisabled(true); };

  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} />;
  const secrets = query.data?.data.secrets ?? [];
  const gmailAccounts = query.data?.data.gmailAccounts ?? [];
  const calendarAccounts = query.data?.data.calendarAccounts ?? [];

  return (
    <section className="space-y-8">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Credentials</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Connectors</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Manage labeled Google accounts over OAuth and store provider API keys. Secret values are encrypted at rest and never displayed — only the last four characters are shown.</p>
      </div>

      <Section
        icon={<Mail size={16} className="text-emerald-300" />}
        title="Gmail accounts"
        action={<AddAccountButton service="gmail" refresh={refresh} />}
      >
        {gmailAccounts.map((a) => <AccountCard key={a.id} account={a} service="gmail" refresh={refresh} />)}
        {gmailAccounts.length === 0 && <EmptyAccounts label="No Gmail accounts yet." />}
      </Section>

      <Section
        icon={<CalendarDays size={16} className="text-emerald-300" />}
        title="Calendar accounts"
        action={<AddAccountButton service="calendar" refresh={refresh} />}
      >
        {calendarAccounts.map((a) => <AccountCard key={a.id} account={a} service="calendar" refresh={refresh} />)}
        {calendarAccounts.length === 0 && <EmptyAccounts label="No calendar accounts yet." />}
      </Section>

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
    </section>
  );
}

function EmptyAccounts({ label }: { label: string }): ReactElement {
  return <div className="sm:col-span-2 rounded-xl border border-dashed border-zinc-800 p-6 text-sm text-zinc-500">{label}</div>;
}

function AddAccountButton({ service, refresh }: { service: Service; refresh: () => Promise<void> }): ReactElement {
  const add = useMutation({
    mutationFn: (label: string) => api<{ data: { authUrl: string } }>('/connectors/accounts', { method: 'POST', body: JSON.stringify({ service, label }) }),
    onSuccess: ({ data }) => window.location.assign(data.authUrl),
    onError: (err: ApiError) => window.alert(err.message),
  });
  const onClick = (): void => {
    const label = window.prompt(`Label for the new ${service === 'gmail' ? 'Gmail' : 'calendar'} account`);
    if (label && label.trim()) add.mutate(label.trim());
  };
  return (
    <button
      disabled={add.isPending}
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-200 enabled:hover:border-emerald-400 enabled:hover:text-emerald-300 disabled:opacity-50"
    >
      <Plus size={13} />Add account
    </button>
  );
}

function AccountCard({ account, service, refresh }: { account: Account; service: Service; refresh: () => Promise<void> }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(account.label);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fail = (err: ApiError): void => setError(err.message);

  const start = useMutation({
    mutationFn: () => api<OauthStart>(`/connectors/accounts/${account.id}/oauth/start`, { method: 'POST' }),
    onMutate: () => setError(null),
    onSuccess: ({ data }) => window.location.assign(data.authUrl),
    onError: fail,
  });
  const relabel = useMutation({
    mutationFn: (next: string) => api(`/connectors/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ label: next }) }),
    onMutate: () => setError(null),
    onSuccess: () => { setEditing(false); return refresh(); },
    onError: fail,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api(`/connectors/accounts/${account.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onMutate: () => setError(null),
    onSuccess: () => refresh(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api(`/connectors/accounts/${account.id}`, { method: 'DELETE' }),
    onMutate: () => setError(null),
    onSuccess: () => { setConfirmRemove(false); return refresh(); },
    onError: (err: ApiError) => { setConfirmRemove(false); fail(err); },
  });

  const busy = start.isPending || relabel.isPending || toggle.isPending || remove.isPending;

  return (
    <Card>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <input
                autoFocus
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && label.trim()) relabel.mutate(label.trim()); if (e.key === 'Escape') { setEditing(false); setLabel(account.label); } }}
                className="min-w-0 flex-1 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-sm outline-none ring-emerald-400 focus:ring-2"
              />
              <button disabled={!label.trim() || relabel.isPending} onClick={() => relabel.mutate(label.trim())} className="rounded-md bg-emerald-400 px-2 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-50">Save</button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <p className="truncate text-sm font-medium text-zinc-100">{account.label}</p>
              <button onClick={() => { setLabel(account.label); setEditing(true); }} className="text-zinc-500 hover:text-zinc-300" title="Rename"><Pencil size={12} /></button>
            </div>
          )}
          <p className="mt-1 truncate text-xs text-zinc-400">{account.accountEmail ?? 'no account email yet'}</p>
          <p className="mt-0.5 font-mono text-[11px] text-zinc-600">{account.credentialName}</p>
        </div>
        <ConnectedBadge connected={account.connected} last4={account.last4} />
      </div>

      {account.connected && <p className="mt-3 text-xs text-zinc-500">Updated {when(account.updatedAt)}</p>}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          disabled={busy}
          onClick={() => start.mutate()}
          className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-3 py-2 text-sm font-semibold text-zinc-950 enabled:hover:bg-emerald-300 disabled:opacity-50"
        >
          <ExternalLink size={14} />{start.isPending ? 'Redirecting…' : account.connected ? 'Reconnect' : 'Connect'}
        </button>
        <button
          disabled={busy}
          onClick={() => toggle.mutate(!account.enabled)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-2 text-sm text-zinc-200 enabled:hover:border-zinc-500 disabled:opacity-50"
        >
          {account.enabled ? 'Disable' : 'Enable'}
        </button>
        {confirmRemove ? (
          <span className="inline-flex items-center gap-2">
            <button disabled={remove.isPending} onClick={() => remove.mutate()} className="rounded-lg bg-red-400 px-2.5 py-2 text-xs font-semibold text-zinc-950 disabled:opacity-50">{remove.isPending ? 'Removing…' : 'Confirm remove'}</button>
            <button onClick={() => setConfirmRemove(false)} className="rounded-lg bg-zinc-800 px-2.5 py-2 text-xs text-zinc-300">Cancel</button>
          </span>
        ) : (
          <button disabled={busy} onClick={() => setConfirmRemove(true)} className="ml-auto inline-flex items-center gap-1.5 text-xs text-red-300 hover:text-red-200 disabled:opacity-50"><Trash2 size={13} />Remove</button>
        )}
      </div>

      {service === 'gmail' && (
        <p className="mt-3 text-[11px] text-amber-300/80">Gmail changes (add / enable / disable) take effect after a restart.</p>
      )}
      {error && <p className="mt-3 text-xs text-red-300">{error}</p>}
    </Card>
  );
}

function SecretCard({ connector, onError, refresh, disabled }: { connector: Secret; onError: (err: ApiError) => void; refresh: () => Promise<void>; disabled: boolean }): ReactElement {
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
