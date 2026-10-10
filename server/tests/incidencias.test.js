import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const reclamos = require('../dist/services/reclamos')
const tienda = require('../dist/routes/storefront.routes')
const appV1 = require('../dist/routes/app-v1.routes')
const adminInc = require('../dist/routes/admin-incidencias.routes')
const panelCoop = require('../dist/routes/cooperativa.routes')
const sesionApp = require('../dist/services/sesion-app')

// ═══════════════════════════════════════════════════════════════════════════
// «¿LLEGÓ TODO BIEN?» Y LAS INCIDENCIAS (2026-10-06, fase 1)
// ═══════════════════════════════════════════════════════════════════════════
// Las reglas (de quién es, 48 h, una vez, cuánto le corresponde) se prueban
// en PostgreSQL real (bloque «LAS INCIDENCIAS» de verify:schema) y de punta a
// punta en `recorridos/09-reclamos`. Aquí: lo que se le dice a cada uno, que
// el pedido sea de la sesión, y que la cooperativa no vea datos del cliente.

const SECRET = 'incidencias-test'
const PEDIDO = '11111111-1111-4111-8111-111111111111'
const LOCAL = '22222222-2222-4222-8222-222222222222'
const INC = '33333333-3333-4333-8333-333333333333'

let anterior
beforeEach(() => {
  anterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
  vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(null)
})
afterEach(() => {
  vi.restoreAllMocks()
  if (anterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = anterior
})

async function correr(r, method, path, { headers = {}, body = {}, params = {}, query = {}, sesionDeTienda, file } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  if (!layer) throw new Error(`Ruta no encontrada: ${method} ${path}`)
  // La sesión de tienda la pone su middleware —el PRIMERO de estas rutas—;
  // aquí se salta y se simula (los manejadores van envueltos, sin su nombre).
  const todos = layer.route.stack.map(l => l.handle)
  const handlers = sesionDeTienda ? todos.slice(1) : todos
  const req = { headers, body, params, query, ip: '1.1.1.1', storefront: sesionDeTienda, file }
  const out = { status: 200, body: undefined }
  const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this }, setHeader() {} }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}
const sesion = { businessId: LOCAL, contactPhone: '593991234567' }
const app = () => ({ authorization: `Bearer ${sesionApp.firmarSesionApp('593991234567')}` })
const admin = () => ({ authorization: `Bearer ${jwt.sign({ role: 'admin', mfa: true, email: 'yo@umbani.ec' }, SECRET)}` })

describe('lo que se le dice al cliente', () => {
  it('cada respuesta de la base, con palabras; lo desconocido no se inventa', () => {
    expect(reclamos.respuestaAlCliente('fuera_de_plazo')).toEqual({ status: 409, error: 'Pasaron más de 48 horas desde la entrega. Escríbenos y lo vemos.' })
    expect(reclamos.respuestaAlCliente('ya_reclamado').status).toBe(409)
    expect(reclamos.respuestaAlCliente('linea_invalida').status).toBe(400)
    expect(reclamos.respuestaAlCliente('algo_raro')).toEqual({ status: 409, error: 'No pudimos registrarlo. Inténtalo de nuevo.' })
  })

  it('el cuerpo del reclamo se lee sin confiar en nada', () => {
    const muchas = Array.from({ length: 80 }, () => ({ item: 'x', cantidad: 1 }))
    const leido = reclamos.leerReclamo({ tipo: 'falta_producto', lineas: [...muchas, null], nota: 'x'.repeat(900) })
    expect(leido.lineas).toHaveLength(50)
    expect(leido.lineas[0]).toEqual({ item: 'x', cantidad: '1' })
    expect(leido.nota).toHaveLength(600)
    expect(reclamos.leerReclamo(null)).toEqual({ tipo: '', lineas: [], nota: null, foto: null })
  })
})

