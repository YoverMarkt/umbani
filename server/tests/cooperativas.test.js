import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const bcrypt = require('bcryptjs')
const guardia = require('../dist/middleware/auth-cooperativa')
const panel = require('../dist/routes/cooperativa.routes')
const adminCoop = require('../dist/routes/admin-cooperativas.routes')
const adminClientes = require('../dist/routes/admin-clients.routes')
const appMoto = require('../dist/routes/app-motorizado.routes')
const sesionApp = require('../dist/services/sesion-app')

// ═══════════════════════════════════════════════════════════════════════════
// LAS COOPERATIVAS DE REPARTO (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Qué motorizado lleva qué pedido, y el dinero, se prueban en PostgreSQL real
// (bloque «LAS COOPERATIVAS» de verify:schema). Aquí:
//   · su sesión: el token dice quién es y la base, cada 15 s, si sigue activo;
//   · el AISLAMIENTO: el id de la cooperativa sale de la sesión, nunca de la
//     petición, y una cooperativa no toca lo de otra;
//   · lo que ve y descarga, sin datos de clientes;
//   · el superadmin, y «Quién reparte: la cooperativa» en la ficha del local.

const SECRET = 'cooperativas-test'
const COOP = '11111111-1111-4111-8111-111111111111'
const OTRA = '22222222-2222-4222-8222-222222222222'
const CHONE = '33333333-3333-4333-8333-333333333333'
const PORTO = '44444444-4444-4444-8444-444444444444'
const MOTO = '55555555-5555-4555-8555-555555555555'

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

/** Corre una ruta entera (frenos, guardia y manejador) con una petición falsa. */
async function correr(r, method, path, { headers = {}, body = {}, params = {}, query = {}, soloElUltimo = false } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  if (!layer) throw new Error(`Ruta no encontrada: ${method} ${path}`)
  const todos = layer.route.stack.map(l => l.handle)
  const handlers = soloElUltimo ? todos.slice(-1) : todos
  const req = { headers, body, params, query, ip: '1.1.1.1' }
  const out = { status: 200, body: undefined, headers: {} }
  const res = {
    status(c) { out.status = c; return this },
    json(v) { out.body = v; return this },
    send(v) { out.body = v; return this },
    setHeader(k, v) { out.headers[String(k).toLowerCase()] = v },
  }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}

// Un usuario distinto en cada sesión: la guardia recuerda 15 s a quien ya miró.
let n = 0
const sesionDe = (claims = {}) => ({
  authorization: `Bearer ${jwt.sign({ role: 'cooperativa', cooperativeId: COOP, userId: `u-${++n}`, email: 'coop@umbani.ec', ...claims }, SECRET)}`,
})
const admin = () => ({ authorization: `Bearer ${jwt.sign({ role: 'admin', mfa: true }, SECRET)}` })
const cooperativa = { id: COOP, name: 'Cooperativa Chone', city_id: CHONE, contact_phone: null, active: true, cities: { name: 'Chone' } }

/** La cooperativa y su usuario, activos: lo que la guardia pregunta. */
function activa() {
  vi.spyOn(db, 'getCooperativeUserById').mockImplementation(async (coop, userId) => ({ id: userId, cooperative_id: coop, active: true }))
  vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
}

