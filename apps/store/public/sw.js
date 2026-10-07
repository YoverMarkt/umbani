// ═══════════════════════════════════════════════════════════════════════════
// EL SERVICE WORKER DE LAS APPS INSTALABLES (`/u` y `/r`, 2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo sirve el servidor en `/u/sw.js` y en `/r/sw.js`
// (`server/src/lib/apps-instalables.ts`): el mismo archivo, un registro por
// app.
//
// Hace DOS cosas y ninguna más:
//   1. Existir. Con él, Android ofrece instalar la app y la abre como una más.
//      Las notificaciones push llegarán también por aquí.
//   2. Si al abrir una pantalla no hay red, enseñar «Sin conexión» en vez de la
//      página de error del navegador.
//
// ⚠️ NO GUARDA NADA MÁS, y es a propósito. Ni la API —los precios, los pedidos
// y la sesión salen SIEMPRE del servidor— ni el HTML: un HTML guardado
// congelaría la app en una versión vieja, la misma razón por la que el servidor
// lo manda con `no-store` (`server/src/lib/cache-estaticos.ts`).
//
// ⚠️ Si cambia `sin-conexion.html`, sube la versión del cajón: el navegador
// solo vuelve a instalar el service worker cuando cambia ESTE archivo.

const CAJON = 'umbani-sin-red-v1'
const SIN_RED = '/t/sin-conexion.html'

self.addEventListener('install', (evento) => {
  evento.waitUntil(
    caches.open(CAJON)
      .then((cajon) => cajon.add(new Request(SIN_RED, { cache: 'reload' })))
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (evento) => {
  evento.waitUntil((async () => {
    const viejos = (await caches.keys()).filter((nombre) => nombre !== CAJON)
    await Promise.all(viejos.map((nombre) => caches.delete(nombre)))
    // Pide la pantalla a la red MIENTRAS arranca el service worker, no
    // después: así tenerlo no hace más lenta la app.
    if (self.registration.navigationPreload) await self.registration.navigationPreload.enable()
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (evento) => {
  // Solo las pantallas. La API, las fotos y los archivos van a la red como si
  // el service worker no existiera.
  if (evento.request.mode !== 'navigate') return
  evento.respondWith((async () => {
    try {
      const adelantada = await evento.preloadResponse
      return adelantada || await fetch(evento.request)
    } catch {
      return (await caches.match(SIN_RED)) || Response.error()
    }
  })())
})
