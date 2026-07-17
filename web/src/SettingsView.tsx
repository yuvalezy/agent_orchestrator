import { type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, RotateCw } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { PushNotificationsPanel } from './PushNotificationsPanel';
import { Select } from './lib/select';

// Settings surface (Contract B3 + pass-2 tuning knobs): render the DB-authoritative config
// grouped by category. Booleans are toggles; enums are selects; numbers/strings are inputs that
// save on blur/Enter. Restart-apply settings carry a "needs restart" badge + a persistent banner;
// live settings (LLM effort, backfill knobs) apply without a restart.

type ApplyMode = 'live' | 'restart';
type SettingType = 'boolean' | 'number' | 'string' | 'enum';
type SettingValue = boolean | number | string;
interface SettingRow {
  key: string; label: string; description: string; type: SettingType;
  applyMode: ApplyMode; value: SettingValue; default: SettingValue; dependsOn?: string | null;
  options?: string[] | null; min?: number | null; max?: number | null; integer?: boolean | null;
}
interface Category { category: string; settings: SettingRow[] }
interface SettingsPayload { data: { categories: Category[] } }
interface PutResult { data: { key: string; value: SettingValue; applyMode: ApplyMode; needsRestart: boolean } }

function Loading(): ReactElement { return <div className="mt-8 rounded-xl border border-zinc-800 p-8 text-sm text-zinc-400">Loading settings…</div>; }
function ErrorState({ message }: { message: string }): ReactElement { return <div className="mt-8 flex items-center gap-3 rounded-xl border border-red-900/60 bg-red-950/30 p-5 text-sm text-red-200"><CircleAlert size={18} />{message}</div>; }
function Panel({ title, children }: { title: string; children: ReactNode }): ReactElement { return <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5"><h2 className="mb-4 text-sm font-semibold">{title}</h2>{children}</section>; }

function Toggle({ checked, disabled, pending, onChange }: { checked: boolean; disabled: boolean; pending: boolean; onChange: () => void }): ReactElement {
  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled || pending}
      onClick={onChange}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:opacity-50 ${checked ? 'bg-emerald-400' : 'bg-zinc-700'}`}
    >
      <span className={`inline-block size-4 transform rounded-full bg-zinc-950 transition ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

const inputCls = 'rounded-lg border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 outline-none focus:border-emerald-400/60 disabled:opacity-50';

/** Enum select — value props are always concrete strings (never empty). Applies on change. */
function EnumControl({ s, disabled, pending, onSave }: { s: SettingRow; disabled: boolean; pending: boolean; onSave: (v: string) => void }): ReactElement {
  return (
    <Select
      className="bg-zinc-950 py-1.5"
      minWidthClassName="min-w-32"
      disabled={disabled || pending}
      value={String(s.value)}
      aria-label={s.key}
      onChange={(v) => v !== String(s.value) && onSave(v)}
      options={(s.options ?? []).map((o) => ({ value: o, label: o }))}
    />
  );
}

/** Number/string input — local draft, saves on blur or Enter when it differs from the stored value. */
function TextControl({ s, disabled, pending, onSave }: { s: SettingRow; disabled: boolean; pending: boolean; onSave: (v: SettingValue) => void }): ReactElement {
  const [draft, setDraft] = useState<string>(String(s.value));
  useEffect(() => { setDraft(String(s.value)); }, [s.value]);
  const dirty = draft !== String(s.value);

  const commit = (): void => {
    if (!dirty) return;
    if (s.type === 'number') {
      const n = Number(draft);
      if (!Number.isFinite(n)) { setDraft(String(s.value)); return; } // reject → revert; server also validates
      onSave(n);
    } else {
      onSave(draft);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {dirty && <span className="text-[11px] text-amber-300/80">unsaved</span>}
      <input
        type={s.type === 'number' ? 'number' : 'text'}
        className={`${inputCls} w-40`}
        disabled={disabled || pending}
        value={draft}
        min={s.type === 'number' && s.min != null ? s.min : undefined}
        max={s.type === 'number' && s.max != null ? s.max : undefined}
        step={s.type === 'number' ? (s.integer ? 1 : 'any') : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur(); } if (e.key === 'Escape') { setDraft(String(s.value)); } }}
      />
    </div>
  );
}

