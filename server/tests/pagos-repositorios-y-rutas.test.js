import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const pagosRouter = require('../dist/routes/admin-pagos.routes')

// ═══════════════════════════════════════════════════════════════════════════
// LOS REPOSITORIOS DEL DINERO Y LA PANTALLA «PAGOS», EJECUTADOS
// ═══════════════════════════════════════════════════════════════════════════
//
// Las cuentas se calculan en PostgreSQL (verificar-esquema.sql). Aquí: que
// cada función llama a la RPC correcta con los parámetros correctos, que un
// error de la base NO se traga, y que las rutas validan antes de escribir.

const SECRET = 'pagos-test-secret'
let secretoAnterior

beforeEach(() => {
  secretoAnterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
})
afterEach(() => {
  vi.restoreAllMocks()
  if (secretoAnterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = secretoAnterior
})

/** Una consulta encadenable que termina en lo que se le diga. */
function consulta(resultado) {
  const q = {}
  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'or', 'not', 'is']) q[m] = vi.fn(() => q)
  q.maybeSingle = vi.fn(async () => resultado)
  q.then = (ok, mal) => Promise.resolve(resultado).then(ok, mal)
  return q
}

describe('repositorio de cobros con tarjeta', () => {
  it('cada función llama a su RPC y lee la respuesta sin afirmar tipos', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({
      data: { result: 'ok', client_transaction_id: 'abc12345', amount_cents: '893', order_number: 7 },
      error: null,
    })
    const r = await db.startCardPayment({ businessId: 'b', orderId: 'o', contactPhone: '593', environment: 'pruebas' })
    expect(r).toMatchObject({ result: 'ok', clientTransactionId: 'abc12345', amountCents: 893, orderNumber: 7 })
    expect(rpc).toHaveBeenLastCalledWith('start_card_payment', {
      p_business_id: 'b', p_order_id: 'o', p_contact_phone: '593', p_environment: 'pruebas',
    })

    await db.claimCardPayment('abc12345', null)
    expect(rpc).toHaveBeenLastCalledWith('claim_card_payment', { p_client_transaction_id: 'abc12345', p_provider_transaction_id: undefined })
    await db.settleCardPayment({ clientTransactionId: 'abc12345', providerTransactionId: '9', statusCode: 3, capturedCents: 893, currency: 'USD' })
    expect(rpc.mock.lastCall[0]).toBe('settle_card_payment')
    expect(rpc.mock.lastCall[1]).toMatchObject({ p_status_code: 3, p_captured_cents: 893 })

    rpc.mockResolvedValue({ data: true, error: null })
    expect(await db.expireCardPayment('abc12345')).toBe(true)
    expect(await db.finishCardRefund('abc12345', true)).toBe(true)
    rpc.mockResolvedValue({ data: [{ id: 'p1' }], error: null })
    expect(await db.leaseCardPayments(5, 45)).toEqual([{ id: 'p1' }])
  })

  it('una respuesta rara de la base no inventa campos', async () => {
    vi.spyOn(client, 'rpc').mockResolvedValue({ data: null, error: null })
    expect(await db.claimCardPayment('abc12345', '9')).toEqual({ result: 'error',
      reason: undefined, status: undefined, orderId: undefined, businessId: undefined, orderNumber: undefined,
      environment: undefined, clientTransactionId: undefined, providerTransactionId: undefined, amountCents: undefined })
  })

  it('un error de la base se lanza, nunca se traga', async () => {
    vi.spyOn(client, 'rpc').mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.startCardPayment({ businessId: 'b', orderId: 'o', contactPhone: '5', environment: 'pruebas' })).rejects.toThrow('caída')
    await expect(db.settleCardPayment({ clientTransactionId: 'x', providerTransactionId: '9', statusCode: 3, capturedCents: 1, currency: 'USD' })).rejects.toThrow('caída')
    await expect(db.leaseCardPayments()).rejects.toThrow('caída')
    await expect(db.closeWeeklySettlements('2026-09-28')).rejects.toThrow('caída')
    await expect(db.markSettlementPaid('id', 'TRF-1')).rejects.toThrow('caída')
    await expect(db.getSettlementBalances()).rejects.toThrow('caída')
  })

  it('las lecturas filtran SIEMPRE por negocio y pedido', async () => {
    const q = consulta({ data: { status: 'aprobado' }, error: null })
    vi.spyOn(client, 'from').mockReturnValue(q)
    expect(await db.getLatestCardPayment('b1', 'o1')).toEqual({ status: 'aprobado' })
    expect(q.eq).toHaveBeenCalledWith('business_id', 'b1')
    expect(q.eq).toHaveBeenCalledWith('order_id', 'o1')
    expect(await db.getCardPaymentOrder('abc12345')).toEqual({ status: 'aprobado' })
    expect(await db.getApprovedCardPayments('b1', [])).toEqual([])
    const lista = consulta({ data: [{ order_id: 'o1' }], error: null })
    client.from.mockReturnValue(lista)
    expect(await db.getApprovedCardPayments('b1', ['o1'])).toEqual([{ order_id: 'o1' }])
    expect(lista.eq).toHaveBeenCalledWith('business_id', 'b1')
  })
})

