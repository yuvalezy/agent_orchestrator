import { type ReactElement, type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { Select } from './lib/select';

// Push subscribers: phones (founder_app_devices) and console browsers (founder_push_subscriptions).
// Rendered as the body of DevicesView (which owns the page header). Each row carries enough state
// to disable or remove it inline; rows stay in the list after the action so history remains
// visible. The shared api() client prefixes /console/api and sends CSRF on mutations; 401s
// broadcast console:unauthorized from there.

interface DeviceRow {
  id: string;
  label: string | null;
  pushEnabled: boolean;
  failureCount: number;
  createdAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
}
interface BrowserRow {
  id: string;
  endpointPrefix: string;
  disabledAt: string | null;
  failureCount: number;
  lastFailureKind: string | null;
  lastSeenAt: string;
  createdAt: string;
}

type DeviceStatus = 'active' | 'push-off' | 'revoked';
type BrowserStatus = 'active' | 'removed';

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (v: string | null): string => (v ? fmt.format(new Date(v)) : '—');
const btn = 'rounded-lg px-3 py-1.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-40';

function deviceStatus(row: DeviceRow): DeviceStatus {
  if (row.revokedAt) return 'revoked';
  return row.pushEnabled ? 'active' : 'push-off';
}
function browserStatus(row: BrowserRow): BrowserStatus {
  return row.disabledAt ? 'removed' : 'active';
}

function DeviceStatusBadge({ status }: { status: DeviceStatus }): ReactElement {
  const tone = status === 'active'
    ? 'bg-emerald-400/15 text-emerald-300'
    : status === 'push-off'
      ? 'bg-zinc-800 text-zinc-400'
      : 'bg-red-400/15 text-red-300';
  const label = status === 'active' ? 'Active' : status === 'push-off' ? 'Push off' : 'Revoked';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}
function BrowserStatusBadge({ status }: { status: BrowserStatus }): ReactElement {
  const tone = status === 'active' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-zinc-800 text-zinc-400';
  const label = status === 'active' ? 'Active' : 'Removed';
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}

function SubSection({ title, filter, children }: { title: string; filter: ReactNode; children: ReactNode }): ReactElement {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-zinc-200">{title}</h3>
        {filter}
      </div>
      {children}
    </div>
  );
}

function RowError({ message }: { message: string }): ReactElement {
  return <p className="mt-3 flex items-center gap-2 text-xs text-red-300"><CircleAlert size={14} />{message}</p>;
}

function DeviceCard({ row, refresh }: { row: DeviceRow; refresh: () => Promise<void> }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const status = deviceStatus(row);
  const disableBlocked = !row.pushEnabled || row.revokedAt !== null;
  const revokeBlocked = row.revokedAt !== null;

  // 404 = row already gone server-side; the contract says treat as success and just refetch.
  const onFail = (err: ApiError, clear: () => void): void => {
    clear();
    if (err.status === 404) { void refresh(); return; }
    setError(err.message);
  };

  const disablePush = useMutation({
    mutationFn: () => api(`/subscribers/devices/${row.id}/disable-push`, { method: 'POST' }),
    onMutate: () => setError(null),
    onSuccess: () => { setConfirmDisable(false); return refresh(); },
    onError: (err: ApiError) => onFail(err, () => setConfirmDisable(false)),
  });
  const revoke = useMutation({
    mutationFn: () => api(`/subscribers/devices/${row.id}/revoke`, { method: 'POST' }),
    onMutate: () => setError(null),
    onSuccess: () => { setConfirmRevoke(false); return refresh(); },
    onError: (err: ApiError) => onFail(err, () => setConfirmRevoke(false)),
  });

  const busy = disablePush.isPending || revoke.isPending;

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-zinc-100">{row.label ?? 'unlabeled'}</p>
            <DeviceStatusBadge status={status} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">Last seen {when(row.lastSeenAt)} · added {when(row.createdAt)}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{row.failureCount} failure{row.failureCount === 1 ? '' : 's'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {busy && <span className="text-xs text-zinc-500" aria-live="polite">…</span>}
          {confirmDisable ? (
            <span className="inline-flex items-center gap-2">
              <button disabled={disablePush.isPending} onClick={() => disablePush.mutate()} className={`${btn} border border-zinc-700 text-zinc-200`}>{disablePush.isPending ? 'Disabling…' : 'Confirm'}</button>
              <button disabled={disablePush.isPending} onClick={() => setConfirmDisable(false)} className={`${btn} bg-zinc-800 text-zinc-300`}>Cancel</button>
            </span>
          ) : (
            <button disabled={busy || disableBlocked} onClick={() => setConfirmDisable(true)} className={`${btn} border border-zinc-700 text-zinc-200`}>Disable push</button>
          )}
          {confirmRevoke ? (
            <span className="inline-flex items-center gap-2">
              <button disabled={revoke.isPending} onClick={() => revoke.mutate()} className={`${btn} border border-red-500/60 text-red-300`}>{revoke.isPending ? 'Revoking…' : 'Confirm'}</button>
              <button disabled={revoke.isPending} onClick={() => setConfirmRevoke(false)} className={`${btn} bg-zinc-800 text-zinc-300`}>Cancel</button>
            </span>
          ) : (
            <button disabled={busy || revokeBlocked} onClick={() => setConfirmRevoke(true)} className={`${btn} border border-red-500/60 text-red-300`}>Revoke device</button>
          )}
        </div>
      </div>
      {error && <RowError message={error} />}
    </div>
  );
}

