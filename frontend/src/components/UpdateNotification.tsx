import { useState, useEffect } from 'react';

interface UpdateNotificationProps {
  updateAvailable: boolean;
  onApplyUpdate: () => void;
  updating?: boolean;
}

export function UpdateNotification({ updateAvailable, onApplyUpdate, updating }: UpdateNotificationProps) {
  const [dismissed, setDismissed] = useState(false);

  // Reset dismissed state when a new update is detected
  useEffect(() => {
    if (updateAvailable) setDismissed(false);
  }, [updateAvailable]);

  if (!updateAvailable || dismissed) return null;

  return (
    <div className="fixed bottom-14 left-0 right-0 z-40 flex justify-center px-4 pb-2">
      <div className="bg-blue-600 dark:bg-blue-700 text-white rounded-lg shadow-lg px-4 py-3 flex items-center gap-3 max-w-lg w-full">
        <svg className={`w-5 h-5 shrink-0${updating ? ' animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h5M20 20v-5h-5" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7.05 9.1A7.002 7.002 0 0119.79 10M16.95 14.9A7.002 7.002 0 014.21 14" />
        </svg>
        <span className="text-sm font-medium flex-1">{updating ? 'Updating…' : 'A new version is available'}</span>
        <button
          onClick={onApplyUpdate}
          disabled={updating}
          className={`text-sm font-semibold px-3 py-1 rounded-md transition-colors shrink-0 ${updating ? 'bg-white/50 text-blue-400 cursor-not-allowed' : 'bg-white text-blue-600 hover:bg-blue-50'}`}
        >
          {updating ? 'Updating…' : 'Update'}
        </button>
        <button
          onClick={() => setDismissed(true)}
          className="text-white/80 hover:text-white transition-colors shrink-0"
          aria-label="Dismiss"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}
