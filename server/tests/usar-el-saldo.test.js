import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { NEGOCIO_ABIERTO, db, ejecutar } from './manejadores-de-la-tienda.mjs'
import { fuenteDeLaTienda } from './fuente-de-rutas.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// USAR EL SALDO UMBANI AL PEDIR (2026-10-10, fase 2 de las incidencias, parte 2)
// ═══════════════════════════════════════════════════════════════════════════
// El saldo paga el pedido como cualquier otro pago, también con efectivo. El
// TOTAL no cambia: lo que se cobra es total − saldo. Las reglas de dinero
// (cuánto se gasta, cuándo vuelve, el escalón 3, el libro y el lunes) se
// prueban en PostgreSQL real: bloque «USAR EL SALDO» de verify:schema. Aquí,
// que el servidor las ALCANCE: que la app pueda pedirlo, que el saldo sea de
// la sesión y no del teléfono, y que todo el que cobra reste lo mismo.

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const { porCobrar, porCobrarCents, saldoUsadoCents } = require('../dist/lib/por-cobrar')
const { quoteCart } = require('../dist/services/cotizacion')
const { pedidoParaElCliente } = require('../dist/lib/precio-para-el-cliente')
const { textoParaElDueno } = require('../dist/services/owner-order-notice')
const avisoAlDueno = require('../dist/services/owner-order-notice')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('lo que falta por cobrar: una sola regla', () => {
  it('es el total menos lo pagado con saldo, en centavos, y nunca negativo', () => {
    expect(porCobrarCents({ total: '8.00', credit_cents: 110 })).toBe(690)
    expect(porCobrar({ total: 15.18, credit_cents: 500 })).toBe(10.18)
    expect(saldoUsadoCents({ total: 8, credit_cents: '110' })).toBe(110)
    // Sin saldo (o un pedido viejo sin la columna): el total entero.
    expect(porCobrarCents({ total: 15.18 })).toBe(1518)
    expect(porCobrarCents({ total: 15.18, credit_cents: null })).toBe(1518)
    // Un dato roto no regala ni cobra de más.
    expect(saldoUsadoCents({ credit_cents: -50 })).toBe(0)
    expect(porCobrarCents({ total: 5, credit_cents: 900 })).toBe(0)
  })
})

describe('la cotización: la misma regla que la base', () => {
  const PIZZA = { id: 'p1', name: 'Pizza', price: 8, price_sale: null, active: true, stock: 'disponible' }
  const cotizar = (saldoCents) => quoteCart({
    items: [{ productId: 'p1', quantity: 1 }], products: [PIZZA], variants: [], optionGroups: [], options: [],
    deliveryFee: 0, fulfillment: 'pickup', saldoCents,
  })

  it('el saldo paga hasta el total y nunca más; el total no cambia', () => {
    expect(cotizar(110)).toMatchObject({ total: 8, saldoUsadoCents: 110, aPagarCents: 690 })
    expect(cotizar(5000)).toMatchObject({ total: 8, saldoUsadoCents: 800, aPagarCents: 0 })
  })

  it('sin saldo (o uno roto) se cotiza como siempre', () => {
    for (const nada of [undefined, null, 0, -20, Number.NaN]) {
      expect(cotizar(nada)).toMatchObject({ total: 8, saldoUsadoCents: 0, aPagarCents: 800 })
    }
  })
})

describe('la ruta de cotizar', () => {
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ ...NEGOCIO_ABIERTO, delivery_fee: 0 })
    vi.spyOn(db, 'getStorefrontProducts').mockResolvedValue([
      { id: 'p1', name: 'Pizza', price: 8, price_sale: null, active: true, stock: 'disponible' },
    ])
    vi.spyOn(db, 'getStorefrontVariants').mockResolvedValue([])
    vi.spyOn(db, 'getStorefrontOptionGroups').mockResolvedValue([])
    vi.spyOn(db, 'getStorefrontOptions').mockResolvedValue([])
    vi.spyOn(db, 'getBusinessPricingRule').mockResolvedValue(null)
  })
  const cotizar = ({ body, storefront }) => ejecutar('/api/store/:slug/quote', 'post', {
    storeBusinessId: 'negocio-a', storefront, params: { slug: 'pizzeria' },
    body: { items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'pickup', ...body },
  })
  const SESION = { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '593900000001' }

  it('con `usarSaldo`, el saldo es el de la PERSONA de la sesión', async () => {
    const saldo = vi.spyOn(db, 'customerCreditBalance').mockResolvedValue({ cents: 110, proximo: null })
    // Un `customerId` en el cuerpo no cuenta: el saldo sale de la sesión.
    const r = await cotizar({ body: { usarSaldo: true, customerId: 'otro' }, storefront: SESION })
    expect(saldo).toHaveBeenCalledWith('cliente-1')
    expect(r.body).toMatchObject({ total: 8, saldoUsadoCents: 110, aPagarCents: 690 })
  })

  it('sin pedirlo, sin sesión o con un «sí» que no es `true`, ni se mira el saldo', async () => {
    const saldo = vi.spyOn(db, 'customerCreditBalance').mockResolvedValue({ cents: 110, proximo: null })
    for (const caso of [{ body: {}, storefront: SESION }, { body: { usarSaldo: true } }, { body: { usarSaldo: 'true' }, storefront: SESION }]) {
      expect((await cotizar(caso)).body).toMatchObject({ saldoUsadoCents: 0, aPagarCents: 800 })
    }
    expect(saldo).not.toHaveBeenCalled()
  })

  it('si el saldo no se puede leer, se cotiza sin él (la base decide al pedir)', async () => {
    vi.spyOn(db, 'customerCreditBalance').mockRejectedValue(new Error('caída'))
    const r = await cotizar({ body: { usarSaldo: true }, storefront: SESION })
    expect(r).toMatchObject({ status: 200, body: { total: 8, saldoUsadoCents: 0, aPagarCents: 800 } })
  })
})