describe('la sesión de la cooperativa', () => {
  const pedir = async (guard, headers) => {
    const req = { headers }
    const out = { status: 200, body: undefined, siguio: false }
    const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this } }
    await guard(req, res, () => { out.siguio = true })
    return { ...out, req }
  }
  const baseActiva = () => ({
    getCooperativeUserById: vi.fn(async (coop, userId) => ({ id: userId, cooperative_id: coop, active: true })),
    getCooperative: vi.fn(async () => ({ active: true })),
  })

  it('sin token, con un token de otro panel o caducado: no entra', async () => {
    const guard = guardia.createCooperativeGuard({ database: baseActiva() })
    expect((await pedir(guard, {})).status).toBe(401)
    const delLocal = jwt.sign({ role: 'client', businessId: 'b1', userId: 'u1' }, SECRET)
    expect((await pedir(guard, { authorization: `Bearer ${delLocal}` })).status).toBe(401)
    const caducado = jwt.sign({ role: 'cooperativa', cooperativeId: COOP, userId: 'u1', exp: 1 }, SECRET)
    expect((await pedir(guard, { authorization: `Bearer ${caducado}` })).status).toBe(401)
    const otroSecreto = jwt.sign({ role: 'cooperativa', cooperativeId: COOP, userId: 'u1' }, 'otro')
    expect((await pedir(guard, { authorization: `Bearer ${otroSecreto}` })).status).toBe(401)
  })

  it('entra, y la cooperativa de la sesión sale del token', async () => {
    const guard = guardia.createCooperativeGuard({ database: baseActiva() })
    const r = await pedir(guard, sesionDe({ userId: 'u-entra' }))
    expect(r.siguio).toBe(true)
    expect(guardia.cooperativaDe(r.req)).toEqual({ cooperativeId: COOP, userId: 'u-entra', email: 'coop@umbani.ec' })
  })

  it('usuario apagado, de OTRA cooperativa, o cooperativa apagada: fuera', async () => {
    const base = baseActiva()
    const guard = guardia.createCooperativeGuard({ database: base })
    base.getCooperativeUserById.mockResolvedValueOnce({ cooperative_id: COOP, active: false })
    expect((await pedir(guard, sesionDe())).status).toBe(401)
    base.getCooperativeUserById.mockResolvedValueOnce({ cooperative_id: OTRA, active: true })
    expect((await pedir(guard, sesionDe())).status).toBe(401)
    base.getCooperative.mockResolvedValueOnce({ active: false })
    expect((await pedir(guard, sesionDe())).status).toBe(401)
  })

  it('falla CERRADO si la base no responde', async () => {
    const base = baseActiva()
    base.getCooperative.mockRejectedValue(new Error('caída'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = guardia.createCooperativeGuard({ database: base })
    const r = await pedir(guard, sesionDe())
    expect(r.status).toBe(503)
    expect(r.siguio).toBe(false)
  })

  it('apagarla le corta el panel en 15 s como mucho, sin esperar a que venza el token', async () => {
    let ahora = 1_000
    const base = baseActiva()
    const guard = guardia.createCooperativeGuard({ database: base, now: () => ahora })
    const misma = sesionDe({ userId: 'u-reloj' })
    expect((await pedir(guard, misma)).siguio).toBe(true)
    base.getCooperative.mockResolvedValue({ active: false })
    ahora += 10_000
    expect((await pedir(guard, misma)).siguio).toBe(true) // aún recordada
    ahora += 6_000
    expect((await pedir(guard, misma)).status).toBe(401)
  })
})

describe('el inicio de sesión de la cooperativa', () => {
  const login = body => correr(panel, 'post', '/api/cooperativa/login', { body, soloElUltimo: true })

  it('tiene su freno de intentos, como el del local', () => {
    const ruta = panel.stack.find(l => l.route?.path === '/api/cooperativa/login')
    expect(ruta.route.stack).toHaveLength(2)
  })

  it('un correo que no existe y una clave mala dicen lo mismo', async () => {
    const buscar = vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue(null)
    const r1 = await login({ email: 'nadie@x.ec', password: 'cualquier-cosa-larga' })
    vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
    buscar.mockResolvedValue({ id: 'u1', cooperative_id: COOP, email: 'coop@x.ec', name: 'Ana', active: true, password_hash: await bcrypt.hash('la-clave-correcta', 4) })
    const r2 = await login({ email: 'coop@x.ec', password: 'otra-clave-mala!!' })
    expect(r1).toMatchObject({ status: 401, body: { error: 'Correo o contraseña incorrectos' } })
    expect(r2).toMatchObject({ status: 401, body: { error: 'Correo o contraseña incorrectos' } })
  })

  it('entra con su token de cooperativa (correo sin mayúsculas ni espacios), y nunca devuelve el hash', async () => {
    const hash = await bcrypt.hash('la-clave-correcta', 4)
    const buscar = vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue({ id: 'u1', cooperative_id: COOP, email: 'coop@x.ec', name: 'Ana', active: true, password_hash: hash })
    vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
    const r = await login({ email: '  COOP@X.EC ', password: 'la-clave-correcta' })
    expect(buscar).toHaveBeenCalledWith('coop@x.ec')
    expect(r.status).toBe(200)
    expect(jwt.verify(r.body.token, SECRET)).toMatchObject({ role: 'cooperativa', cooperativeId: COOP, userId: 'u1' })
    expect(r.body.cooperativa).toEqual({ nombre: 'Cooperativa Chone', ciudad: 'Chone' })
    expect(JSON.stringify(r.body)).not.toContain(hash)
  })

  it('con la cooperativa o el usuario apagados, no entra', async () => {
    const hash = await bcrypt.hash('la-clave-correcta', 4)
    vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue({ id: 'u1', cooperative_id: COOP, email: 'coop@x.ec', active: true, password_hash: hash })
    const coop = vi.spyOn(db, 'getCooperative').mockResolvedValue({ ...cooperativa, active: false })
    expect((await login({ email: 'coop@x.ec', password: 'la-clave-correcta' })).status).toBe(403)
    coop.mockResolvedValue(cooperativa)
    vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue({ id: 'u1', cooperative_id: COOP, email: 'coop@x.ec', active: false, password_hash: hash })
    expect((await login({ email: 'coop@x.ec', password: 'la-clave-correcta' })).status).toBe(403)
  })
})