function SettingControl({ s, disabled, pending, onSave }: { s: SettingRow; disabled: boolean; pending: boolean; onSave: (v: SettingValue) => void }): ReactElement {
  if (s.type === 'boolean') return <Toggle checked={s.value === true} disabled={disabled} pending={pending} onChange={() => onSave(!(s.value === true))} />;
  if (s.type === 'enum') return <EnumControl s={s} disabled={disabled} pending={pending} onSave={onSave} />;
  return <TextControl s={s} disabled={disabled} pending={pending} onSave={onSave} />;
}

export function SettingsView(): ReactElement {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['settings'], queryFn: () => api<SettingsPayload>('/settings') });
  const [active, setActive] = useState<string | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: ({ key, value }: { key: string; value: SettingValue }) => api<PutResult>(`/settings/${key}`, { method: 'PUT', body: JSON.stringify({ value }) }),
    onMutate: ({ key }) => { setPendingKey(key); setError(null); },
    onSuccess: (res) => { if (res.data.needsRestart) setRestartRequired(true); return client.invalidateQueries({ queryKey: ['settings'] }); },
    onError: (err: ApiError) => setError(err.message),
    onSettled: () => setPendingKey(null),
  });

  if (query.isLoading) return <Loading />;
  if (query.isError) return <ErrorState message={(query.error as Error).message} />;
  const categories = query.data?.data.categories ?? [];
  if (categories.length === 0) return <Panel title="Settings"><p className="text-sm text-zinc-500">No configurable settings are registered.</p></Panel>;

  const activeCategory = categories.find((c) => c.category === active) ?? categories[0];
  // Effective value + label of every setting, so a child can tell whether its dependsOn parent (which
  // may live in another category) is currently on and name it in the hint.
  const valueOf = new Map<string, SettingValue>();
  const labelOf = new Map<string, string>();
  categories.forEach((c) => c.settings.forEach((s) => { valueOf.set(s.key, s.value); labelOf.set(s.key, s.label); }));

  return (
    <section>
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-emerald-300">Configuration</p>
        <h1 className="mt-2 text-3xl font-semibold tracking-tight">Settings</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">Configuration resolves from the database. Values marked <span className="text-amber-200">needs restart</span> apply at the next boot; the rest apply live.</p>
      </div>

      {restartRequired && (
        <div className="mt-6 flex items-start gap-3 rounded-xl border border-amber-700/60 bg-amber-950/30 p-4 text-sm text-amber-100">
          <RotateCw size={18} className="mt-0.5 shrink-0" />
          <div><p className="font-medium">Saved — restart required to apply</p><p className="mt-1 text-amber-100/80">One or more saved changes take effect at boot. Run <code className="rounded bg-zinc-950 px-1.5 py-0.5 text-xs">./debug.sh</code> to restart the orchestrator.</p></div>
        </div>
      )}
      {error && <ErrorState message={error} />}

      <div className="mt-6 grid gap-5 md:grid-cols-[220px_1fr]">
        <nav className="flex gap-2 overflow-x-auto md:flex-col md:overflow-visible">
          {categories.map((c) => (
            <button
              key={c.category}
              onClick={() => setActive(c.category)}
              className={`shrink-0 rounded-lg px-3 py-2 text-left text-sm transition ${activeCategory.category === c.category ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100'}`}
            >
              {c.category}
            </button>
          ))}
        </nav>

        <Panel title={activeCategory.category}>
          <div className="divide-y divide-zinc-800">
            {activeCategory.settings.map((s) => {
              const parentOff = s.dependsOn ? valueOf.get(s.dependsOn) === false : false;
              const parentLabel = s.dependsOn ? labelOf.get(s.dependsOn) : undefined;
              return (
                <div key={s.key} className="flex items-start justify-between gap-4 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className={`text-sm font-medium ${parentOff ? 'text-zinc-500' : 'text-zinc-100'}`}>{s.label}</p>
                      {s.applyMode === 'restart' && <span className="rounded-full bg-amber-400/15 px-2 py-0.5 text-xs font-medium text-amber-200">needs restart</span>}
                    </div>
                    <p className="mt-1 text-xs leading-5 text-zinc-500">{s.description}</p>
                    <p className="mt-1 font-mono text-[11px] text-zinc-600">{s.key}</p>
                    {parentOff && <p className="mt-1 text-xs text-amber-300/80">Disabled — enable {parentLabel ?? s.dependsOn} first.</p>}
                  </div>
                  <div className="shrink-0 pt-0.5">
                    <SettingControl
                      s={s}
                      disabled={parentOff}
                      pending={pendingKey === s.key}
                      onSave={(value) => mutation.mutate({ key: s.key, value })}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      </div>
      <PushNotificationsPanel />
    </section>
  );
}
