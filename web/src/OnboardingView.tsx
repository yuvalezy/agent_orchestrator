import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Building2, CheckCircle2, CircleAlert, FolderKanban, MessageCircle, Sparkles, UserPlus } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { Select } from './lib/select';

// Customer Onboarding + Backfill screen. A guided flow: search EZY Portal for a business partner
// (already-onboarded ones are flagged and cannot be picked), preview its WhatsApp/email contacts,
// choose the target project + work item type, onboard, then run the backfill — a DRY preview
// first, and the LIVE sweep (which posts Telegram approval cards) as a deliberate second action.
// The portal has no BP→project link, so the operator chooses the project; the work item type is
// auto-picked when the project type has exactly one, otherwise a dropdown.

interface CustomerHit { ref: string; name: string; code: string; alreadyOnboarded: boolean }
interface ProjectHit { ref: string; code: string; name: string; status: string }
interface Contact { name: string; email: string | null; phone: string | null; whatsapp: string | null; telegram: string | null; isPrimary: boolean }
interface Preview { ref: string; name: string; website: string | null; email: string | null; contacts: Contact[]; alreadyOnboarded: boolean }
interface WorkItemType { ref: string; name: string }
interface DrySummary { at: string; threads: number; linkedOpen: number; linkedResolved: number; memories: number; proposed: number; proposalsConsidered: number; skipped: number; retryable: number; skippedReason?: string }
interface BackfillState { enabled: boolean; reason: string | null; status: string | null; running: boolean; dry: DrySummary | null }
interface OnboardResponse { data: { customerId: string; created: boolean; waBlocked: boolean; workItemTypeRef: string } }

function useDebounced(value: string, ms = 300): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => { const id = setTimeout(() => setDebounced(value), ms); return () => clearTimeout(id); }, [value, ms]);
  return debounced;
}

function Panel({ step, title, children }: { step: number; title: string; children: ReactNode }): ReactElement {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-zinc-200">
        <span className="grid size-5 place-items-center rounded-full bg-zinc-800 text-[11px] text-zinc-400">{step}</span>
        {title}
      </h2>
      {children}
    </section>
  );
}

function ErrorText({ message }: { message: string }): ReactElement {
  return <p className="mt-3 flex items-center gap-2 text-sm text-red-300"><CircleAlert size={15} />{message}</p>;
}

