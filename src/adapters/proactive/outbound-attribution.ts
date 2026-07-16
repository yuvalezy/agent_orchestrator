// The outbound-attribution contact join, shared by the commitment + meeting-prep worker reads
// (ADAPTER — a SQL fragment, imported by the concrete worker queries next to it).
//
// An outbound agent_inbox row carries NO customer_id (only triaged INBOUND rows get one), so the
// customer is resolved from the row's channel_thread_id against agent_customer_contacts on the SAME
// channel type — the WhatsApp contact number IS the thread key. Email threads key on an opaque
// threadId (not an address), so email outbound is NOT attributed by this join. Every consumer of the
// fragment already aliases agent_inbox as `i` and channel_instances as `ci`, and reads the resolved
// contact through the `ct` alias.
export const OUTBOUND_CONTACT_ATTRIBUTION_JOIN = `LEFT JOIN agent_customer_contacts ct
         ON ct.channel_type = ci.channel_type AND ct.address = i.channel_thread_id`;
