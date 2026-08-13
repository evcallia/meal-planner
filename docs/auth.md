# Authentication

The app supports two login methods, both producing the same signed-cookie
session (`meal_planner_session`):

1. **OIDC** — any spec-compliant provider (Authentik, Authelia, Keycloak,
   Google, …). Configured via `OIDC_ISSUER` / `OIDC_CLIENT_ID` /
   `OIDC_CLIENT_SECRET` / `OIDC_REDIRECT_URI`. Discovery
   (`/.well-known/openid-configuration`) supplies all endpoints — there is no
   provider-specific code.
2. **Password (basic) auth** — username + password checked against the
   `user_credentials` table (bcrypt). Enabled by default; disable with
   `PASSWORD_AUTH_ENABLED=false`.

At least one method must be available for non-local deployments
(`ValidateSecurity`).

## Identity model — how logins map to one user

All application data is keyed by `sub` (originally the Authentik OIDC subject).
The `users` table is the identity directory: `sub` (PK), `email`, `name`.

Logins are resolved to a **canonical sub** at login time (`resolveIdentity`):

1. If the login carries an email, look up `users` by case-insensitive email
   match. Found → the session uses **that row's existing sub** (the provider's
   sub is discarded; directory name/email are refreshed).
2. Otherwise look up by the provider's sub. Found → use it.
3. Otherwise create a new `users` row with the provider's sub.

Consequences:

- **Switching OIDC providers loses no data.** A user's first Authelia login
  carries the same email as their old Authentik logins, so it resolves to the
  original sub and all their data (settings, tracker lists, shares, push
  subscriptions, activity, hidden events) is intact. No migration step needed.
- Password logins use the email as the username, so they resolve to the same
  canonical user as OIDC logins with that email.
- **Email is the linking key**: the OIDC provider must be trusted to assert
  emails (any single-provider self-hosted setup qualifies). Users whose
  directory row has no email can only be matched by sub.
- Duplicate emails in `users` resolve to the oldest row (`last_seen ASC`).

## Password credentials

`user_credentials` table: `username` (PK, stored lowercase — an email),
`sub` (FK to `users`), `password_hash` (bcrypt).

Created two ways:

- **Self-service**: `POST /api/auth/password` `{password}` (authenticated,
  min 8 chars) sets a password for the current user, keyed by their email.
  Surfaced in Settings → account row ("Set password"). This is the migration
  path: set a password while still signed in via the old provider.
- **CLI**: `server -set-password <username>` (password from the `PASSWORD` env
  var or prompted on stdin). Links to an existing user by email, else creates
  `local:<username>`.

Login: `POST /api/auth/login/password` `{username, password}` → 200 with
`{sub, email, name}` + session cookie, or 401 `Invalid username or password`
(unknown users burn a dummy bcrypt compare to keep timing flat).

Hardening:

- Passwords are stored ONLY as bcrypt hashes (salted, adaptive cost); the
  plaintext is never persisted or logged. bcrypt reads at most 72 bytes, so
  set-password rejects longer inputs with a 400 (8-char minimum too).
- All credential/identity lookups go through GORM parameterized queries —
  SQL metacharacters in usernames/passwords are inert (regression test:
  `TestPasswordAuthSQLInjectionSafe`).
- Brute-force throttle: 10 failed logins per username per 15 min → 429 until
  attempts age out; success resets. In-memory, per-username (IPs are
  unreliable behind proxies).
- The login endpoint caps request bodies at 1 MB (it is public, so the
  authenticated-route body cap doesn't apply to it).
- `TestAllAPIRoutesAuthenticatedUnlessAllowlisted` asserts every /api route
  is auth-wrapped unless on the explicit public allowlist (health, the auth
  flow endpoints themselves).

## Endpoints

| Endpoint | Notes |
| --- | --- |
| `GET /api/auth/methods` | public; `{oidc, oidc_name, password}` — drives the login screen |
| `GET /api/auth/login` | OIDC redirect (500 if OIDC unconfigured) |
| `GET /api/auth/callback` | OIDC code exchange → canonical session |
| `POST /api/auth/login/password` | registered only when password auth enabled |
| `POST /api/auth/password` | authenticated; set own password |
| `POST /api/auth/logout` | clears session; returns `end_session_url` (see below) |
| `GET /api/auth/dev-login` | only when OIDC unset AND `FRONTEND_URL` is localhost |

## Logout

`POST /api/auth/logout` clears the app session and returns
`{status, end_session_url?}`. The URL the frontend then visits (popup on
desktop, redirect in PWA) is chosen as:

1. `LOGOUT_URL` env var, if set — point this at the provider's logout endpoint
   (e.g. Authelia's `https://auth.example.com/logout`) to end both sessions.
2. Else, with OIDC configured, the provider's discovered
   `end_session_endpoint` (3s discovery timeout; omitted on failure).
3. Else omitted — app session only.

The old hardcoded Authentik invalidation-flow URL is gone; Authentik users who
want the no-prompt flow should set
`LOGOUT_URL=https://auth.example.com/if/flow/default-invalidation-flow/`.

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `OIDC_ISSUER` etc. | empty | any OIDC provider; empty disables OIDC |
| `OIDC_PROVIDER_NAME` | `SSO` | login button label ("Sign in with X") |
| `PASSWORD_AUTH_ENABLED` | `true` | set `false` to disable username/password login |
| `LOGOUT_URL` | empty | overrides the post-logout provider URL |

## Frontend

- `LoginScreen` fetches `/api/auth/methods` and shows the SSO button and/or a
  username/password form (falls back to showing both if the fetch fails).
- `ReAuthModal`'s Sign in button goes to `/api/auth/login` when OIDC is
  enabled, else reloads to land on the login screen.
- Settings account row: "Set password" (shown when password auth is enabled).
