import { type ReactElement } from 'react';
import { useFeedContext } from './AppData';
import { ChatFeed } from './ChatFeed';
import { Composer } from './Composer';
import { ScreenHeader } from './ScreenHeader';
import type { Message } from './types';

// Internal-scope turns only: chat rows with no customerRef. Customer-scoped Ask turns
// (chat rows tagged with a customerRef) belong to the customer screen, and system
// notifications/questions belong to Activity. Module-level so ChatFeed's memo stays stable.
const internalChatOnly = (message: Message): boolean => message.kind === 'chat' && !message.customerRef;

/** The internal-scope assistant chat: ask the system anything, get a grounded answer. */
export function AssistantScreen(): ReactElement {
  const feed = useFeedContext();
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Assistant" subtitle="Ask the system" settings />
      <ChatFeed feed={feed} filter={internalChatOnly} emptyLabel="Ask the system anything — grounded answers from your internal project memory." />
      <Composer onSend={(text) => void feed.send(text).catch(() => { /* row stays, marked failed */ })} sending={feed.sending} />
    </div>
  );
}
