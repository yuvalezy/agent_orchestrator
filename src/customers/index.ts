// Core domain: customers (registry + contacts). Onboarding persistence,
// email-domain derivation, contact resolution, and founder-notification content.
// Depends only on src/ports + src/db (D1); never imports src/adapters.
export * from './onboarding';
export * from './email-domain';
export * from './contact-resolution';
export * from './notifications';
