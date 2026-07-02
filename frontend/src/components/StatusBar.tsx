import { useEffect, useRef, useState } from 'react';
import { ConnectionStatus } from '../types';

const SpinIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
  </svg>
);

const OfflineIcon = ({ className }: { className?: string }) => (
  <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3" />
  </svg>
);

/**
 * Compact connection-status chip for the header. Renders nothing when fully
 * online (or auth-required, which the re-auth modal owns). Replaces the old
 * full-width banner so it never covers modals.
 */
export function StatusChip({ status, pendingCount = 0 }: { status: ConnectionStatus; pendingCount?: number }) {
  if (status === 'online' || status === 'auth-required') return null;
  if (status === 'offline') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-orange-100 text-orange-700 dark:bg-orange-500/25 dark:text-orange-200 ring-1 ring-orange-200 dark:ring-orange-500/30" title="Offline — changes are saved locally">
        <span className="w-1.5 h-1.5 rounded-full bg-orange-500" />
        Offline{pendingCount > 0 ? ` · ${pendingCount}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-500/25 dark:text-amber-200 ring-1 ring-amber-200 dark:ring-amber-500/30" title={`Syncing ${pendingCount} pending change${pendingCount === 1 ? '' : 's'}…`}>
      <SpinIcon className="w-2.5 h-2.5 animate-spin" />
      Syncing{pendingCount > 0 ? ` ${pendingCount}` : ''}
    </span>
  );
}

const TONES: Record<'offline' | 'syncing' | 'online', string> = {
  offline: 'bg-orange-500',
  syncing: 'bg-yellow-500',
  online: 'bg-emerald-500',
};

/**
 * Transient toast shown when the connection status changes (offline / syncing /
 * back online). Auto-dismisses; pointer-events-none so it never blocks taps.
 */
export function StatusToast({ status, pendingCount }: { status: ConnectionStatus; pendingCount: number }) {
  const [toast, setToast] = useState<{ text: string; tone: keyof typeof TONES } | null>(null);
  const prevRef = useRef<ConnectionStatus>(status);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    if (status === prev) return;
    prevRef.current = status;

    let next: { text: string; tone: keyof typeof TONES } | null = null;
    if (status === 'offline') next = { text: "You're offline — changes are saved locally", tone: 'offline' };
    else if (status === 'syncing') next = { text: `Syncing ${pendingCount} change${pendingCount === 1 ? '' : 's'}…`, tone: 'syncing' };
    else if (status === 'online' && (prev === 'offline' || prev === 'syncing')) next = { text: 'Back online', tone: 'online' };

    if (!next) return;
    setToast(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setToast(null), 3000);
  }, [status, pendingCount]);

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  if (!toast) return null;
  return (
    <div className="fixed top-3 left-1/2 z-[60] pointer-events-none status-toast-in">
      <div className={`${TONES[toast.tone]} text-white px-4 py-2 rounded-full shadow-lg text-sm font-medium flex items-center gap-2`}>
        {toast.tone === 'syncing' ? <SpinIcon className="w-4 h-4 animate-spin" /> : toast.tone === 'offline' ? <OfflineIcon className="w-4 h-4" /> : null}
        <span>{toast.text}</span>
      </div>
    </div>
  );
}
