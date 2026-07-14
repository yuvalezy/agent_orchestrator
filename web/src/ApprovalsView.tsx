import { type ReactElement, type ReactNode, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, Pencil, Send, Sparkles, X } from 'lucide-react';
import { api, type ApiError } from './lib/api';

// The Approvals surface: clear pending draft replies + backfill task proposals in the UI instead of
// Telegram. Every action hits a /console/api/approvals endpoint that reuses the SAME core fn the
// Telegram flow calls. Self-contained (local mini-primitives) to keep App.tsx edits to 3 lines.

interface DraftRow {
  queue_id: string; created_at: string; customer_name: string | null;
  channel_name: string | null; channel_type: string | null;
  draft_body: string | null; inbox_subject: string | null; inbox_body: string | null; sender_name: string | null;
}
interface ProposalRow {
  decision_id: string; created_at: string; customer_name: string | null;
  title: string | null; description: string | null; priority: string | null;
  channel: string | null; summary: string | null;
}

const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const when = (v: string | null): string => (v ? fmt.format(new Date(v)) : '—');
const ageDays = (v: string | null): number => (v ? (Date.now() - new Date(v).getTime()) / 86_400_000 : 0);
const PRIORITY_RANK: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 };

function Loading(): ReactElement { return <div className="mt-6 rounded-xl border border-zinc-800 p-8 text-sm text-zinc-400">Loading…</div>; }
function ErrorState({ message }: { message: string }): ReactElement { return <div className="mt-6 flex items-center gap-3 rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200"><CircleAlert size={18} />{message}</div>; }
function Panel({ children }: { children: ReactNode }): ReactElement { return <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">{children}</section>; }
function PriorityBadge({ value }: { value: string | null }): ReactElement {
  const v = value ?? 'medium';
  const tone = v === 'urgent' ? 'bg-red-400/15 text-red-300' : v === 'high' ? 'bg-amber-400/15 text-amber-200' : 'bg-zinc-800 text-zinc-300';
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${tone}`}>{v}</span>;
}
const btn = 'rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-40';

interface ConfirmOpts { title: string; message: string; confirmLabel: string; tone?: 'danger' | 'primary'; onConfirm: () => void }

function ConfirmDialog({ title, message, confirmLabel, tone = 'primary', onConfirm, onClose }: ConfirmOpts & { onClose: () => void }): ReactElement {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-100">{title}</h3>
        <p className="mt-2 text-sm leading-6 text-zinc-400">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button autoFocus onClick={onClose} className={`${btn} bg-zinc-800 text-zinc-300`}>Cancel</button>
          <button onClick={() => { onConfirm(); onClose(); }} className={`${btn} ${tone === 'danger' ? 'bg-red-400 text-zinc-900' : 'bg-emerald-400 text-zinc-900'}`}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function useConfirm(): { ask: (o: ConfirmOpts) => void; dialog: ReactElement | null } {
  const [opts, setOpts] = useState<ConfirmOpts | null>(null);
  return { ask: setOpts, dialog: opts ? <ConfirmDialog {...opts} onClose={() => setOpts(null)} /> : null };
}

export function ApprovalsView(): ReactElement {
  const [tab, setTab] = useState<'drafts' | 'proposals'>('drafts');
  const drafts = useQuery({ queryKey: ['approvals', 'drafts'], queryFn: () => api<{ data: DraftRow[] }>('/approvals/drafts') });
  const proposals = useQuery({ queryKey: ['approvals', 'proposals'], queryFn: () => api<{ data: ProposalRow[] }>('/approvals/proposals') });

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Approvals</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Pending decisions</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Approve, edit, revise, or reject drafts, and accept or skip backfill task proposals — the same actions as Telegram. Approving a draft sends the reply to the customer.</p>
      </div>
      <div className="flex gap-2">
        <button onClick={() => setTab('drafts')} className={`${btn} ${tab === 'drafts' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900'}`}>Draft replies {drafts.data ? `(${drafts.data.data.length})` : ''}</button>
        <button onClick={() => setTab('proposals')} className={`${btn} ${tab === 'proposals' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900'}`}>Task proposals {proposals.data ? `(${proposals.data.data.length})` : ''}</button>
      </div>
      {tab === 'drafts' ? <DraftsTab query={drafts} /> : <ProposalsTab query={proposals} />}
    </div>
  );
}

function useActionState(): { err: string | null; ok: string | null; run: (p: Promise<unknown>, okMsg: string) => Promise<void> } {
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (p: Promise<unknown>, okMsg: string): Promise<void> => {
    setErr(null); setOk(null);
    try { await p; setOk(okMsg); } catch (e) { setErr((e as ApiError).message); }
  };
  return { err, ok, run };
}

function DraftsTab({ query }: { query: ReturnType<typeof useQuery<{ data: DraftRow[] }>> }): ReactElement {
  const client = useQueryClient();
  const caps = useQuery({ queryKey: ['approvals', 'capabilities'], queryFn: () => api<{ data: { reviseEnabled: boolean } }>('/approvals/capabilities') });
  const reviseEnabled = caps.data?.data.reviseEnabled ?? false;
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [revising, setRevising] = useState<{ id: string; text: string } | null>(null);
  const { err, ok, run } = useActionState();
  const { ask, dialog } = useConfirm();
  const refetch = (): void => void client.invalidateQueries({ queryKey: ['approvals', 'drafts'] });

  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} />;
  const rows = query.data?.data ?? [];
  if (rows.length === 0) return <Panel><p className="text-sm text-zinc-500">No draft replies awaiting approval.</p></Panel>;

  const post = (path: string, body?: object): Promise<unknown> => api(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined });

  return (
    <div className="space-y-4">
      {dialog}
      {err && <ErrorState message={err} />}
      {ok && <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-sm text-emerald-200">{ok}</div>}
      {rows.map((d) => {
        const stale = ageDays(d.created_at) >= 1;
        const isEditing = editing?.id === d.queue_id;
        const isRevising = revising?.id === d.queue_id;
        return (
          <Panel key={d.queue_id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">{d.customer_name ?? '(no customer)'} <span className="text-zinc-500">· {d.channel_name ?? d.channel_type ?? '—'}</span></p>
                <p className="text-xs text-zinc-500">{d.inbox_subject ?? '(no subject)'} · {when(d.created_at)} {stale && <span className="text-amber-300">· waiting {Math.floor(ageDays(d.created_at))}d</span>}</p>
              </div>
            </div>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Customer's message{d.sender_name ? ` · ${d.sender_name}` : ''}</p>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded border-l-2 border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-200">{d.inbox_body?.trim() || '(no original message — founder-initiated or history-sourced)'}</pre>
            <p className="mt-3 text-xs font-medium uppercase tracking-wide text-emerald-300/80">Proposed reply</p>
            <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded bg-zinc-950 p-3 text-xs text-zinc-300">{d.draft_body ?? '—'}</pre>

            {isEditing ? (
              <div className="mt-3 space-y-2">
                <textarea value={editing.text} onChange={(e) => setEditing({ id: d.queue_id, text: e.target.value })} rows={5} className="w-full rounded bg-zinc-950 p-3 text-xs text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500" />
                <div className="flex gap-2">
                  <button disabled={!editing.text.trim()} onClick={() => run(post(`/approvals/drafts/${d.queue_id}/edit`, { body: editing.text }).then(() => { setEditing(null); refetch(); }), 'Edited and sent.')} className={`${btn} bg-emerald-400 text-zinc-900`}>Save &amp; send</button>
                  <button onClick={() => setEditing(null)} className={`${btn} bg-zinc-800 text-zinc-300`}>Cancel</button>
                </div>
              </div>
            ) : isRevising ? (
              <div className="mt-3 space-y-2">
                <input value={revising.text} onChange={(e) => setRevising({ id: d.queue_id, text: e.target.value })} placeholder="Instruction, e.g. 'be more concise and offer a call'" className="w-full rounded bg-zinc-950 p-3 text-xs text-zinc-200 outline-none ring-1 ring-zinc-800 focus:ring-emerald-500" />
                <div className="flex gap-2">
                  <button disabled={!revising.text.trim()} onClick={() => run(post(`/approvals/drafts/${d.queue_id}/revise`, { instruction: revising.text }).then(() => { setRevising(null); refetch(); }), 'Revised — review the regenerated draft.')} className={`${btn} bg-violet-400 text-zinc-900`}>Regenerate</button>
                  <button onClick={() => setRevising(null)} className={`${btn} bg-zinc-800 text-zinc-300`}>Cancel</button>
                </div>
              </div>
            ) : (
              <div className="mt-3 flex flex-wrap gap-2">
                <button onClick={() => ask({ title: 'Send reply to customer?', message: `This sends the draft to ${d.customer_name ?? 'the customer'} via ${d.channel_name ?? d.channel_type ?? 'the channel'}.`, confirmLabel: 'Approve & send', tone: 'primary', onConfirm: () => void run(post(`/approvals/drafts/${d.queue_id}/approve`).then(refetch), 'Approved — sending.') })} className={`${btn} bg-emerald-400 text-zinc-900`}><Send size={12} className="mr-1 inline" />Approve &amp; send</button>
                <button onClick={() => setEditing({ id: d.queue_id, text: d.draft_body ?? '' })} className={`${btn} bg-zinc-800 text-zinc-200`}><Pencil size={12} className="mr-1 inline" />Edit</button>
                {reviseEnabled && <button onClick={() => setRevising({ id: d.queue_id, text: '' })} className={`${btn} bg-zinc-800 text-zinc-200`}><Sparkles size={12} className="mr-1 inline" />Revise</button>}
                <button onClick={() => ask({ title: 'Reject this draft?', message: 'The draft will be cancelled and not sent.', confirmLabel: 'Reject', tone: 'danger', onConfirm: () => void run(post(`/approvals/drafts/${d.queue_id}/reject`).then(refetch), 'Rejected.') })} className={`${btn} bg-red-400/15 text-red-300`}><X size={12} className="mr-1 inline" />Reject</button>
              </div>
            )}
          </Panel>
        );
      })}
    </div>
  );
}

function ProposalsTab({ query }: { query: ReturnType<typeof useQuery<{ data: ProposalRow[] }>> }): ReactElement {
  const client = useQueryClient();
  const [priority, setPriority] = useState<string>('');
  const [customer, setCustomer] = useState<string>('');
  const { err, ok, run } = useActionState();
  const { ask, dialog } = useConfirm();
  const refetch = (): void => void client.invalidateQueries({ queryKey: ['approvals', 'proposals'] });

  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} />;
  const all = query.data?.data ?? [];
  if (all.length === 0) return <Panel><p className="text-sm text-zinc-500">No task proposals awaiting review.</p></Panel>;

  const customers = [...new Set(all.map((p) => p.customer_name ?? '(none)'))].sort();
  const rows = all
    .filter((p) => (!priority || (p.priority ?? 'medium') === priority) && (!customer || (p.customer_name ?? '(none)') === customer))
    .sort((a, b) => (PRIORITY_RANK[a.priority ?? 'medium'] ?? 2) - (PRIORITY_RANK[b.priority ?? 'medium'] ?? 2));

  const post = (path: string): Promise<unknown> => api(path, { method: 'POST' });

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        {['', 'urgent', 'high', 'medium', 'low'].map((p) => (
          <button key={p || 'all'} onClick={() => setPriority(p)} className={`rounded-full px-2.5 py-1 ${priority === p ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>{p || 'all priorities'}</button>
        ))}
        <select value={customer} onChange={(e) => setCustomer(e.target.value)} className="rounded bg-zinc-900 px-2 py-1 text-zinc-300 outline-none ring-1 ring-zinc-800">
          <option value="">all customers</option>
          {customers.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-zinc-500">{rows.length} shown</span>
      </div>
      {err && <ErrorState message={err} />}
      {ok && <div className="rounded-lg border border-emerald-900/60 bg-emerald-950/30 p-3 text-sm text-emerald-200">{ok}</div>}
      {rows.map((p) => (
        <Panel key={p.decision_id}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2"><PriorityBadge value={p.priority} /><p className="text-sm font-medium">{p.title ?? '(untitled)'}</p></div>
              <p className="mt-1 text-xs text-zinc-500">{p.customer_name ?? '(no customer)'} · from {p.channel ?? '—'} · {when(p.created_at)}</p>
              {p.description && <p className="mt-2 whitespace-pre-wrap text-xs text-zinc-400">{p.description}</p>}
            </div>
            <div className="flex shrink-0 gap-2">
              <button title="Create task" onClick={() => void run(post(`/approvals/proposals/${p.decision_id}/approve`).then(refetch), 'Task created in the portal.')} className={`${btn} bg-emerald-400 text-zinc-900`}><CheckCircle2 size={12} className="mr-1 inline" />Approve</button>
              <button title="Skip" onClick={() => ask({ title: 'Skip this proposal?', message: 'No task will be created.', confirmLabel: 'Reject', tone: 'danger', onConfirm: () => void run(post(`/approvals/proposals/${p.decision_id}/reject`).then(refetch), 'Skipped.') })} className={`${btn} bg-red-400/15 text-red-300`}><X size={12} className="mr-1 inline" />Reject</button>
            </div>
          </div>
        </Panel>
      ))}
    </div>
  );
}
