import 'dotenv/config';
import { env } from '../src/config/env';
import { resolveCredential } from '../src/config/credentials';
import { computeSignature } from '../src/adapters/whatsapp-manager/signature';

// Post a signed synthetic whatsapp_manager webhook to a running orchestrator —
// exercises the full ingest path (verify → map → agent_inbox) WITHOUT the real
// WhatsApp device. Also proves the 401 path with --tamper.
//
//   npm run smoke:webhook -- [--id=<msgId>] [--body="text"] [--from=<number>]
//                            [--voice] [--outbound] [--tamper]
//
// After running, check: SELECT id,status,body FROM agent_inbox
//   WHERE channel_message_id='<msgId>';

function arg(name: string, fallback?: string): string | undefined {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq === -1 ? 'true' : hit.slice(eq + 1);
}

async function main(): Promise<void> {
  const id = arg('id', `smoke-${Date.now()}`)!;
  const isVoice = arg('voice') === 'true';
  const message = {
    messageId: id,
    chatId: `${arg('from', '50768087246')}@c.us`,
    contactNumber: arg('from', '50768087246'),
    senderNumber: arg('from', '50768087246'),
    senderName: 'Smoke Test',
    body: isVoice ? '' : (arg('body', 'hello from smoke-webhook') ?? ''),
    messageType: isVoice ? 'ptt' : 'chat',
    direction: arg('outbound') === 'true' ? 'outbound' : 'inbound',
    timestamp: new Date().toISOString(),
    detectedLanguage: 'en',
    ...(isVoice ? { media: { mediaType: 'ptt', mimetype: 'audio/ogg' } } : {}),
  };

  const rawBody = Buffer.from(JSON.stringify(message));
  const secret = resolveCredential('WEBHOOK_SECRET');
  let signature = computeSignature(rawBody, secret);
  if (arg('tamper') === 'true') signature = signature.slice(0, -1) + (signature.endsWith('a') ? 'b' : 'a');

  const url = `http://localhost:${env.PORT}/webhooks/whatsapp`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
    body: rawBody,
  });
  console.log(`POST ${url} → ${res.status}`, await res.text());
  console.log(`messageId=${id} direction=${message.direction} type=${message.messageType}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
