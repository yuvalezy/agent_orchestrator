import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getMessaging, getToken, isSupported } from 'firebase/messaging';
import { api } from './lib/api';
import { registerServiceWorker } from './swClient';
import type { FirebaseWebConfig } from './types';

const PUSH_FLAG = 'ao_push_enabled';

export function pushLocallyEnabled(): boolean {
  return localStorage.getItem(PUSH_FLAG) === '1';
}

function app(config: FirebaseWebConfig): FirebaseApp {
  return getApps()[0] ?? initializeApp(config);
}

/**
 * Full opt-in flow: permission → token → server register. Throws on any refusal.
 *
 * The Firebase SDK lives HERE and only here: minting the token is the one thing it is
 * needed for. The worker renders pushes natively (public/sw.js), so nothing has to be
 * handed to it — and a foreground handler is deliberately absent, because an open app
 * is already kept live by the SSE feed and the worker suppresses notifications while
 * the app is on screen.
 */
export async function enablePush(config: FirebaseWebConfig, vapidKey: string): Promise<void> {
  if (!(await isSupported())) throw new Error('This browser cannot receive push notifications.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notifications were not allowed. Telegram still delivers everything.');

  const registration = await registerServiceWorker();
  const messaging = getMessaging(app(config));
  const fcmToken = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  if (!fcmToken) throw new Error('Could not obtain a push token from Firebase.');

  await api('/push/register', { method: 'POST', body: JSON.stringify({ fcmToken }) });
  localStorage.setItem(PUSH_FLAG, '1');
}

export async function disablePush(): Promise<void> {
  localStorage.removeItem(PUSH_FLAG);
  // Dropping the token server-side is what stops delivery. The worker stays registered
  // either way — it also serves the app shell, and it is inert without a token.
  await api('/push/register', { method: 'DELETE' }).catch(() => { /* server may already have dropped it */ });
}
