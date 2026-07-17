import { type ReactElement } from 'react';
import { ConversationChat } from './ConversationChat';

/** Persistent query chat pinned to exactly one customer. */
export function CustomerAsk({ customerId }: { customerId: string }): ReactElement {
  return (
    <ConversationChat
      customerId={customerId}
      emptyLabel="Ask anything about this customer — the assistant answers from their history only."
    />
  );
}