describe('el estado de cada pedido (de una lista, de una vez)', () => {
  it('«todo bien», su reclamo, y hasta cuándo puede reclamar (solo dentro de las 48 h y sin reclamo)', async () => {
    const consulta = (data) => {
      const q = {}
      for (const m of ['select', 'in', 'eq']) q[m] = vi.fn(() => q)
      q.then = (ok, mal) => Promise.resolve({ data, error: null }).then(ok, mal)
      return q
    }
    const hace1h = new Date(Date.now() - 3600_000).toISOString()
    const hace50h = new Date(Date.now() - 50 * 3600_000).toISOString()
    vi.spyOn(client, 'from')
      .mockReturnValueOnce(consulta([{ order_id: 'reclamado', kind: 'falta_producto', status: 'abierta', suggested_cents: 440, compensation_cents: null }]))
      .mockReturnValueOnce(consulta([{ order_id: 'reciente', sold_at: hace1h }, { order_id: 'viejo', sold_at: hace50h }, { order_id: 'reclamado', sold_at: hace1h }]))
    const estados = await db.claimStates([
      { id: 'reciente', status: 'completado', received_ok_at: null },
      { id: 'viejo', status: 'completado', received_ok_at: hace50h },
      { id: 'reclamado', status: 'completado' },
      { id: 'cocinando', status: 'preparacion' },
    ])
    expect(estados.get('reciente')).toMatchObject({ todoBien: false, reclamo: null })
    expect(new Date(estados.get('reciente').reclamableHasta).getTime()).toBeGreaterThan(Date.now() + 46 * 3600_000)
    expect(estados.get('viejo')).toEqual({ todoBien: true, reclamo: null, reclamableHasta: null })
    expect(estados.get('reclamado')).toMatchObject({ reclamo: { tipo: 'falta_producto', estado: 'abierta', sugeridoCents: 440 }, reclamableHasta: null })
    expect(estados.get('cocinando')).toEqual({ todoBien: false, reclamo: null, reclamableHasta: null })
  })
})

describe('en la tienda (la mini app)', () => {
  it('el pedido tiene que ser de ESTE local y de ESTE teléfono: si no, 404 y la base ni se entera', async () => {
    vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({ data: null, error: null })
    const reclamar = vi.spyOn(db, 'reportOrderProblem')
    const r = await correr(tienda, 'post', '/api/store/:slug/orders/:id/reclamo', { sesionDeTienda: sesion, params: { id: PEDIDO }, body: { tipo: 'no_llego' } })
    expect(r.status).toBe(404)
    expect(reclamar).not.toHaveBeenCalled()
  })

  it('reclamar y «todo bien» van con el teléfono de la sesión; la base decide y se le dice', async () => {
    vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({ data: { id: PEDIDO }, error: null })
    const reclamar = vi.spyOn(db, 'reportOrderProblem').mockResolvedValue({ result: 'ok', sugeridoCents: 660 })
    const r = await correr(tienda, 'post', '/api/store/:slug/orders/:id/reclamo', {
      sesionDeTienda: sesion, params: { id: PEDIDO }, body: { tipo: 'falta_producto', lineas: [{ item: 'a', cantidad: 1 }], nota: 'Faltó' },
    })
    expect(r).toEqual({ status: 201, body: {
      ok: true, estado: 'abierta', sugeridoCents: 660, saldoCents: 0, venceEl: null,
      mensaje: 'Lo estamos revisando. Te avisamos apenas tengamos una respuesta.',
    } })
    expect(reclamar).toHaveBeenCalledWith(PEDIDO, '593991234567', 'falta_producto', [{ item: 'a', cantidad: '1' }], 'Faltó')
    reclamar.mockResolvedValue({ result: 'fuera_de_plazo' })
    expect((await correr(tienda, 'post', '/api/store/:slug/orders/:id/reclamo', { sesionDeTienda: sesion, params: { id: PEDIDO }, body: { tipo: 'no_llego' } })).status).toBe(409)

    const confirmar = vi.spyOn(db, 'confirmOrderReceived').mockResolvedValue({ result: 'ok' })
    expect((await correr(tienda, 'post', '/api/store/:slug/orders/:id/todo-bien', { sesionDeTienda: sesion, params: { id: PEDIDO } })).body).toEqual({ ok: true })
    expect(confirmar).toHaveBeenCalledWith(PEDIDO, '593991234567')
    confirmar.mockResolvedValue({ result: 'no_entregado' })
    expect((await correr(tienda, 'post', '/api/store/:slug/orders/:id/todo-bien', { sesionDeTienda: sesion, params: { id: PEDIDO } })).body)
      .toEqual({ error: 'Tu pedido todavía no se ha entregado' })
  })
})