describe('crear el pedido', () => {
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(NEGOCIO_ABIERTO)
    vi.spyOn(db, 'getSchedule').mockResolvedValue([])
    vi.spyOn(db, 'isCustomerBlocked').mockResolvedValue(false)
  })
  const pedir = (body) => ejecutar('/api/store/:slug/orders', 'post', {
    storefront: { businessId: 'negocio-a', customerId: 'cliente-1', contactPhone: '593900000001' },
    params: { slug: 'pizzeria' },
    body: { items: [{ productId: 'p1', quantity: 1 }], fulfillment: 'pickup', ...body },
  })

  it('solo con `usarSaldo: true` se le pide a la base que use el saldo', async () => {
    const crear = vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({ data: { id: 'pedido-1' }, error: null })
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue(null)
    await pedir({ paymentMethod: 'efectivo', usarSaldo: true })
    expect(crear).toHaveBeenLastCalledWith(expect.objectContaining({ useCredit: true, customerId: 'cliente-1' }))
    for (const nada of [{}, { usarSaldo: 'true' }, { usarSaldo: 1 }]) {
      await pedir({ paymentMethod: 'efectivo', ...nada })
      expect(crear).toHaveBeenLastCalledWith(expect.objectContaining({ useCredit: false }))
    }
  })

  it('devuelve lo pagado con saldo y lo que FALTA, leído de la fila sellada', async () => {
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({
      data: { id: 'pedido-1', total: 8, credit_cents: 110 }, error: null,
    })
    vi.spyOn(db, 'getOrderMoney').mockResolvedValue({
      subtotal: 8, shipping: 0, total: 8, status: 'pendiente', payment_method: 'efectivo', credit_cents: 110,
    })
    const r = await pedir({ paymentMethod: 'efectivo', usarSaldo: true })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ total: 8, saldoUsadoCents: 110, aPagarCents: 690, payment_method: 'efectivo' })
    // Un solo nombre hacia el cliente, como en el seguimiento.
    expect(r.body).not.toHaveProperty('credit_cents')
  })

  it('con tarjeta, se avisa al dueño solo si el saldo la cubrió entera', async () => {
    // La tarjeta encendida en el local y en el servidor, en el mismo modo.
    vi.stubEnv('PAYPHONE_TOKEN', 'token-de-prueba')
    vi.stubEnv('PAYPHONE_MODO', 'pruebas')
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue({ ...NEGOCIO_ABIERTO, card_mode: 'pruebas' })
    const avisar = vi.spyOn(avisoAlDueno, 'avisarAlDuenoDelPedido').mockResolvedValue(false)
    vi.spyOn(db, 'createStorefrontOrder').mockResolvedValue({ data: { id: 'pedido-1' }, error: null })
    // Cubierto entero: la base lo dejó en `saldo`, pagado. PayPhone no confirmará nada.
    vi.spyOn(db, 'getOrderMoney').mockResolvedValueOnce({
      subtotal: 8, shipping: 0, total: 8, status: 'pendiente', payment_method: 'saldo', credit_cents: 800,
    })
    const pagado = await pedir({ paymentMethod: 'tarjeta', usarSaldo: true })
    expect(pagado.body).toMatchObject({ saldoUsadoCents: 800, aPagarCents: 0, payment_method: 'saldo' })
    expect(avisar).toHaveBeenCalledTimes(1)
    // En parte: sigue esperando el cobro, y el aviso sale cuando PayPhone confirme.
    vi.spyOn(db, 'getOrderMoney').mockResolvedValueOnce({
      subtotal: 8, shipping: 0, total: 8, status: 'esperando_pago', payment_method: 'tarjeta', credit_cents: 110,
    })
    const debe = await pedir({ paymentMethod: 'tarjeta', usarSaldo: true })
    expect(debe.body).toMatchObject({ saldoUsadoCents: 110, aPagarCents: 690 })
    expect(avisar).toHaveBeenCalledTimes(1)
  })
})

