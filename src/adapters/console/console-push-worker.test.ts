import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

test('notification worker has no fetch handler or app-shell cache and opens only console routes', async () => {
  const worker = await readFile(path.join(process.cwd(), 'web/public/sw.js'), 'utf8');
  assert.equal(worker.includes("addEventListener('fetch'"), false);
  assert.equal(worker.includes('cache.addAll'), false);
  assert.match(worker, /addEventListener\('push'/);
  assert.match(worker, /route\.startsWith\('\/console'\)/);
});
