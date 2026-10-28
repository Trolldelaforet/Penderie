/* Penderie : fonctionnement hors ligne. Changer VERSION Ã  chaque mise Ã  jour de l'appli. */
const VERSION = 'penderie-v4';
const TOOLS = 'penderie-detecteur'; // moteur et modÃ¨le de dÃ©tection de posture, gardÃ©s d'une version Ã  l'autre
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'calib-presets.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== TOOLS).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  /* dÃ©tecteur : cache d'abord, il ne change pas (version figÃ©e) */
  if (url.href.startsWith('https://cdn.jsdelivr.net/npm/@mediapipe/') || url.href.startsWith('https://storage.googleapis.com/mediapipe-models/')) {
    e.respondWith(caches.open(TOOLS).then(c => c.match(e.request).then(hit => hit || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }))));
    return;
  }
  /* appli : rÃ©seau d'abord pour rÃ©cupÃ©rer les mises Ã  jour, cache si pas de rÃ©seau */
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
  );
});
