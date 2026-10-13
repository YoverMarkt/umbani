import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const sesion = require('../dist/services/sesion-app')
const appMoto = require('../dist/routes/app-motorizado.routes')
const pedidosDelPanel = require('../dist/routes/orders.routes')
const aviso = require('../dist/services/order-status-notice')
const { actorActual } = require('../dist/lib/actor-de-la-peticion')
const { leerUbicacion, respuestaDeLaPuerta, idDelPedido } = require('../dist/lib/no-estaba-el-cliente')
const { RESPUESTA_AL_CLIENTE } = require('../dist/services/reclamos')

// ═══════════════════════════════════════════════════════════════════════════
// «LLEGUÉ» Y «NO ESTABA EL CLIENTE» (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
// Las reglas —quién lleva el pedido, la espera, el dinero— se prueban en
// PostgreSQL real (bloque «NO ESTABA EL CLIENTE» de verificar-esquema.sql).
// Aquí: quién puede llamar, qué se le dice, y que nada sale del cuerpo de la
// petición que no deba.

const SECRET = 'no-estaba-test'
const PEDIDO = '11111111-2222-4333-8444-555555555555'
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

// ⚠️ Cada paso corre DENTRO del `next` del anterior, como en Express: la
// sesión abre ahí el contexto con quién está detrás (`conActor`), y un arnés
// que llamara a los pasos uno tras otro lo perdería.
async function correr(r, method, path, { headers = {}, body = {}, params = {} } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  if (!layer) throw new Error(`no existe ${method} ${path}`)
  const handlers = layer.route.stack.map(l => l.handle)
  const req = { headers, body, params, query: {}, ip: '1.1.1.1' }
  const out = { status: 200, body: undefined }
  const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this }, setHeader() {} }
  const paso = async (i) => {
    if (i >= handlers.length) return
    let siguiente = null
    await handlers[i](req, res, (e) => { if (e) throw e; siguiente = paso(i + 1) })
    if (siguiente) await siguiente
  }
  await paso(0)
  return out
}
const moto = { id: 'm1', phone: '593900', email: 'luis@umbani.test', name: 'Luis', vehicle: null, fleet_business_id: null, active: true, available: true, cash_limit_cents: 15000 }
const conSesion = () => ({ authorization: `Bearer ${sesion.firmarSesionApp('593900')}` })
const delLocal = (claims = {}) => ({
  authorization: `Bearer ${jwt.sign({ role: 'client', businessId: 'b1', urole: 'owner', email: 'duena@local.test', ...claims }, SECRET)}`,
})

