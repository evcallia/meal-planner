// Self-heal for stale service-worker deployments.
//
// The SW serves index.html + hashed chunks from its precache. A deploy
// replaces the server's dist/, deleting old hashed chunks — so a device whose
// SW/cache is stale can end up loading a cached index.html that references
// chunks the server no longer has: 404 → permanent white page, and the
// in-app update prompt can never run because the app never boots.
//
// This file is deliberately tiny, ES5-only, and loaded before the app bundle:
// if an /assets/ script fails to load, unregister every service worker, wipe
// Cache Storage, and reload once — the network then serves the current build.
(function () {
  var KEY = 'mp-recovered-at';

  function recover() {
    // Never recover while offline: the SW cache is the only thing keeping the
    // app alive, and wiping it would turn a partial failure into a total one.
    // A network-reachable device retries on its next (online) load instead.
    if (navigator.onLine === false) return;
    try {
      var last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60000) return; // one attempt per minute — no reload loops
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch (e) { /* storage unavailable — still attempt recovery */ }

    var work = [];
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        work.push(navigator.serviceWorker.getRegistrations().then(function (rs) {
          return Promise.all(rs.map(function (r) { return r.unregister(); }));
        }));
      }
      if (window.caches && caches.keys) {
        work.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }));
      }
    } catch (e) { /* best effort */ }

    Promise.all(work).then(
      function () { location.reload(); },
      function () { location.reload(); }
    );
  }

  // Capture-phase listener sees resource load errors (they don't bubble).
  window.addEventListener('error', function (e) {
    var t = e && e.target;
    if (t && t.tagName === 'SCRIPT' && t.src && t.src.indexOf('/assets/') !== -1) {
      recover();
    }
  }, true);

  // Vite dispatches this when a dynamic import / preload fails.
  window.addEventListener('vite:preloadError', recover);
})();