describe('en la app (v1)', () => {
  it('con el teléfono de la sesión de la app; un id raro es 404 sin preguntar', async () => {
    const reclamar = vi.spyOn(db, 'reportOrderProblem').mockResolvedValue({ result: 'ok', sugeridoCents: 1250 })
    expect((await correr(appV1, 'post', '/api/v1/pedidos/:id/reclamo', { headers: app(), params: { id: 'x' }, body: { tipo: 'no_llego' } })).status).toBe(404)
    expect(reclamar).not.toHaveBeenCalled()
    const r = await correr(appV1, 'post', '/api/v1/pedidos/:id/reclamo', { headers: app(), params: { id: PEDIDO }, body: { tipo: 'no_llego' } })
    expect(r).toMatchObject({ status: 201, body: { ok: true, estado: 'abierta', sugeridoCents: 1250, saldoCents: 0 } })
    expect(reclamar.mock.calls[0][1]).toBe('593991234567')
    vi.spyOn(db, 'confirmOrderReceived').mockResolvedValue({ result: 'ya_reclamado' })
    expect((await correr(appV1, 'post', '/api/v1/pedidos/:id/todo-bien', { headers: app(), params: { id: PEDIDO } })).status).toBe(409)
    expect((await correr(appV1, 'post', '/api/v1/pedidos/:id/todo-bien', { params: { id: PEDIDO } })).status).toBe(401)
  })
})

describe('el superadmin', () => {
  it('todas sus rutas exigen superadmin', async () => {
    for (const l of adminInc.stack.filter(x => x.route)) {
      const metodo = Object.keys(l.route.methods)[0]
      expect((await correr(adminInc, metodo, l.route.path, { headers: app(), params: { id: INC } })).status).toBe(403)
    }
  })

  it('la lista: solo abiertas por defecto, con el pedido, el local y quién lo llevaba', async () => {
    const listar = vi.spyOn(db, 'listIncidents').mockResolvedValue([{
      id: INC, kind: 'falta_producto', origin: 'cliente', status: 'abierta', responsible: null, lines: [{ nombre: 'Pizza', cantidad: 1 }],
      note: 'Faltó', suggested_cents: 440, compensation_cents: null, resolution_note: null, resolved_by: null,
      created_at: '2026-10-06T12:00:00Z', resolved_at: null, order_id: PEDIDO, business_id: LOCAL,
      orders: { order_number: 41, total: 12.5, payment_method: 'efectivo', contact_name: 'Ana', contact_phone: '593991234567' },
      businesses: { name: 'Monster Pizza' }, couriers: { name: 'Andrés', cooperatives: { name: 'Coop Chone' } },
    }])
    const r = await correr(adminInc, 'get', '/api/admin/incidencias', { headers: admin() })
    expect(listar).toHaveBeenCalledWith('abierta')
    expect(r.body.incidencias[0]).toMatchObject({
      tipo: 'falta_producto', sugeridoCents: 440, pedido: { numero: 41, totalCents: 1250 }, local: { nombre: 'Monster Pizza' },
      repartidor: { nombre: 'Andrés', cooperativa: 'Coop Chone' },
    })
    await correr(adminInc, 'get', '/api/admin/incidencias', { headers: admin(), query: { estado: 'todas' } })
    expect(listar).toHaveBeenLastCalledWith('todas')
  })

  it('registrar y resolver: valida, y quién lo hizo queda anotado', async () => {
    const registrar = vi.spyOn(db, 'registerIncident').mockResolvedValue({ result: 'ok', id: INC })
    expect((await correr(adminInc, 'post', '/api/admin/incidencias', { headers: admin(), body: { localId: 'x', numero: 41 } })).status).toBe(400)
    expect((await correr(adminInc, 'post', '/api/admin/incidencias', { headers: admin(), body: { localId: LOCAL, numero: 41, tipo: 'comida_caida', nota: 'Se cayó' } })).body).toEqual({ id: INC })
    expect(registrar).toHaveBeenCalledWith(LOCAL, 41, 'comida_caida', 'Se cayó')
    registrar.mockResolvedValue({ result: 'not_found' })
    expect((await correr(adminInc, 'post', '/api/admin/incidencias', { headers: admin(), body: { localId: LOCAL, numero: 9, tipo: 'otro', nota: 'xxx' } })).status).toBe(404)

    const resolver = vi.spyOn(db, 'resolveIncident').mockResolvedValue({ result: 'ok' })
    expect((await correr(adminInc, 'post', '/api/admin/incidencias/:id/resolver', { headers: admin(), params: { id: INC }, body: { compensacionCents: 4.5 } })).status).toBe(400)
    await correr(adminInc, 'post', '/api/admin/incidencias/:id/resolver', {
      headers: admin(), params: { id: INC }, body: { estado: 'resuelta', responsable: 'local', compensacionCents: 440, nota: 'El local la olvidó' },
    })
    expect(resolver).toHaveBeenCalledWith({ id: INC, status: 'resuelta', responsible: 'local', compensationCents: 440, note: 'El local la olvidó', actor: 'superadmin:yo@umbani.ec' })
    resolver.mockResolvedValue({ result: 'ya_resuelta' })
    expect((await correr(adminInc, 'post', '/api/admin/incidencias/:id/resolver', { headers: admin(), params: { id: INC }, body: { estado: 'descartada', nota: 'x' } })).status).toBe(409)
  })
})

