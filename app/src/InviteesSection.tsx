import { type ReactElement, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { cn } from './lib/utils';
import { ContactPicker } from './ContactPicker';

export interface InviteesSectionProps {
  /** Current invitee list (controlled). */
  emails: string[];
  /** Called with the FULL new list on every add/remove. */
  onChange: (next: string[]) => void;
  /** When set, picker defaults to this customer's contacts. */
  customerId?: string;
  customerName?: string;
  /** When set, that chip is non-removable and tagged "host". Lowercased for comparison. */
  organizerEmail?: string | null;
}

const FIELD_LABEL = 'mb-2 text-[0.68rem] font-medium uppercase tracking-wide text-zinc-500';

/**
 * The inline invitee editor for the calendar event/block sheets: a wrap-row of removable chips
 * (the organizer chip is tagged "host" and has no X), a muted placeholder when empty, and an
 * "Add from contacts" affordance that opens `<ContactPicker>` in a bottom sheet.
 *
 * Controlled — every add/remove calls `onChange` with the full new list, so the parent keeps the
 * source of truth and decides whether to persist it. When `organizerEmail` is set, that chip is
 * rendered non-removable (the host can't be uninvited from their own event).
 */
export function InviteesSection({
  emails, onChange, customerId, customerName, organizerEmail,
}: InviteesSectionProps): ReactElement {
  const [pickerOpen, setPickerOpen] = useState(false);
  const host = organizerEmail?.toLowerCase() ?? null;

  const remove = (email: string): void => {
    onChange(emails.filter((e) => e !== email));
  };

  const toggle = (email: string): void => {
    const lower = email.toLowerCase();
    const exists = emails.some((e) => e.toLowerCase() === lower);
    if (exists) onChange(emails.filter((e) => e.toLowerCase() !== lower));
    else onChange([...emails, email]);
  };

  return (
    <div className="mb-5">
      <p className={FIELD_LABEL}>Invitees</p>

      {emails.length === 0 ? (
        <p className="mb-2 text-xs text-zinc-500">No invitees — tap Add below.</p>
      ) : (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {emails.map((email) => {
            const isHost = email.toLowerCase() === host;
            return (
              <span
                key={email}
                className="inline-flex min-h-9 max-w-full items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 py-1 pl-3 pr-1.5 text-xs text-zinc-100"
              >
                <span className="truncate">{email}</span>
                {isHost ? (
                  <span className="shrink-0 rounded-full bg-ember-400/20 px-1.5 py-0.5 text-[0.6rem] font-medium uppercase tracking-wide text-ember-300">Host</span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Remove ${email}`}
                    onClick={() => remove(email)}
                    className="grid size-6 shrink-0 place-items-center rounded-full text-zinc-400 active:bg-zinc-700"
                  >
                    <X size={13} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}

      <button
        type="button"
        onClick={() => setPickerOpen(true)}
        className={cn(
          'inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-full bg-zinc-800 px-4 text-sm font-medium text-zinc-200 transition active:scale-[0.98]',
        )}
      >
        <Plus size={15} /> Add from contacts
      </button>

      {pickerOpen && (
        <ContactPicker
          selected={new Set(emails.map((e) => e.toLowerCase()))}
          onToggle={toggle}
          onClose={() => setPickerOpen(false)}
          scopedCustomerId={customerId}
          scopedCustomerName={customerName}
        />
      )}
    </div>
  );
}