describe('repositorio de liquidaciones', () => {
  it('cierra la semana, lee saldos y marca pagada', async () => {
    const rpc = vi.spyOn(client, 'rpc')
    rpc.mockResolvedValueOnce({ data: { semana: '2026-09-28', creadas: 2 }, error: null })
    expect(await db.closeWeeklySettlements('2026-09-28')).toEqual({ creadas: 2, motivo: undefined })
    rpc.mockResolvedValueOnce({ data: { creadas: 0, motivo: 'antes_del_corte' }, error: null })
    expect(await db.closeWeeklySettlements('2026-09-21')).toEqual({ creadas: 0, motivo: 'antes_del_corte' })
    rpc.mockResolvedValueOnce({ data: [{ business_id: 'b1', neto_cents: 1278 }], error: null })
    expect(await db.getSettlementBalances(null)).toEqual([{ business_id: 'b1', neto_cents: 1278 }])
    rpc.mockResolvedValueOnce({ data: { result: 'updated', status: 'pagada' }, error: null })
    expect(await db.markSettlementPaid('id', 'TRF-1')).toEqual({ result: 'updated', status: 'pagada' })
  })

  it('los locales de demostración salen en UNA consulta, como conjunto (2026-09-30)', async () => {
    const eq = vi.fn(async () => ({ data: [{ id: 'a' }, { id: 'b' }], error: null }))
    const select = vi.fn(() => ({ eq }))
    vi.spyOn(client, 'from').mockReturnValue({ select })
    const demos = await db.getDemoBusinessIds()
    expect([...demos]).toEqual(['a', 'b'])
    expect(eq).toHaveBeenCalledWith('is_demo', true)
    eq.mockResolvedValueOnce({ data: null, error: { message: 'caída' } })
    await expect(db.getDemoBusinessIds()).rejects.toThrow('caída')
  })

  it('el libro de UN local: siempre filtrado por su negocio', async () => {
    const q = consulta({ data: [{ id: 'l1' }], error: null })
    vi.spyOn(client, 'from').mockReturnValue(q)
    expect(await db.listLedger('b1', { soloSinLiquidar: true, limite: 9999 })).toEqual([{ id: 'l1' }])
    expect(q.eq).toHaveBeenCalledWith('business_id', 'b1')
    expect(q.is).toHaveBeenCalledWith('settlement_id', null)
    expect(q.limit).toHaveBeenCalledWith(500)
    await db.listLedger('b1')
    client.from.mockReturnValue(consulta({ data: null, error: { message: 'caída' } }))
    await expect(db.listLedger('b1')).rejects.toThrow('caída')
  })

  it('lista liquidaciones (con o sin negocio) y cobros con tope', async () => {
    const q = consulta({ data: [{ id: 's1' }], error: null })
    vi.spyOn(client, 'from').mockReturnValue(q)
    expect(await db.listSettlements({ businessId: 'b1', limite: 5000 })).toEqual([{ id: 's1' }])
    expect(q.eq).toHaveBeenCalledWith('business_id', 'b1')
    expect(q.limit).toHaveBeenCalledWith(300)
    expect(await db.listSettlements()).toEqual([{ id: 's1' }])
    expect(await db.listCardPayments(0)).toEqual([{ id: 's1' }])
    expect(q.limit).toHaveBeenLastCalledWith(1)
    client.from.mockReturnValue(consulta({ data: null, error: { message: 'caída' } }))
    await expect(db.listSettlements()).rejects.toThrow('caída')
    await expect(db.listCardPayments()).rejects.toThrow('caída')
  })
})

