/**
 * lock-messages.ts â€” Tiny shared module to break the circular dependency
 * between index.ts and ws-handler.ts.
 *
 * lockMessagesSent tracks whether a "project locked" notification has
 * already been pushed to a session, preventing duplicate toasts.
 */
export const lockMessagesSent = new Set<string>();
