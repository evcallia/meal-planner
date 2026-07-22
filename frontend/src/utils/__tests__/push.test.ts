import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../api/client', () => ({
  getPushPublicKey: vi.fn(),
  savePushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
}));

import { ensurePushSubscription, enablePush, disablePush } from '../push';
import { getPushPublicKey, savePushSubscription } from '../../api/client';

// base64url of a 3-byte key [1, 2, 3]
const SERVER_KEY_B64 = 'AQID';
const SERVER_KEY_BYTES = new Uint8Array([1, 2, 3]).buffer;

function makePushManager(existing: unknown) {
  return {
    getSubscription: vi.fn().mockResolvedValue(existing),
    subscribe: vi.fn().mockResolvedValue({
      endpoint: 'https://push.example.com/new',
      options: { applicationServerKey: SERVER_KEY_BYTES },
      toJSON: () => ({ endpoint: 'https://push.example.com/new', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn(),
    }),
  };
}

// The global test setup replaces localStorage with a bare vi.fn() mock that
// stores nothing — the enabled-flag logic needs one that actually works.
function installWorkingLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
}

function stubEnvironment({ permission = 'granted', existingSubscription = null as unknown } = {}) {
  const pushManager = makePushManager(existingSubscription);
  const registration = { pushManager };
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      ready: Promise.resolve(registration),
      getRegistration: vi.fn().mockResolvedValue(registration),
    },
    configurable: true,
  });
  vi.stubGlobal('Notification', { permission, requestPermission: vi.fn().mockResolvedValue(permission) });
  vi.stubGlobal('PushManager', function PushManager() {});
  return { pushManager };
}

describe('ensurePushSubscription', () => {
  beforeEach(() => {
    installWorkingLocalStorage();
    vi.mocked(getPushPublicKey).mockResolvedValue({ key: SERVER_KEY_B64 });
    vi.mocked(savePushSubscription).mockResolvedValue({ status: 'ok' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('does nothing when push was never enabled on this device', async () => {
    const { pushManager } = stubEnvironment();
    await ensurePushSubscription();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(savePushSubscription).not.toHaveBeenCalled();
  });

  it('re-subscribes when the flag is set but the subscription is gone (post-update heal)', async () => {
    localStorage.setItem('meal-planner-push-enabled', 'true');
    const { pushManager } = stubEnvironment({ existingSubscription: null });
    await ensurePushSubscription();
    expect(pushManager.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ userVisibleOnly: true })
    );
    expect(savePushSubscription).toHaveBeenCalled();
  });

  it('re-registers a surviving subscription with the server without re-subscribing', async () => {
    localStorage.setItem('meal-planner-push-enabled', 'true');
    const existing = {
      endpoint: 'https://push.example.com/old',
      options: { applicationServerKey: SERVER_KEY_BYTES },
      toJSON: () => ({ endpoint: 'https://push.example.com/old', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn(),
    };
    const { pushManager } = stubEnvironment({ existingSubscription: existing });
    await ensurePushSubscription();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
    expect(savePushSubscription).toHaveBeenCalled();
  });

  it('replaces a subscription bound to a stale server key', async () => {
    localStorage.setItem('meal-planner-push-enabled', 'true');
    const stale = {
      endpoint: 'https://push.example.com/stale',
      options: { applicationServerKey: new Uint8Array([9, 9, 9]).buffer },
      toJSON: () => ({ endpoint: 'https://push.example.com/stale', keys: { p256dh: 'p', auth: 'a' } }),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };
    const { pushManager } = stubEnvironment({ existingSubscription: stale });
    await ensurePushSubscription();
    expect(stale.unsubscribe).toHaveBeenCalled();
    expect(pushManager.subscribe).toHaveBeenCalled();
  });

  it('does nothing when permission was revoked', async () => {
    localStorage.setItem('meal-planner-push-enabled', 'true');
    const { pushManager } = stubEnvironment({ permission: 'denied' });
    await ensurePushSubscription();
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });
});

describe('enable/disable remember the device preference', () => {
  beforeEach(() => {
    installWorkingLocalStorage();
    vi.mocked(getPushPublicKey).mockResolvedValue({ key: SERVER_KEY_B64 });
    vi.mocked(savePushSubscription).mockResolvedValue({ status: 'ok' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('enablePush sets the flag on success', async () => {
    stubEnvironment({ existingSubscription: null });
    const result = await enablePush();
    expect(result).toBe('enabled');
    expect(localStorage.getItem('meal-planner-push-enabled')).toBe('true');
  });

  it('disablePush clears the flag', async () => {
    localStorage.setItem('meal-planner-push-enabled', 'true');
    stubEnvironment({ existingSubscription: null });
    await disablePush();
    expect(localStorage.getItem('meal-planner-push-enabled')).toBeNull();
  });
});
