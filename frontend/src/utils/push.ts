// Web Push subscription management. The master "notifications on/off" state is
// per-device (it's the browser's push subscription), while the per-category
// toggles live in synced user settings — the server checks those when sending.

import { getPushPublicKey, savePushSubscription, deletePushSubscription } from '../api/client';

export type EnablePushResult = 'enabled' | 'denied' | 'unsupported' | 'error';

// Device-local memory that the user wants push on. The subscription itself
// can be destroyed out from under us — most notably the app-update "nuclear"
// path unregisters the service worker, which deletes its push subscriptions
// — so this flag lets ensurePushSubscription() silently restore it on launch.
const PUSH_ENABLED_KEY = 'meal-planner-push-enabled';

function rememberPushEnabled(on: boolean): void {
  try {
    if (on) {
      localStorage.setItem(PUSH_ENABLED_KEY, 'true');
    } else {
      localStorage.removeItem(PUSH_ENABLED_KEY);
    }
  } catch { /* storage unavailable */ }
}

function pushWasEnabled(): boolean {
  try {
    return localStorage.getItem(PUSH_ENABLED_KEY) === 'true';
  } catch {
    return false;
  }
}

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

// The VAPID key arrives base64url-encoded; pushManager.subscribe wants bytes.
// (Explicitly ArrayBuffer-backed so it satisfies the BufferSource parameter type.)
function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function getRegistration(): Promise<ServiceWorkerRegistration | null> {
  // getRegistration() (not .ready) so we resolve immediately in dev where no
  // service worker is registered, instead of hanging forever.
  try {
    return (await navigator.serviceWorker.getRegistration()) ?? null;
  } catch {
    return null;
  }
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  const registration = await getRegistration();
  if (!registration) return null;
  try {
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

// True when the subscription's bound server key matches the current one.
// A null bound key (browser doesn't expose it) counts as matching — we can't
// verify, and churning the subscription on every enable would be worse.
function serverKeyMatches(bound: ArrayBuffer | null, current: Uint8Array): boolean {
  if (!bound) return true;
  const a = new Uint8Array(bound);
  if (a.length !== current.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== current[i]) return false;
  }
  return true;
}

export async function enablePush(): Promise<EnablePushResult> {
  if (!isPushSupported()) return 'unsupported';
  const registration = await getRegistration();
  if (!registration) return 'unsupported';

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';

  try {
    const { key } = await getPushPublicKey();
    const serverKey = urlBase64ToUint8Array(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !serverKeyMatches(subscription.options.applicationServerKey, serverKey)) {
      // Bound to a stale VAPID key (server keypair changed since this device
      // subscribed) — push services reject sends signed with the new key
      // (Apple: 403 VapidPkHashMismatch). Re-subscribe fresh.
      try { await subscription.unsubscribe(); } catch { /* replaced below */ }
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      });
    }
    await savePushSubscription(subscription.toJSON());
    rememberPushEnabled(true);
    return 'enabled';
  } catch {
    return 'error';
  }
}

export async function disablePush(): Promise<void> {
  rememberPushEnabled(false);
  const subscription = await getPushSubscription();
  if (!subscription) return;
  const endpoint = subscription.endpoint;
  try {
    await subscription.unsubscribe();
  } catch {
    // Browser-side unsubscribe failed — still remove it server-side
  }
  try {
    await deletePushSubscription(endpoint);
  } catch {
    // Server cleanup failed; the server prunes dead endpoints on next send
  }
}

/**
 * Self-healing, called on app start: if this device had push enabled and
 * permission is still granted but the subscription is gone (app update
 * unregistered the SW, browser evicted it, server key rotated), silently
 * re-subscribe and re-register with the server. No-op otherwise — and it
 * never prompts, since it only acts when permission is already granted.
 */
export async function ensurePushSubscription(): Promise<void> {
  if (!isPushSupported()) return;
  if (!pushWasEnabled()) return;
  if (Notification.permission !== 'granted') return;
  try {
    // `ready` (not getRegistration): right after an update reload the new SW
    // may still be installing. Safe to wait on — pushWasEnabled() implies a
    // SW-capable production environment.
    const registration = await navigator.serviceWorker.ready;
    const { key } = await getPushPublicKey();
    const serverKey = urlBase64ToUint8Array(key);
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && !serverKeyMatches(subscription.options.applicationServerKey, serverKey)) {
      try { await subscription.unsubscribe(); } catch { /* replaced below */ }
      subscription = null;
    }
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: serverKey,
      });
    }
    // Re-register even when the browser subscription survived — the server
    // row may have been pruned after a failed delivery.
    await savePushSubscription(subscription.toJSON());
  } catch {
    // Offline or transient failure — next launch retries
  }
}