describe('la cooperativa ve las de sus motorizados, sin datos del cliente', () => {
  it('qué pasó y quién respondió; ni el nombre, ni el teléfono, ni la nota del cliente', async () => {
    vi.spyOn(db, 'getCooperativeUserById').mockImplementation(async (coop, userId) => ({ id: userId, cooperative_id: coop, active: true }))
    vi.spyOn(db, 'getCooperative').mockResolvedValue({ id: 'c1', active: true })
    vi.spyOn(db, 'cooperativeRetainedRuns').mockResolvedValue([])
    vi.spyOn(db, 'listCooperativeCouriers').mockResolvedValue([{ id: 'm1', name: 'Andrés' }])
    const deSusMotorizados = vi.spyOn(db, 'cooperativeIncidents').mockResolvedValue([{
      id: INC, kind: 'no_llego', status: 'resuelta', responsible: 'repartidor', created_at: '2026-10-06T12:00:00Z',
      courier_id: 'm1', orders: { order_number: 41 }, businesses: { name: 'Monster Pizza' },
    }])
    const token = jwt.sign({ role: 'cooperativa', cooperativeId: 'c1', userId: 'u-inc', email: 'c@x.ec' }, SECRET)
    const r = await correr(panelCoop, 'get', '/api/cooperativa/problemas', { headers: { authorization: `Bearer ${token}` } })
    expect(deSusMotorizados).toHaveBeenCalledWith(['m1'])
    expect(r.body.incidencias).toEqual([{
      pedido: 41, local: 'Monster Pizza', fecha: '2026-10-06T12:00:00Z', repartidor: 'Andrés', tipo: 'no_llego', estado: 'resuelta', responsable: 'repartidor',
    }])
  })
})

