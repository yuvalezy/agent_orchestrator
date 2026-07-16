import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { api, type ApiError } from './lib/api';
import { Login } from './Login';
import { AppDataProvider, useAppData } from './AppData';
import { UiProvider } from './Ui';
import { TabBar } from './TabBar';
import { AttentionScreen } from './AttentionScreen';
import { CustomersScreen } from './CustomersScreen';
import { CustomerScreen } from './CustomerScreen';
import { ActivityScreen } from './ActivityScreen';
import { AssistantScreen } from './AssistantScreen';
import { SettingsSheet, type InstallPrompt } from './SettingsSheet';
import type { AppConfig } from './types';

export function App(): ReactElement {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [label, setLabel] = useState(() => localStorage.getItem('ao_device_label') ?? '');

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await api<AppConfig>('/config'));
      setAuthed(true);
    } catch (err) {
      if ((err as ApiError).status === 401) setAuthed(false);
      else setAuthed((prev) => prev ?? false);
    }
  }, []);

  useEffect(() => { void loadConfig(); }, [loadConfig]);
  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener('app:unauthorized', onUnauthorized);
    return () => window.removeEventListener('app:unauthorized', onUnauthorized);
  }, []);

  if (authed === null) {
    return <div className="grid min-h-[100dvh] place-items-center"><Loader2 className="animate-spin text-zinc-600" size={24} /></div>;
  }
  if (!authed) {
    return <Login onSuccess={(next) => { setLabel(next); setAuthed(true); void loadConfig(); }} />;
  }
  return (
    <AppDataProvider config={config} deviceLabel={label}>
      <AppShell onLoggedOut={() => { setConfig(null); setAuthed(false); }} />
    </AppDataProvider>
  );
}

function AppShell({ onLoggedOut }: { onLoggedOut: () => void }): ReactElement {
  const navigate = useNavigate();
  const { config, deviceLabel, feed } = useAppData();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const onPrompt = (event: Event) => { event.preventDefault(); setInstallPrompt(event as InstallPrompt); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  // Deep links: the SW posts {type:'navigate', route:'/app/...'} on a notification tap.
  // Strip the '/app' basename so react-router routes to it in-app.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; route?: string } | null;
      if (data?.type === 'navigate' && typeof data.route === 'string') {
        navigate(data.route.replace(/^\/app/, '') || '/attention');
      }
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  const logout = async () => {
    await api('/logout', { method: 'POST' }).catch(() => { /* sign out locally regardless */ });
    onLoggedOut();
  };

  return (
    <UiProvider openSettings={() => setSettingsOpen(true)}>
      <div className="flex h-[100dvh] flex-col">
        <main className="min-h-0 flex-1 overflow-hidden">
          <Routes>
            <Route path="/" element={<Navigate to="/attention" replace />} />
            <Route path="/attention" element={<AttentionScreen />} />
            <Route path="/customers" element={<CustomersScreen />} />
            <Route path="/customer/:id" element={<CustomerScreen />} />
            <Route path="/activity" element={<ActivityScreen />} />
            <Route path="/assistant" element={<AssistantScreen />} />
            <Route path="*" element={<Navigate to="/attention" replace />} />
          </Routes>
        </main>
        <TabBar />
      </div>

      <SettingsSheet
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        config={config}
        deviceLabel={deviceLabel}
        installPrompt={installPrompt}
        onForegroundRefresh={feed.refetch}
        onLogout={() => void logout()}
      />
    </UiProvider>
  );
}
