import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import salesRouter from '../dist/routes/sales.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'sales-routes-test-secret'

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

function authorization(claims = {}) {
  const token = jwt.sign({
    role: 'client',
    businessId: 'business-a',
    userId: 'user-a',
    urole: 'owner',
    ...claims,
  }, JWT_SECRET)
  return `Bearer ${token}`
}

async function dispatch(method, path, { auth, body = {}, query = {}, params = {} } = {}) {
  const routeLayer = salesRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, query, params }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(responseBody) { result.body = responseBody; return this },
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

describe('rutas de ventas', () => {
  // Quedan dos: consultar el historial de un contacto y anular una venta. El
  // alta manual y su cotización se retiraron con el estándar de ventas.
  it('protege los endpoints con autenticación y permiso ventas', async () => {
    const routes = [
      ['post', '/api/client/sales/:id/void'],
      ['get', '/api/client/sales'],
    ]
    for (const [method, path] of routes) {
      const layer = salesRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      ))
      expect(layer.route.stack).toHaveLength(3)
    }

    // Y las retiradas no pueden reaparecer sin que alguien lo note: eran el
    // cuarto camino por el que entraba dinero sin pedido ni cita detrás.
    for (const [method, path] of [
      ['post', '/api/client/sales'],
      ['get', '/api/client/sessions/:phone/quote'],
    ]) {
      expect(salesRouter.stack.find(item => (
        item.route?.path === path && item.route?.methods?.[method]
      )), `${method} ${path} volvió a existir`).toBeUndefined()
    }

    expect((await dispatch('get', '/api/client/sales')).status).toBe(401)
    const employee = authorization({ urole: 'employee', perms: ['citas'] })
    expect((await dispatch('get', '/api/client/sales', { auth: employee })).status).toBe(403)
  })






  it('anula y consulta ventas usando únicamente el negocio del JWT', async () => {
    const voidSale = vi.spyOn(db, 'voidSale').mockResolvedValue({ error: null })
    const getSales = vi.spyOn(db, 'getSalesByContact').mockResolvedValue([{ id: 'sale-a' }])
    const auth = authorization()

    await dispatch('post', '/api/client/sales/:id/void', {
      auth, params: { id: 'sale-a' }, body: { businessId: 'business-b' },
    })
    const empty = await dispatch('get', '/api/client/sales', { auth })
    const listed = await dispatch('get', '/api/client/sales', {
      auth,
      query: { phone: encodeURIComponent('+593999000001'), businessId: 'business-b' },
    })

    expect(voidSale).toHaveBeenCalledWith('business-a', 'sale-a')
    expect(empty.body).toEqual([])
    expect(getSales).toHaveBeenCalledOnce()
    expect(getSales).toHaveBeenCalledWith('business-a', '+593999000001')
    expect(listed.body).toEqual([{ id: 'sale-a' }])
  })

  it('un pedido de la APP no lo anula el local: la base dice que no y se le explica (2026-10-11)', async () => {
    vi.spyOn(db, 'voidSale').mockResolvedValue({
      error: { code: '42501', message: 'Los pedidos de la app solo los anula Umbani.' },
    })
    const response = await dispatch('post', '/api/client/sales/:id/void', {
      auth: authorization(), params: { id: 'sale-a' },
    })
    expect(response.status).toBe(403)
    expect(response.body.error).toMatch(/solo Umbani puede anularlo/)
  })

  it('no confirma una anulación rechazada por Supabase', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(db, 'voidSale').mockResolvedValue({
      error: { message: 'detalle interno PostgreSQL' },
    })

    const response = await dispatch('post', '/api/client/sales/:id/void', {
      auth: authorization(), params: { id: 'sale-a' },
    })

    expect(response).toEqual({
      status: 500, body: { error: 'No se pudo anular la venta' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })
})