describe('el repositorio, ejecutado', () => {
  const consulta = (resultado) => {
    const q = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) q[m] = vi.fn(() => q)
    q.then = (ok, mal) => Promise.resolve(resultado).then(ok, mal)
    return q
  }

  it('cada RPC con sus parámetros, y un error de la base se lanza', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: { result: 'ok' }, error: null })
    await db.confirmOrderReceived(PEDIDO, '593')
    expect(rpc).toHaveBeenLastCalledWith('customer_confirm_order', { p_order_id: PEDIDO, p_phone: '593' })
    await db.reportOrderProblem(PEDIDO, '593', 'no_llego', 'no-es-lista', null)
    expect(rpc).toHaveBeenLastCalledWith('customer_report_order', { p_order_id: PEDIDO, p_phone: '593', p_kind: 'no_llego', p_lines: [], p_note: '' })
    await db.registerIncident(LOCAL, 41, 'otro', 'nota')
    await db.resolveIncident({ id: INC, status: 'descartada', responsible: null, compensationCents: null, note: 'n', actor: 'a' })
    expect(rpc).toHaveBeenLastCalledWith('resolve_incident', { p_id: INC, p_status: 'descartada', p_responsible: '', p_compensation_cents: -1, p_note: 'n', p_actor: 'a' })
    rpc.mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.reportOrderProblem(PEDIDO, '593', 'no_llego', [], null)).rejects.toThrow('caída')
  })

  it('las lecturas: la lista del superadmin y las de la cooperativa', async () => {
    const q = consulta({ data: [{ id: INC }], error: null })
    vi.spyOn(client, 'from').mockReturnValue(q)
    expect(await db.listIncidents('abierta')).toEqual([{ id: INC }])
    // Lo que le toca al superadmin: también las compensadas (falta confirmar quién responde).
    expect(q.in).toHaveBeenCalledWith('status', ['abierta', 'compensada'])
    expect(await db.listIncidents('todas', 9999)).toEqual([{ id: INC }])
    expect(await db.cooperativeIncidents(['m1'])).toEqual([{ id: INC }])
    expect(await db.cooperativeIncidents([])).toEqual([])
    expect(await db.claimStates([])).toEqual(new Map())
    vi.spyOn(client, 'from').mockReturnValue(consulta({ data: null, error: { message: 'caída' } }))
    await expect(db.listIncidents('abierta')).rejects.toThrow('caída')
    await expect(db.cooperativeIncidents(['m1'])).rejects.toThrow('caída')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// FASE 2: EL SALDO UMBANI (2026-10-10)
// ═══════════════════════════════════════════════════════════════════════════
// Las reglas (al instante, la escalera, el saldo) se prueban en PostgreSQL
// real (bloque «EL SALDO UMBANI» de verify:schema) y de punta a punta en
// `recorridos/09-reclamos`. Aquí: lo que se le dice, la foto, y lo que ve el
// superadmin.
const cloudinary = require('../dist/integrations/cloudinary')

describe('fase 2: lo que se le dice al cliente al reportar', () => {
  it('saldo al instante: cuánto, que vale en cualquier local, y hasta cuándo', () => {
    const r = reclamos.respuestaDelReclamo('falta_producto', {
      result: 'ok', estado: 'compensada', sugeridoCents: 150, saldoCents: 150, venceEl: '2027-01-08T17:00:00Z',
    })
    expect(r).toEqual({
      ok: true, estado: 'compensada', sugeridoCents: 150, saldoCents: 150, venceEl: '2027-01-08T17:00:00Z',
      mensaje: 'Listo: te devolvimos $1,50 en saldo Umbani. Lo usas en tu próximo pedido, en cualquier local, hasta el 8 de enero.',
    })
  })

  it('iba a pagar al recibir y no llegó: no pagó, y se le dice así', () => {
    expect(reclamos.respuestaDelReclamo('no_llego', { result: 'ok', estado: 'abierta', sugeridoCents: 0, saldoCents: 0 }).mensaje)
      .toBe('Como ibas a pagar al recibir, no se te cobró nada. Revisamos qué pasó con el repartidor.')
  })

  it('a revisión: «lo estamos revisando», sin decirle la regla', () => {
    const r = reclamos.respuestaDelReclamo('falta_producto', { result: 'ok', estado: 'abierta', sugeridoCents: 900, saldoCents: 0 })
    expect(r).toMatchObject({ estado: 'abierta', saldoCents: 0, venceEl: null, mensaje: 'Lo estamos revisando. Te avisamos apenas tengamos una respuesta.' })
    expect(r.mensaje).not.toMatch(/tope|escal|rechaz|30|90/)
  })

  it('el cuerpo trae la foto, recortada y sin espacios; lo que no es texto no cuenta', () => {
    expect(reclamos.leerReclamo({ tipo: 'vino_mal', foto: '  botpanel/a/reclamos/b/c  ' }).foto).toBe('botpanel/a/reclamos/b/c')
    expect(reclamos.leerReclamo({ tipo: 'vino_mal', foto: 42 }).foto).toBeNull()
    expect(reclamos.leerReclamo({ tipo: 'vino_mal', foto: 'x'.repeat(400) }).foto).toHaveLength(300)
  })
})

describe('fase 2: en la app', () => {
  it('el reclamo manda la foto a la base, y el saldo al instante se le dice', async () => {
    const reclamar = vi.spyOn(db, 'reportOrderProblem').mockResolvedValue({
      result: 'ok', estado: 'compensada', sugeridoCents: 220, saldoCents: 220, venceEl: '2027-01-08T17:00:00Z',
    })
    const foto = `botpanel/${LOCAL}/reclamos/${PEDIDO}/abc`
    const r = await correr(appV1, 'post', '/api/v1/pedidos/:id/reclamo', {
      headers: app(), params: { id: PEDIDO }, body: { tipo: 'vino_mal', lineas: [{ item: 'a', cantidad: 1 }], foto },
    })
    expect(r).toMatchObject({ status: 201, body: { estado: 'compensada', saldoCents: 220 } })
    expect(r.body.mensaje).toContain('$2,20')
    expect(reclamar).toHaveBeenCalledWith(PEDIDO, '593991234567', 'vino_mal', [{ item: 'a', cantidad: '1' }], null, foto)
  })

  it('«/yo» trae su saldo; si no se pudo leer, null y lo demás sigue', async () => {
    vi.spyOn(db, 'resolveMarketplaceCustomer').mockResolvedValue({ id: 'c1', phone: '593991234567', city_id: null })
    const saldo = vi.spyOn(db, 'customerCreditBalance').mockResolvedValue({ cents: 150, proximo: { cents: 150, venceEl: '2027-01-08' } })
    const r = await correr(appV1, 'get', '/api/v1/yo', { headers: app() })
    expect(r.body).toMatchObject({ telefono: '593991234567', saldo: { cents: 150, proximo: { cents: 150 } } })
    expect(saldo).toHaveBeenCalledWith('c1')
    saldo.mockRejectedValue(new Error('caída'))
    expect((await correr(appV1, 'get', '/api/v1/yo', { headers: app() })).body).toMatchObject({ telefono: '593991234567', saldo: null })
  })
})

describe('fase 2: la foto del reclamo', () => {
  const RUTA = '/api/v1/pedidos/:id/reclamo/foto'
  const foto = { buffer: Buffer.from([0xff, 0xd8, 0xff]), mimetype: 'image/jpeg', size: 3, originalname: 'f.jpg' }

  it('sin sesión 401; un id raro o sin foto, no se sube nada', async () => {
    const subir = vi.spyOn(cloudinary, 'uploadPrivateMedia')
    expect((await correr(appV1, 'post', RUTA, { params: { id: PEDIDO }, file: foto })).status).toBe(401)
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: 'x' }, file: foto })).status).toBe(404)
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO } })).status).toBe(400)
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO }, file: { ...foto, mimetype: 'video/mp4' } })).status).toBe(400)
    expect(subir).not.toHaveBeenCalled()
  })

  it('el pedido tiene que ser SUYO y estar entregado: si no, la nube ni se entera', async () => {
    const subir = vi.spyOn(cloudinary, 'uploadPrivateMedia')
    const dueno = vi.spyOn(db, 'getAppOrderOwner').mockResolvedValue(null)
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO }, file: foto })).status).toBe(404)
    expect(dueno).toHaveBeenCalledWith('593991234567', PEDIDO)
    dueno.mockResolvedValue({ business_id: LOCAL, contact_phone: '593991234567', status: 'en_camino', businesses: null })
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO }, file: foto })).status).toBe(409)
    expect(subir).not.toHaveBeenCalled()
  })

  it('entregado y suyo: se sube en privado, en la carpeta de ESE pedido', async () => {
    vi.spyOn(db, 'getAppOrderOwner').mockResolvedValue({ business_id: LOCAL, contact_phone: '593991234567', status: 'completado', businesses: null })
    const configurada = vi.spyOn(cloudinary, 'isConfigured').mockResolvedValue(false)
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO }, file: foto })).status).toBe(503)
    configurada.mockResolvedValue(true)
    const subir = vi.spyOn(cloudinary, 'uploadPrivateMedia').mockResolvedValue({ url: 'u', public_id: `botpanel/${LOCAL}/reclamos/${PEDIDO}/abc`, resource_type: 'image' })
    const r = await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO }, file: foto })
    expect(r).toEqual({ status: 201, body: { foto: `botpanel/${LOCAL}/reclamos/${PEDIDO}/abc` } })
    expect(subir).toHaveBeenCalledWith(foto.buffer, LOCAL, `reclamos/${PEDIDO}`)
    subir.mockRejectedValue(new Error('cloudinary caído'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect((await correr(appV1, 'post', RUTA, { headers: app(), params: { id: PEDIDO }, file: foto })).status).toBe(502)
  })

  it('las fotos del staging van a su propia carpeta, lejos de las de producción', () => {
    expect(cloudinary.raizDeLaNube({ UMBANI_ENTORNO: 'staging' })).toBe('botpanel-pruebas')
    expect(cloudinary.raizDeLaNube({})).toBe('botpanel')
  })
})

