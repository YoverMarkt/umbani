import { createRequire } from 'node:module'

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE COMPARTEN LAS PRUEBAS DE LAS RUTAS DE LA TIENDA (2026-10-07)
// ═══════════════════════════════════════════════════════════════════════════
//
// Las pruebas de la mini app vivían en un solo archivo de 1.279 líneas; se
// partieron por lo que prueban (ningún archivo pasa de 1.000). Esto es lo que
// usan varias: el router, la base y cómo ejecutar un manejador.

const require = createRequire(import.meta.url)

export const router = require('../dist/routes/storefront.routes')
export const db = require('../dist/db')

export const rutas = router.stack
  .filter(layer => layer.route)
  .map(layer => ({
    path: layer.route.path,
    // El primer handler es el propio router; los middlewares van antes del final.
    handlers: layer.route.stack.length,
  }))

// Ejecuta un manejador saltándose los middlewares: la sesión ya se comprueba
// en las pruebas de cableado y en storefront-session.test.js.
export async function ejecutar(path, method, { storefront, storeBusinessId, body = {}, params = {} } = {}) {
  const layer = router.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handler = layer.route.stack.at(-1).handle
  // ⚠️ `storeBusinessId` NO es lo mismo que `storefront.businessId`. Las rutas
  // públicas —catálogo y cotización— se ven sin enlace, así que su middleware
  // (`readStorefrontSession`) resuelve el negocio por el slug y lo deja ahí.
  // Pasar solo `storefront` las deja cotizando con `undefined`, y como los
  // simulacros responden igual a cualquier id, la prueba pasaba en falso.
  const req = { storefront, storeBusinessId, body, params, query: {}, headers: {} }
  const resultado = { status: 200, body: undefined }
  const res = {
    status(code) { resultado.status = code; return this },
    json(value) { resultado.body = value; return this },
  }
  await handler(req, res, error => { if (error) throw error })
  return resultado
}

export const NEGOCIO_ABIERTO = {
  id: 'negocio-a', slug: 'pizzeria', name: 'Pizzería',
  takes_orders: true, storefront_enabled: true, active: true, suspended: false,
}
