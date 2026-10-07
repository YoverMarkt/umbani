import { afterEach, beforeEach, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import clientsRouterCompilado from '../dist/routes/admin-clients.routes.js'

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE COMPARTEN LAS PRUEBAS DE LAS RUTAS DE LOCALES DEL SUPERADMIN
// ═══════════════════════════════════════════════════════════════════════════
//
// Vivían en un solo archivo de 1.141 líneas; se partieron por lo que prueban
// el 2026-10-07 (ningún archivo pasa de 1.000): la plataforma, el alta y las
// fichas. Esto es lo que usan todas.

const require = createRequire(import.meta.url)
export const db = require('../dist/db')
export const bcrypt = require('bcryptjs')
export const JWT_SECRET = 'admin-clients-test-secret'
export const clientsRouter = clientsRouterCompilado

/** El entorno de cada prueba. Se llama arriba de cada archivo: registra sus `beforeEach`/`afterEach`. */
export function prepararElEntorno() {
  let originalJwtSecret
  let originalYCloudWebhookSecret
  let originalYCloudWebhookEndpointId

  beforeEach(() => {
    originalJwtSecret = process.env.JWT_SECRET
    originalYCloudWebhookSecret = process.env.YCLOUD_WEBHOOK_SECRET
    originalYCloudWebhookEndpointId = process.env.YCLOUD_WEBHOOK_ENDPOINT_ID
    process.env.JWT_SECRET = JWT_SECRET
    process.env.YCLOUD_WEBHOOK_SECRET = 'ycloud-signing-secret-test'
    process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = 'ycloud-endpoint-test'
    // El alta busca un slug libre, así que consulta la base. Sin este simulacro
    // la ruta llamaría a Supabase de verdad y el test se quedaba colgado hasta
    // agotar el tiempo — que es exactamente lo que pasó al añadirlo.
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
    else process.env.JWT_SECRET = originalJwtSecret
    if (originalYCloudWebhookSecret === undefined) delete process.env.YCLOUD_WEBHOOK_SECRET
    else process.env.YCLOUD_WEBHOOK_SECRET = originalYCloudWebhookSecret
    if (originalYCloudWebhookEndpointId === undefined) {
      delete process.env.YCLOUD_WEBHOOK_ENDPOINT_ID
    } else {
      process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = originalYCloudWebhookEndpointId
    }
  })
}

export function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, mfa: true, businessId: 'business-a' }, JWT_SECRET)}`
}

export async function dispatch(method, path, { auth, body = {}, params = {}, query = {} } = {}) {
  const layer = clientsRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  if (!layer) throw new Error(`Ruta no encontrada: ${method.toUpperCase()} ${path}`)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}
