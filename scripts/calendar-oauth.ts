import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { buildGoogleAuthUrl, clientFromGmailCred, exchangeGoogleCode } from '../src/adapters/connectors/google-oauth';

// ─────────────────────────────────────────────────────────────────────────────
// Google Calendar OAuth helper (M5(d) prerequisite) — mint a refresh token for ONE
// Google account with the calendar.readonly + calendar.events scopes, via the
// loopback flow. Run it ONCE PER ACCOUNT (work, then personal — pick the right
// Google account in the browser each time). No external deps: raw http + fetch.
//
// ⚠︎ RE-CONSENT: calendar.events (needed to CREATE task-deadline events) was added
// after the first tokens were minted. A token minted with calendar.readonly alone
// keeps working for reads and 403s on every write — re-run this for each account
// before turning CALENDAR_WRITE_ENABLED on.
//
// The Google client (client_id/client_secret) is REUSED from the existing Gmail
// OAuth setup by default — same GCP project, no new client to create. You still
// must, one time in that project:
//   1. APIs & Services → Library → enable "Google Calendar API".
//   2. OAuth consent screen → add the scopes .../auth/calendar.readonly and
//      .../auth/calendar.events (and keep your Gmail account(s) as Test users).
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

// Read + write. Mirrors google-account-scopes.ts (the console flow) — one story for the grants.
const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'];
const CAL = 'https://www.googleapis.com/calendar/v3';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  const eq = hit.indexOf('=');
  if (eq !== -1) return hit.slice(eq + 1);
  const i = process.argv.indexOf(hit);
  return process.argv[i + 1];
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
  const which = (arg('from-gmail') ?? 'any').toLowerCase();
  const reused = clientFromGmailCred(which === 'work' || which === 'personal' ? which : 'any');
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

  const authUrl = buildGoogleAuthUrl({ clientId, redirectUri, scopes: SCOPES, state });

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
  const tok = await exchangeGoogleCode({ client: { clientId, clientSecret }, code, redirectUri });
  if (tok.error || !tok.refresh_token) {
    throw new Error(`token exchange failed: ${tok.error ?? 'unknown'} ${tok.error_description ?? ''}${tok.refresh_token ? '' : ' (no refresh_token — revoke prior grant at myaccount.google.com/permissions and retry, or ensure prompt=consent)'}`);
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
      'calendar by default (override per row via calendar_accounts.calendar_id).',
      '════════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
