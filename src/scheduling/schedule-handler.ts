import { DateTime } from 'luxon';
import type { MessageEvent, Notification } from '../ports/founder-notifier.port';
import type { ScheduleInterpretation, ScheduleInterpreterPort } from '../ports/llm.port';
import type { ReplyOrigin, ScheduleRoute, ScheduledAction } from './scheduling-repo';

export interface ScheduleHandlerDeps {
  interpreter: ScheduleInterpreterPort;
  timezone: string;
  graceMinutes: number;
  outboundEnabled: boolean;
  allowedChannelTypes: string[];
  now: () => Date;
  findCustomer: (threadId: string) => Promise<{ id: string; displayName: string } | null>;
  resolveReplyOrigin: (chatId: string, messageId: number, customerId: string) => Promise<ReplyOrigin | null>;
  loadMappedOutboundBody: (ref: string, customerId: string) => Promise<string | null>;
  resolveRoute: (customerId: string, allowed: string[], origin?: ReplyOrigin | null) => Promise<ScheduleRoute | null>;
  createAction: (input: {
    sourceChatId: string;
    sourceMessageId: number;
    sourceThreadId: string;
    createdBy: string;
    customerId: string;
    kind: 'customer_message' | 'reminder';
    executeAt: Date;
    expiresAt: Date;
    timezone: string;
    body: string;
    contextSnapshot?: unknown;
    route?: ScheduleRoute | null;
  }) => Promise<{ action: ScheduledAction; created: boolean }>;
  postAnswer: (threadId: string, text: string) => Promise<void>;
  notifyCustomer: (customerId: string, n: Notification, buttons?: Array<{ id: string; label: string }>) => Promise<void>;
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
}

function validatedExecution(iso: string | null, timezone: string, now: Date): Date | null {
  if (!iso) return null;
  const parsed = DateTime.fromISO(iso, { setZone: true });
  if (!parsed.isValid) return null;
  const local = parsed.setZone(timezone);
  if (!local.isValid) return null;
  // Reject a model-provided offset that changes the intended local wall-clock minute.
  if (parsed.toFormat('yyyy-LL-dd HH:mm') !== local.toFormat('yyyy-LL-dd HH:mm')) return null;
  const date = parsed.toJSDate();
  return date.getTime() >= now.getTime() - 60_000 ? date : null;
}

function exactBody(
  kind: 'customer_message' | 'reminder',
  body: string | null,
  source: 'command' | 'mapped_outbound' | 'none',
  command: string,
  mappedOutboundBody: string | null,
): string | null {
  const candidate = body?.trim() ?? '';
  if (!candidate || candidate.length > 4096) return null;
  if (source === 'command' && command.includes(candidate)) return candidate;
  if (kind === 'customer_message' && source === 'mapped_outbound' && mappedOutboundBody !== null && candidate === mappedOutboundBody.trim()) {
    return mappedOutboundBody.trim();
  }
  return null;
}

function renderConfirmation(action: ScheduledAction): string {
  const when = DateTime.fromJSDate(new Date(action.execute_at), { zone: action.timezone }).toFormat("ccc LLL d, yyyy 'at' h:mm a ZZZZ");
  if (action.action_kind === 'reminder') {
    return `⏰ Reminder scheduled\n${when}\n\n${action.body}`;
  }
  return `📤 Customer message scheduled\nTo: ${action.recipient_label ?? action.recipient_address} via ${action.channel_type}\n${when}\n\n${action.body}`;
}