describe('fase 2: el superadmin', () => {
  it('ve si el saldo salió al instante, por qué no, el escalón y la foto (con enlace que caduca)', async () => {
    vi.spyOn(db, 'listIncidents').mockResolvedValue([{
      id: INC, kind: 'vino_mal', origin: 'cliente', status: 'abierta', responsible: null, lines: [], note: null,
      suggested_cents: 900, compensation_cents: null, resolution_note: null, resolved_by: null,
      created_at: '2026-10-10T12:00:00Z', resolved_at: null, order_id: PEDIDO, business_id: LOCAL,
      auto_approved: false, compensated_at: null, local_cents: 800, umbani_cents: 100, reparto_cents: 0,
      photo_public_id: 'botpanel/x/reclamos/y/z', escalon: 2, review_reasons: ['tope', 'reportes_seguidos'],
      orders: null, businesses: null, couriers: null,
    }])
    const firmar = vi.spyOn(cloudinary, 'signedMediaUrl').mockResolvedValue('https://firmada')
    const r = await correr(adminInc, 'get', '/api/admin/incidencias', { headers: admin() })
    expect(r.body.incidencias[0]).toMatchObject({
      alInstante: false, escalon: 2, motivos: ['tope', 'reportes_seguidos'], fotoUrl: 'https://firmada',
      reparto: { localCents: 800, umbaniCents: 100, carreraCents: 0 },
    })
    expect(firmar).toHaveBeenCalledWith('botpanel/x/reclamos/y/z')
  })

  it('al resolver dice cuánto saldo recibió el cliente, y los rechazos nuevos se explican', async () => {
    const resolver = vi.spyOn(db, 'resolveIncident').mockResolvedValue({ result: 'ok', saldoCents: 440 })
    const body = { estado: 'resuelta', responsable: 'local', compensacionCents: 440, nota: 'El local la olvidó' }
    expect((await correr(adminInc, 'post', '/api/admin/incidencias/:id/resolver', { headers: admin(), params: { id: INC }, body })).body)
      .toEqual({ ok: true, saldoCents: 440 })
    for (const [resultado, estado] of [['compensacion_ya_dada', 409], ['cliente_sin_compensacion', 400], ['sin_cuenta', 409]]) {
      resolver.mockResolvedValue({ result: resultado })
      const r = await correr(adminInc, 'post', '/api/admin/incidencias/:id/resolver', { headers: admin(), params: { id: INC }, body })
      expect(r.status, resultado).toBe(estado)
      expect(r.body.error, resultado).not.toBe('No se pudo. Inténtalo de nuevo.')
    }
  })
})

describe('fase 2: el repositorio', () => {
  it('la foto viaja a la base solo si la hay; el saldo se lee de la base', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: { result: 'ok' }, error: null })
    await db.reportOrderProblem(PEDIDO, '593', 'vino_mal', [], null, 'botpanel/a/reclamos/b/c')
    expect(rpc).toHaveBeenLastCalledWith('customer_report_order', {
      p_order_id: PEDIDO, p_phone: '593', p_kind: 'vino_mal', p_lines: [], p_note: '', p_photo: 'botpanel/a/reclamos/b/c',
    })
    rpc.mockResolvedValue({ data: { cents: 150, proximo: { cents: 150, venceEl: '2027-01-08' } }, error: null })
    expect(await db.customerCreditBalance('c1')).toEqual({ cents: 150, proximo: { cents: 150, venceEl: '2027-01-08' } })
    expect(rpc).toHaveBeenLastCalledWith('saldo_del_cliente', { p_customer_id: 'c1' })
    rpc.mockResolvedValue({ data: { cents: 0, proximo: null }, error: null })
    expect(await db.customerCreditBalance('c1')).toEqual({ cents: 0, proximo: null })
  })
})

