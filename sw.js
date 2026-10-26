/**
 * Офлайн-кэш сайта.
 *
 * Сайты-сёстры живут на одном домене (stellasdeutsch-dev.github.io) в
 * разных папках, поэтому имя кэша включает папку: иначе один сайт стирал
 * бы кэш другого при обновлении.
 *
 * Стратегия — сначала сеть, кэш только когда сети нет. Так обновления
 * доходят сразу, а не через одно лишнее открытие. cache: 'no-cache' нужен
 * из-за GitHub Pages: он отдаёт файлы с max-age=600, и без этого «сеть»
 * десять минут возвращала бы старую копию из HTTP-кэша браузера.
 */

const SCOPE = new URL(self.registration.scope).pathname;
const CACHE = `planner:${SCOPE}`;

const FILES = [
  './',
  'index.html',
  'favicon.svg',
  'css/app.css',
  'js/app.js', 'js/assistant.js', 'js/calendar.js', 'js/chat.js', 'js/content.js',
  'js/exporter.js', 'js/intake.js', 'js/pdf.js', 'js/plan.js', 'js/sanitize.js',
  'js/site.js', 'js/steps.js', 'js/stepview.js', 'js/store.js', 'js/timeline.js', 'js/utils.js',
  'fonts/inter-cyrillic.woff2', 'fonts/inter-latin.woff2', 'fonts/inter-latin-ext.woff2',
  'fonts/pdf-regular.ttf', 'fonts/pdf-semibold.ttf',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  if (!new URL(request.url).pathname.startsWith(SCOPE)) return;

  event.respondWith(
    fetch(request, { cache: 'no-cache' })
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(request, { ignoreSearch: true });
        if (hit) return hit;
        const page = request.mode === 'navigate' ? await cache.match('./') : undefined;
        return page ?? Response.error();
      })
  );
});
