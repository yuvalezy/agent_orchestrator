import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Tests run with globals disabled, so RTL's auto-cleanup hook never registers itself.
afterEach(cleanup);

// jsdom implements neither of these; the feed relies on both.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!globalThis.crypto?.randomUUID) {
  const value = { randomUUID: () => `test-${Math.random().toString(16).slice(2)}` } as Crypto;
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true });
}