describe('su panel: cada ruta exige su sesión', () => {
  it('sin sesión, ninguna ruta del panel responde (salvo el login)', async () => {
    const rutas = panel.stack.filter(l => l.route && l.route.path !== '/api/cooperativa/login')
    expect(rutas.length).toBe(8)
    for (const l of rutas) {
      const metodo = Object.keys(l.route.methods)[0]
      expect((await correr(panel, metodo, l.route.path, { params: { id: MOTO, semana: '2026-09-28' } })).status).toBe(401)
    }
  })
})

describe('sus motorizados', () => {
  beforeEach(activa)
  const alta = { nombre: 'Andrés Mera', telefono: '099 123 4567', vehiculo: 'Moto', cedula: '1312 345678', placa: 'mb123a' }

  it('el nuevo entra en SU cooperativa aunque la petición diga otra, con el teléfono como lo verá WhatsApp', async () => {
    const crear = vi.spyOn(db, 'createCooperativeCourier').mockResolvedValue({ id: MOTO, name: 'Andrés Mera', phone: '593991234567', active: true })
    const r = await correr(panel, 'post', '/api/cooperativa/repartidores', {
      headers: sesionDe(), body: { ...alta, cooperativeId: OTRA, cooperative_id: OTRA },
    })
    expect(r.status).toBe(201)
    expect(crear).toHaveBeenCalledWith(COOP, {
      phone: '593991234567', name: 'Andrés Mera', vehicle: 'Moto', idNumber: '1312345678', plate: 'MB123A', licenseNumber: null,
    })
  })

  it('sin sus datos (cédula, placa, vehículo, teléfono) no llega a la base', async () => {
    const crear = vi.spyOn(db, 'createCooperativeCourier')
    for (const malo of [{ cedula: '' }, { placa: 'A' }, { vehiculo: '' }, { telefono: '12' }, { nombre: 'A' }, { licencia: 'x' }]) {
      const r = await correr(panel, 'post', '/api/cooperativa/repartidores', { headers: sesionDe(), body: { ...alta, ...malo } })
      expect(r.status).toBe(400)
    }
    expect(crear).not.toHaveBeenCalled()
  })

  it('un teléfono ya registrado responde lo mismo, sin decir de quién es', async () => {
    vi.spyOn(db, 'createCooperativeCourier').mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const r = await correr(panel, 'post', '/api/cooperativa/repartidores', { headers: sesionDe(), body: alta })
    expect(r).toMatchObject({ status: 409, body: { error: 'Ese teléfono ya está registrado como repartidor' } })
  })

  it('apagar al de OTRA flota responde 404, igual que uno que no existe', async () => {
    const cambiar = vi.spyOn(db, 'setCooperativeCourierActive').mockResolvedValue(false)
    expect((await correr(panel, 'put', '/api/cooperativa/repartidores/:id/activo', { headers: sesionDe(), params: { id: MOTO }, body: { activo: false } })).status).toBe(404)
    expect(cambiar).toHaveBeenCalledWith(COOP, MOTO, false)
    expect((await correr(panel, 'put', '/api/cooperativa/repartidores/:id/activo', { headers: sesionDe(), params: { id: 'x' }, body: { activo: false } })).status).toBe(404)
    cambiar.mockResolvedValue(true)
    expect((await correr(panel, 'put', '/api/cooperativa/repartidores/:id/activo', { headers: sesionDe(), params: { id: MOTO }, body: { activo: true } })).body).toEqual({ activo: true })
  })

  it('la lista: solo los SUYOS, con el efectivo que lleva cada uno', async () => {
    const listar = vi.spyOn(db, 'listCooperativeCouriers').mockResolvedValue([
      { id: MOTO, name: 'Andrés', phone: '593991234567', vehicle: 'Moto', plate: 'MB123A', id_number: '1312345678', license_number: null, active: true, available: true, cash_limit_cents: 15000 },
    ])
    vi.spyOn(db, 'getCourierBalance').mockResolvedValue({ efectivoEncimaCents: 2350 })
    const r = await correr(panel, 'get', '/api/cooperativa/repartidores', { headers: sesionDe() })
    expect(listar).toHaveBeenCalledWith(COOP)
    expect(r.body.repartidores[0]).toMatchObject({ nombre: 'Andrés', placa: 'MB123A', efectivoEncimaCents: 2350, topeEfectivoCents: 15000 })
  })
})

