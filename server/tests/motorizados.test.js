import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const sesion = require('../dist/services/sesion-app')
const appMoto = require('../dist/routes/app-motorizado.routes')
const adminMoto = require('../dist/routes/admin-motorizados.routes')
const aviso = require('../dist/services/order-status-notice')

// ═══════════════════════════════════════════════════════════════════════════
// LOS MOTORIZADOS: las reglas del dinero se prueban en PostgreSQL real (bloque
// «LOS MOTORIZADOS» de verificar-esquema.sql). Aquí: quién entra, qué se le
// dice, y que el superadmin valida antes de escribir.
// ═══════════════════════════════════════════════════════════════════════════

const SECRET = 'motorizados-test'
let anterior
beforeEach(() => {
  anterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
  // `authApp` pregunta si la sesión se cerró desde WhatsApp (2026-09-29): aquí
  // nunca se cerró. Lo de cerrarla se prueba en `cerrar-sesion-de-la-app.test.js`.
  vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(null)
})
afterEach(() => {
  vi.restoreAllMocks()
  if (anterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = anterior
})

async function correr(r, method, path, { headers = {}, body = {}, params = {} } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle)
  const req = { headers, body, params, query: {}, ip: '1.1.1.1' }
  const out = { status: 200, body: undefined }
  const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this }, setHeader() {} }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}
const moto = { id: 'm1', phone: '593900', name: 'Luis', vehicle: null, fleet_business_id: null, active: true, available: false, cash_limit_cents: 15000 }
const conSesion = () => ({ authorization: `Bearer ${sesion.firmarSesionApp('593900')}` })
const admin = () => ({ authorization: `Bearer ${jwt.sign({ role: 'admin', mfa: true }, SECRET)}` })

describe('la app del motorizado', () => {
  // La ruta cambiaba el estado y NO avisaba al cliente: con motorizado, nadie le
  // decía «en camino» ni «entregado». Lo cazó el recorrido de motorizados.
  it('al recoger y al entregar, el cliente recibe su aviso (del negocio DEL PEDIDO)', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    vi.spyOn(db, 'courierAdvanceOrder').mockResolvedValue({ result: 'updated', order: { business_id: 'b9' } })
    const avisar = vi.spyOn(aviso, 'avisarAlCliente').mockResolvedValue()
    await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/recogido', { headers: conSesion(), params: { id: 'o1' } })
    await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/entregado', { headers: conSesion(), params: { id: 'o1' } })
    expect(avisar).toHaveBeenNthCalledWith(1, 'b9', 'o1', 'en_camino')
    expect(avisar).toHaveBeenNthCalledWith(2, 'b9', 'o1', 'completado')
  })

  it('si no se pudo mover el pedido, no se avisa nada', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    vi.spyOn(db, 'courierAdvanceOrder').mockResolvedValue({ result: 'not_found' })
    const avisar = vi.spyOn(aviso, 'avisarAlCliente').mockResolvedValue()
    await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/entregado', { headers: conSesion(), params: { id: 'o1' } })
    expect(avisar).not.toHaveBeenCalled()
  })

  it('sin sesión 401; con sesión pero sin ser motorizado activo 403', async () => {
    expect((await correr(appMoto, 'get', '/api/v1/motorizado/yo')).status).toBe(401)
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(null)
    expect((await correr(appMoto, 'get', '/api/v1/motorizado/yo', { headers: conSesion() })).status).toBe(403)
  })

  it('su inicio: flota, tope y su semana', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    vi.spyOn(db, 'getCourierBalance').mockResolvedValue({ carrerasCents: 400 })
    const r = await correr(appMoto, 'get', '/api/v1/motorizado/yo', { headers: conSesion() })
    expect(r.body).toMatchObject({ nombre: 'Luis', flota: 'umbani', topeEfectivoCents: 15000, semana: { carrerasCents: 400 } })
  })

  it('tomar: cada negativa con su texto; el tope se explica', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const tomar = vi.spyOn(db, 'courierTakeOrder')
    const ruta = '/api/v1/motorizado/pedidos/:id/tomar'
    tomar.mockResolvedValueOnce({ result: 'ok' })
    expect((await correr(appMoto, 'post', ruta, { headers: conSesion(), params: { id: 'o1' } })).status).toBe(200)
    expect(tomar).toHaveBeenLastCalledWith('m1', 'o1')
    tomar.mockResolvedValueOnce({ result: 'tope_de_efectivo' })
    const tope = await correr(appMoto, 'post', ruta, { headers: conSesion(), params: { id: 'o1' } })
    expect(tope).toMatchObject({ status: 409, body: { reason: 'tope_de_efectivo' } })
    expect(tope.body.error).toMatch(/efectivo/)
    tomar.mockResolvedValueOnce({ result: 'ya_tomado' })
    expect((await correr(appMoto, 'post', ruta, { headers: conSesion(), params: { id: 'o1' } })).body.error).toMatch(/Otro motorizado/)
  })

  it('recoger exige la checklist del local; entregar marca completado', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const avanzar = vi.spyOn(db, 'courierAdvanceOrder')
    avanzar.mockResolvedValueOnce({ result: 'incompleto', faltan: 'Coca-Cola x1' })
    const r = await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/recogido', { headers: conSesion(), params: { id: 'o1' } })
    expect(r).toMatchObject({ status: 409 })
    expect(r.body.error).toMatch(/Coca-Cola/)
    avanzar.mockResolvedValueOnce({ result: 'updated' })
    await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/entregado', { headers: conSesion(), params: { id: 'o1' } })
    expect(avanzar).toHaveBeenLastCalledWith('m1', 'o1', 'completado')
    avanzar.mockResolvedValueOnce({ result: 'not_found' })
    expect((await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/entregado', { headers: conSesion(), params: { id: 'x' } })).status).toBe(404)
  })

  it('disponible, pedidos y liquidaciones SIEMPRE del motorizado de la sesión', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const disp = vi.spyOn(db, 'setCourierAvailable').mockResolvedValue()
    await correr(appMoto, 'put', '/api/v1/motorizado/disponible', { headers: conSesion(), body: { disponible: true } })
    expect(disp).toHaveBeenCalledWith('m1', true)
    const pedidos = vi.spyOn(db, 'getCourierOrders').mockResolvedValue([])
    await correr(appMoto, 'get', '/api/v1/motorizado/pedidos', { headers: conSesion() })
    expect(pedidos).toHaveBeenCalledWith('m1')
    const liq = vi.spyOn(db, 'listCourierSettlements').mockResolvedValue([])
    await correr(appMoto, 'get', '/api/v1/motorizado/liquidaciones', { headers: conSesion() })
    expect(liq).toHaveBeenCalledWith('m1', 52)
  })
})