export function buildScheduleMessageHandler(deps: ScheduleHandlerDeps): (m: MessageEvent) => Promise<boolean> {
  return async (m): Promise<boolean> => {
    const customer = await deps.findCustomer(m.threadId);
    if (!customer) return false; // scheduling is customer-topic only

    const sourceMessageId = Number(m.messageId);
    if (!Number.isSafeInteger(sourceMessageId)) {
      await deps.postAnswer(m.threadId, '⚠️ I could not identify that Telegram message, so nothing was scheduled.');
      return true;
    }

    let origin: ReplyOrigin | null = null;
    if (m.replyTo) {
      const replyMessageId = Number(m.replyTo.messageId);
      if (Number.isSafeInteger(replyMessageId)) {
        origin = await deps.resolveReplyOrigin(m.chatId, replyMessageId, customer.id);
      }
    }
    const mappedOutboundBody = origin?.kind === 'outbound'
      ? await deps.loadMappedOutboundBody(origin.ref, customer.id)
      : null;
    const now = deps.now();

    let interpreted: ScheduleInterpretation;
    try {
      interpreted = await deps.interpreter.interpretSchedule({
        commandText: m.text,
        repliedText: m.replyTo?.text ?? null,
        mappedOutboundBody,
        customerName: customer.displayName,
        nowIso: DateTime.fromJSDate(now, { zone: deps.timezone }).toISO() ?? now.toISOString(),
        timezone: deps.timezone,
      }, customer.id);
    } catch {
      deps.log.error({ customerId: customer.id, messageId: m.messageId }, 'schedule: interpretation failed');
      await deps.postAnswer(m.threadId, '⚠️ I could not check that message for scheduling. Please try again.');
      return true;
    }

    if (interpreted.kind === 'none') return false;
    if (interpreted.kind === 'clarify') {
      await deps.postAnswer(m.threadId, interpreted.clarification?.trim() || 'What exact action, time, and wording should I schedule?');
      return true;
    }

    const executeAt = validatedExecution(interpreted.execute_at, deps.timezone, now);
    const body = exactBody(interpreted.kind, interpreted.body, interpreted.body_source, m.text, mappedOutboundBody);
    if (!executeAt) {
      await deps.postAnswer(m.threadId, `What future date and time should I use? Times are interpreted in ${deps.timezone}.`);
      return true;
    }
    if (!body) {
      await deps.postAnswer(
        m.threadId,
        interpreted.kind === 'customer_message'
          ? 'What exact words should I send? I will not invent text for an automatic customer message.'
          : 'What exactly should I remind you about?',
      );
      return true;
    }

    let route: ScheduleRoute | null = null;
    if (interpreted.kind === 'customer_message') {
      if (interpreted.delivery_channel === 'none') {
        await deps.postAnswer(m.threadId, 'Which channel should I use: WhatsApp or email? Nothing has been scheduled yet.');
        return true;
      }
      if (!deps.allowedChannelTypes.includes(interpreted.delivery_channel)) {
        await deps.postAnswer(m.threadId, `${interpreted.delivery_channel === 'email' ? 'Email' : 'WhatsApp'} delivery is disabled, so nothing was scheduled.`);
        return true;
      }
      if (!deps.outboundEnabled) {
        await deps.postAnswer(m.threadId, 'Outbound delivery is disabled, so I did not schedule a customer message.');
        return true;
      }
      route = await deps.resolveRoute(customer.id, [interpreted.delivery_channel], origin);
      if (!route) {
        await deps.postAnswer(m.threadId, 'I could not resolve an active send-capable contact for this customer. Nothing was scheduled.');
        return true;
      }
    }

    const expiresAt = new Date(executeAt.getTime() + deps.graceMinutes * 60_000);
    const { action, created } = await deps.createAction({
      sourceChatId: m.chatId,
      sourceMessageId,
      sourceThreadId: m.threadId,
      createdBy: m.by,
      customerId: customer.id,
      kind: interpreted.kind,
      executeAt,
      expiresAt,
      timezone: deps.timezone,
      body,
      contextSnapshot: {
        replyMessageId: m.replyTo?.messageId ?? null,
        replyText: m.replyTo?.text?.slice(0, 4096) ?? null,
        origin,
      },
      route,
    });

    if (!created && action.status !== 'pending') {
      await deps.postAnswer(m.threadId, `This command was already handled (status: ${action.status}).`);
      return true;
    }
    await deps.notifyCustomer(
      customer.id,
      { title: 'Scheduled', body: renderConfirmation(action), severity: 'action' },
      [{ id: `sc:${action.id}`, label: '❌ Cancel schedule' }],
    );
    deps.log.info({ actionId: action.id, customerId: customer.id, kind: action.action_kind }, 'schedule: action created');
    return true;
  };
}
