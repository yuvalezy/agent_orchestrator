import { type ReactElement } from 'react';
import { ConversationChat } from './ConversationChat';
import { ScreenHeader } from './ScreenHeader';

/** The internal-scope assistant chat: ask the system anything, get a grounded answer. */
export function AssistantScreen(): ReactElement {
  return (
    <div className="flex h-full flex-col">
      <ScreenHeader title="Assistant" subtitle="Ask the system" settings />
      <ConversationChat emptyLabel="Ask the system anything — grounded answers from your internal project memory." />
    </div>
  );
}