describe('sus carreras', () => {
  beforeEach(activa)
  const suyos = [{ id: MOTO, name: 'Andrés', phone: '593991234567' }]

  it('la semana en curso de cada uno sale de la base, y las cerradas, de su liquidación', async () => {
    vi.spyOn(db, 'listCooperativeCouriers').mockResolvedValue(suyos)
    vi.spyOn(db, 'getCourierBalance').mockResolvedValue({ pedidos: 3, carrerasCents: 450, retenidasCents: 150, efectivoCobradoCents: 3790, efectivoEncimaCents: 3790 })
    const semanas = vi.spyOn(db, 'cooperativeWeeks').mockResolvedValue(['2026-09-28'])
    const r = await correr(panel, 'get', '/api/cooperativa/carreras', { headers: sesionDe() })
    expect(semanas).toHaveBeenCalledWith(COOP)
    expect(r.body).toEqual({
      semanas: ['2026-09-28'],
      enCurso: [{ id: MOTO, nombre: 'Andrés', telefono: '593991234567', pedidos: 3, carrerasCents: 450, retenidasCents: 150, efectivoCobradoCents: 3790, efectivoEncimaCents: 3790 }],
    })
    const semana = vi.spyOn(db, 'cooperativeWeek').mockResolvedValue([{
      courier_id: MOTO, period_start: '2026-09-28', period_end: '2026-10-04', orders_count: 2, derecho_cents: 300,
      en_mano_cents: 842, arrastre_cents: 0, neto_cents: -542, status: 'por_cobrar', paid_at: null, couriers: { name: 'Andrés', phone: '593991234567' },
    }])
    const cerrada = await correr(panel, 'get', '/api/cooperativa/carreras/semana/:semana', { headers: sesionDe(), params: { semana: '2026-09-28' } })
    expect(semana).toHaveBeenCalledWith(COOP, '2026-09-28')
    expect(cerrada.body.filas[0]).toMatchObject({ nombre: 'Andrés', pedidos: 2, carrerasCents: 300, efectivoCobradoCents: 842, saldoCents: -542, estado: 'por_cobrar' })
    expect((await correr(panel, 'get', '/api/cooperativa/carreras/semana/:semana', { headers: sesionDe(), params: { semana: 'cualquiera' } })).status).toBe(400)
  })

  it('se descargan para Excel en español: «;», tildes (BOM) y la coma decimal', async () => {
    vi.spyOn(db, 'listCooperativeCouriers').mockResolvedValue(suyos)
    vi.spyOn(db, 'getCourierBalance').mockResolvedValue({ pedidos: 3, carrerasCents: 450, retenidasCents: 0, efectivoCobradoCents: 3790, efectivoEncimaCents: 1250 })
    const r = await correr(panel, 'get', '/api/cooperativa/carreras.csv', { headers: sesionDe(), query: {} })
    expect(r.headers['content-type']).toBe('text/csv; charset=utf-8')
    expect(r.headers['content-disposition']).toContain('attachment')
    expect(r.body.startsWith('﻿"Repartidor";"WhatsApp";"Pedidos";"Carreras"')).toBe(true)
    expect(r.body).toContain('"Andrés";"593991234567";"3";"4,50";"0,00";"37,90";"12,50"')

    vi.spyOn(db, 'cooperativeWeek').mockResolvedValue([{
      courier_id: MOTO, period_start: '2026-09-28', period_end: '2026-10-04', orders_count: 2, derecho_cents: 300,
      en_mano_cents: 842, arrastre_cents: 0, neto_cents: -542, status: 'por_cobrar', paid_at: null, couriers: { name: 'Andrés', phone: '593991234567' },
    }])
    const cerrada = await correr(panel, 'get', '/api/cooperativa/carreras.csv', { headers: sesionDe(), query: { semana: '2026-09-28' } })
    expect(cerrada.body).toContain('"2026-09-28 a 2026-10-04";"Andrés";"593991234567";"2";"3,00";"8,42";"-5,42";"Debe entregarlo"')
    expect((await correr(panel, 'get', '/api/cooperativa/carreras.csv', { headers: sesionDe(), query: { semana: 'x' } })).status).toBe(400)
  })
})

