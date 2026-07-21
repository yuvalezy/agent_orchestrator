import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installGracefulShutdown } from './graceful-shutdown';
import type { WorkerHandle } from '../workers/worker-runner';

const silentLog = { info: () => {}, warn: () => {} };

test('graceful shutdown stops workers, drains server, then closes shared resources once', async () => {
  const events: string[] = [];
  const worker: WorkerHandle = {
    stop: () => events.push('stop'),
    waitForIdle: async () => { events.push('idle'); },
  };
  const server = {
    close: (callback: (err?: Error) => void) => { events.push('server'); callback(); return server; },
  };
  let exits = 0;
  const shutdown = installGracefulShutdown({
    server,
    workers: [worker],
    closeResources: async () => { events.push('resources'); },
    log: silentLog,
    exit: () => { exits += 1; },
    registerSignalHandlers: false,
  });

  await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
  assert.equal(events[0], 'stop');
  assert.ok(events.indexOf('resources') > events.indexOf('idle'));
  assert.ok(events.indexOf('resources') > events.indexOf('server'));
  assert.equal(exits, 1);
});

test('graceful shutdown forces exit after the bounded grace period', async () => {
  let stopped = false;
  let forced = false;
  let exited = false;
  const server = {
    close: () => server,
    closeAllConnections: () => { forced = true; },
  };
  const shutdown = installGracefulShutdown({
    server,
    workers: [{ stop: () => { stopped = true; }, waitForIdle: () => new Promise(() => {}) }],
    closeResources: async () => {},
    log: silentLog,
    graceMs: 10,
    exit: () => { exited = true; },
    registerSignalHandlers: false,
  });

  await shutdown('SIGTERM');
  assert.equal(stopped, true);
  assert.equal(forced, true);
  assert.equal(exited, true);
});
