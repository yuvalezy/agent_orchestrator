import pino from 'pino';
import { env } from './config/env';

/**
 * Shared structured logger. Pretty-printed in dev, JSON in production.
 * NOTE: message *content* is never logged — only metadata/counters — by design.
 *
 * "No bodies in logs" is enforced CLASS-closed, not case-closed:
 *  1. PRIMARY — a custom `err` serializer ALLOWLISTS only { type, message, stack },
 *     overriding pino's default serializer (which copies every enumerable prop of
 *     the error, e.g. body-parser's err.body). No error object can leak a payload
 *     prop regardless of its name (err.body, err.rawBody, err.request.data, …).
 *  2. The malformed-JSON 400 handler (app.ts) intercepts parse errors before they
 *     reach here — a SyntaxError's *message* can itself echo a body snippet.
 *  3. Belt-and-suspenders — redact any stray `*.body` on non-error objects.
 */
export const logger = pino({
  level: env.LOG_LEVEL,
  serializers: {
    err: (e: { name?: string; message?: string; stack?: string; constructor?: { name?: string } }) => ({
      type: e?.name ?? e?.constructor?.name,
      message: e?.message,
      stack: e?.stack,
    }),
  },
  redact: { paths: ['*.body'], remove: true },
  transport:
    env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname',
          },
        },
});

export type Logger = typeof logger;