describe('sus problemas', () => {
  beforeEach(activa)

  it('las carreras retenidas, con su motivo, y ni un dato del cliente', async () => {
    vi.spyOn(db, 'listCooperativeCouriers').mockResolvedValue([{ id: MOTO, name: 'Andrés' }])
    const retenidas = vi.spyOn(db, 'cooperativeRetainedRuns').mockResolvedValue([{
      order_id: 'o1', courier_id: MOTO, sold_at: '2026-10-01T15:00:00Z', reparto_cents: 150,
      retenido_motivo: 'Se le cayó la pizza', courier_settlement_id: null, orders: { order_number: 41 }, businesses: { name: 'Monster Pizza' },
    }])
    vi.spyOn(db, 'cooperativeIncidents').mockResolvedValue([])
    const r = await correr(panel, 'get', '/api/cooperativa/problemas', { headers: sesionDe() })
    expect(retenidas).toHaveBeenCalledWith(COOP)
    expect(r.body.retenidas).toEqual([{
      pedido: 41, local: 'Monster Pizza', fecha: '2026-10-01T15:00:00Z', repartidor: 'Andrés',
      carreraCents: 150, motivo: 'Se le cayó la pizza', liquidada: false,
    }])
  })
})

describe('el superadmin', () => {
  it('todas sus rutas exigen superadmin', async () => {
    for (const l of adminCoop.stack.filter(x => x.route)) {
      const metodo = Object.keys(l.route.methods)[0]
      expect((await correr(adminCoop, metodo, l.route.path, { headers: sesionDe(), params: { id: COOP } })).status).toBe(403)
    }
  })

  const nueva = { nombre: 'Cooperativa Chone', ciudadId: CHONE, telefono: '05 269 0000', usuario: { email: 'Coop@Chone.ec', clave: 'una-clave-de-12+', nombre: 'Rosa' } }

  it('da de alta la cooperativa con su ciudad y su primer acceso (la clave, con bcrypt)', async () => {
    vi.spyOn(db, 'getCity').mockResolvedValue({ id: CHONE, name: 'Chone', active: true })
    vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue(null)
    const crear = vi.spyOn(db, 'createCooperative').mockResolvedValue({ id: COOP })
    const usuario = vi.spyOn(db, 'createCooperativeUser').mockResolvedValue({ id: 'u1' })
    const r = await correr(adminCoop, 'post', '/api/admin/cooperativas', { headers: admin(), body: { ...nueva, telefono: '' } })
    expect(r).toMatchObject({ status: 201, body: { id: COOP } })
    expect(crear).toHaveBeenCalledWith({ name: 'Cooperativa Chone', cityId: CHONE, contactPhone: null })
    const { passwordHash, ...resto } = usuario.mock.calls[0][0]
    expect(resto).toEqual({ cooperativeId: COOP, email: 'coop@chone.ec', name: 'Rosa' })
    expect(await bcrypt.compare('una-clave-de-12+', passwordHash)).toBe(true)
  })

  it('valida antes de escribir: nombre, correo, clave de 12, ciudad activa, correo libre', async () => {
    const ciudad = vi.spyOn(db, 'getCity').mockResolvedValue({ id: CHONE, active: true })
    const libre = vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue(null)
    const crear = vi.spyOn(db, 'createCooperative')
    const malo = async (cambio, estado = 400) => {
      const r = await correr(adminCoop, 'post', '/api/admin/cooperativas', { headers: admin(), body: { ...nueva, ...cambio } })
      expect(r.status).toBe(estado)
    }
    await malo({ nombre: 'C' })
    await malo({ usuario: { ...nueva.usuario, email: 'sin-arroba' } })
    await malo({ usuario: { ...nueva.usuario, clave: 'corta' } })
    await malo({ telefono: '12' })
    ciudad.mockResolvedValueOnce({ id: CHONE, active: false })
    await malo({})
    libre.mockResolvedValueOnce({ id: 'ya' })
    await malo({}, 409)
    expect(crear).not.toHaveBeenCalled()
  })

  it('si su acceso no se pudo crear, la cooperativa se deshace (no queda a medias)', async () => {
    vi.spyOn(db, 'getCity').mockResolvedValue({ id: CHONE, active: true })
    vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue(null)
    vi.spyOn(db, 'createCooperative').mockResolvedValue({ id: COOP })
    vi.spyOn(db, 'createCooperativeUser').mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const deshacer = vi.spyOn(db, 'deleteCooperative').mockResolvedValue()
    const r = await correr(adminCoop, 'post', '/api/admin/cooperativas', { headers: admin(), body: nueva })
    expect(r.status).toBe(409)
    expect(deshacer).toHaveBeenCalledWith(COOP)
  })

  it('un nombre repetido es 409', async () => {
    vi.spyOn(db, 'getCity').mockResolvedValue({ id: CHONE, active: true })
    vi.spyOn(db, 'getCooperativeUserByEmail').mockResolvedValue(null)
    vi.spyOn(db, 'createCooperative').mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    expect((await correr(adminCoop, 'post', '/api/admin/cooperativas', { headers: admin(), body: nueva })).status).toBe(409)
  })

  it('la lista dice cuántos motorizados tiene y quién entra, nunca la clave', async () => {
    vi.spyOn(db, 'listCooperatives').mockResolvedValue([{
      id: COOP, name: 'Cooperativa Chone', city_id: CHONE, contact_phone: null, active: true, cities: { name: 'Chone' },
      cooperative_users: [{ id: 'u1', email: 'coop@chone.ec', name: 'Rosa', active: true }], couriers: [{ count: 4 }],
    }])
    const r = await correr(adminCoop, 'get', '/api/admin/cooperativas', { headers: admin() })
    expect(r.body.cooperativas[0]).toEqual({
      id: COOP, nombre: 'Cooperativa Chone', ciudadId: CHONE, ciudad: 'Chone', telefono: null, activa: true,
      repartidores: 4, usuarios: [{ id: 'u1', email: 'coop@chone.ec', nombre: 'Rosa', activo: true }],
    })
  })

  it('apagar, otro acceso y la clave nueva', async () => {
    const activar = vi.spyOn(db, 'setCooperativeActive').mockResolvedValue(true)
    expect((await correr(adminCoop, 'put', '/api/admin/cooperativas/:id/activa', { headers: admin(), params: { id: COOP }, body: { activa: 'no' } })).status).toBe(400)
    expect((await correr(adminCoop, 'put', '/api/admin/cooperativas/:id/activa', { headers: admin(), params: { id: COOP }, body: { activa: false } })).body).toEqual({ activa: false })
    expect(activar).toHaveBeenCalledWith(COOP, false)
    activar.mockResolvedValue(false)
    expect((await correr(adminCoop, 'put', '/api/admin/cooperativas/:id/activa', { headers: admin(), params: { id: COOP }, body: { activa: true } })).status).toBe(404)

    vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
    vi.spyOn(db, 'createCooperativeUser').mockResolvedValue({ id: 'u2', email: 'otro@chone.ec' })
    expect((await correr(adminCoop, 'post', '/api/admin/cooperativas/:id/usuarios', { headers: admin(), params: { id: COOP }, body: { email: 'otro@chone.ec', clave: 'corta' } })).status).toBe(400)
    expect((await correr(adminCoop, 'post', '/api/admin/cooperativas/:id/usuarios', { headers: admin(), params: { id: COOP }, body: { email: 'otro@chone.ec', clave: 'otra-clave-de-12+' } })).status).toBe(201)

    const clave = vi.spyOn(db, 'setCooperativeUserPassword').mockResolvedValue(true)
    expect((await correr(adminCoop, 'put', '/api/admin/cooperativas/usuarios/:id/clave', { headers: admin(), params: { id: MOTO }, body: { clave: 'corta' } })).status).toBe(400)
    expect((await correr(adminCoop, 'put', '/api/admin/cooperativas/usuarios/:id/clave', { headers: admin(), params: { id: MOTO }, body: { clave: 'la-clave-nueva-12' } })).body).toEqual({ ok: true })
    expect(await bcrypt.compare('la-clave-nueva-12', clave.mock.calls[0][1])).toBe(true)
  })
})

