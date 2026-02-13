// Lightweight event system for auth/access failures.
// Any part of the app can emit these; App.tsx listens and forces re-login.

export type AuthFailureReason = 'session-expired' | 'cf-challenge';

export const AUTH_FAILURE_EVENT = 'meal-planner-auth-failure';

export function emitAuthFailure(reason: AuthFailureReason) {
  window.dispatchEvent(
    new CustomEvent(AUTH_FAILURE_EVENT, { detail: { reason } })
  );
}

export function onAuthFailure(handler: (reason: AuthFailureReason) => void): () => void {
  const listener = (e: Event) => {
    const detail = (e as CustomEvent<{ reason: AuthFailureReason }>).detail;
    handler(detail.reason);
  };
  window.addEventListener(AUTH_FAILURE_EVENT, listener);
  return () => window.removeEventListener(AUTH_FAILURE_EVENT, listener);
}
