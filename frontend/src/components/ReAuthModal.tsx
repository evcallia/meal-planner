import { getLoginUrl } from '../api/client';

interface ReAuthModalProps {
  pendingCount: number;
}

export function ReAuthModal({ pendingCount }: ReAuthModalProps) {
  const handleSignIn = () => {
    window.location.href = getLoginUrl();
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-labelledby="reauth-title"
    >
      <div className="glass rounded-2xl max-w-sm w-full p-6 text-center">
        <h2
          id="reauth-title"
          className="text-xl font-bold text-gray-900 dark:text-gray-100 mb-3"
        >
          Sign in to keep using Meal Planner
        </h2>
        <p className="text-gray-700 dark:text-gray-300 mb-3">
          Your session has expired. Sign in again to continue.
        </p>
        <p className="text-sm text-gray-600 dark:text-gray-400 italic mb-5">
          Your unsaved changes are saved on this device and will sync after sign-in.
        </p>
        {pendingCount > 0 && (
          <p className="text-sm text-gray-700 dark:text-gray-300 mb-5">
            {pendingCount} {pendingCount === 1 ? 'change' : 'changes'} waiting to sync.
          </p>
        )}
        <button
          onClick={handleSignIn}
          className="w-full py-3 px-4 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors"
        >
          Sign in
        </button>
      </div>
    </div>
  );
}
