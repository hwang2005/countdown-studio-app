/**
 * @file sw.js
 * Service Worker for Countdown Studio PWA.
 * Uses Network-First with offline Cache fallback so updates load immediately
 * while full offline capability is preserved when disconnected.
 */

const CACHE_NAME = 'countdown-studio-v2.2.0';

const CORE_ASSETS = [
  './',
  './index.html',
  './solo.html',
  './versus-display.html',
  './versus-host.html',
  './tests/index.html',
  './manifest.webmanifest',
  './assets/icon.svg',
  './assets/stage-bg.svg',
  './css/base.css',
  './css/theme.css',
  './css/components.css',
  './css/display.css',
  './css/animations.css',
  './js/i18n.js',
  './js/core/state.js',
  './js/core/events.js',
  './js/core/storage.js',
  './js/core/audio.js',
  './js/core/clock.js',
  './js/core/rng.js',
  './js/game/letters.js',
  './js/game/numbers.js',
  './js/game/conundrum.js',
  './js/game/scoring.js',
  './js/game/schedule.js',
  './js/solver/trie.js',
  './js/solver/wordSolver.js',
  './js/solver/numbersSolver.js',
  './js/ui/tiles.js',
  './js/ui/board.js',
  './js/ui/scoreboard.js',
  './js/ui/modal.js',
  './js/ui/toast.js',
  './js/ui/a11y.js',
  './js/net/sync.js',
  './js/net/dictionaryApi.js',
  './js/app-home.js',
  './js/app-solo.js',
  './js/app-display.js',
  './js/app-host.js',
  './data/letterDistribution.json',
  './data/conundrums.json',
  './data/words.txt',
  './data/LICENSE-words.txt'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.allSettled(CORE_ASSETS.map((url) => cache.add(url).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  // Network-first with offline cache fallback
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503, statusText: 'Offline' });
        })
      )
  );
});
