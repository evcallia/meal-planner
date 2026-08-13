import { useEffect, useState, FormEvent } from 'react';
import { getAuthMethods, setPassword as setPasswordAPI } from '../api/client';

// Self-service password setup in the Settings account row (docs/auth.md):
// lets a user signed in via OIDC set a username/password login for the same
// account — the migration path before switching providers. Renders nothing
// when password auth is disabled on the server.
export function PasswordSetter() {
  const [enabled, setEnabled] = useState(false);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAuthMethods()
      .then((m) => { if (!cancelled) setEnabled(m.password); })
      .catch(() => { /* leave hidden if unknown */ });
    return () => { cancelled = true; };
  }, []);

  if (!enabled) return null;

  const handleSave = async (e: FormEvent) => {
    e.preventDefault();
    if (saving) return;
    if (password.length < 8) {
      setError('Password must be at least 8 characters');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await setPasswordAPI(password);
      setSaved(true);
      setOpen(false);
      setPassword('');
      setConfirm('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save password');
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="px-4 py-3 border-t border-gray-200 dark:border-gray-700">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {saved ? 'Password saved' : 'Password sign-in'}
        </span>
        <button
          onClick={() => { setOpen(!open); setSaved(false); setError(null); }}
          className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-700 shrink-0"
        >
          {open ? 'Cancel' : 'Set password'}
        </button>
      </div>
      {open && (
        <form onSubmit={handleSave} className="mt-3 space-y-2">
          <p className="text-xs text-gray-500 dark:text-gray-400">
            Sign in with your email and this password — works with any login provider.
          </p>
          <input
            type="password"
            autoComplete="new-password"
            placeholder="New password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputClass}
            aria-label="New password"
          />
          <input
            type="password"
            autoComplete="new-password"
            placeholder="Confirm password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className={inputClass}
            aria-label="Confirm password"
          />
          {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
          <button
            type="submit"
            disabled={!password || !confirm || saving}
            className="w-full py-2 text-sm bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save password'}
          </button>
        </form>
      )}
    </div>
  );
}
