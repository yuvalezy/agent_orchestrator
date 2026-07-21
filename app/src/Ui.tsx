import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

// Lets any screen open the settings/reminders sheets without threading callbacks through props.
const OpenSettingsContext = createContext<() => void>(() => {});
const OpenRemindersContext = createContext<() => void>(() => {});

export function UiProvider({ openSettings, openReminders, children }: { openSettings: () => void; openReminders: () => void; children: ReactNode }): ReactElement {
  return (
    <OpenSettingsContext.Provider value={openSettings}>
      <OpenRemindersContext.Provider value={openReminders}>{children}</OpenRemindersContext.Provider>
    </OpenSettingsContext.Provider>
  );
}

export function useOpenSettings(): () => void {
  return useContext(OpenSettingsContext);
}

export function useOpenReminders(): () => void {
  return useContext(OpenRemindersContext);
}
