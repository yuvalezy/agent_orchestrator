import { createContext, useContext, type ReactElement, type ReactNode } from 'react';

// Lets any screen open the settings sheet without threading a callback through props.
const OpenSettingsContext = createContext<() => void>(() => {});

export function UiProvider({ openSettings, children }: { openSettings: () => void; children: ReactNode }): ReactElement {
  return <OpenSettingsContext.Provider value={openSettings}>{children}</OpenSettingsContext.Provider>;
}

export function useOpenSettings(): () => void {
  return useContext(OpenSettingsContext);
}
