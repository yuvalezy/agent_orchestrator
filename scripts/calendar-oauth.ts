import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { tryResolveCredential } from '../src/config/credentials';

// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar OAuth helper (M5(d) prerequisite) — mint a READ-ONLY refresh
// token for ONE Google account with the calendar.readonly scope, via the loopback
// flow. Run it ONCE PER ACCOUNT (work, then personal — pick the right Google
// account in the browser each time). No external deps: raw http + fetch.
//
// The Google client (client_id/client_secret) is REUSED from the existing Gmail
// OAuth setup by default — same GCP project, no new client to create. You still
// must, one time in that project:
//   1. APIs & Services → Library → enable "Google Calendar API".
//   2. OAuth consent screen → add the scope .../auth/calendar.readonly (and keep
//      your Gmail account(s) as Test users).
// (The loopback redirect is already allowed for the Desktop client Gmail uses.)
//
// ── Run ──────────────────────────────────────────────────────────────────────
//   npm run calendar:oauth                    # reuse the Gmail client automatically
//   npm run calendar:oauth -- --from-gmail work | personal   # pick which Gmail cred to reuse
//   npm run calendar:oauth -- --client ~/Downloads/client_secret_XXX.json
//   npm run calendar:oauth -- --client-id <id> --client-secret <secret>
//   optional: --port 4779  (must be free; the loopback redirect uses it)
//
// It prints: the refresh token, the account email (the primary calendar id), and
// the ready-to-store credential blob + a curl to POST it to /admin/credentials as
// GOOGLE_CALENDAR_WORK_OAUTH / GOOGLE_CALENDAR_PERSONAL_OAUTH.
// ─────────────────────────────────────────────────────────────────────────────

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];
const CAL = 'https://www.googleapis.com/calendar/v3';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  if (eq !== -1) return hit.slice(eq + 1);
  const i = process.argv.indexOf(hit);
  return process.argv[i + 1];
}

/** Pull the client_id/client_secret out of a stored Gmail OAuth blob (same GCP project). */
function clientFromGmailCred(which: string): { clientId: string; clientSecret: string } | undefined {
  const refs = which === 'work' ? ['GMAIL_WORK_OAUTH'] : which === 'personal' ? ['GMAIL_PERSONAL_OAUTH'] : ['GMAIL_WORK_OAUTH', 'GMAIL_PERSONAL_OAUTH'];
  for (const ref of refs) {
    const raw = tryResolveCredential(ref);
    if (!raw) continue;
    try {
      const c = JSON.parse(raw) as { client_id?: string; client_secret?: string };
      if (c.client_id && c.client_secret) return { clientId: c.client_id, clientSecret: c.client_secret };
    } catch {
      /* not JSON — skip */
    }
  }
  return undefined;
}

function resolveClient(): { clientId: string; clientSecret: string } {
  const path = arg('client');
  if (path) {
    const j = JSON.parse(fs.readFileSync(path, 'utf8')) as Record<string, { client_id: string; client_secret: string }>;
    const c = j.installed ?? j.web;
    if (!c?.client_id) throw new Error(`${path} is not a Google OAuth client JSON (expected "installed" or "web")`);
    return { clientId: c.client_id, clientSecret: c.client_secret };
  }
  const clientId = arg('client-id') ?? process.env.GOOGLE_CLIENT_ID;
  const clientSecret = arg('client-secret') ?? process.env.GOOGLE_CLIENT_SECRET;
  if (clientId && clientSecret) return { clientId, clientSecret };

  // Default: reuse the client from the existing Gmail OAuth credential (same GCP project).
  const reused = clientFromGmailCred((arg('from-gmail') ?? 'any').toLowerCase());
  if (reused) {
    process.stdout.write('▶ Reusing the Google OAuth client from your Gmail credential (same GCP project).\n');
    return reused;
  }
  throw new Error('provide --client <json>, or --client-id/--client-secret, or set GMAIL_WORK_OAUTH/GMAIL_PERSONAL_OAUTH to reuse the Gmail client');
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {
    /* headless / no browser — the printed URL is the fallback */
  }
}

async function main(): Promise<void> {
  const { clientId, clientSecret } = resolveClient();
  const port = Number(arg('port') ?? 4779);
  const redirectUri = `http://localhost:${port}`;
  const state = crypto.randomBytes(16).toString('hex');

  const authUrl =
    'https://accounts.google.com/o/oauth2/v2/auth?' +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      access_type: 'offline', // → refresh_token
      prompt: 'consent', // force a refresh_token even on re-auth
      state,
    }).toString();

  // Wait for the loopback redirect carrying ?code=.
  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', redirectUri);
      if (u.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const gotCode = u.searchParams.get('code');
      const gotState = u.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      if (err || !gotCode || gotState !== state) {
        res.end(`<h2>Authorization failed</h2><p>${err ?? (gotState !== state ? 'state mismatch' : 'no code')}. You can close this tab.</p>`);
        server.close();
        reject(new Error(err ?? (gotState !== state ? 'OAuth state mismatch (possible CSRF)' : 'no authorization code')));
        return;
      }
      res.end('<h2>✅ Authorized</h2><p>Calendar refresh token minted — return to the terminal. You can close this tab.</p>');
      server.close();
      resolve(gotCode);
    });
    server.on('error', reject);
    server.listen(port, () => {
      process.stdout.write(`\n▶ Open this URL and authorize the Google account whose calendar you want to connect:\n\n${authUrl}\n\n(attempting to open your browser…)\n`);
      openBrowser(authUrl);
    });
  });

  // Exchange the code for tokens.
  const tokRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }),
  });
  const tok = (await tokRes.json()) as { refresh_token?: string; access_token?: string; error?: string; error_description?: string };
  if (!tokRes.ok || !tok.refresh_token) {
    throw new Error(`token exchange failed: ${tok.error ?? tokRes.status} ${tok.error_description ?? ''}${tok.refresh_token ? '' : ' (no refresh_token — revoke prior grant at myaccount.google.com/permissions and retry, or ensure prompt=consent)'}`);
  }

  // Which account did they authorize? The PRIMARY calendar id IS the account email —
  // no extra scope needed (calendar.readonly can read it).
  let email = '(unknown — name the credential manually)';
  try {
    const p = await fetch(`${CAL}/calendars/primary`, { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (p.ok) email = ((await p.json()) as { id?: string }).id ?? email;
  } catch {
    /* primary-calendar lookup is best-effort */
  }

  const blob = JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: tok.refresh_token });
  const isPersonal = /@gmail\.com$/i.test(email);
  const credName = isPersonal ? 'GOOGLE_CALENDAR_PERSONAL_OAUTH' : 'GOOGLE_CALENDAR_WORK_OAUTH';

  process.stdout.write(
    [
      '',
      '════════════════════════════════════════════════════════════════',
      `✅ Connected calendar: ${email}`,
      '',
      'Refresh token:',
      `  ${tok.refresh_token}`,
      '',
      `Store the OAuth credential as ${credName} (the calendar adapter resolves this name):`,
      `     curl -s -X POST http://localhost:3100/admin/credentials \\`,
      `       -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \\`,
      `       -d '{"name":"${credName}","value":${JSON.stringify(blob)}}'`,
      '',
      '   (or put it in .env as that name = the JSON blob above)',
      '',
      'Then set CALENDAR_ENABLED=true and restart. Each account reads its own primary',
      'calendar by default (override with GOOGLE_CALENDAR_WORK_ID / _PERSONAL_ID).',
      '════════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