// ── La pantalla «Pagos» ─────────────────────────────────────────────────
async function despachar(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = pagosRouter.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const r = { status: 200, body: undefined }
  const res = { status(c) { r.status = c; return this }, json(v) { r.body = v; return this } }
  const correr = async (i) => {
    if (i >= handlers.length) return
    let siguiente = false
    let fallo
    await handlers[i](req, res, (e) => { siguiente = true; fallo = e })
    if (fallo) throw fallo
    if (siguiente) await correr(i + 1)
  }
  await correr(0)
  return r
}
const admin = () => `Bearer ${jwt.sign({ role: 'admin', mfa: true }, SECRET)}`

describe('rutas de Pagos', () => {
  it('sin superadmin no se ve ni se marca nada', async () => {
    expect((await despachar('get', '/api/admin/pagos')).status).toBe(401)
    const local = `Bearer ${jwt.sign({ role: 'client', businessId: 'b1' }, SECRET)}`
    expect((await despachar('get', '/api/admin/pagos', { auth: local })).status).toBe(403)
    expect((await despachar('post', '/api/admin/pagos/liquidaciones/:id/marcar', { auth: local })).status).toBe(403)
  })

  it('enseña la cuenta SOLO de quien tiene saldo a su favor', async () => {
    vi.spyOn(db, 'getSettlementBalances').mockResolvedValue([
      { business_id: 'b1', neto_cents: 1278 }, { business_id: 'b2', neto_cents: -120 },
    ])
    vi.spyOn(db, 'listSettlements').mockResolvedValue([{ id: 's1', business_id: 'b3', status: 'por_pagar' }])
    vi.spyOn(db, 'listCardPayments').mockResolvedValue([])
    // ⚠️ La ruta lee también los locales de demostración (2026-09-30). Sin
    // simularlo, en el CI la lectura se queda colgada y la prueba muere a los 5 s.
    vi.spyOn(db, 'getDemoBusinessIds').mockResolvedValue(new Set())
    const cuenta = vi.spyOn(db, 'getBusinessBankAccount').mockImplementation(async id => ({ account_number: `cta-${id}` }))
    const r = await despachar('get', '/api/admin/pagos', { auth: admin() })
    expect(r.status).toBe(200)
    expect(Object.keys(r.body.cuentas).sort()).toEqual(['b1', 'b3'])
    expect(cuenta).not.toHaveBeenCalledWith('b2')
  })

  it('cada fila dice si es de un local de DEMOSTRACIÓN, y su liquidación no se paga (2026-09-30)', async () => {
    vi.spyOn(db, 'getSettlementBalances').mockResolvedValue([{ business_id: 'demo', neto_cents: 500 }, { business_id: 'real', neto_cents: 300 }])
    vi.spyOn(db, 'listSettlements').mockResolvedValue([{ id: 's1', business_id: 'demo', status: 'por_pagar' }])
    vi.spyOn(db, 'listCardPayments').mockResolvedValue([{ id: 'c1', business_id: 'demo' }])
    vi.spyOn(db, 'getDemoBusinessIds').mockResolvedValue(new Set(['demo']))
    vi.spyOn(db, 'getBusinessBankAccount').mockResolvedValue(null)
    const r = await despachar('get', '/api/admin/pagos', { auth: admin() })
    expect(r.body.saldos.map(s => [s.business_id, s.demo])).toEqual([['demo', true], ['real', false]])
    expect(r.body.liquidaciones[0].demo).toBe(true)
    expect(r.body.cobros[0].demo).toBe(true)

    const ruta = '/api/admin/pagos/liquidaciones/:id/marcar'
    vi.spyOn(db, 'markSettlementPaid').mockResolvedValue({ result: 'demo' })
    const marcar = await despachar('post', ruta, { auth: admin(), params: { id: '22222222-2222-4222-8222-222222222222' }, body: { referencia: 'TRF-1' } })
    expect(marcar.status).toBe(409)
    expect(marcar.body.error).toMatch(/local de demostración/)
  })

  it('marcar exige id válido y referencia, y no marca dos veces', async () => {
    const ruta = '/api/admin/pagos/liquidaciones/:id/marcar'
    const id = '22222222-2222-4222-8222-222222222222'
    expect((await despachar('post', ruta, { auth: admin(), params: { id: 'x' }, body: { referencia: 'TRF-1' } })).status).toBe(400)
    expect((await despachar('post', ruta, { auth: admin(), params: { id }, body: { referencia: 'x' } })).status).toBe(400)
    const marcar = vi.spyOn(db, 'markSettlementPaid').mockResolvedValue({ result: 'updated', status: 'pagada' })
    const bien = await despachar('post', ruta, { auth: admin(), params: { id }, body: { referencia: ' TRF-1 ' } })
    expect(bien).toMatchObject({ status: 200, body: { status: 'pagada' } })
    expect(marcar).toHaveBeenCalledWith(id, 'TRF-1')
    marcar.mockResolvedValue({ result: 'not_pending' })
    expect((await despachar('post', ruta, { auth: admin(), params: { id }, body: { referencia: 'TRF-1' } })).status).toBe(409)
  })
})

