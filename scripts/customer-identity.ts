import 'dotenv/config';
import { pool, query } from '../src/db';
import { logger } from '../src/logger';
import { env } from '../src/config/env';
import { tryResolveCredential } from '../src/config/credentials';
import { credentialsStore } from '../src/config/credentials-store';
import { getCustomerDirectoryInfo } from '../src/customers/customer-directory';
import { getCustomerEmailIdentity } from '../src/customers/email-identity';
import { buildWhatsAppDirectoryClient, buildWaHistoryClient } from '../src/adapters/whatsapp-manager/factory';
import type { WaWhitelistEntry, WaGroupEntry } from '../src/adapters/whatsapp-manager/directory-client';
import { GmailClient } from '../src/adapters/email/gmail-client';
import { buildGmailQuery } from '../src/adapters/email/gmail-history-source';
import { computeIdentityFlags } from '../src/customers/identity-flags';

// READ-ONLY identity-audit for ONE customer: what identity we resolved (bp_ref /
// display_name / email_domain / contacts) and what history is ACTUALLY reachable
// (whatsapp_manager message count for the mapped chats + Gmail thread count per
// account) — so "0 threads / wrong domain / unmapped mailbox" is VISIBLE instead of
// silently backfilling nothing. Every probe is best-effort: a failing source logs +
// shows "unavailable" and never aborts. Writes NOTHING, sends NOTHING.
//
//   npm run customer:identity -- <customerId>

// Mirror lib-backfill.ts: the two configured Gmail accounts + their OAuth cred refs.
const GMAIL_ACCOUNTS = [
  { name: 'email:gmail:work', ref: 'GMAIL_WORK_OAUTH' },
  { name: 'email:gmail:personal', ref: 'GMAIL_PERSONAL_OAUTH' },
] as const;
// Count cap per account — high enough that a real "0 vs many" is unambiguous.
const GMAIL_THREAD_CAP = 200;

const isGroupChat = (chatId: string): boolean => chatId.endsWith('@g.us');

interface ContactRow {
  channel_type: string;
  address: string;
  display_name: string | null;
  is_group: boolean | null;
}

interface GmailAccountResult {
  name: string;
  count: number | null; // null = unavailable
  capped: boolean;
  note?: string;
}

function line(label: string, value: string): void {
  console.log(`  ${label.padEnd(16)} ${value}`);
}

