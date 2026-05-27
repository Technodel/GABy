/**
 * Browser push notification helpers for SUNy run receipts.
 * Uses the Notifications API directly (no server push subscription needed
 * since SUNy is already connected via WebSocket when the tab is open,
 * and uses SW showNotification for background tabs).
 */

let swRegistration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js');
  } catch {
    // Non-fatal — push notifications simply won't work
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!('Notification' in window)) return 'denied';
  if (Notification.permission === 'granted') return 'granted';
  return Notification.requestPermission();
}

export function notificationsSupported(): boolean {
  return 'Notification' in window;
}

export function notificationsGranted(): boolean {
  return 'Notification' in window && Notification.permission === 'granted';
}

export interface RunReceipt {
  taskLabel: string;       // first ~60 chars of the user message
  filesChanged: number;
  testsPassed?: number;    // undefined if no tests ran
  testsFailed?: number;
  creditsUsed: number;
  durationMs: number;
  success: boolean;
}

export function sendRunReceipt(receipt: RunReceipt): void {
  if (!notificationsGranted()) return;

  const durationSecs = Math.round(receipt.durationMs / 1000);
  const durationStr = durationSecs >= 60
    ? `${Math.floor(durationSecs / 60)}m ${durationSecs % 60}s`
    : `${durationSecs}s`;

  const testLine = receipt.testsPassed !== undefined
    ? `Tests: ${receipt.testsPassed} passing${receipt.testsFailed ? `, ${receipt.testsFailed} failing` : ''}\n`
    : '';

  const body = [
    `Files changed: ${receipt.filesChanged}`,
    testLine.trim(),
    `Credits: $${receipt.creditsUsed.toFixed(4)}`,
    `Time: ${durationStr}`,
  ].filter(Boolean).join('\n');

  const title = receipt.success
    ? `✅ SUNy finished: "${receipt.taskLabel}"`
    : `⚠️ SUNy stopped: "${receipt.taskLabel}"`;

  // Use SW notification if available (works when tab is backgrounded)
  if (swRegistration?.active) {
    swRegistration.showNotification(title, {
      body,
      icon: '/SLOGO.png',
      badge: '/SLOGO.png',
      tag: 'suny-run-receipt',
      requireInteraction: false,
    });
  } else {
    // Fallback: direct Notification API (only when tab is foregrounded)
    new Notification(title, { body, icon: '/SLOGO.png' });
  }
}