export function OnboardingView(): ReactElement {
  const [customerInput, setCustomerInput] = useState('');
  const [selected, setSelected] = useState<CustomerHit | null>(null);
  const [projectInput, setProjectInput] = useState('');
  const [project, setProject] = useState<ProjectHit | null>(null);
  const [witRef, setWitRef] = useState<string>('');
  const [onboardedId, setOnboardedId] = useState<string | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);

  const customerQ = useDebounced(customerInput);
  const projectQ = useDebounced(projectInput);

  const customers = useQuery({
    queryKey: ['onboarding-customers', customerQ],
    queryFn: () => api<{ data: CustomerHit[] }>(`/onboarding/customers?q=${encodeURIComponent(customerQ)}`),
    enabled: customerQ.trim().length > 0 && !selected,
  });
  const preview = useQuery({
    queryKey: ['onboarding-preview', selected?.ref],
    queryFn: () => api<{ data: Preview }>(`/onboarding/customers/${selected!.ref}/preview`),
    enabled: Boolean(selected),
  });
  const projects = useQuery({
    queryKey: ['onboarding-projects', projectQ],
    queryFn: () => api<{ data: ProjectHit[] }>(`/onboarding/projects?q=${encodeURIComponent(projectQ)}`),
    enabled: projectQ.trim().length > 0 && !project,
  });
  const workItemTypes = useQuery({
    queryKey: ['onboarding-wit', project?.ref],
    queryFn: () => api<{ data: WorkItemType[] }>(`/onboarding/projects/${project!.ref}/work-item-types`),
    enabled: Boolean(project),
  });

  // Auto-pick the work item type when the project type has exactly one (mirrors the CLI).
  const witList = workItemTypes.data?.data ?? [];
  useEffect(() => {
    if (witList.length === 1) setWitRef(witList[0].ref);
    else setWitRef('');
  }, [project?.ref, witList.length]);

  const onboard = useMutation({
    mutationFn: () => api<OnboardResponse>('/onboarding', { method: 'POST', body: JSON.stringify({ bpRef: selected!.ref, projectRef: project!.ref, workItemTypeRef: witRef || undefined }) }),
    onSuccess: ({ data }) => setOnboardedId(data.customerId),
  });

  const resetCustomer = (): void => { setSelected(null); setProject(null); setProjectInput(''); setWitRef(''); setOnboardedId(null); onboard.reset(); };

  const canOnboard = Boolean(selected && project && witRef) && !preview.data?.data.alreadyOnboarded;

  return (
    <section className="space-y-6">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Bring a customer online</p>
        <h1 className="mt-2 flex items-center gap-2 text-3xl font-semibold tracking-tight"><UserPlus size={26} className="text-emerald-300" />Onboarding</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
          Register an EZY Portal customer with the orchestrator: import its contacts, create its Telegram topic, and point its tasks at a project. Then optionally seed its memory from history. Work here is idempotent — re-running never double-creates.
        </p>
      </div>

      {/* Instructions */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 text-sm leading-6 text-zinc-400">
        <p className="font-medium text-zinc-300">How it works</p>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Search the portal for the customer. Already-onboarded ones are marked and can't be picked again.</li>
          <li>Review the contacts we'll import — especially the WhatsApp numbers.</li>
          <li>Pick the project its tasks land in. Its work item type is chosen automatically when there's only one.</li>
          <li>Onboard. Then run the <span className="text-zinc-300">dry</span> backfill preview to see what history would seed — nothing is written until you run the <span className="text-zinc-300">live</span> sweep, which posts Telegram approval cards.</li>
        </ol>
      </div>

      {/* Step 1: customer search / selection */}
      <Panel step={1} title="Choose the customer to onboard">
        {selected ? (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-zinc-100"><Building2 size={14} className="mr-1.5 inline text-zinc-500" />{selected.name}</p>
              <p className="mt-1 font-mono text-[11px] text-zinc-600">{selected.code} · {selected.ref}</p>
            </div>
            <button onClick={resetCustomer} className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500">Change</button>
          </div>
        ) : (
          <>
            <input
              autoFocus
              value={customerInput}
              onChange={(e) => setCustomerInput(e.target.value)}
              maxLength={100}
              placeholder="Search EZY Portal by customer name or code"
              className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none ring-emerald-400 focus:ring-2"
            />
            {customers.isError && <ErrorText message={(customers.error as Error).message} />}
            {customerQ.trim().length > 0 && (
              <div className="mt-3 divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                {customers.isLoading && <p className="p-3 text-sm text-zinc-500">Searching…</p>}
                {customers.data?.data.length === 0 && <p className="p-3 text-sm text-zinc-500">No portal customers match “{customerQ}”.</p>}
                {customers.data?.data.map((hit) => (
                  <button
                    key={hit.ref}
                    disabled={hit.alreadyOnboarded}
                    onClick={() => setSelected(hit)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-zinc-900/60 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-transparent"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-sm text-zinc-100">{hit.name}</span>
                      <span className="block font-mono text-[11px] text-zinc-600">{hit.code}</span>
                    </span>
                    {hit.alreadyOnboarded
                      ? <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400">already onboarded</span>
                      : <span className="shrink-0 rounded-full bg-emerald-400/15 px-2 py-1 text-xs font-medium text-emerald-300">Select</span>}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </Panel>

      {/* Step 2: contacts preview */}
      {selected && (
        <Panel step={2} title="Contacts we'll import">
          {preview.isLoading && <p className="text-sm text-zinc-500">Loading contacts…</p>}
          {preview.isError && <ErrorText message={(preview.error as Error).message} />}
          {preview.data && (
            <>
              {preview.data.data.alreadyOnboarded && <ErrorText message="This customer is already onboarded — pick another." />}
              {preview.data.data.website && <p className="mb-3 text-xs text-zinc-500">Website: {preview.data.data.website}</p>}
              {preview.data.data.contacts.length === 0 ? (
                <p className="text-sm text-zinc-500">No contacts on this business partner. WhatsApp groups from whatsapp_manager are imported at onboarding regardless.</p>
              ) : (
                <div className="divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                  {preview.data.data.contacts.map((c, i) => (
                    <div key={i} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
                      <span className="text-zinc-200">{c.name || '—'}{c.isPrimary && <span className="ml-2 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">primary</span>}</span>
                      <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                        {c.email && <span>{c.email}</span>}
                        {c.whatsapp && <span className="text-emerald-300"><MessageCircle size={12} className="mr-1 inline" />{c.whatsapp}</span>}
                        {c.phone && !c.whatsapp && <span>{c.phone}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>
      )}

      {/* Step 3: project + work item type */}
      {selected && !preview.data?.data.alreadyOnboarded && (
        <Panel step={3} title="Point its tasks at a project">
          {project ? (
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-zinc-100"><FolderKanban size={14} className="mr-1.5 inline text-zinc-500" />{project.name}</p>
                <p className="mt-1 font-mono text-[11px] text-zinc-600">{project.code} · {project.status}</p>
              </div>
              <button onClick={() => { setProject(null); setProjectInput(''); setWitRef(''); }} className="shrink-0 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-zinc-500">Change</button>
            </div>
          ) : (
            <>
              <input
                value={projectInput}
                onChange={(e) => setProjectInput(e.target.value)}
                maxLength={100}
                placeholder="Search projects by code or name"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm outline-none ring-emerald-400 focus:ring-2"
              />
              {projects.isError && <ErrorText message={(projects.error as Error).message} />}
              {projectQ.trim().length > 0 && (
                <div className="mt-3 divide-y divide-zinc-800 rounded-lg border border-zinc-800">
                  {projects.isLoading && <p className="p-3 text-sm text-zinc-500">Searching…</p>}
                  {projects.data?.data.length === 0 && <p className="p-3 text-sm text-zinc-500">No projects match “{projectQ}”.</p>}
                  {projects.data?.data.map((p) => (
                    <button key={p.ref} onClick={() => setProject(p)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-zinc-900/60">
                      <span className="min-w-0"><span className="block truncate text-sm text-zinc-100">{p.name}</span><span className="block font-mono text-[11px] text-zinc-600">{p.code}</span></span>
                      <span className="shrink-0 rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400">{p.status}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {project && (
            <div className="mt-4">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">Work item type</p>
              {workItemTypes.isLoading && <p className="text-sm text-zinc-500">Loading work item types…</p>}
              {workItemTypes.isError && <ErrorText message={(workItemTypes.error as Error).message} />}
              {workItemTypes.data && witList.length === 0 && <ErrorText message="This project type has no work item types — the portal would reject task creation. Pick another project." />}
              {witList.length === 1 && <p className="text-sm text-zinc-300">{witList[0].name} <span className="text-zinc-500">(only option — selected automatically)</span></p>}
              {witList.length > 1 && (
                <Select value={witRef} onChange={setWitRef} sort searchable placeholder="Choose a work item type…" aria-label="Work item type" options={witList.map((t) => ({ value: t.ref, label: t.name }))} />
              )}
            </div>
          )}
        </Panel>
      )}

      {/* Step 4: onboard */}
      {selected && !preview.data?.data.alreadyOnboarded && (
        <Panel step={4} title="Onboard">
          {onboardedId ? (
            <div className="flex items-center gap-2 rounded-lg bg-emerald-400/10 p-4 text-sm text-emerald-200">
              <CheckCircle2 size={18} />
              Onboarded. {onboard.data?.data.waBlocked && <span className="text-amber-200">WhatsApp directory import was skipped (auth) — re-run once configured.</span>}
            </div>
          ) : (
            <>
              <p className="mb-3 text-sm text-zinc-400">Creates the customer record, imports the contacts above, and opens its Telegram topic.</p>
              <button
                disabled={!canOnboard || onboard.isPending}
                onClick={() => onboard.mutate()}
                className="inline-flex items-center gap-2 rounded-lg bg-emerald-400 px-4 py-2.5 text-sm font-semibold text-zinc-950 enabled:hover:bg-emerald-300 disabled:opacity-50"
              >
                <UserPlus size={16} />{onboard.isPending ? 'Onboarding…' : 'Onboard customer'}
              </button>
              {onboard.isError && <ErrorText message={(onboard.error as ApiError).message} />}
            </>
          )}
        </Panel>
      )}

      {/* Step 5: backfill */}
      {onboardedId && <BackfillPanel customerId={onboardedId} confirmLive={confirmLive} setConfirmLive={setConfirmLive} />}
    </section>
  );
}

function BackfillPanel({ customerId, confirmLive, setConfirmLive }: { customerId: string; confirmLive: boolean; setConfirmLive: (v: boolean) => void }): ReactElement {
  const status = useQuery({
    queryKey: ['onboarding-backfill', customerId],
    queryFn: () => api<{ data: BackfillState }>(`/onboarding/${customerId}/backfill`),
    refetchInterval: (q) => (q.state.data?.data.running ? 3000 : false),
  });
  const dryMut = useMutation({ mutationFn: () => api(`/onboarding/${customerId}/backfill/dry`, { method: 'POST' }), onSuccess: () => void status.refetch() });
  const liveMut = useMutation({ mutationFn: () => api(`/onboarding/${customerId}/backfill/live`, { method: 'POST' }), onSuccess: () => { setConfirmLive(false); void status.refetch(); } });

  const state = status.data?.data;
  const running = Boolean(state?.running);
  const dry = state?.dry ?? null;

  return (
    <Panel step={5} title="Backfill customer history (optional)">
      <p className="mb-4 text-sm leading-6 text-zinc-400">
        Seed the customer's memory from their existing history. Run the <span className="text-zinc-300">dry preview</span> first — it reads every history leg and reports what would be linked or proposed, writing nothing. When it looks right, run the <span className="text-zinc-300">live sweep</span>: it seeds memory and posts a Telegram approval card for each starred unmatched request. Tasks are created only when you tap ✅.
      </p>

      {state && !state.enabled && (
        <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-100">
          <CircleAlert size={16} className="mt-0.5 shrink-0" />{state.reason ?? 'Backfill is unavailable.'}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button
          disabled={!state?.enabled || running || dryMut.isPending}
          onClick={() => dryMut.mutate()}
          className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-4 py-2.5 text-sm font-medium text-zinc-200 enabled:hover:border-emerald-400 enabled:hover:text-emerald-300 disabled:opacity-50"
        >
          <Sparkles size={16} />{running ? 'Running…' : dry ? 'Re-run dry preview' : 'Run dry preview'}
        </button>

        {!confirmLive ? (
          <button
            disabled={!state?.enabled || running || liveMut.isPending}
            onClick={() => setConfirmLive(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-amber-300 px-4 py-2.5 text-sm font-semibold text-zinc-950 enabled:hover:bg-amber-200 disabled:opacity-50"
          >
            Run live backfill
          </button>
        ) : (
          <span className="inline-flex items-center gap-2 rounded-lg border border-amber-700/60 bg-amber-950/30 px-3 py-1.5">
            <span className="text-xs text-amber-100">This posts Telegram approval cards. Continue?</span>
            <button disabled={liveMut.isPending} onClick={() => liveMut.mutate()} className="rounded-md bg-amber-300 px-2.5 py-1 text-xs font-semibold text-zinc-950 disabled:opacity-50">{liveMut.isPending ? 'Starting…' : 'Run live'}</button>
            <button onClick={() => setConfirmLive(false)} className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs text-zinc-300">Cancel</button>
          </span>
        )}

        {running && <span className="text-xs text-zinc-500">A backfill job is running…</span>}
        {state?.status && <span className="rounded-full bg-zinc-800 px-2 py-1 text-xs text-zinc-400">status: {state.status}</span>}
      </div>

      {dryMut.isError && <ErrorText message={(dryMut.error as ApiError).message} />}
      {liveMut.isError && <ErrorText message={(liveMut.error as ApiError).message} />}

      {dry && (
        <div className="mt-5 rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-zinc-500">Dry preview {dry.skippedReason ? '(incomplete)' : ''}</p>
          {dry.skippedReason
            ? <ErrorText message={dry.skippedReason} />
            : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Threads" value={dry.threads} />
                <Stat label="Link → open" value={dry.linkedOpen} />
                <Stat label="Link → resolved" value={dry.linkedResolved} />
                <Stat label="Memories" value={dry.memories} />
                <Stat label="Proposed tasks" value={dry.proposed} />
                <Stat label="Skipped" value={dry.skipped} />
                <Stat label="Retryable" value={dry.retryable} />
              </div>
            )}
        </div>
      )}
    </Panel>
  );
}

function Stat({ label, value }: { label: string; value: number }): ReactElement {
  return <div><p className="text-2xl font-semibold text-zinc-100">{value}</p><p className="mt-1 text-xs text-zinc-500">{label}</p></div>;
}
