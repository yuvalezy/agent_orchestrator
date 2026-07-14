import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { buildGoogleAuthUrl, exchangeGoogleCode } from '../src/adapters/connectors/google-oauth';

// ─────────────────────────────────────────────────────────────────────────────
// Gmail OAuth helper (M1.6 prerequisite) — mint a REFRESH TOKEN for one Gmail
// account with the gmail.readonly + gmail.send scopes, via the loopback flow.
// Run it ONCE PER ACCOUNT (personal, then work — pick the right Google account
// in the browser each time). No external deps: raw http + fetch.
//
// ── One-time Google Cloud setup ──────────────────────────────────────────────
//   1. console.cloud.google.com → create/select a project.
//   2. APIs & Services → Library → enable "Gmail API".
//   3. APIs & Services → OAuth consent screen → External; add YOUR Gmail(s) as
//      Test users; add scopes .../auth/gmail.readonly and .../auth/gmail.send.
//   4. Credentials → Create credentials → OAuth client ID → Application type
//      "Desktop app" → download the client JSON (loopback redirect is allowed
//      for Desktop clients, so no redirect URI needs registering).
//
// ── Run ──────────────────────────────────────────────────────────────────────
//   npm run gmail:oauth -- --client ~/Downloads/client_secret_XXX.json
//   npm run gmail:oauth -- --client-id <id> --client-secret <secret>
//   (env GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET also work)
//   optional: --port 4779  (must be free; the loopback redirect uses it)
//
// It prints: the refresh token, the account email (→ set channel_instances
// config.accountEmail), and the ready-to-store credential blob + a curl to POST
// it to /admin/credentials as GMAIL_PERSONAL_OAUTH / GMAIL_WORK_OAUTH.
// ─────────────────────────────────────────────────────────────────────────────

const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'];

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
  if (!clientId || !clientSecret) {
    throw new Error('provide --client <json>, or --client-id/--client-secret, or GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET');
  }
  return { clientId, clientSecret };
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
      res.end('<h2>✅ Authorized</h2><p>Refresh token minted — return to the terminal. You can close this tab.</p>');
      server.close();
      resolve(gotCode);
    });
    server.on('error', reject);
    server.listen(port, () => {
      process.stdout.write(`\n▶ Open this URL and authorize the Gmail account you want to connect:\n\n${authUrl}\n\n(attempting to open your browser…)\n`);
      openBrowser(authUrl);
    });
  });

  // Exchange the code for tokens.
  const tok = await exchangeGoogleCode({ client: { clientId, clientSecret }, code, redirectUri });
  if (tok.error || !tok.refresh_token) {
    throw new Error(`token exchange failed: ${tok.error ?? 'unknown'} ${tok.error_description ?? ''}${tok.refresh_token ? '' : ' (no refresh_token — revoke prior grant at myaccount.google.com/permissions and retry, or ensure prompt=consent)'}`);
  }

  // Which account did they authorize?
  let email = '(unknown — set config.accountEmail manually)';
  try {
    const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: { Authorization: `Bearer ${tok.access_token}` } });
    if (p.ok) email = ((await p.json()) as { emailAddress?: string }).emailAddress ?? email;
  } catch { /* profile is best-effort */ }

  const blob = JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: tok.refresh_token });
  const credName = /work|company|corp/i.test(email) ? 'GMAIL_WORK_OAUTH' : 'GMAIL_PERSONAL_OAUTH';

  process.stdout.write(
    [
      '',
      '════════════════════════════════════════════════════════════════',
      `✅ Connected: ${email}`,
      '',
      'Refresh token:',
      `  ${tok.refresh_token}`,
      '',
      `1) Set the account email on the channel instance (email:gmail:personal or :work):`,
      `     UPDATE channel_instances SET config = jsonb_set(config,'{accountEmail}','"${email}"') WHERE name = 'email:gmail:<personal|work>';`,
      '',
      `2) Store the OAuth credential (name it ${credName} or GMAIL_WORK_OAUTH to match the instance's credentials_ref):`,
      `     curl -s -X POST http://localhost:3100/admin/credentials \\`,
      `       -H "x-admin-key: $ADMIN_API_KEY" -H 'content-type: application/json' \\`,
      `       -d '{"name":"${credName}","value":${JSON.stringify(blob)}}'`,
      '',
      '   (or put it in .env as that name = the JSON blob above)',
      '════════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
}

main().catch((err) => {
  process.stderr.write(`\n✗ ${(err as Error).message}\n`);
  process.exitCode = 1;
});
