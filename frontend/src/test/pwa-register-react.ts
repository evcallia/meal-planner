import { useEffect, useState } from 'react';

// Test double for virtual:pwa-register/react. By default no registration is
// reported (onRegistered is a no-op, matching a browser without a SW). Tests
// that care about the service-worker lifecycle stage one — e.g. a registration
// with a `waiting` worker left over from a previous launch.
let mockRegistration: unknown = undefined;

export function __setMockRegistration(registration: unknown) {
  mockRegistration = registration;
}

export function __resetMockRegistration() {
  mockRegistration = undefined;
}

export function useRegisterSW(options?: any) {
  const offlineReady = useState(false);
  const needRefresh = useState(false);
  useEffect(() => {
    options?.onRegistered?.(mockRegistration);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return {
    offlineReady,
    needRefresh,
    updateServiceWorker: async (_reloadPage?: boolean) => {},
  };
}
