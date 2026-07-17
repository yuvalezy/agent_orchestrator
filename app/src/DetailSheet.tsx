import { type ReactElement, useEffect, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import type { DetailKind, DetailRow } from './types';

const titles: Record<DetailKind, string> = { inbox: 'Inbox message', outbound: 'Outbound reply', decision: 'Decision' };

/** Bottom sheet that fetches GET /app/api/items/:kind/:id and renders it as a generic
 *  key/value record — the "tap a row, see the whole thing" drill-down. */
export function DetailSheet({ target, onClose }: { target: { kind: DetailKind; id: string } | null; onClose: () => void }): ReactElement {
  const open = target !== null;
  const [row, setRow] = useState<DetailRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!target) return;
    setRow(null); setError(null); setLoading(true);
    let live = true;
    void api<{ data: DetailRow }>(`/items/${target.kind}/${target.id}`)
      .then((res) => { if (live) setRow(res.data); })
      .catch((err: ApiError) => { if (live) setError(err.message); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [target]);

  return (
    <div className={cnOpen(open)}>
      <button aria-label="Close detail" onClick={onClose} className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Detail"
        className={`safe-bottom absolute inset-x-0 bottom-0 max-h-[80dvh] overflow-y-auto rounded-t-3xl border-t border-zinc-800 bg-zinc-950 px-4 pb-4 pt-3 shadow-2xl transition-transform duration-300 ease-out ${open ? 'translate-y-0' : 'translate-y-full'}`}
      >
        <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-zinc-700" />
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">{target ? titles[target.kind] : 'Detail'}</h2>
          <button aria-label="Close" onClick={onClose} className="grid size-9 place-items-center rounded-full text-zinc-400 active:bg-zinc-800">
            <X size={20} />
          </button>
        </div>

        {loading && <div className="flex justify-center py-8"><Loader2 className="animate-spin text-zinc-600" size={20} /></div>}
        {error && <p className="py-6 text-center text-sm text-rose-300">{error}</p>}
        {row && (
          <dl className="space-y-3">
            {Object.entries(row).map(([key, value]) => (
              <div key={key}>
                <dt className="text-[0.68rem] font-medium uppercase tracking-wide text-zinc-500">{key.replace(/_/g, ' ')}</dt>
                <dd className="mt-0.5 whitespace-pre-wrap break-words rounded-lg bg-zinc-900 px-3 py-2 text-[0.85rem] text-zinc-200">
                  {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value ?? '—')}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </div>
  );
}

function cnOpen(open: boolean): string {
  return `fixed inset-0 z-40 transition-opacity ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`;
}