async function main(): Promise<void> {
  const customerId = process.argv[2];
  if (!customerId) {
    logger.error('usage: npm run customer:identity -- <customerId>');
    process.exitCode = 1;
    return;
  }

  // Secrets live in the encrypted store now — load it before resolving GMAIL_*_OAUTH (store-first).
  await credentialsStore.load();

  const info = await getCustomerDirectoryInfo(customerId);
  if (!info) {
    console.log(`\n✗ No customer found for id ${customerId}\n`);
    process.exitCode = 1;
    return;
  }
  const identity = await getCustomerEmailIdentity(customerId);

  // ── DB contacts (email + whatsapp) ──
  const contacts = (
    await query<ContactRow>(
      'SELECT channel_type, address, display_name, is_group FROM agent_customer_contacts WHERE customer_id = $1 ORDER BY channel_type, address',
      [customerId],
    )
  ).rows;
  const emailContacts = contacts.filter((c) => c.channel_type === 'email');
  const waContacts = contacts.filter((c) => c.channel_type === 'whatsapp');

  // ── WhatsApp directory (whitelist + groups) mapped to this customer's bp_ref ──
  let waWhitelist: WaWhitelistEntry[] | null = null;
  let waGroups: WaGroupEntry[] | null = null;
  let waDirError: string | undefined;
  if (info.bpRef) {
    try {
      const dir = buildWhatsAppDirectoryClient();
      const [wl, gr] = await Promise.all([dir.listWhitelist(), dir.listGroups()]);
      waWhitelist = wl.filter((w) => w.ezy_bp_id === info.bpRef);
      waGroups = gr.filter((g) => g.ezy_bp_id === info.bpRef);
    } catch (err) {
      waDirError = (err as Error)?.message;
      logger.warn({ customerId, reason: waDirError }, 'customer-identity: WA directory unavailable');
    }
  }

  // ── WhatsApp message COUNT for the mapped chats (same selection as wa-history-source) ──
  let waMessageCount: number | null = null;
  let waArchiveCapped = false;
  let waCountError: string | undefined;
  if (info.bpRef && waWhitelist && waGroups) {
    const phones = new Set(waWhitelist.map((w) => w.phone_number));
    const groupChatIds = new Set(
      waGroups.flatMap((g) => [g.chat_id, `${g.group_id}@g.us`].filter((x): x is string => !!x)),
    );
    if (phones.size === 0 && groupChatIds.size === 0) {
      waMessageCount = 0; // mapped to a bp_ref but no whitelist/group entries → genuinely 0
    } else {
      try {
        const { messages, capped } = await buildWaHistoryClient().listAllMessages();
        waArchiveCapped = capped;
        waMessageCount = messages.filter((m) =>
          isGroupChat(m.chat_id)
            ? groupChatIds.has(m.chat_id)
            : !!m.contact_number && phones.has(m.contact_number),
        ).length;
      } catch (err) {
        waCountError = (err as Error)?.message;
        logger.warn({ customerId, reason: waCountError }, 'customer-identity: WA message probe unavailable');
      }
    }
  }

  // ── Gmail query + thread COUNT per configured account ──
  const gmailQuery = buildGmailQuery({ domain: identity.domain, addresses: identity.addresses });
  const gmailResults: GmailAccountResult[] = [];
  if (gmailQuery) {
    for (const acct of GMAIL_ACCOUNTS) {
      const cred = tryResolveCredential(acct.ref);
      if (!cred) {
        gmailResults.push({ name: acct.name, count: null, capped: false, note: `no credential (${acct.ref})` });
        continue;
      }
      try {
        const ids = await new GmailClient(() => cred).searchThreadIds(gmailQuery, GMAIL_THREAD_CAP);
        gmailResults.push({ name: acct.name, count: ids.length, capped: ids.length >= GMAIL_THREAD_CAP });
      } catch (err) {
        const note = (err as Error)?.message;
        logger.warn({ customerId, account: acct.name, reason: note }, 'customer-identity: Gmail probe unavailable');
        gmailResults.push({ name: acct.name, count: null, capped: false, note });
      }
    }
  }
  // Aggregate Gmail thread count for flagging: null unless the query ran AND at least
  // one account answered (an all-unavailable probe must not masquerade as 0 threads).
  let gmailThreadCount: number | null = null;
  if (gmailQuery) {
    const answered = gmailResults.filter((r) => r.count !== null);
    if (answered.length > 0) gmailThreadCount = answered.reduce((s, r) => s + (r.count ?? 0), 0);
  }

  const flags = computeIdentityFlags({
    bpRef: info.bpRef,
    displayName: info.displayName,
    emailDomain: identity.domain,
    waMessageCount,
    gmailThreadCount,
  });

  // ──────────────────────── REPORT ────────────────────────
  console.log(`\n════════ CUSTOMER IDENTITY AUDIT — ${customerId} ════════\n`);

  console.log('IDENTITY');
  line('bp_ref', info.bpRef ?? '(none)');
  line('display_name', info.displayName);
  line('email_domain', identity.domain ?? '(none)');
  line('language', info.language ?? '(none)');

  console.log('\nEMAIL CONTACTS');
  if (emailContacts.length === 0) console.log('  (none)');
  for (const c of emailContacts) console.log(`  ${c.address}${c.display_name ? `  (${c.display_name})` : ''}`);

  console.log('\nWHATSAPP CONTACTS (DB)');
  if (waContacts.length === 0) console.log('  (none)');
  for (const c of waContacts)
    console.log(`  ${c.address}${c.is_group ? ' [group]' : ''}${c.display_name ? `  (${c.display_name})` : ''}`);

  console.log('\nWHATSAPP DIRECTORY (whatsapp_manager, mapped by bp_ref)');
  if (!info.bpRef) {
    console.log('  (no bp_ref — cannot map whatsapp_manager chats to this customer)');
  } else if (waDirError) {
    console.log(`  unavailable — ${waDirError}`);
  } else {
    console.log(`  whitelist entries: ${waWhitelist?.length ?? 0}`);
    for (const w of waWhitelist ?? [])
      console.log(`    ${w.phone_number}${w.label ? `  (${w.label})` : ''}`);
    console.log(`  group entries: ${waGroups?.length ?? 0}`);
    for (const g of waGroups ?? []) console.log(`    ${g.chat_id}${g.subject ? `  (${g.subject})` : ''}`);
    if (waCountError) {
      console.log(`  message count: unavailable — ${waCountError}`);
    } else {
      console.log(`  message count: ${waMessageCount ?? 0}${waArchiveCapped ? ' (archive hit page cap — partial)' : ''}`);
    }
  }
  // Surface the WA window cap (BACKFILL_WA_MAX_WINDOWS) — otherwise it is only visible in
  // logs (wa-history-source.ts warns when it drops the oldest windows during a backfill).
  console.log(
    `  window cap:      BACKFILL_WA_MAX_WINDOWS=${env.BACKFILL_WA_MAX_WINDOWS} (backfill keeps the newest N windows/customer; older are dropped + logged)`,
  );

  console.log('\nGMAIL HISTORY REACH');
  if (!gmailQuery) {
    console.log('  no email domain/addresses — no Gmail query to run (nothing to search)');
  } else {
    console.log(`  query: ${gmailQuery}`);
    for (const r of gmailResults) {
      const val =
        r.count === null ? `unavailable — ${r.note ?? 'error'}` : `${r.count} threads${r.capped ? ` (≥ cap ${GMAIL_THREAD_CAP})` : ''}`;
      line(`  ${r.name}`, val);
    }
  }

  console.log('\n⚠️  FLAGS');
  if (flags.length === 0) console.log('  none — identity resolves and history is reachable');
  for (const f of flags) console.log(`  ⚠️  [${f.code}] ${f.message}`);
  console.log('');
}

main()
  .catch((err) => {
    logger.error({ err: { message: (err as Error)?.message } }, 'customer-identity failed');
    process.exitCode = 1;
  })
  .finally(() => void pool.end());