// ── La vuelta de PayPhone y la tarea real del cierre ─────────────────────
describe('la vuelta de PayPhone', () => {
  const retorno = require('../dist/routes/pagos.routes')
  async function volver(query) {
    const layer = retorno.stack.find(l => l.route?.path === '/pagos/payphone/retorno')
    const handlers = layer.route.stack.map(l => l.handle)
    const r = { status: 200, headers: {}, redirect: null, html: null }
    const res = {
      setHeader(k, v) { r.headers[k] = v },
      status(c) { r.status = c; return this },
      type() { return this },
      send(h) { r.html = h; return this },
      redirect(c, url) { r.status = c; r.redirect = url; return this },
    }
    // Se salta el limitador (handlers[0]): aquí se prueba la lógica.
    await handlers[handlers.length - 1]({ query, headers: {} }, res, () => {})
    return r
  }

  it('una referencia inventada no llega a la base y no redirige a ningún sitio', async () => {
    const reclamo = vi.spyOn(db, 'claimCardPayment')
    const r = await volver({ clientTransactionId: "x' or 1=1", id: '1' })
    expect(r.status).toBe(404)
    expect(r.html).toMatch(/No encontramos ese pago/)
    expect(reclamo).not.toHaveBeenCalled()
    expect(r.headers['Cache-Control']).toBe('no-store')
  })

  it('confirma y devuelve al cliente a SU tienda, sin afirmar nada en la URL', async () => {
    const reclamo = vi.spyOn(db, 'claimCardPayment').mockResolvedValue({ result: 'final', status: 'aprobado', orderId: 'o1', businessId: 'b1' })
    vi.spyOn(db, 'getCardPaymentOrder').mockResolvedValue({ order_id: 'o1', business_id: 'b1' })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({ slug: 'burger-brava' })
    const r = await volver({ clientTransactionId: 'abcdef1234567890abcdef1234567890', id: '91754743' })
    expect(reclamo).toHaveBeenCalledWith('abcdef1234567890abcdef1234567890', '91754743')
    expect(r).toMatchObject({ status: 303, redirect: '/t/burger-brava?pago=o1' })
  })

  it('si el cliente canceló en PayPhone no se confirma nada', async () => {
    const reclamo = vi.spyOn(db, 'claimCardPayment')
    vi.spyOn(db, 'getCardPaymentOrder').mockResolvedValue(null)
    const r = await volver({ clientTransactionId: 'abcdef1234567890abcdef1234567890', cancelado: '1' })
    expect(reclamo).not.toHaveBeenCalled()
    expect(r.status).toBe(404)
  })
})

describe('la tarea real del cierre', () => {
  it('pide cerrar la última semana terminada y no lanza si la base falla', async () => {
    const { cerrarSemanaAnterior } = require('../dist/services/liquidacion')
    const cerrar = vi.spyOn(db, 'closeWeeklySettlements').mockResolvedValue({ creadas: 1, motivo: undefined })
    // La misma tarea cierra también la semana de los motorizados.
    const motos = vi.spyOn(db, 'closeWeeklyCourierSettlements').mockResolvedValue({ creadas: 2 })
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const r = await cerrarSemanaAnterior()
    expect(r.creadas).toBe(3)
    expect(motos.mock.calls[0][0]).toBe(cerrar.mock.calls[0][0])
    expect(cerrar.mock.calls[0][0]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    cerrar.mockRejectedValue(new Error('caída'))
    vi.spyOn(db, 'recordPlatformError').mockResolvedValue(undefined)
    expect(await cerrarSemanaAnterior()).toBeNull()
  })
})
