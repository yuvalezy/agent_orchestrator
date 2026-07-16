import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getMessaging, getToken, isSupported, onMessage } from 'firebase/messaging';
import { api } from './lib/api';
import { registerServiceWorker, setStoredSwConfig } from './swClient';
import type { FirebaseWebConfig } from './types';

const PUSH_FLAG = 'ao_push_enabled';

export function pushLocallyEnabled(): boolean {
  return localStorage.getItem(PUSH_FLAG) === '1';
}

function app(config: FirebaseWebConfig): FirebaseApp {
  return getApps()[0] ?? initializeApp(config);
}

/** Full opt-in flow: permission → token → server register. Throws on any refusal. */
export async function enablePush(
  config: FirebaseWebConfig,
  vapidKey: string,
  onForeground: () => void,
): Promise<void> {
  if (!(await isSupported())) throw new Error('This browser cannot receive push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. Telegram still delivers everything.');

  // Persist the config and (re)register the single worker WITH it, so this same
  // push-enabled worker comes back on the next cold start (main.tsx reads the store).
  const encoded = btoa(JSON.stringify(config));
  setStoredSwConfig(encoded);
  const registration = await registerServiceWorker(encoded);

  const messaging = getMessaging(app(config));
  const fcmToken = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!fcmToken) throw new Error('Could not obtain a push token from Firebase.');

  await api('/push/register', { method: 'POST', body: JSON.stringify({ fcmToken }) });
  // Foreground pushes shouldn't double as system notifications — just refresh.
  onMessage(messaging, () => onForeground());
  localStorage.setItem(PUSH_FLAG, '1');
}

export async function disablePush(): Promise<void> {
  localStorage.removeItem(PUSH_FLAG);
  setStoredSwConfig(null);
  await api('/push/register', { method: 'DELETE' }).catch(() => { /* server may already have dropped it */ });
  // Re-register the worker without a config so the FCM branch goes dormant.
  await registerServiceWorker(null).catch(() => { /* worker stays; the deleted token already stops delivery */ });
}
