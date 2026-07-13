import { type FormEvent, type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, CheckCircle2, CircleAlert, ClipboardList, LogOut, Menu, RefreshCw, Send, ShieldCheck, Users } from 'lucide-react';
import { api, type ApiError, setCsrfToken } from './lib/api';
import { cn } from './lib/utils';

type Overview = {
  data: {
    status: 'ok' | 'degraded'; db: 'ok' | 'down'; uptime: number;
    backlog: { inbox: Bucket; outboundQueue: Bucket }; workers: Worker[];
  };
};
type Bucket = { pending: number; failed: number; oldestPendingAgeSeconds: number | null };
type Worker = { name: string; intervalMs: number; lastRunAt: string | null; lastSuccessAt: string | null; lastError: string | null; consecutiveFailures: number };
type Row = Record<string, unknown>;
type Page = { data: Row[]; nextCursor: string | null };

const nav = [
  ['overview', 'Overview', Activity],
  ['workers', 'Worker health', Activity],
  ['inbox', 'Inbox', ClipboardList],
  ['outbound', 'Outbound', Send],
  ['customers', 'Customers', Users],
  ['decisions', 'Decisions', ShieldCheck],
] as const;
type View = typeof nav[number][0];

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
function displayDate(value: unknown): string { return typeof value === 'string' ? fmt.format(new Date(value)) : '—'; }
function display(value: unknown): string { return typeof value === 'string' && value ? value : '—'; }

export function App(): ReactElement {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const queryClient = useQueryClient();
  const session = useQuery({ queryKey: ['session'], queryFn: () => api<{ data: { csrfToken: string } }>('/session'), retry: false });
  useEffect(() => {
    if (authenticated !== null) return;
    if (session.isSuccess) { setCsrfToken(session.data.data.csrfToken); setAuthenticated(true); }
    if (session.isError) setAuthenticated(false);
  }, [authenticated, session.isError, session.isSuccess, session.data]);
  useEffect(() => {
    const clear = () => { setCsrfToken(null); queryClient.clear(); setAuthenticated(false); };
    window.addEventListener('console:unauthorized', clear);
    return () => window.removeEventListener('console:unauthorized', clear);
  }, [queryClient]);
  if (authenticated === null) return <div className="grid min-h-screen place-items-center text-zinc-400">Checking secure session…</div>;
  return authenticated ? <Console onLogout={() => { setCsrfToken(null); queryClient.clear(); setAuthenticated(false); }} /> : <Login onSuccess={(csrf) => { setCsrfToken(csrf); setAuthenticated(true); }} />;
}

function Login({ onSuccess }: { onSuccess: (csrf: string) => void }): ReactElement {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const login = useMutation({
    mutationFn: () => api<{ data: { csrfToken: string } }>('/session', { method: 'POST', body: JSON.stringify({ password }) }),
    onSuccess: ({ data }) => onSuccess(data.csrfToken),
    onError: (err: ApiError) => setError(err.message),
  });
  const submit = (event: FormEvent) => { event.preventDefault(); setError(null); login.mutate(); };
  return <main className="grid min-h-screen place-items-center bg-[radial-gradient(circle_at_top,_#27272a,_#09090b_52%)] p-5">
    <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-zinc-800 bg-zinc-950/80 p-7 shadow-2xl shadow-black/30">
      <div className="mb-7 flex size-11 items-center justify-center rounded-xl bg-emerald-400 text-zinc-950"><ShieldCheck size={24} /></div>
      <h1 className="text-xl font-semibold">Founder console</h1>
      <p className="mt-2 text-sm leading-6 text-zinc-400">Private operations access for the agent orchestrator.</p>
      <label className="mt-7 block text-sm font-medium">Password<input autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} className="mt-2 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 outline-none ring-emerald-400 focus:ring-2" /></label>
      {error && <p className="mt-3 text-sm text-red-300">{error}</p>}
      <button disabled={login.isPending || !password} className="mt-5 flex w-full items-center justify-center rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 enabled:hover:bg-emerald-300 disabled:opacity-50">{login.isPending ? 'Signing in…' : 'Sign in securely'}</button>
      <p className="mt-5 text-center text-xs text-zinc-500">Tailnet access and app session required.</p>
    </form>
  </main>;
}