describe('la app del repartidor: «Llegué»', () => {
  it('es SU pedido (de la sesión) y la ubicación viaja solo si es un punto de verdad', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const llegue = vi.spyOn(db, 'markArrived').mockResolvedValue({ result: 'ok', llegoEn: 't0', noEstabaDesde: 't10', metros: 40 })
    const r = await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/llegue', {
      headers: conSesion(), params: { id: PEDIDO }, body: { lat: -0.695, lng: -80.096, courierId: 'otro' },
    })
    expect(r.status).toBe(200)
    // La distancia NO vuelve al repartidor: es la prueba que mira Umbani.
    expect(r.body).toEqual({ llegoEn: 't0', noEstabaDesde: 't10' })
    expect(llegue).toHaveBeenCalledWith({ courierId: 'm1' }, PEDIDO, { lat: -0.695, lng: -80.096 })
    await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/llegue', {
      headers: conSesion(), params: { id: PEDIDO }, body: { lat: 'x', lng: 500 },
    })
    expect(llegue).toHaveBeenLastCalledWith({ courierId: 'm1' }, PEDIDO, null)
  })

  it('un id mal escrito es 404 sin preguntar a la base; lo que no está en camino, 409', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const llegue = vi.spyOn(db, 'markArrived').mockResolvedValue({ result: 'no_en_camino' })
    expect((await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/llegue', { headers: conSesion(), params: { id: 'nada' } })).status).toBe(404)
    expect(llegue).not.toHaveBeenCalled()
    const r = await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/llegue', { headers: conSesion(), params: { id: PEDIDO } })
    expect(r).toEqual({ status: 409, body: { error: 'Ese pedido no está en camino', reason: 'no_en_camino' } })
  })

  it('sin sesión 401; sin ser repartidor activo 403', async () => {
    expect((await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/llegue', { params: { id: PEDIDO } })).status).toBe(401)
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(null)
    expect((await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/no-estaba', { headers: conSesion(), params: { id: PEDIDO } })).status).toBe(403)
  })
})

describe('la app del repartidor: «No estaba el cliente»', () => {
  it('cierra SU pedido, deja quién fue en el registro de dinero y NO le avisa «entregado» al cliente', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const avisar = vi.spyOn(aviso, 'avisarAlCliente').mockResolvedValue()
    let actorEnLaBase = null
    const cerrar = vi.spyOn(db, 'markCustomerAbsent').mockImplementation(async () => {
      // El actor viaja en la cabecera de cada consulta de esta petición.
      actorEnLaBase = actorActual()
      return { result: 'ok', order: { id: PEDIDO } }
    })
    const r = await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/no-estaba', { headers: conSesion(), params: { id: PEDIDO } })
    expect(r).toEqual({ status: 200, body: { ok: true } })
    expect(cerrar).toHaveBeenCalledWith({ courierId: 'm1' }, PEDIDO, 'repartidor:luis@umbani.test')
    expect(actorEnLaBase).toBe('repartidor:luis@umbani.test')
    expect(avisar).not.toHaveBeenCalled()
  })

  it('antes de tiempo dice cuántos minutos faltan (la espera la dio la base), y sin «Llegué» lo pide', async () => {
    vi.spyOn(db, 'getActiveCourierByPhone').mockResolvedValue(moto)
    const desde = new Date(Date.now() + 4 * 60_000 + 5_000).toISOString()
    vi.spyOn(db, 'markCustomerAbsent').mockResolvedValueOnce({ result: 'todavia_no', noEstabaDesde: desde })
      .mockResolvedValueOnce({ result: 'sin_llegada' })
    const antes = await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/no-estaba', { headers: conSesion(), params: { id: PEDIDO } })
    expect(antes.status).toBe(409)
    expect(antes.body).toEqual({ error: 'Espera al cliente 5 minutos más antes de marcarlo', reason: 'todavia_no', noEstabaDesde: desde })
    const sin = await correr(appMoto, 'post', '/api/v1/motorizado/pedidos/:id/no-estaba', { headers: conSesion(), params: { id: PEDIDO } })
    expect(sin.body.error).toBe('Primero toca «Llegué» cuando estés en la puerta')
  })
})

describe('el panel del local que reparte él mismo', () => {
  it('el negocio sale del JWT, nunca de la petición; y el actor es quien está en el panel', async () => {
    const llegue = vi.spyOn(db, 'markArrived').mockResolvedValue({ result: 'ok', llegoEn: 't0', noEstabaDesde: 't10' })
    const cerrar = vi.spyOn(db, 'markCustomerAbsent').mockResolvedValue({ result: 'ok', order: { id: PEDIDO, status: 'completado' } })
    const r1 = await correr(pedidosDelPanel, 'post', '/api/client/orders/:id/llegue', {
      headers: delLocal(), params: { id: PEDIDO }, body: { businessId: 'b2', lat: 1, lng: 1 },
    })
    expect(r1).toEqual({ status: 200, body: { llegoEn: 't0', noEstabaDesde: 't10' } })
    // El panel está en el local, no en la puerta: no manda ubicación.
    expect(llegue).toHaveBeenCalledWith({ businessId: 'b1' }, PEDIDO)
    const r2 = await correr(pedidosDelPanel, 'post', '/api/client/orders/:id/no-estaba', {
      headers: delLocal(), params: { id: PEDIDO }, body: { businessId: 'b2' },
    })
    expect(r2).toEqual({ status: 200, body: { id: PEDIDO, status: 'completado' } })
    expect(cerrar).toHaveBeenCalledWith({ businessId: 'b1' }, PEDIDO, 'local:duena@local.test')
  })

  it('lo de otro local o de un repartidor de Umbani: 404 (la base no lo reconoce como suyo)', async () => {
    vi.spyOn(db, 'markCustomerAbsent').mockResolvedValue({ result: 'not_found' })
    const r = await correr(pedidosDelPanel, 'post', '/api/client/orders/:id/no-estaba', { headers: delLocal(), params: { id: PEDIDO } })
    expect(r).toEqual({ status: 404, body: { error: 'No encontramos ese pedido' } })
  })

  it('exige sesión del local y el permiso de ventas', async () => {
    const cerrar = vi.spyOn(db, 'markCustomerAbsent').mockResolvedValue({ result: 'ok' })
    expect((await correr(pedidosDelPanel, 'post', '/api/client/orders/:id/no-estaba', { params: { id: PEDIDO } })).status).toBe(401)
    const sinPermiso = await correr(pedidosDelPanel, 'post', '/api/client/orders/:id/no-estaba', {
      headers: delLocal({ urole: 'employee', perms: ['citas'] }), params: { id: PEDIDO },
    })
    expect(sinPermiso.status).toBe(403)
    expect(cerrar).not.toHaveBeenCalled()
  })
})

describe('lo que se traduce aquí', () => {
  it('la ubicación: solo números dentro del mundo; si no, nada (y nunca bloquea)', () => {
    expect(leerUbicacion({ lat: '-0.69', lng: '-80.09' })).toEqual({ lat: -0.69, lng: -80.09 })
    expect(leerUbicacion({ lat: 0, lng: 0 })).toEqual({ lat: 0, lng: 0 })
    expect(leerUbicacion({ lat: 91, lng: 0 })).toBeNull()
    expect(leerUbicacion({ lat: '', lng: '' })).toBeNull()
    expect(leerUbicacion({ lat: 1 })).toBeNull()
    expect(leerUbicacion(null)).toBeNull()
  })

  it('«todavía no»: un minuto en singular, y sin hora conocida no inventa minutos', () => {
    const ahora = Date.parse('2026-10-12T20:00:00Z')
    expect(respuestaDeLaPuerta({ result: 'todavia_no', noEstabaDesde: '2026-10-12T20:00:30Z' }, ahora).body.error)
      .toBe('Espera al cliente 1 minuto más antes de marcarlo')
    expect(respuestaDeLaPuerta({ result: 'todavia_no' }, ahora).body.error).toBe('Espera al cliente un poco más antes de marcarlo')
    expect(respuestaDeLaPuerta({ result: 'invalid_transition' }).status).toBe(409)
    expect(idDelPedido(` ${PEDIDO} `)).toBe(PEDIDO)
    expect(idDelPedido('1; drop table')).toBeNull()
  })

  it('el cliente que intenta reportar otra cosa de un «no estaba» recibe su texto', () => {
    expect(RESPUESTA_AL_CLIENTE.no_estabas.status).toBe(409)
    expect(RESPUESTA_AL_CLIENTE.no_estabas.error).toMatch(/no te encontramos/)
  })
})

describe('el repositorio, ejecutado', () => {
  it('pasa UNO de los dos (repartidor o local), y la ubicación solo si la hay', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: { result: 'ok' }, error: null })
    await db.markArrived({ courierId: 'm1' }, 'o1', { lat: 1, lng: 2 })
    expect(rpc).toHaveBeenLastCalledWith('pedido_llegue', { p_order_id: 'o1', p_courier_id: 'm1', p_lat: 1, p_lng: 2 })
    await db.markArrived({ businessId: 'b1' }, 'o1')
    expect(rpc).toHaveBeenLastCalledWith('pedido_llegue', { p_order_id: 'o1', p_business_id: 'b1' })
    await db.markCustomerAbsent({ businessId: 'b1' }, 'o1', 'local:x')
    expect(rpc).toHaveBeenLastCalledWith('pedido_cliente_ausente', { p_order_id: 'o1', p_business_id: 'b1', p_actor: 'local:x' })
    rpc.mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.markCustomerAbsent({ courierId: 'm1' }, 'o1', 'x')).rejects.toThrow('caída')
  })
})

describe('lo que ve cada uno', () => {
  const fuente = (ruta) => readFileSync(new URL(ruta, import.meta.url), 'utf8')

  it('el cliente recibe «llegó» y «no estaba», pero NO a cuántos metros estaba el repartidor', () => {
    const campos = fuente('../src/db/repositories/storefront.ts').match(/const CAMPOS_DEL_SEGUIMIENTO = '([^']+)'/)[1]
    expect(campos).toContain('arrived_at')
    expect(campos).toContain('customer_absent_at')
    expect(campos).not.toContain('arrived_distance_m')
  })

  it('el superadmin ve la hora y la distancia del «Llegué» para revisar un «sí estaba»', () => {
    const ruta = fuente('../src/routes/admin-incidencias.routes.ts')
    for (const campo of ['llegoEn: i.orders?.arrived_at', 'metrosDeLaDireccion: i.orders?.arrived_distance_m', 'noEstabaEn: i.orders?.customer_absent_at']) {
      expect(ruta).toContain(campo)
    }
    expect(fuente('../src/db/repositories/incidents.ts')).toMatch(/arrived_at, arrived_distance_m, customer_absent_at/)
  })
})
