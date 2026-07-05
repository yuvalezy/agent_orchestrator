// Barrel re-export of every port contract. Core modules import from here; the
// composition root (src/main.ts) is the only place that pairs a port with its
// adapter implementation (D1).
export * from './channel.port';
export * from './task-target.port';
export * from './customer-directory.port';
export * from './ticketing.port';
export * from './founder-notifier.port';
export * from './llm.port';
export * from './embedding.port';
