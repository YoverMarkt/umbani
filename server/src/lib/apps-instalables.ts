import path from 'node:path'
import type { Express, Response } from 'express'

// ═══════════════════════════════════════════════════════════════════════════
// LAS APPS INSTALABLES: DÓNDE VIVE SU SERVICE WORKER (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// `/u` (clientes) y `/r` (repartidores) se instalan en el teléfono como una
// app más (ver `apps/store/src/lib/app-instalable.ts`). Cada una necesita un
// service worker que controle SU dirección, y el navegador solo deja que uno
// controle la carpeta donde vive, o lo que el servidor le permita con
// `Service-Worker-Allowed`. `/u/sw.js` vive en `/u/` y tiene que controlar
// `/u`, sin barra: de ahí la cabecera.
//
// ⚠️ ESTAS RUTAS VAN ANTES QUE LOS COMODINES `/u/*` Y `/r/*`. El comodín
// responde la página de la app a CUALQUIER cosa bajo `/u`: montadas después,
// `/u/sw.js` devolvería el HTML de la app, el navegador lo rechazaría por no
// ser JavaScript y la app dejaría de poder instalarse sin que nada fallara a
// la vista. Lo vigilan `apps-instalables.test.js` (que lee `index.ts`) y el
// humo de producción (que lo pide de verdad).

export const APPS_INSTALABLES = ['/u', '/r'] as const

export function enviarServiceWorker(response: Response, archivo: string, alcance: string): void {
  // El navegador ya lo revisa cada vez que se abre la app; `no-cache` evita
  // que un intermediario lo guarde por su cuenta y retrase una corrección.
  response.setHeader('Cache-Control', 'no-cache')
  response.setHeader('Service-Worker-Allowed', alcance)
  response.type('text/javascript')
  response.sendFile(archivo)
}

export function montarAppsInstalables(app: Express, storeDist: string): void {
  // Un solo archivo para las dos apps: lo que cambia es su alcance.
  const archivo = path.join(storeDist, 'sw.js')
  for (const alcance of APPS_INSTALABLES) {
    app.get(`${alcance}/sw.js`, (_req, res) => enviarServiceWorker(res, archivo, alcance))
  }
}
