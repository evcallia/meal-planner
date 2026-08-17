import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assetFingerprint, checkForAppUpdate, currentFingerprint,
  claimStaleUpdate, __resetAppUpdateForTests, __resetStaleUpdateForTests,
} from '../appUpdate';

// Regression cover for the false "update available" banner: a redeploy of
// unchanged code must not look like a new build.

const html = (assets: string[]) => `<!doctype html><html><head>${
  assets.filter(a => a.endsWith('.css')).map(a => `<link rel="stylesheet" href="${a}">`).join('')
}</head><body><div id="root"></div>${
  assets.filter(a => a.endsWith('.js')).map(a => `<script type="module" src="${a}"></script>`).join('')
}</body></html>`;

/** Put the given assets in the live document, as a loaded build would. */
function loadPage(assets: string[]) {
  document.head.replaceChildren();
  document.body.replaceChildren();
  for (const asset of assets) {
    if (asset.endsWith('.css')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = asset;
      document.head.append(link);
    } else {
      const script = document.createElement('script');
      script.type = 'module';
      script.src = asset;
      document.body.append(script);
    }
  }
}

const serve = (body: string, ok = true) =>
  vi.fn().mockResolvedValue({ ok, text: async () => body } as Response);

beforeEach(() => {
  __resetAppUpdateForTests();
  document.head.replaceChildren();
  document.body.replaceChildren();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('assetFingerprint', () => {
  it('is the sorted set of hashed asset URLs', () => {
    const doc = new DOMParser().parseFromString(html(['/assets/index-AAA.js', '/assets/index-BBB.css']), 'text/html');
    expect(assetFingerprint(doc)).toBe('/assets/index-AAA.js|/assets/index-BBB.css');
  });

  it('ignores tag order, so markup shuffling is not a new build', () => {
    const a = new DOMParser().parseFromString(html(['/assets/x-1.js', '/assets/y-2.js']), 'text/html');
    const b = new DOMParser().parseFromString(html(['/assets/y-2.js', '/assets/x-1.js']), 'text/html');
    expect(assetFingerprint(a)).toBe(assetFingerprint(b));
  });

  it('ignores non-asset scripts and links', () => {
    const doc = new DOMParser().parseFromString(
      '<html><head><link rel="manifest" href="/manifest.webmanifest"></head>'
      + '<body><script src="/recover.js"></script><script src="/assets/index-AAA.js"></script></body></html>',
      'text/html',
    );
    expect(assetFingerprint(doc)).toBe('/assets/index-AAA.js');
  });

  it('is empty for a document with no assets', () => {
    expect(assetFingerprint(new DOMParser().parseFromString('<html><body>hi</body></html>', 'text/html'))).toBe('');
  });
});

describe('checkForAppUpdate', () => {
  it('stays quiet when the server serves the same build', async () => {
    const assets = ['/assets/index-AAA.js', '/assets/index-BBB.css'];
    loadPage(assets);
    vi.stubGlobal('fetch', serve(html(assets)));
    const listener = vi.fn();
    window.addEventListener('pwa-update-available', listener);

    expect(await checkForAppUpdate()).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener('pwa-update-available', listener);
  });

  it('announces once when the served bundle differs', async () => {
    loadPage(['/assets/index-AAA.js', '/assets/index-BBB.css']);
    vi.stubGlobal('fetch', serve(html(['/assets/index-ZZZ.js', '/assets/index-BBB.css'])));
    const listener = vi.fn();
    window.addEventListener('pwa-update-available', listener);

    expect(await checkForAppUpdate()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect((window as unknown as { __pwaUpdateAvailable?: boolean }).__pwaUpdateAvailable).toBe(true);

    // Sticky: further checks don't re-announce.
    expect(await checkForAppUpdate()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener('pwa-update-available', listener);
  });

  it('notices a CSS-only change', async () => {
    loadPage(['/assets/index-AAA.js', '/assets/index-BBB.css']);
    vi.stubGlobal('fetch', serve(html(['/assets/index-AAA.js', '/assets/index-CCC.css'])));
    expect(await checkForAppUpdate()).toBe(true);
  });

  it('throttles repeat checks', async () => {
    const assets = ['/assets/index-AAA.js'];
    loadPage(assets);
    const fetchMock = serve(html(assets));
    vi.stubGlobal('fetch', fetchMock);

    await checkForAppUpdate();
    await checkForAppUpdate();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the service worker cache', async () => {
    loadPage(['/assets/index-AAA.js']);
    const fetchMock = serve(html(['/assets/index-AAA.js']));
    vi.stubGlobal('fetch', fetchMock);
    await checkForAppUpdate();

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/^\/index\.html\?t=\d+$/); // query keeps it off the precache
    expect(init).toMatchObject({ cache: 'no-store' });
  });

  // An auth proxy answering with its own login page must not read as a release.
  it('ignores an HTML response with no hashed assets', async () => {
    loadPage(['/assets/index-AAA.js']);
    vi.stubGlobal('fetch', serve('<html><body>Sign in to continue</body></html>'));
    expect(await checkForAppUpdate()).toBe(false);
  });

  it('stays quiet on a non-ok response', async () => {
    loadPage(['/assets/index-AAA.js']);
    vi.stubGlobal('fetch', serve('', false));
    expect(await checkForAppUpdate()).toBe(false);
  });

  it('stays quiet when offline', async () => {
    loadPage(['/assets/index-AAA.js']);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    expect(await checkForAppUpdate()).toBe(false);
  });

  it('never guesses when this tab has no assets to compare', async () => {
    const fetchMock = serve(html(['/assets/index-ZZZ.js']));
    vi.stubGlobal('fetch', fetchMock);
    expect(await checkForAppUpdate()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('currentFingerprint', () => {
  it('reports the running build', () => {
    loadPage(['/assets/index-AAA.js']);
    expect(currentFingerprint()).toBe('/assets/index-AAA.js');
  });
});

// A worker parked in `waiting` re-announces itself on every registration, so
// without this latch the update banner returns on every launch forever.
describe('claimStaleUpdate', () => {
  beforeEach(() => { __resetStaleUpdateForTests(); });

  it('claims a leftover update once, then defers to the prompt', () => {
    expect(claimStaleUpdate()).toBe(true);
    expect(claimStaleUpdate()).toBe(false);
    expect(claimStaleUpdate()).toBe(false);
  });

  it('claims again in a fresh session', () => {
    expect(claimStaleUpdate()).toBe(true);
    __resetStaleUpdateForTests();
    expect(claimStaleUpdate()).toBe(true);
  });

  it('declines rather than risk a loop when sessionStorage is unavailable', () => {
    // Private browsing / blocked storage throws on access.
    const real = window.sessionStorage;
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    try {
      expect(claimStaleUpdate()).toBe(false);
    } finally {
      Object.defineProperty(window, 'sessionStorage', { configurable: true, value: real });
    }
  });
});
