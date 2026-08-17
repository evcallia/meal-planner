// Detecting that a NEWER build is deployed, without false positives.
//
// A build used to be identified by a timestamp baked in at compile time
// (`__APP_BUILD__` + version.json). That timestamp was *content*, so every
// rebuild — even of byte-identical source — produced a new asset hash, a new
// service-worker precache manifest and a new version.json. Redeploying the
// same commit therefore told every client "update available" when nothing had
// changed.
//
// A build is now identified by the hashed asset URLs its index.html
// references. Vite derives those hashes from content, so an unchanged
// codebase fingerprints identically and only a real change prompts.

const THROTTLE_MS = 30_000;

let lastCheck = 0;
let announced = false;

/**
 * The build fingerprint of a document: its `/assets/…` script and stylesheet
 * URLs, sorted and joined. Empty when there are none — an auth-proxy login
 * page or a half-parsed document must never look like a new build.
 */
export function assetFingerprint(root: ParentNode): string {
  return Array.from(root.querySelectorAll('script[src], link[href]'))
    .map(el => el.getAttribute('src') ?? el.getAttribute('href') ?? '')
    .filter(url => url.includes('/assets/'))
    .sort()
    .join('|');
}

/** The fingerprint of the build currently running in this tab. */
export function currentFingerprint(): string {
  return assetFingerprint(document);
}

/**
 * One update check. Fetches index.html straight from the network and compares
 * its asset references with the ones this tab actually loaded. Returns whether
 * a newer build is being served; announces it once via `pwa-update-available`.
 */
export async function checkForAppUpdate(): Promise<boolean> {
  if (announced) return true;
  const now = Date.now();
  if (now - lastCheck < THROTTLE_MS) return false;
  lastCheck = now;

  const mine = currentFingerprint();
  if (!mine) return false; // nothing to compare against — never guess

  try {
    // The query string keeps this off the service worker's precache, and the
    // server sends index.html no-store, so this is always the deployed HTML.
    const res = await fetch(`/index.html?t=${now}`, { cache: 'no-store' });
    if (!res.ok) return false;
    const served = assetFingerprint(new DOMParser().parseFromString(await res.text(), 'text/html'));
    if (!served || served === mine) return false;
  } catch {
    return false; // offline
  }

  announced = true;
  (window as unknown as { __pwaUpdateAvailable?: boolean }).__pwaUpdateAvailable = true;
  window.dispatchEvent(new Event('pwa-update-available'));
  return true;
}

/**
 * Check now, then whenever the app comes back to the foreground. This is the
 * backup for iOS standalone, where the service worker's own update lifecycle
 * is unreliable.
 */
export function watchForAppUpdate(): void {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForAppUpdate();
  });
  window.addEventListener('focus', () => { void checkForAppUpdate(); });
  void checkForAppUpdate();
}

export function __resetAppUpdateForTests(): void {
  lastCheck = 0;
  announced = false;
  delete (window as unknown as { __pwaUpdateAvailable?: boolean }).__pwaUpdateAvailable;
}

const AUTO_UPDATE_KEY = 'meal-planner-auto-update';

/**
 * Should a service worker that was ALREADY waiting when the app launched be
 * applied without asking?
 *
 * Yes — once per session. Workbox re-dispatches `waiting` on every
 * registration, so a worker that never activates (it can't while any client
 * still holds the old one) would otherwise raise the update banner on every
 * single launch, indefinitely, long after the deploy. At startup there is no
 * unsaved work to protect and the answer is always "yes". The once-per-session
 * latch stops a failed activation from turning into a reload loop; after it,
 * the normal prompt takes over.
 */
export function claimStaleUpdate(): boolean {
  try {
    if (sessionStorage.getItem(AUTO_UPDATE_KEY) === '1') return false;
    sessionStorage.setItem(AUTO_UPDATE_KEY, '1');
    return true;
  } catch {
    return false; // no sessionStorage — prompt rather than risk a loop
  }
}

export function __resetStaleUpdateForTests(): void {
  try { sessionStorage.removeItem(AUTO_UPDATE_KEY); } catch { /* ignore */ }
}