describe('«Quién reparte: la cooperativa» en la ficha del local', () => {
  // Un local completo: la ficha comprueba también su canal antes de guardar.
  const LOCAL = { id: 'b1', plan: 'micro', whatsapp_provider: 'ycloud', whatsapp_number: '+593999000001', ycloud_api_key: 'guardada' }
  const guardar = body => correr(adminClientes, 'put', '/api/admin/clients/:id', { headers: admin(), params: { id: 'b1' }, body })
  let actualizar
  const entorno = {}
  beforeEach(() => {
    // Como en `admin-clients.routes.test.js`: el canal de YCloud, completo.
    for (const k of ['YCLOUD_WEBHOOK_SECRET', 'YCLOUD_WEBHOOK_ENDPOINT_ID']) entorno[k] = process.env[k]
    process.env.YCLOUD_WEBHOOK_SECRET = 'ycloud-signing-secret-test'
    process.env.YCLOUD_WEBHOOK_ENDPOINT_ID = 'ycloud-endpoint-test'
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ ...LOCAL, city_id: CHONE, delivery_by: 'umbani', cooperative_id: null })
    actualizar = vi.spyOn(db, 'updateBusiness').mockResolvedValue({ error: null })
  })

  it('dice CUÁL, activa y de la ciudad del local; si no, lo dice con palabras', async () => {
    const coop = vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
    expect((await guardar({ delivery_by: 'cooperativa' })).body.error).toBe('Elige la cooperativa que reparte')
    coop.mockResolvedValueOnce({ ...cooperativa, city_id: PORTO })
    expect((await guardar({ delivery_by: 'cooperativa', cooperative_id: COOP })).body.error).toBe('La cooperativa tiene que ser de la ciudad del local')
    coop.mockResolvedValueOnce({ ...cooperativa, active: false })
    expect((await guardar({ delivery_by: 'cooperativa', cooperative_id: COOP })).body.error).toBe('Esa cooperativa está apagada')
    expect((await guardar({ delivery_by: 'otra' })).body.error).toBe('Quién reparte: el local, Umbani o una cooperativa')
    expect((await guardar({ delivery_by: 'local', cooperative_id: COOP })).status).toBe(400)
    expect(actualizar).not.toHaveBeenCalled()

    expect(await guardar({ delivery_by: 'cooperativa', cooperative_id: COOP })).toMatchObject({ status: 200, body: { ok: true } })
    expect(actualizar).toHaveBeenLastCalledWith('b1', { delivery_by: 'cooperativa', cooperative_id: COOP })
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(entorno)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('volver a Umbani suelta la cooperativa', async () => {
    db.getBusinessById.mockResolvedValue({ ...LOCAL, city_id: CHONE, delivery_by: 'cooperativa', cooperative_id: COOP })
    expect(await guardar({ delivery_by: 'umbani' })).toMatchObject({ status: 200, body: { ok: true } })
    expect(actualizar).toHaveBeenLastCalledWith('b1', { delivery_by: 'umbani', cooperative_id: null })
  })

  it('mudar el local de ciudad con su cooperativa de la otra: no', async () => {
    db.getBusinessById.mockResolvedValue({ ...LOCAL, city_id: CHONE, delivery_by: 'cooperativa', cooperative_id: COOP })
    vi.spyOn(db, 'getCity').mockResolvedValue({ id: PORTO, active: true })
    vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
    const r = await guardar({ city_id: PORTO })
    expect(r.body.error).toBe('La cooperativa tiene que ser de la ciudad del local')
    expect(actualizar).not.toHaveBeenCalled()
  })
})

