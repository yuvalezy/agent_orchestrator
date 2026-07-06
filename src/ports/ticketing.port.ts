// Ticketing port (design.md D6). Service-desk read/write operations, implemented
// by the EzyPortalGateway. Ingestion of tickets is a channel concern (the
// ServiceDeskAdapter); status ops are a port concern. M1.7 fills in the real
// shapes (recon §2) and implements the read half (listChangedTickets/getThread);
// the write half (postReply/setStatus) is port-complete but unwired until M1.8.

/**
 * A changed ticket surfaced by the service desk (recon §2 — camelCase JSON).
 * `description` is the initial body (nullable → fall back to `subject`).
 * Identity for the whole thread (D-A): `requesterBPID` PRIMARY — the portal
 * backfills it from `requesterUserID` even on `account`-type tickets, so it is
 * authoritative whenever present (matches `agent_customers.bp_ref`) — with
 * `requesterEmail` as the FALLBACK when no BP ref is set.
 */
export interface TargetTicket {
  id: string; // uuid — the `:id` used by getThread / getTicket
  ticketNumber: string; // 'SD-00042'
  subject: string; // required
  description: string | null; // the initial body; null → use subject
  status: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  requesterType: 'bp' | 'account' | 'manual';
  requesterBPID: string | null; // PRIMARY identity — backfilled, authoritative when set (D-A)
  requesterEmail: string | null; // FALLBACK identity for the whole thread when no BP ref (D-A/B1)
  requesterName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One entry in a ticket thread (recon §2). `authorIsExternal` — true = customer,
 * false = staff/agent. Thread entries carry NO author email; the reply author is
 * the ticket requester (D-A/B1). `entryType`/`visibility` drive the skip rules (D-C).
 */
export interface TicketThreadEntry {
  id: string; // uuid — dedup key within the thread
  body: string;
  authorName: string;
  authorIsExternal: boolean; // true = customer → inbound; false = staff → outbound
  visibility: 'public' | 'internal';
  entryType: 'reply' | 'internal_note' | 'system';
  createdAt: Date;
}

export interface TicketingPort {
  /**
   * Drain the changed-ticket list for `updatedAfter` (RFC3339, INCLUSIVE `>=`)
   * across all pages (D-D). The caller (ServiceDeskAdapter) computes `updatedAfter`
   * from the persisted cursor or the bootstrap window. `nextCursor` is
   * `max(updatedAt)` over the drained set, or the passed `updatedAfter` on an empty
   * drain (never null — B9).
   */
  listChangedTickets(updatedAfter: string): Promise<{ tickets: TargetTicket[]; nextCursor: string }>;
  /** Public thread entries only (`?visibility=public`), created_at ASC (recon §2). */
  getThread(ticketRef: string): Promise<TicketThreadEntry[]>;
  postReply(ticketRef: string, body: string, visibility: 'public' | 'internal'): Promise<void>;
  /** NOTE: named `setTicketStatus` (not `setStatus`) to avoid a method-name clash
   *  with `TaskTargetPort.setStatus(task, status)` on the EzyPortalGateway, which
   *  implements both ports. Unwired until M1.8 (needs `service-desk.manage`). */
  setTicketStatus(ticketRef: string, status: 'open' | 'pending' | 'resolved' | 'closed'): Promise<void>;
}
