import { useEffect, useState, FormEvent } from 'react';
import { getAuthMethods, getLoginUrl, loginWithPassword, AuthMethods } from '../api/client';
import { UserInfo } from '../types';

interface LoginScreenProps {
  onLoggedIn: (user: UserInfo) => void;
}

// If /api/auth/methods can't be reached (offline, server down) show every
// method — a wrong extra option fails on submit, a missing one is a dead end.
const FALLBACK_METHODS: AuthMethods = { oidc: true, oidc_name: 'SSO', password: true };

export function LoginScreen({ onLoggedIn }: LoginScreenProps) {
  const [methods, setMethods] = useState<AuthMethods | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getAuthMethods()
      .then((m) => { if (!cancelled) setMethods(m); })
      .catch(() => { if (!cancelled) setMethods(FALLBACK_METHODS); });
    return () => { cancelled = true; };
  }, []);

  const handlePasswordLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!username || !password || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const user = await loginWithPassword(username, password);
      onLoggedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
      setSubmitting(false);
    }
  };

  const inputClass =
    'w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500';

  return (
    <div className="min-h-screen bg-gray-100 dark:bg-transparent flex items-center justify-center p-4">
      <div className="glass rounded-lg p-8 max-w-sm w-full text-center">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">Meal Planner</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-6">Plan your weekly meals with ease</p>

        {methods === null ? (
          <div
            className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500 mx-auto"
            aria-label="Loading sign-in options"
          />
        ) : (
          <>
            {methods.oidc && (
              <a
                href={getLoginUrl()}
                className="inline-block w-full py-3 px-4 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors"
              >
                Sign in with {methods.oidc_name}
              </a>
            )}

            {methods.oidc && methods.password && (
              <div className="flex items-center gap-3 my-5">
                <div className="flex-1 h-px bg-gray-300 dark:bg-gray-600" />
                <span className="text-sm text-gray-500 dark:text-gray-400">or</span>
                <div className="flex-1 h-px bg-gray-300 dark:bg-gray-600" />
              </div>
            )}

            {methods.password && (
              <form onSubmit={handlePasswordLogin} className="text-left space-y-3">
                {/* type=text: usernames are normally emails but the CLI can
                    create arbitrary ones — email validation would block those */}
                <input
                  type="text"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  placeholder="Email"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={inputClass}
                  aria-label="Email"
                />
                <input
                  type="password"
                  autoComplete="current-password"
                  placeholder="Password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass}
                  aria-label="Password"
                />
                {error && (
                  <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
                )}
                <button
                  type="submit"
                  disabled={!username || !password || submitting}
                  className="w-full py-3 px-4 bg-blue-500 text-white font-medium rounded-lg hover:bg-blue-600 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {submitting ? 'Signing in…' : 'Sign in'}
                </button>
              </form>
            )}

            {!methods.oidc && !methods.password && (
              <p className="text-gray-600 dark:text-gray-400">
                No sign-in methods are configured. Contact the administrator.
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
