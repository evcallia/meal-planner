import { useState } from 'react';

export function useRegisterSW(_options?: any) {
  const offlineReady = useState(false);
  const needRefresh = useState(false);
  return {
    offlineReady,
    needRefresh,
    updateServiceWorker: async (_reloadPage?: boolean) => {},
  };
}
