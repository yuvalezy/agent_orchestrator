import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { FirebaseConfig } from '../../config/firebase';
import { logger } from '../../logger';

// Firebase Cloud Messaging sender for the AO Founder PWA (M6).
//
// PRIVACY: the push payload is GENERIC — it carries a messageId + kind/severity + a
// deep link into the app, NEVER a title, body, or customer name. This mirrors the
// deliberate stance of the web-push channel (web-push-notifier.ts): customer content
// must not transit a third-party push relay. The SW opens the app, which then fetches
// the real content over the authed /app/api channel.
//
// firebase-admin is imported DYNAMICALLY (a runtime-only dependency) so the type-check
// and the test suite never require the package to be installed — only a real boot with
// FCM configured pulls it in.

export interface FcmPayload {
  messageId: string;
  kind: 'notification' | 'question';
  severity: string | null;
  /** The '<ref>' shared by a message's buttons; used as the collapse key. */
  ref: string | null;
  /** Deep-link the SW navigates to on click: '/app/customer/<id>' or '/app/attention'. */
  route: string;
}

export interface FcmSendResult {
  token: string;
  success: boolean;
  /** The registration token is dead (messaging/registration-token-not-registered). */
  unregistered: boolean;
}

/** Sends a generic push to N registration tokens; per-token success is reported back. */
export type FcmSender = (tokens: string[], payload: FcmPayload) => Promise<FcmSendResult[]>;

const UNREGISTERED_CODE = 'messaging/registration-token-not-registered';

/** Resolve a '/app/...' route against the configured public URL; null unless it yields https. */
function absoluteLink(route: string, publicUrl?: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(route, publicUrl);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function notificationTitle(severity: string | null): string {
  return severity === 'warning' ? 'Founder attention needed' : 'AO Founder';
}

/**
 * The generic, DATA-ONLY multicast message. Two reasons it carries no `notification`
 * block:
 *   1. The PWA's service worker (sw.js — app shell + FCM in one) renders the
 *      notification itself from `data`;
 *      a `notification` payload would double up (the browser would auto-show one too).
 *   2. Privacy — title/body stay generic ("AO Founder" / "Tap to open"), never a
 *      customer name or message body, so no customer content transits the FCM relay.
 * The SW reads data.title/data.body/data.tag (tag = the collapse key = the ref).
 */
export function buildMulticastMessage(tokens: string[], payload: FcmPayload, publicUrl?: string | null): Record<string, unknown> {
  const collapse = payload.ref || payload.messageId;
  // fcm_options.link must be an ABSOLUTE https URL — FCM ignores (or rejects) a bare path, so
  // for most of this app's life the field carried '/app/attention' and did nothing. It is
  // resolved against FOUNDER_APP_PUBLIC_URL and simply omitted when that is not configured.
  const link = absoluteLink(payload.route, publicUrl);
  return {
    tokens,
    // FCM data values must all be strings.
    data: {
      title: notificationTitle(payload.severity),
      body: 'Tap to open AO Founder.',
      tag: collapse,
      messageId: payload.messageId,
      kind: payload.kind,
      severity: payload.severity ?? '',
      // Deep link into the v2 cockpit: the customer screen for customer-scoped
      // notifications, the attention queue otherwise. The SW reads data.route on click.
      route: payload.route,
    },
    android: { collapseKey: collapse, priority: 'high' },
    webpush: { headers: { Topic: collapse }, ...(link ? { fcmOptions: { link } } : {}) },
  };
}

// A minimal structural view of the slice of firebase-admin we touch, so the dynamic
// import can be typed without the package's own types being present at compile time.
interface AdminMessagingResponse {
  responses: Array<{ success: boolean; error?: { code?: string } }>;
}
interface AdminModule {
  apps: unknown[];
  initializeApp(options: unknown, name?: string): unknown;
  app(name?: string): unknown;
  credential: { cert(serviceAccount: unknown): unknown };
  messaging(app?: unknown): {
    sendEachForMulticast(message: unknown): Promise<AdminMessagingResponse>;
  };
}

const APP_NAME = 'ao-founder-app';

/**
 * Build the real FCM sender by dynamically importing firebase-admin and initializing a
 * named app from the service-account JSON. Returns null (and logs a safe warn) when the
 * package is absent or the credential file can't be read — the caller then runs with FCM
 * disabled and the rest of the app router unaffected.
 */
export async function buildFcmSender(config: FirebaseConfig, publicUrl?: string | null): Promise<FcmSender | null> {
  let admin: AdminModule;
  try {
    // A string-typed specifier keeps tsc from resolving (and thus requiring) the module.
    const specifier = 'firebase-admin';
    const mod = (await import(specifier)) as unknown as { default?: AdminModule } & AdminModule;
    admin = (mod.default ?? mod) as AdminModule;
  } catch {
    logger.warn('FCM disabled: firebase-admin is not installed');
    return null;
  }

  let serviceAccount: unknown;
  try {
    const file = path.isAbsolute(config.serviceAccountFile)
      ? config.serviceAccountFile
      : path.join(process.cwd(), config.serviceAccountFile);
    serviceAccount = JSON.parse(await readFile(file, 'utf8'));
  } catch {
    logger.warn('FCM disabled: service-account file missing or unreadable');
    return null;
  }

  let messaging: ReturnType<AdminModule['messaging']>;
  try {
    const existing = admin.apps.find(
      (a) => (a as { name?: string } | null)?.name === APP_NAME,
    );
    const fbApp = existing ?? admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }, APP_NAME);
    messaging = admin.messaging(fbApp);
  } catch {
    logger.warn('FCM disabled: firebase-admin failed to initialize (invalid service account)');
    return null;
  }

  return async (tokens, payload) => {
    if (tokens.length === 0) return [];
    const res = await messaging.sendEachForMulticast(buildMulticastMessage(tokens, payload, publicUrl));
    return tokens.map((token, i) => {
      const r = res.responses[i];
      return {
        token,
        success: Boolean(r?.success),
        unregistered: r?.error?.code === UNREGISTERED_CODE,
      };
    });
  };
}
