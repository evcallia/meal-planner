import { ConnectionStatus } from '../types';
import { getLoginUrl } from '../api/client';

interface StatusBarProps {
  status: ConnectionStatus;
  pendingCount: number;
}

export function StatusBar({ status, pendingCount }: StatusBarProps) {
  if (status === 'online') {
    return null;
  }

  const getStatusConfig = () => {
    if (status === 'auth-required') {
      return {
        bg: 'bg-red-500',
        text: 'Session expired',
        icon: (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m0 0v2m0-2h2m-2 0H10m9.374-9.373A9 9 0 115.626 5.626a9 9 0 0113.748 0z" />
          </svg>
        ),
        action: (
          <a
            href={getLoginUrl()}
            className="ml-2 underline font-semibold hover:text-red-100"
          >
            Sign in
          </a>
        ),
      };
    }
    if (status === 'offline') {
      return {
        bg: 'bg-orange-500',
        text: 'Offline - Changes saved locally',
        icon: (
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3" />
          </svg>
        ),
        action: null,
      };
    }
    return {
      bg: 'bg-yellow-500',
      text: `Syncing... (${pendingCount} pending)`,
      icon: (
        <svg className="w-4 h-4 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
        </svg>
      ),
      action: null,
    };
  };

  const config = getStatusConfig();

  return (
    <>
      {/* Fixed banner at top */}
      <div className={`${config.bg} text-white px-4 py-2 flex items-center justify-center gap-2 text-sm font-medium dark:opacity-90 fixed top-0 left-0 right-0 z-50`}>
        {config.icon}
        <span>{config.text}</span>
        {config.action}
      </div>
      {/* Spacer to push content down */}
      <div className="h-10" />
    </>
  );
}
