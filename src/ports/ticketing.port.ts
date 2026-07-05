// Ticketing port (design.md D6). Service-desk operations, implemented by the
// EzyPortalGateway. Ingestion of tickets is a channel concern; status ops are a
// port concern.

/**
 * A changed ticket surfaced by the service desk. Placeholder (blueprint decision
 * #4) — design.md references `TargetTicket` without defining it; refine when the
 * ServiceDeskAdapter / TicketingPort adapter lands (M1.3/change 04).
 */
export interface TargetTicket {
  ref: string;
  subject: string;
  status: 'open' | 'pending' | 'resolved' | 'closed';
  requesterRef?: string;
  updatedAt: Date;
}

export interface TicketingPort {
  listChangedTickets(cursor: string | null): Promise<{ tickets: TargetTicket[]; nextCursor: string }>;
  getThread(ticketRef: string): Promise<
    Array<{
      ref: string;
      body: string;
      authorName: string;
      isExternal: boolean;
      visibility: 'public' | 'internal';
      at: Date;
    }>
  >;
  postReply(ticketRef: string, body: string, visibility: 'public' | 'internal'): Promise<void>;
  setStatus(ticketRef: string, status: 'open' | 'pending' | 'resolved' | 'closed'): Promise<void>;
}