describe('el superadmin', () => {
  it('todas las rutas exigen superadmin', async () => {
    for (const layer of adminMoto.stack.filter(l => l.route)) {
      const metodo = Object.keys(layer.route.methods)[0]
      expect((await correr(adminMoto, metodo, layer.route.path, { params: { id: 'x' } })).status, layer.route.path).toBe(401)
    }
  })

  it('registrar valida teléfono, nombre, flota y tope; un teléfono repetido es 409', async () => {
    const ruta = '/api/admin/motorizados'
    expect((await correr(adminMoto, 'post', ruta, { headers: admin(), body: { telefono: '12', nombre: 'Luis' } })).status).toBe(400)
    expect((await correr(adminMoto, 'post', ruta, { headers: admin(), body: { telefono: '593991234567', nombre: 'L' } })).status).toBe(400)
    expect((await correr(adminMoto, 'post', ruta, { headers: admin(), body: { telefono: '593991234567', nombre: 'Luis', flotaLocalId: 'x' } })).status).toBe(400)
    expect((await correr(adminMoto, 'post', ruta, { headers: admin(), body: { telefono: '593991234567', nombre: 'Luis', topeEfectivo: '-5' } })).status).toBe(400)
    const crear = vi.spyOn(db, 'createCourier').mockResolvedValue({ id: 'm1' })
    expect((await correr(adminMoto, 'post', ruta, { headers: admin(), body: { telefono: '+593 99 123 4567', nombre: 'Luis', topeEfectivo: '150' } })).status).toBe(201)
    expect(crear.mock.calls[0][0]).toMatchObject({ phone: '+593991234567', cashLimitCents: 15000, fleetBusinessId: null })
    crear.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    expect((await correr(adminMoto, 'post', ruta, { headers: admin(), body: { telefono: '593991234567', nombre: 'Luis' } })).status).toBe(409)
  })

  it('lista, activa, marca liquidaciones y retiene carreras con motivo', async () => {
    vi.spyOn(db, 'listCouriers').mockResolvedValue([moto])
    vi.spyOn(db, 'listCourierSettlements').mockResolvedValue([])
    vi.spyOn(db, 'getCourierBalance').mockResolvedValue({ efectivoEncimaCents: 1518 })
    const lista = await correr(adminMoto, 'get', '/api/admin/motorizados', { headers: admin() })
    expect(lista.body.motorizados[0].semana.efectivoEncimaCents).toBe(1518)
    const id = '22222222-2222-4222-8222-222222222222'
    vi.spyOn(db, 'setCourierActive').mockResolvedValue()
    expect((await correr(adminMoto, 'put', '/api/admin/motorizados/:id/activo', { headers: admin(), params: { id }, body: { activo: false } })).body).toEqual({ activo: false })
    const marcar = vi.spyOn(db, 'markCourierSettlementPaid').mockResolvedValue({ result: 'updated', status: 'cobrada' })
    expect((await correr(adminMoto, 'post', '/api/admin/motorizados/liquidaciones/:id/marcar', { headers: admin(), params: { id }, body: { referencia: 'EF-1' } })).body).toEqual({ status: 'cobrada' })
    marcar.mockResolvedValue({ result: 'not_pending' })
    expect((await correr(adminMoto, 'post', '/api/admin/motorizados/liquidaciones/:id/marcar', { headers: admin(), params: { id }, body: { referencia: 'EF-1' } })).status).toBe(409)
    expect((await correr(adminMoto, 'post', '/api/admin/motorizados/retener', { headers: admin(), body: { pedidoId: id, motivo: 'x' } })).status).toBe(400)
    const retener = vi.spyOn(db, 'retainCourierFee').mockResolvedValue({ result: 'retenida' })
    expect((await correr(adminMoto, 'post', '/api/admin/motorizados/retener', { headers: admin(), body: { pedidoId: id, motivo: 'Se cayó la pizza' } })).body).toEqual({ ok: true })
    retener.mockResolvedValue({ result: 'no_aplica' })
    expect((await correr(adminMoto, 'post', '/api/admin/motorizados/retener', { headers: admin(), body: { pedidoId: id, motivo: 'Se cayó la pizza' } })).status).toBe(409)
  })

  it('«Quién reparte» solo acepta local o umbani', () => {
    const fuente = fs.readFileSync('src/routes/admin-clients.routes.ts', 'utf8')
    expect(fuente).toMatch(/'delivery_by',/)
    expect(fuente).toMatch(/body\.delivery_by !== 'local' && body\.delivery_by !== 'umbani'/)
  })

  // Local por local (2026-10-04). Un «true» en texto o un 1 no se adivinan:
  // decide qué repartidores pueden llevar la comida de ese local.
  it('«Repartidores propios» lo edita el superadmin, y solo con un sí o un no', () => {
    const fuente = fs.readFileSync('src/routes/admin-clients.routes.ts', 'utf8')
    expect(fuente).toMatch(/'own_fleet',/)
    expect(fuente).toMatch(/typeof body\.own_fleet !== 'boolean'/)
  })
})

