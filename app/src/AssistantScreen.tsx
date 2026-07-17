import { type ReactElement } from 'react';
import { ConversationChat } from './ConversationChat';
import { ScreenHeader } from './ScreenHeader';
import { Screen } from './Layout';

/** The internal-scope assistant chat: ask the system anything, get a grounded answer. */
export function AssistantScreen(): ReactElement {
  return (
    <Screen>
      <ScreenHeader title="Assistant" subtitle="Ask the system" settings />
      <ConversationChat emptyLabel="Ask the system anything — grounded answers from your internal project memory." />
    </Screen>
  );
}
