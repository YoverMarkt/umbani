import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const settings = require('../dist/services/settings')
const router = require('../dist/routes/repartidores.routes')
const adminMoto = require('../dist/routes/admin-motorizados.routes')

// ═══════════════════════════════════════════════════════════════════════════
// LOS REPARTIDORES DEL LOCAL (2026-10-02)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que defienden, por orden de lo que costaría fallar:
//   1. Un local NO toca a los repartidores de otro: el negocio sale del JWT.
//   2. APAGADO de verdad: sin el interruptor, la API no existe (404).
//   3. Solo el dueño.

const SECRET = 'repartidores-test'
let anterior
beforeEach(() => {
  anterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
  vi.spyOn(settings, 'get').mockImplementation(async clave => (clave === 'flota_del_local' ? '1' : null))
})
afterEach(() => {
  vi.restoreAllMocks()
  if (anterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = anterior
})

const DUENO = { role: 'client', businessId: 'b1', urole: 'owner' }

async function correr(r, method, path, { claims, body = {}, params = {}, query = {}, headers = {} } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle)
  const req = {
    headers: { ...(claims ? { authorization: `Bearer ${jwt.sign(claims, SECRET)}` } : {}), ...headers },
    body, params, query,
  }
  const out = { status: 200, body: undefined }
  const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this } }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}

describe('apagado de verdad', () => {
  it('con el interruptor apagado la API no existe, aunque seas el dueño', async () => {
    settings.get.mockImplementation(async () => '0')
    const lista = await correr(router, 'get', '/api/client/repartidores', { claims: DUENO })
    const alta = await correr(router, 'post', '/api/client/repartidores', { claims: DUENO, body: { nombre: 'Ana', telefono: '593991111111' } })
    expect(lista.status).toBe(404)
    expect(alta.status).toBe(404)
  })

  it('si no se puede leer el interruptor, también 404 (falla cerrado)', async () => {
    settings.get.mockRejectedValue(new Error('base caída'))
    const lista = await correr(router, 'get', '/api/client/repartidores', { claims: DUENO })
    expect(lista.status).toBe(404)
  })
})

describe('solo el dueño, y solo su negocio', () => {
  it('un empleado no ve los repartidores', async () => {
    const r = await correr(router, 'get', '/api/client/repartidores', {
      claims: { role: 'client', businessId: 'b1', urole: 'employee', perms: ['ventas'] },
    })
    expect(r.status).toBe(403)
  })

  it('la lista y el efectivo salen del negocio del JWT, nunca de la petición', async () => {
    const lista = vi.spyOn(db, 'listFleetCouriers').mockResolvedValue([
      { id: 'r1', name: 'Ana', phone: '593991111111', vehicle: 'Moto', active: true, available: false, fleet_business_id: 'b1', cash_limit_cents: 15000 },
    ])
    const efectivo = vi.spyOn(db, 'fleetCash').mockResolvedValue(new Map([['r1', { enCursoCents: 1250, cobradoHoyCents: 3400, entregasHoy: 2 }]]))
    const r = await correr(router, 'get', '/api/client/repartidores', { claims: DUENO, query: { businessId: 'OTRO' } })
    expect(r.status).toBe(200)
    expect(lista).toHaveBeenCalledWith('b1')
    expect(efectivo.mock.calls[0][0]).toBe('b1')
    expect(efectivo.mock.calls[0][1]).toEqual(['r1'])
    expect(r.body.repartidores[0]).toMatchObject({ nombre: 'Ana', efectivoEnCursoCents: 1250, cobradoHoyCents: 3400, entregasHoy: 2 })
  })

  it('el repartidor nuevo entra en la flota del negocio del JWT, aunque el cuerpo diga otra', async () => {
    const crear = vi.spyOn(db, 'createCourier').mockResolvedValue({ id: 'r2', name: 'Luis', phone: '593992222222', vehicle: null, active: true })
    const r = await correr(router, 'post', '/api/client/repartidores', {
      claims: DUENO, body: { nombre: 'Luis', telefono: '593 99 222 2222', fleetBusinessId: 'OTRO', flotaLocalId: 'OTRO' },
    })
    expect(r.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(expect.objectContaining({ fleetBusinessId: 'b1', phone: '593992222222' }))
  })

  it('un teléfono ya registrado (aquí o en otro local) responde lo mismo, sin decir de quién', async () => {
    vi.spyOn(db, 'createCourier').mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const r = await correr(router, 'post', '/api/client/repartidores', { claims: DUENO, body: { nombre: 'Luis', telefono: '593992222222' } })
    expect(r.status).toBe(409)
    expect(r.body.error).toBe('Ese teléfono ya está registrado como repartidor')
  })

  it('datos malos no llegan a la base', async () => {
    const crear = vi.spyOn(db, 'createCourier')
    const sinNombre = await correr(router, 'post', '/api/client/repartidores', { claims: DUENO, body: { nombre: 'A', telefono: '593992222222' } })
    const sinTelefono = await correr(router, 'post', '/api/client/repartidores', { claims: DUENO, body: { nombre: 'Luis', telefono: '123' } })
    expect(sinNombre.status).toBe(400)
    expect(sinTelefono.status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
  })

  it('activar o desactivar al repartidor de OTRO local responde 404, igual que uno que no existe', async () => {
    const cambiar = vi.spyOn(db, 'setFleetCourierActive').mockResolvedValue(false)
    const id = '11111111-2222-4333-8444-555555555555'
    const r = await correr(router, 'put', '/api/client/repartidores/:id/activo', { claims: DUENO, params: { id }, body: { activo: false } })
    expect(r.status).toBe(404)
    expect(cambiar).toHaveBeenCalledWith('b1', id, false)
  })
})

describe('el superadmin ve las carreras de un motorizado', () => {
  const admin = { role: 'admin', email: 'a@b.c', mfa: true }

  it('pide las carreras del motorizado de la URL', async () => {
    const consulta = vi.spyOn(db, 'listCourierRuns').mockResolvedValue([{ order_id: 'o1', reparto_cents: 150, retenido: false }])
    const id = '11111111-2222-4333-8444-555555555555'
    const r = await correr(adminMoto, 'get', '/api/admin/motorizados/:id/carreras', { claims: admin, params: { id } })
    expect(r.status).toBe(200)
    expect(consulta).toHaveBeenCalledWith(id)
    expect(r.body.carreras).toHaveLength(1)
  })

  it('un id que no es uuid no llega a la base, y sin admin, nada', async () => {
    const consulta = vi.spyOn(db, 'listCourierRuns')
    const malo = await correr(adminMoto, 'get', '/api/admin/motorizados/:id/carreras', { claims: admin, params: { id: 'x' } })
    const sinAdmin = await correr(adminMoto, 'get', '/api/admin/motorizados/:id/carreras', { claims: DUENO, params: { id: '11111111-2222-4333-8444-555555555555' } })
    expect(malo.status).toBe(400)
    expect(sinAdmin.status).toBe(403)
    expect(consulta).not.toHaveBeenCalled()
  })
})