function BrowserCard({ row, refresh }: { row: BrowserRow; refresh: () => Promise<void> }): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const status = browserStatus(row);
  const removeBlocked = status === 'removed';

  const remove = useMutation({
    mutationFn: () => api(`/subscribers/browsers/${row.id}/remove`, { method: 'POST' }),
    onMutate: () => setError(null),
    onSuccess: () => { setConfirmRemove(false); return refresh(); },
    onError: (err: ApiError) => {
      setConfirmRemove(false);
      if (err.status === 404) { void refresh(); return; }
      setError(err.message);
    },
  });

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <code className="truncate rounded bg-zinc-950 px-1.5 py-0.5 font-mono text-xs text-zinc-300">{row.endpointPrefix}…</code>
            <BrowserStatusBadge status={status} />
          </div>
          <p className="mt-1 text-xs text-zinc-500">Last seen {when(row.lastSeenAt)} · added {when(row.createdAt)}</p>
          <p className="mt-0.5 text-xs text-zinc-500">{row.failureCount} failure{row.failureCount === 1 ? '' : 's'}{row.lastFailureKind ? ` · ${row.lastFailureKind}` : ''}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {remove.isPending && <span className="text-xs text-zinc-500" aria-live="polite">…</span>}
          {confirmRemove ? (
            <span className="inline-flex items-center gap-2">
              <button disabled={remove.isPending} onClick={() => remove.mutate()} className={`${btn} border border-red-500/60 text-red-300`}>{remove.isPending ? 'Removing…' : 'Confirm'}</button>
              <button disabled={remove.isPending} onClick={() => setConfirmRemove(false)} className={`${btn} bg-zinc-800 text-zinc-300`}>Cancel</button>
            </span>
          ) : (
            <button disabled={remove.isPending || removeBlocked} onClick={() => setConfirmRemove(true)} className={`${btn} border border-red-500/60 text-red-300`}>Remove</button>
          )}
        </div>
      </div>
      {error && <RowError message={error} />}
    </div>
  );
}

export function SubscribersPanel(): ReactElement {
  const client = useQueryClient();
  const devices = useQuery({ queryKey: ['subscribers-devices'], queryFn: () => api<{ data: DeviceRow[] }>('/subscribers/devices') });
  const browsers = useQuery({ queryKey: ['subscribers-browsers'], queryFn: () => api<{ data: BrowserRow[] }>('/subscribers/browsers') });
  const [deviceFilter, setDeviceFilter] = useState<string>('active');
  const [browserFilter, setBrowserFilter] = useState<string>('active');

  const refreshDevices = (): Promise<void> => client.invalidateQueries({ queryKey: ['subscribers-devices'] }).then(() => undefined);
  const refreshBrowsers = (): Promise<void> => client.invalidateQueries({ queryKey: ['subscribers-browsers'] }).then(() => undefined);

  const allDevices = devices.data?.data ?? [];
  const deviceRows = allDevices.filter((row) => {
    if (!deviceFilter) return true;
    return deviceStatus(row) === deviceFilter;
  });
  const allBrowsers = browsers.data?.data ?? [];
  const browserRows = allBrowsers.filter((row) => {
    if (!browserFilter) return true;
    return browserStatus(row) === browserFilter;
  });

  return (
    <div className="space-y-8">
      <SubSection
        title="Phones"
        filter={
          <Select
            value={deviceFilter}
            onChange={setDeviceFilter}
            aria-label="Phones status filter"
            minWidthClassName="min-w-40"
            className="py-1.5"
            options={[
              { value: 'active', label: 'Active' },
              { value: '', label: 'All' },
              { value: 'push-off', label: 'Push off' },
              { value: 'revoked', label: 'Revoked' },
            ]}
          />
        }
      >
        {devices.isLoading
          ? <p className="rounded-lg border border-zinc-800 p-4 text-sm text-zinc-500">Loading devices…</p>
          : devices.isError
            ? <RowError message={(devices.error as Error).message} />
            : deviceRows.length === 0
              ? <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">No phones in this view.</p>
              : <div className="space-y-2">{deviceRows.map((row) => <DeviceCard key={row.id} row={row} refresh={refreshDevices} />)}</div>}
      </SubSection>

      <SubSection
        title="Browsers"
        filter={
          <Select
            value={browserFilter}
            onChange={setBrowserFilter}
            aria-label="Browsers status filter"
            minWidthClassName="min-w-40"
            className="py-1.5"
            options={[
              { value: 'active', label: 'Active' },
              { value: '', label: 'All' },
              { value: 'removed', label: 'Removed' },
            ]}
          />
        }
      >
        {browsers.isLoading
          ? <p className="rounded-lg border border-zinc-800 p-4 text-sm text-zinc-500">Loading subscriptions…</p>
          : browsers.isError
            ? <RowError message={(browsers.error as Error).message} />
            : browserRows.length === 0
              ? <p className="rounded-lg border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">No subscriptions in this view.</p>
              : <div className="space-y-2">{browserRows.map((row) => <BrowserCard key={row.id} row={row} refresh={refreshBrowsers} />)}</div>}
      </SubSection>
    </div>
  );
}