describe('la app del motorizado sabe que es de una cooperativa', () => {
  it('flota «cooperativa» y el nombre de la suya; los de Umbani, sin cooperativa', async () => {
    vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(null)
    vi.spyOn(db, 'getCourierBalance').mockResolvedValue(null)
    vi.spyOn(db, 'getCooperative').mockResolvedValue(cooperativa)
    const moto = vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue({
      id: MOTO, name: 'Andrés', vehicle: 'Moto', fleet_business_id: null, cooperative_id: COOP, available: false, cash_limit_cents: 15000,
    })
    const headers = { authorization: `Bearer ${sesionApp.firmarSesionApp('593991234567')}` }
    const yo = await correr(appMoto, 'get', '/api/v1/motorizado/yo', { headers })
    expect(yo.body).toMatchObject({ flota: 'cooperativa', cooperativa: 'Cooperativa Chone' })
    moto.mockResolvedValue({ id: MOTO, name: 'Luis', vehicle: null, fleet_business_id: null, cooperative_id: null, available: false, cash_limit_cents: 15000 })
    expect((await correr(appMoto, 'get', '/api/v1/motorizado/yo', { headers })).body).toMatchObject({ flota: 'umbani', cooperativa: null })
  })
})

describe('el repositorio, ejecutado', () => {
  const consulta = (resultado) => {
    const q = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'in', 'order', 'limit']) q[m] = vi.fn(() => q)
    q.maybeSingle = vi.fn(async () => resultado)
    q.single = vi.fn(async () => resultado)
    q.then = (ok, mal) => Promise.resolve(resultado).then(ok, mal)
    return q
  }

  it('lecturas y escrituras; lo de una cooperativa, filtrado por ella', async () => {
    const q = consulta({ data: [{ id: COOP }], error: null })
    const from = vi.spyOn(client, 'from').mockReturnValue(q)
    expect(await db.listCooperatives()).toEqual([{ id: COOP }])
    expect(await db.setCooperativeActive(COOP, false)).toBe(true)
    expect(await db.setCooperativeUserPassword('u1', 'hash')).toBe(true)
    expect(await db.setCooperativeCourierActive(COOP, MOTO, false)).toBe(true)
    expect(q.eq).toHaveBeenCalledWith('cooperative_id', COOP)
    await db.deleteCooperative(COOP)
    expect(await db.listCooperativeCouriers(COOP)).toEqual([{ id: COOP }])
    from.mockReturnValue(consulta({ data: { id: COOP }, error: null }))
    expect(await db.getCooperative(COOP)).toEqual({ id: COOP })
    expect(await db.createCooperative({ name: 'C', cityId: CHONE })).toEqual({ id: COOP })
    expect(await db.createCooperativeUser({ cooperativeId: COOP, email: 'a@b.ec', passwordHash: 'h' })).toEqual({ id: COOP })
    expect(await db.getCooperativeUserByEmail('a@b.ec')).toEqual({ id: COOP })
    expect(await db.getCooperativeUserById(COOP, 'u1')).toEqual({ id: COOP })
    expect(await db.createCooperativeCourier(COOP, { phone: '593', name: 'A', vehicle: 'Moto', idNumber: '1', plate: 'P' })).toEqual({ id: COOP })
  })

  it('las semanas se dicen una vez cada una, y sin motorizados no se pregunta nada más', async () => {
    const from = vi.spyOn(client, 'from')
      .mockReturnValueOnce(consulta({ data: [{ id: MOTO }], error: null }))
      .mockReturnValueOnce(consulta({ data: [{ period_start: '2026-09-28' }, { period_start: '2026-09-28' }, { period_start: '2026-09-21' }], error: null }))
    expect(await db.cooperativeWeeks(COOP)).toEqual(['2026-09-28', '2026-09-21'])
    from.mockReturnValue(consulta({ data: [], error: null }))
    expect(await db.cooperativeWeeks(COOP)).toEqual([])
    expect(await db.cooperativeWeek(COOP, '2026-09-28')).toEqual([])
    expect(await db.cooperativeRetainedRuns(COOP)).toEqual([])
    from.mockReturnValueOnce(consulta({ data: [{ id: MOTO }], error: null })).mockReturnValueOnce(consulta({ data: [{ courier_id: MOTO }], error: null }))
    expect(await db.cooperativeWeek(COOP, '2026-09-28')).toEqual([{ courier_id: MOTO }])
    from.mockReturnValueOnce(consulta({ data: [{ id: MOTO }], error: null })).mockReturnValueOnce(consulta({ data: [{ order_id: 'o1' }], error: null }))
    expect(await db.cooperativeRetainedRuns(COOP)).toEqual([{ order_id: 'o1' }])
  })

  it('un error de la base se lanza con su código (23505 = repetido)', async () => {
    vi.spyOn(client, 'from').mockReturnValue(consulta({ data: null, error: { message: 'dup', code: '23505' } }))
    await expect(db.createCooperative({ name: 'C', cityId: CHONE })).rejects.toMatchObject({ message: 'dup', code: '23505' })
    await expect(db.listCooperatives()).rejects.toThrow('dup')
    await expect(db.getCooperativeUserByEmail('a@b.ec')).rejects.toThrow('dup')
    await expect(db.cooperativeWeeks(COOP)).rejects.toThrow('dup')
  })
})