describe('el repositorio, ejecutado', () => {
  const consulta = (resultado) => {
    const q = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'order', 'limit', 'single']) q[m] = vi.fn(() => q)
    q.maybeSingle = vi.fn(async () => resultado)
    q.single = vi.fn(async () => resultado)
    q.then = (ok, mal) => Promise.resolve(resultado).then(ok, mal)
    return q
  }

  it('cada RPC con sus parámetros, y un error de la base se lanza', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: { result: 'ok', creadas: 2 }, error: null })
    await db.courierTakeOrder('m1', 'o1')
    expect(rpc).toHaveBeenLastCalledWith('courier_take_order', { p_courier_id: 'm1', p_order_id: 'o1' })
    await db.courierAdvanceOrder('m1', 'o1', 'en_camino')
    await db.getCourierBalance('m1')
    await db.retainCourierFee('o1', 'Se cayó')
    expect(await db.closeWeeklyCourierSettlements('2026-10-05')).toEqual({ creadas: 2 })
    await db.markCourierSettlementPaid('s1', 'EF-1')
    rpc.mockResolvedValue({ data: [{ id: 'o1' }], error: null })
    expect(await db.getCourierOrders('m1')).toEqual([{ id: 'o1' }])
    rpc.mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.courierTakeOrder('m1', 'o1')).rejects.toThrow('caída')
  })

  it('las lecturas y escrituras de la tabla', async () => {
    const from = vi.spyOn(client, 'from').mockReturnValue(consulta({ data: moto, error: null }))
    expect(await db.getActiveCourierByPhone('593900')).toEqual(moto)
    await db.setCourierAvailable('m1', true)
    await db.setCourierActive('m1', false)
    expect(await db.createCourier({ phone: '593900', name: 'Luis' })).toEqual(moto)
    from.mockReturnValue(consulta({ data: [moto], error: null }))
    expect(await db.listCouriers()).toEqual([moto])
    expect(await db.listCourierSettlements('m1', 9999)).toEqual([moto])
    from.mockReturnValue(consulta({ data: null, error: { message: 'caída', code: 'X' } }))
    await expect(db.getActiveCourierByPhone('593900')).rejects.toThrow('caída')
    await expect(db.createCourier({ phone: '593900', name: 'Luis' })).rejects.toThrow('caída')
    await expect(db.listCouriers()).rejects.toThrow('caída')
    await expect(db.listCourierSettlements()).rejects.toThrow('caída')
    await expect(db.setCourierAvailable('m1', true)).rejects.toThrow('caída')
  })
})
