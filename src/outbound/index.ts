// Core domain: outbound queue. The queue data-access (outbound-repo), the pure
// send-window computation (send-window), and the send-outcome error class
// (send-error) live in this directory (M1.8). Core only — db/pure, never imports
// src/adapters (D1). The drainer + holiday seeder that USE these are adapter-layer
// (src/adapters/outbound). Import the concrete modules directly; this barrel stays
// intentionally empty.
export {};
