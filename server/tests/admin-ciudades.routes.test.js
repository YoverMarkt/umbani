import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const router = require('../dist/routes/admin-ciudades.routes')

// ═══════════════════════════════════════════════════════════════════════════
// LAS CIUDADES DEL SUPERADMIN (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Solo el superadmin las crea y las apaga. No se borran: apagar una la quita
// del chat y de la app sin perder a qué ciudad pertenece cada local.

const SECRET = 'ciudades-test'
let anterior
beforeEach(() => {
  anterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
})
afterEach(() => {
  vi.restoreAllMocks()
  if (anterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = anterior
})

const ADMIN = { role: 'admin', email: 'a@b.c', mfa: true }
const DUENO = { role: 'client', businessId: 'b1', urole: 'owner' }

async function correr(method, path, { claims, body = {}, params = {} } = {}) {
  const layer = router.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle)
  const req = { headers: claims ? { authorization: `Bearer ${jwt.sign(claims, SECRET)}` } : {}, body, params, query: {} }
  const out = { status: 200, body: undefined }
  const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this } }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}

describe('solo el superadmin', () => {
  it('sin sesión 401, y un dueño de local no entra', async () => {
    const lista = vi.spyOn(db, 'listCities')
    expect((await correr('get', '/api/admin/ciudades')).status).toBe(401)
    expect((await correr('get', '/api/admin/ciudades', { claims: DUENO })).status).toBe(403)
    expect((await correr('post', '/api/admin/ciudades', { claims: DUENO, body: { nombre: 'Chone' } })).status).toBe(403)
    expect(lista).not.toHaveBeenCalled()
  })
})

describe('crear y apagar', () => {
  it('lista todas, también las apagadas', async () => {
    vi.spyOn(db, 'listCities').mockResolvedValue([{ id: 'c1', name: 'Chone', active: true }, { id: 'c2', name: 'Manta', active: false }])
    const r = await correr('get', '/api/admin/ciudades', { claims: ADMIN })
    expect(r.body.ciudades).toHaveLength(2)
  })

  it('un nombre que no lo es no llega a la base; uno repetido es 409', async () => {
    const crear = vi.spyOn(db, 'createCity')
    expect((await correr('post', '/api/admin/ciudades', { claims: ADMIN, body: { nombre: 'X' } })).status).toBe(400)
    expect(crear).not.toHaveBeenCalled()
    crear.mockResolvedValue({ id: 'c3', name: 'Bahía de Caráquez', province: 'Manabí', active: true, sort: 0 })
    const r = await correr('post', '/api/admin/ciudades', { claims: ADMIN, body: { nombre: '  Bahía   de Caráquez ', provincia: 'Manabí' } })
    expect(r.status).toBe(201)
    expect(crear).toHaveBeenCalledWith({ name: 'Bahía de Caráquez', province: 'Manabí' })
    crear.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    expect((await correr('post', '/api/admin/ciudades', { claims: ADMIN, body: { nombre: 'Chone' } })).status).toBe(409)
  })

  it('apagar: un id que no es uuid no llega a la base, y una que no existe es 404', async () => {
    const activar = vi.spyOn(db, 'setCityActive').mockResolvedValue(false)
    const ruta = '/api/admin/ciudades/:id/activa'
    expect((await correr('put', ruta, { claims: ADMIN, params: { id: 'x' }, body: { activa: false } })).status).toBe(400)
    expect(activar).not.toHaveBeenCalled()
    const id = '11111111-2222-4333-8444-555555555555'
    expect((await correr('put', ruta, { claims: ADMIN, params: { id }, body: { activa: false } })).status).toBe(404)
    activar.mockResolvedValue(true)
    const r = await correr('put', ruta, { claims: ADMIN, params: { id }, body: { activa: false } })
    expect(r.body).toEqual({ activa: false })
    expect(activar).toHaveBeenLastCalledWith(id, false)
  })
})

describe('la cobertura de una ciudad (2026-10-05)', () => {
  const id = '11111111-2222-4333-8444-555555555555'
  const ruta = '/api/admin/ciudades/:id'

  it('centro y radio válidos se guardan; lo demás no llega a la base', async () => {
    const guardar = vi.spyOn(db, 'updateCityArea').mockResolvedValue(true)
    const malos = [
      { latitud: '', longitud: '-80.09', radioKm: 6 },
      { latitud: '-0.69', longitud: '200', radioKm: 6 },
      { latitud: '-0.69', longitud: '-80.09', radioKm: 0.1 },
      { latitud: '-0.69', longitud: '-80.09', radioKm: 80 },
    ]
    for (const body of malos) {
      expect((await correr('put', ruta, { claims: ADMIN, params: { id }, body })).status).toBe(400)
    }
    expect(guardar).not.toHaveBeenCalled()
    const r = await correr('put', ruta, { claims: ADMIN, params: { id }, body: { latitud: '-0.69819', longitud: '-80.09361', radioKm: '6' } })
    expect(r.status).toBe(200)
    expect(guardar).toHaveBeenCalledWith(id, { latitude: -0.69819, longitude: -80.09361, radius_km: 6 })
    guardar.mockResolvedValue(false)
    expect((await correr('put', ruta, { claims: ADMIN, params: { id }, body: { latitud: '-0.69', longitud: '-80.09', radioKm: 6 } })).status).toBe(404)
    expect((await correr('put', ruta, { claims: DUENO, params: { id }, body: { latitud: '-0.69', longitud: '-80.09', radioKm: 6 } })).status).toBe(403)
  })

  it('quién pide desde fuera: los días se acotan', async () => {
    const consulta = vi.spyOn(db, 'coverageRequests').mockResolvedValue([])
    await correr('get', '/api/admin/ciudades/sin-cobertura', { claims: ADMIN })
    expect(consulta).toHaveBeenLastCalledWith(30)
  })
})
