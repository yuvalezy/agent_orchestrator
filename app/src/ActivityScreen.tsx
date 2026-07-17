import { type ReactElement } from 'react';
import { useFeedContext } from './AppData';
import { ChatFeed } from './ChatFeed';
import { ScreenHeader } from './ScreenHeader';
import { Screen } from './Layout';

/** The v1 global feed, demoted to a read-only audit stream — every notification,
 *  question, and chat line the system produced, newest at the bottom. */
export function ActivityScreen(): ReactElement {
  const feed = useFeedContext();
  return (
    <Screen>
      <ScreenHeader title="Activity" subtitle="Everything the system did" settings />
      <ChatFeed feed={feed} />
    </Screen>
  );
}
