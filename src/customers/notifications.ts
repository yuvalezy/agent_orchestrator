import { Notification } from '../ports';

// Founder-notification CONTENT builders (domain layer). These produce port-typed
// `Notification`s; turning one into Telegram wire format is the adapter's job
// (TelegramNotifier.render). Placed in core — not the Telegram adapter — because
// core `proposeAddContact` must build the proposal and D1 forbids core→adapter
// imports. Single source of truth for both onboarding messages (DRY).

/** Welcome posted to a customer's topic right after onboarding. */
export function welcomeNotification(displayName: string): Notification {
  return {
    title: '👋 Customer onboarded',
    body: `${displayName} is now set up. Messages from this customer will be triaged into this topic.`,
    severity: 'info',
  };
}

/**
 * "Add this contact?" proposal — fired when an unknown email address matches
 * exactly one customer's email domain (contact-resolution `propose`). Rendered
 * with yes/no buttons via askFounder; nothing handles the tap until M1.5b.
 */
export function newContactProposal(
  customerName: string,
  channelType: string,
  address: string,
): Notification {
  return {
    title: '🆕 New contact?',
    body: `An unrecognized ${channelType} address (${address}) matches ${customerName}'s domain. Add it as a contact for this customer?`,
    severity: 'action',
  };
}