describe('el repositorio', () => {
  it('`p_use_credit` viaja SOLO cuando se pide (sin él, la RPC de siempre)', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: { id: 'x' }, error: null })
    await db.createStorefrontOrder({ businessId: 'b', customerId: 'c', contactPhone: '593', items: [], useCredit: true })
    expect(rpc.mock.lastCall[1]).toMatchObject({ p_use_credit: true })
    await db.createStorefrontOrder({ businessId: 'b', customerId: 'c', contactPhone: '593', items: [] })
    expect(rpc.mock.lastCall[1]).not.toHaveProperty('p_use_credit')
  })

  it('lo que cobra o enseña lee `credit_cents`; si no, cobraría el total entero', () => {
    const tienda = readFileSync('src/db/repositories/storefront.ts', 'utf8')
    const pedidos = readFileSync('src/db/repositories/orders.ts', 'utf8')
    // El dinero oficial del pedido recién creado y el seguimiento del cliente.
    expect(tienda).toMatch(/select\('subtotal,shipping,total,status,payment_method,credit_cents'\)/)
    expect(tienda).toMatch(/CAMPOS_DEL_SEGUIMIENTO = '[^']*credit_cents/)
    // El comprobante (en la app y por el chat), el aviso de transferencia y el del dueño.
    expect(pedidos).toMatch(/select\('total,credit_cents,created_at,contact_name'\)/)
    expect(pedidos.match(/credit_cents/g).length).toBeGreaterThanOrEqual(4)
  })
})

describe('todo el que cobra resta lo mismo', () => {
  it('el comprobante se compara con lo que FALTABA, no con el total', () => {
    const pagos = fuenteDeLaTienda()
    const buzon = readFileSync('src/services/payment-proof-inbox.ts', 'utf8')
    const aviso = readFileSync('src/services/payment-request-notice.ts', 'utf8')
    expect(pagos).toMatch(/total: porCobrar\(pedido\)/)
    expect(pagos).not.toMatch(/total: Number\(pedido\.total/)
    expect(buzon.match(/total: porCobrar\(pedido\)/g)).toHaveLength(2)
    expect(aviso).toMatch(/total: porCobrar\(pedido\)/)
  })

  it('el cliente ve lo que pagó con saldo y lo que faltaba, sin `credit_cents`', () => {
    const pedido = pedidoParaElCliente({
      id: 'p', total: 8, shipping: 0, service_fee: 0, credit_cents: 110, order_items: [],
    }, null)
    expect(pedido).toMatchObject({ total: 8, saldoUsadoCents: 110, aPagarCents: 690 })
    expect(pedido).not.toHaveProperty('credit_cents')
    expect(pedidoParaElCliente({ id: 'q', total: 8, order_items: [] }, null))
      .toMatchObject({ saldoUsadoCents: 0, aPagarCents: 800 })
  })

  it('el dueño lee qué se pagó con saldo y, en efectivo, cuánto COBRA', () => {
    const efectivo = textoParaElDueno({ order_number: 7, total: 8, credit_cents: 110, payment_method: 'efectivo', fulfillment: 'pickup' })
    expect(efectivo).toContain('*Total: $8.00*')
    expect(efectivo).toContain('Pagó $1.10 con saldo Umbani')
    expect(efectivo).toContain('*Cobra: $6.90*')
    // Con tarjeta el resto ya lo cobró PayPhone: no hay nada que cobrar en la puerta.
    const tarjeta = textoParaElDueno({ total: 8, credit_cents: 110, payment_method: 'tarjeta', fulfillment: 'pickup' })
    expect(tarjeta).toContain('Pagó $1.10 con saldo Umbani')
    expect(tarjeta).not.toContain('Cobra:')
    const saldo = textoParaElDueno({ total: 8, credit_cents: 800, payment_method: 'saldo', fulfillment: 'pickup' })
    expect(saldo).toContain('Pago: saldo Umbani (ya está pagado)')
    expect(saldo).not.toContain('Cobra:')
    // Sin saldo, el aviso de siempre.
    const normal = textoParaElDueno({ total: 8, payment_method: 'efectivo', fulfillment: 'pickup' })
    expect(normal).not.toMatch(/saldo|Cobra:/i)
  })
})