function Console({ onLogout }: { onLogout: () => void }): ReactElement {
  const [view, setView] = useState<View>('overview');
  const [menuOpen, setMenuOpen] = useState(false);
  const client = useQueryClient();
  const logout = useMutation({ mutationFn: () => api<void>('/session', { method: 'DELETE' }), onSettled: onLogout });
  const choose = (next: View) => { setView(next); setMenuOpen(false); };
  return <div className="min-h-screen bg-zinc-950 text-zinc-100">
    <aside className={cn('fixed inset-y-0 z-20 w-64 border-r border-zinc-800 bg-zinc-950 p-4 transition-transform md:translate-x-0', menuOpen ? 'translate-x-0' : '-translate-x-full')}>
      <div className="mb-7 flex items-center gap-3 px-2"><div className="grid size-8 place-items-center rounded-lg bg-emerald-400 text-zinc-950"><Activity size={18} /></div><span className="font-semibold">AO Console</span></div>
      <nav className="space-y-1">{nav.map(([key, label, Icon]) => <button key={key} onClick={() => choose(key)} className={cn('flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition', view === key ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100')}><Icon size={17} />{label}</button>)}</nav>
      <button onClick={() => logout.mutate()} className="absolute bottom-5 flex items-center gap-3 px-3 text-sm text-zinc-400 hover:text-white"><LogOut size={17} />Sign out</button>
    </aside>
    {menuOpen && <button aria-label="Close navigation" onClick={() => setMenuOpen(false)} className="fixed inset-0 z-10 bg-black/60 md:hidden" />}
    <main className="min-h-screen md:ml-64">
      <header className="sticky top-0 z-10 flex h-16 items-center justify-between border-b border-zinc-800 bg-zinc-950/85 px-5 backdrop-blur"><button onClick={() => setMenuOpen(true)} className="md:hidden"><Menu /></button><div className="text-sm text-zinc-400">Founder-only · Tailscale protected</div><button onClick={() => client.invalidateQueries()} className="rounded-md p-2 text-zinc-400 hover:bg-zinc-900 hover:text-white" title="Refresh"><RefreshCw size={17} /></button></header>
      <div className="mx-auto max-w-7xl p-5 md:p-8">{view === 'overview' && <OverviewView onSelect={choose} />}{view === 'workers' && <WorkersView />}{view === 'inbox' && <InboxView />}{view === 'outbound' && <OutboundView />}{view === 'customers' && <CustomersView />}{view === 'decisions' && <DecisionsView />}</div>
    </main>
  </div>;
}

function OverviewView({ onSelect }: { onSelect: (view: View) => void }): ReactElement {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api<Overview>('/overview'), refetchInterval: 30_000 });
  if (overview.isLoading) return <Loading title="Loading operational state…" />;
  if (overview.isError) return <ErrorState message={(overview.error as Error).message} />;
  if (!overview.data) return <Loading title="Loading operational state…" />;
  const data = overview.data.data;
  return <section><PageTitle eyebrow="Live system" title="Operations overview" description="Bounded runtime state from the orchestrator database and worker registry." />
    <div className="mt-7 grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><Metric label="Database" value={data.db === 'ok' ? 'Connected' : 'Unavailable'} tone={data.db === 'ok' ? 'good' : 'bad'} /><Metric label="Inbox pending" value={String(data.backlog.inbox.pending)} detail={`${data.backlog.inbox.failed} failed`} onClick={() => onSelect('inbox')} /><Metric label="Outbound pending" value={String(data.backlog.outboundQueue.pending)} detail={`${data.backlog.outboundQueue.failed} failed`} /><Metric label="Workers" value={String(data.workers.length)} detail={`${data.workers.filter((w) => w.lastError).length} failing`} onClick={() => onSelect('workers')} /></div>
    <div className="mt-7 grid gap-5 lg:grid-cols-[1.3fr_1fr]"><Panel title="Attention needed"><Attention workers={data.workers} /></Panel><Panel title="Safety boundary"><div className="space-y-3 text-sm text-zinc-400"><p>Message bodies and decision output are hidden from list views.</p><p>Only failed inbox requeue and approved outbound cancellation are allowed here.</p><p className="flex gap-2 text-emerald-300"><CheckCircle2 size={17} />No direct customer send path</p></div></Panel></div>
  </section>;
}

function WorkersView(): ReactElement {
  const workers = useQuery({ queryKey: ['workers'], queryFn: () => api<{ data: Worker[] }>('/workers'), refetchInterval: 30_000 });
  if (workers.isLoading) return <Loading title="Loading worker health…" />;
  if (workers.isError) return <ErrorState message={(workers.error as Error).message} />;
  if (!workers.data) return <Loading title="Loading worker health…" />;
  return <section><PageTitle eyebrow="Runtime" title="Worker health" description="Safe categories only — upstream error text is never exposed." /><div className="mt-7 overflow-hidden rounded-xl border border-zinc-800"><table className="w-full text-left text-sm"><thead className="bg-zinc-900 text-zinc-400"><tr><th className="p-4">Worker</th><th className="p-4">Last success</th><th className="p-4">State</th></tr></thead><tbody>{workers.data.data.map((worker) => <tr key={worker.name} className="border-t border-zinc-800"><td className="p-4 font-mono text-xs text-zinc-200">{worker.name}</td><td className="p-4 text-zinc-400">{displayDate(worker.lastSuccessAt)}</td><td className="p-4"><Status error={worker.lastError} failures={worker.consecutiveFailures} /></td></tr>)}</tbody></table></div></section>;
}

function InboxView(): ReactElement {
  const [status, setStatus] = useState(''); const [selected, setSelected] = useState<string | null>(null);
  const inbox = useQuery({ queryKey: ['inbox', status], queryFn: () => api<Page>(`/inbox${status ? `?status=${status}` : ''}`) });
  const detail = useQuery({ queryKey: ['inbox', selected], queryFn: () => api<{ data: Row }>(`/inbox/${selected}`), enabled: Boolean(selected) });
  const client = useQueryClient();
  const requeue = useMutation({ mutationFn: (id: string) => api(`/inbox/${id}/requeue`, { method: 'POST' }), onSuccess: () => { void client.invalidateQueries({ queryKey: ['inbox'] }); setSelected(null); } });
  if (inbox.isLoading) return <Loading title="Loading inbox…" />;
  if (inbox.isError) return <ErrorState message={(inbox.error as Error).message} />;
  if (!inbox.data) return <Loading title="Loading inbox…" />;
  return <section><PageTitle eyebrow="Read-first queue" title="Inbox" description="Metadata list; sensitive content appears only after an explicit detail reveal." /><div className="mt-6 flex gap-2 overflow-x-auto">{['', 'pending', 'processing', 'processed', 'failed', 'skipped'].map((value) => <button key={value || 'all'} onClick={() => setStatus(value)} className={cn('rounded-full border px-3 py-1.5 text-sm capitalize', status === value ? 'border-emerald-400 bg-emerald-400 text-zinc-950' : 'border-zinc-700 text-zinc-300')}>{value || 'all'}</button>)}</div><div className="mt-6 grid gap-5 xl:grid-cols-[1fr_440px]"><Panel title={`${inbox.data.data.length} records`}><div className="divide-y divide-zinc-800">{inbox.data.data.map((row) => <button key={String(row.id)} onClick={() => setSelected(String(row.id))} className="block w-full px-1 py-4 text-left hover:bg-zinc-900/50"><div className="flex items-center justify-between gap-3"><span className="font-medium">{display(row.customer_name)}</span><Badge value={display(row.status)} /></div><p className="mt-1 truncate text-sm text-zinc-400">{display(row.subject)}</p><p className="mt-2 text-xs text-zinc-500">{display(row.channel_name)} · {displayDate(row.received_at)}</p></button>)}</div></Panel><Detail title="Inbox detail" loading={detail.isLoading} error={detail.error as Error | null} data={detail.data?.data} action={detail.data?.data.status === 'failed' ? <button onClick={() => { if (window.confirm('Requeue this failed inbox item? It will return to pending processing.')) requeue.mutate(String(detail.data?.data.id)); }} className="rounded-lg bg-amber-300 px-3 py-2 text-sm font-semibold text-zinc-950">Requeue safely</button> : undefined} /></div></section>;
}

function OutboundView(): ReactElement {
  const [status, setStatus] = useState(''); const [selected, setSelected] = useState<string | null>(null);
  const outbound = useQuery({ queryKey: ['outbound', status], queryFn: () => api<Page>(`/outbound${status ? `?status=${status}` : ''}`) });
  const detail = useQuery({ queryKey: ['outbound', selected], queryFn: () => api<{ data: Row }>(`/outbound/${selected}`), enabled: Boolean(selected) });
  const client = useQueryClient();
  const cancel = useMutation({ mutationFn: (id: string) => api(`/outbound/${id}/cancel`, { method: 'POST' }), onSuccess: () => { void client.invalidateQueries({ queryKey: ['outbound'] }); setSelected(null); } });
  if (outbound.isLoading) return <Loading title="Loading outbound queue…" />;
  if (outbound.isError) return <ErrorState message={(outbound.error as Error).message} />;
  if (!outbound.data) return <Loading title="Loading outbound queue…" />;
  return <section><PageTitle eyebrow="Delivery safety" title="Outbound queue" description="This console cannot send or resend messages. Cancellation is restricted to approved, unsent, non-draft rows." /><div className="mt-6 flex gap-2 overflow-x-auto">{['', 'pending', 'approved', 'sending', 'sent', 'failed', 'cancelled'].map((value) => <button key={value || 'all'} onClick={() => setStatus(value)} className={cn('rounded-full border px-3 py-1.5 text-sm capitalize', status === value ? 'border-emerald-400 bg-emerald-400 text-zinc-950' : 'border-zinc-700 text-zinc-300')}>{value || 'all'}</button>)}</div><div className="mt-6 grid gap-5 xl:grid-cols-[1fr_440px]"><Panel title={`${outbound.data.data.length} records`}><div className="divide-y divide-zinc-800">{outbound.data.data.map((row) => <button key={String(row.id)} onClick={() => setSelected(String(row.id))} className="block w-full px-1 py-4 text-left hover:bg-zinc-900/50"><div className="flex items-center justify-between gap-3"><span className="font-medium">{display(row.customer_name)}</span><Badge value={display(row.status)} /></div><p className="mt-1 truncate text-sm text-zinc-400">{display(row.subject)}</p><p className="mt-2 text-xs text-zinc-500">{display(row.channel_name)} · {row.is_draft === true ? 'draft' : 'non-draft'} · {displayDate(row.created_at)}</p></button>)}</div></Panel><Detail title="Outbound detail" loading={detail.isLoading} error={detail.error as Error | null} data={detail.data?.data} action={detail.data?.data.status === 'approved' && detail.data?.data.is_draft === false ? <button onClick={() => { if (window.confirm('Cancel this approved outbound item? It cannot be restored from the console.')) cancel.mutate(String(detail.data?.data.id)); }} className="rounded-lg bg-red-300 px-3 py-2 text-sm font-semibold text-zinc-950">Cancel approved send</button> : undefined} /></div></section>;
}

function CustomersView(): ReactElement {
  const [searchInput, setSearchInput] = useState(''); const [search, setSearch] = useState(''); const [selected, setSelected] = useState<string | null>(null);
  const customers = useQuery({ queryKey: ['customers', search], queryFn: () => api<Page>(`/customers${search ? `?search=${encodeURIComponent(search)}` : ''}`) });
  const detail = useQuery({ queryKey: ['customer', selected], queryFn: () => api<{ data: Row }>(`/customers/${selected}`), enabled: Boolean(selected) });
  const timeline = useQuery({ queryKey: ['customer-timeline', selected], queryFn: () => api<{ data: Row[] }>(`/customers/${selected}/timeline`), enabled: Boolean(selected) });
  if (customers.isLoading) return <Loading title="Loading local customers…" />;
  if (customers.isError) return <ErrorState message={(customers.error as Error).message} />;
  if (!customers.data) return <Loading title="Loading local customers…" />;
  return <section><PageTitle eyebrow="Local customer record" title="Customers" description="A bounded timeline built only from orchestrator records. It contains event metadata, never inbox bodies or agent output." />
    <form onSubmit={(event) => { event.preventDefault(); setSearch(searchInput.trim()); setSelected(null); }} className="mt-6 flex max-w-xl gap-2"><input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder="Search customer name or BP reference" className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none ring-emerald-400 focus:ring-2" /><button className="rounded-lg bg-emerald-400 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-300">Search</button></form>
    <div className="mt-6 grid gap-5 xl:grid-cols-[minmax(280px,0.8fr)_minmax(0,1.5fr)]"><Panel title={`${customers.data.data.length} local customers`}><div className="divide-y divide-zinc-800">{customers.data.data.length === 0 && <p className="py-4 text-sm text-zinc-500">No local customer records match this search.</p>}{customers.data.data.map((row) => <button key={String(row.id)} onClick={() => setSelected(String(row.id))} className={cn('block w-full px-1 py-4 text-left hover:bg-zinc-900/50', selected === String(row.id) && 'bg-zinc-800/60')}><div className="flex items-center justify-between gap-3"><span className="truncate font-medium">{display(row.display_name)}</span><span className="text-xs text-zinc-500">{String(row.inbox_count ?? 0)} inbox</span></div><p className="mt-1 text-xs text-zinc-500">{display(row.bp_ref)} · added {displayDate(row.created_at)}</p></button>)}</div></Panel>
      <div className="space-y-5"><Detail title="Customer record" loading={detail.isLoading} error={detail.error as Error | null} data={detail.data?.data} /><Panel title="Activity timeline">{!selected && <p className="text-sm text-zinc-500">Select a customer to see local activity.</p>}{timeline.isLoading && <p className="text-sm text-zinc-400">Loading timeline…</p>}{timeline.isError && <ErrorState message={(timeline.error as Error).message} />}{timeline.data && <div className="space-y-4">{timeline.data.data.length === 0 && <p className="text-sm text-zinc-500">No local activity recorded for this customer.</p>}{timeline.data.data.map((event) => <article key={`${String(event.event_type)}-${String(event.entity_id)}`} className="border-l border-zinc-700 pl-4"><div className="flex flex-wrap items-center gap-2"><Badge value={display(event.event_type)} /><span className="text-sm font-medium">{display(event.status)}</span></div><p className="mt-1 text-xs text-zinc-500">{displayDate(event.created_at)}</p>{Boolean(event.metadata) && <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-2 text-xs text-zinc-400">{JSON.stringify(event.metadata, null, 2)}</pre>}</article>)}</div>}</Panel></div>
    </div>
  </section>;
}

function DecisionsView(): ReactElement {
  const [selected, setSelected] = useState<string | null>(null);
  const decisions = useQuery({ queryKey: ['decisions'], queryFn: () => api<Page>('/decisions') });
  const detail = useQuery({ queryKey: ['decision', selected], queryFn: () => api<{ data: Row }>(`/decisions/${selected}`), enabled: Boolean(selected) });
  if (decisions.isLoading) return <Loading title="Loading decisions…" />;
  if (decisions.isError) return <ErrorState message={(decisions.error as Error).message} />;
  if (!decisions.data) return <Loading title="Loading decisions…" />;
  return <section><PageTitle eyebrow="Human-in-the-loop" title="Decisions" description="Resolution history and backfill/draft outcomes; agent output is detail-only." /><div className="mt-6 grid gap-5 xl:grid-cols-[1fr_440px]"><Panel title={`${decisions.data.data.length} decisions`}><div className="divide-y divide-zinc-800">{decisions.data.data.map((row) => <button key={String(row.id)} onClick={() => setSelected(String(row.id))} className="block w-full px-1 py-4 text-left hover:bg-zinc-900/50"><div className="flex items-center justify-between"><span className="font-medium">{display(row.decision_type)}</span><Badge value={display(row.outcome)} /></div><p className="mt-2 text-xs text-zinc-500">{display(row.customer_name)} · {displayDate(row.created_at)}</p></button>)}</div></Panel><Detail title="Decision detail" loading={detail.isLoading} error={detail.error as Error | null} data={detail.data?.data} /></div></section>;
}

function PageTitle({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }): ReactElement { return <div><p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">{eyebrow}</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">{title}</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">{description}</p></div>; }
function Panel({ title, children }: { title: string; children: ReactNode }): ReactElement { return <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5"><h2 className="mb-4 text-sm font-semibold">{title}</h2>{children}</section>; }
function Metric({ label, value, detail, tone, onClick }: { label: string; value: string; detail?: string; tone?: 'good' | 'bad'; onClick?: () => void }): ReactElement { return <button onClick={onClick} className={cn('rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 text-left', onClick && 'hover:border-zinc-600')}><p className="text-sm text-zinc-400">{label}</p><p className={cn('mt-3 text-2xl font-semibold', tone === 'good' && 'text-emerald-300', tone === 'bad' && 'text-red-300')}>{value}</p>{detail && <p className="mt-2 text-xs text-zinc-500">{detail}</p>}</button>; }
function Badge({ value }: { value: string }): ReactElement { const bad = ['failed', 'rejected', 'cancelled'].includes(value); return <span className={cn('rounded-full px-2 py-1 text-xs font-medium', bad ? 'bg-red-400/15 text-red-300' : value === 'pending' ? 'bg-amber-400/15 text-amber-200' : 'bg-zinc-800 text-zinc-300')}>{value}</span>; }
function Status({ error, failures }: { error: string | null; failures: number }): ReactElement { return error ? <span className="inline-flex items-center gap-2 text-red-300"><CircleAlert size={16} />{error} ({failures})</span> : <span className="inline-flex items-center gap-2 text-emerald-300"><CheckCircle2 size={16} />healthy</span>; }
function Attention({ workers }: { workers: Worker[] }): ReactElement { const failing = workers.filter((worker) => worker.lastError); return failing.length ? <div className="space-y-3">{failing.map((worker) => <div key={worker.name} className="flex items-center justify-between rounded-lg bg-red-400/10 p-3"><span className="font-mono text-xs">{worker.name}</span><Status error={worker.lastError} failures={worker.consecutiveFailures} /></div>)}</div> : <div className="flex items-center gap-3 rounded-lg bg-emerald-400/10 p-4 text-sm text-emerald-200"><CheckCircle2 size={18} />No failing registered workers.</div>; }
function Loading({ title }: { title: string }): ReactElement { return <div className="mt-8 rounded-xl border border-zinc-800 p-8 text-sm text-zinc-400">{title}</div>; }
function ErrorState({ message }: { message: string }): ReactElement { return <div className="mt-8 flex items-center gap-3 rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200"><CircleAlert size={18} />{message}</div>; }
function Detail({ title, data, loading, error, action }: { title: string; data?: Row; loading: boolean; error: Error | null; action?: ReactNode }): ReactElement { return <Panel title={title}>{loading && <p className="text-sm text-zinc-400">Loading selected record…</p>}{error && <ErrorState message={error.message} />}{!loading && !error && !data && <p className="text-sm text-zinc-500">Select a row to reveal its detail.</p>}{data && <div className="space-y-4 text-sm">{Object.entries(data).map(([key, value]) => <div key={key}><p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{key.replaceAll('_', ' ')}</p><pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 text-xs text-zinc-300">{typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—')}</pre></div>)}{action && <div className="border-t border-zinc-800 pt-4">{action}</div>}</div>}</Panel>; }
