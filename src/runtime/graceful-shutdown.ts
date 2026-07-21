import type { WorkerHandle } from '../workers/worker-runner';

interface ClosableServer {
  close(callback: (err?: Error) => void): unknown;
  closeAllConnections?(): void;
}

export interface ShutdownLog {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
}

export interface RuntimeShutdownDeps {
  server: ClosableServer;
  workers: WorkerHandle[];
  closeResources: () => Promise<void>;
  log: ShutdownLog;
  graceMs?: number;
  exit?: (code: number) => void;
  /** Test/embedding seam; production defaults to installing process handlers. */
  registerSignalHandlers?: boolean;
}

function closeServer(server: RuntimeShutdownDeps['server']): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err?: Error) => (err ? reject(err) : resolve()));
  });
}

/**
 * Install one idempotent SIGINT/SIGTERM path. New work is stopped first; active
 * HTTP requests and worker ticks then receive a bounded opportunity to finish
 * before shared resources are closed. The hard deadline prevents an ignored
 * AbortSignal or a stuck keep-alive connection from blocking deployment forever.
 */
export function installGracefulShutdown(deps: RuntimeShutdownDeps): (signal: string) => Promise<void> {
  const graceMs = deps.graceMs ?? 30_000;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let shutdownPromise: Promise<void> | null = null;

  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      deps.log.info({ signal, graceMs }, 'Shutting down…');
      for (const worker of deps.workers) worker.stop();

      const cleanup = (async () => {
        await Promise.all([closeServer(deps.server), ...deps.workers.map((worker) => worker.waitForIdle())]);
        await deps.closeResources();
      })();

      let deadline: NodeJS.Timeout | undefined;
      let cleanupFailed = false;
      const timedOut = await Promise.race([
        cleanup.then(() => false),
        new Promise<boolean>((resolve) => {
          deadline = setTimeout(() => resolve(true), graceMs);
        }),
      ]).catch((err: unknown) => {
        cleanupFailed = true;
        deps.log.warn({ signal, reason: err instanceof Error ? err.name : 'unknown' }, 'Shutdown cleanup failed');
        return false;
      });
      if (deadline) clearTimeout(deadline);

      if (timedOut) {
        deps.server.closeAllConnections?.();
        deps.log.warn({ signal, graceMs }, 'Shutdown grace period expired; forcing process exit');
      }
      exit(cleanupFailed ? 1 : 0);
    })();
    return shutdownPromise;
  };

  if (deps.registerSignalHandlers ?? true) {
    process.once('SIGINT', () => void shutdown('SIGINT'));
    process.once('SIGTERM', () => void shutdown('SIGTERM'));
  }
  return shutdown;
}
