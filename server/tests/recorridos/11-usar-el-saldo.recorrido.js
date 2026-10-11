import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, centavos, cerrarSql, clientePorLaApp, cobroDelPedido, configurarElDinero, entrarComoLocal, exigir, http,
  lineaDelLibro, llevarHastaEntregar, pedirYPagarConTarjeta, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// USAR EL SALDO UMBANI AL PEDIR, DE PUNTA A PUNTA (2026-10-10)
// ═══════════════════════════════════════════════════════════════════════════
//
// Un cliente NUEVO de la app recibe saldo por el camino de verdad (el
// superadmin le resuelve un reclamo a su favor) y lo usa: con efectivo, con
// una transferencia que se cancela, con un pedido que el saldo cubre entero y
// con tarjeta. El TOTAL nunca cambia: lo que se cobra es lo que falta, y lo
// pagado con saldo lo pone Umbani en el libro. ⚠️ El ORDEN importa (vitest
// las corre en el orden del archivo): el escalón 3 va al final porque deja al
// cliente pagando solo por adelantado.
//
// ⚠️ El freno de la tienda deja 8 intentos de pedido por minuto y por IP (y
// cada archivo de recorridos tiene la suya). Por eso el saldo y los rechazos
// salen de UN solo pedido entregado —el superadmin puede registrar varias
// incidencias sobre el mismo— en vez de un pedido de relleno por cada una.

let cliente
let local
let carta
let addressId
let negocio
let comoEstaba
/** El pedido entregado del que salen las incidencias (su número en el local). */
let numeroBase

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorLaApp()
  local = await entrarComoLocal()
  carta = await cliente.catalogo()
  addressId = await cliente.direccion()
  ;[{ id: negocio, ...comoEstaba }] = await sql(`select id, delivery_by, own_fleet, cooperative_id from businesses where slug = 'demo'`)
  // El local reparte él mismo: lo entrega desde su panel.
  await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'local', own_fleet: false }))
  numeroBase = await entregado()
})
afterAll(async () => {
  await admin.pedir('PUT', `/api/admin/clients/${negocio}`, comoEstaba)
  await cerrarSql()
})

const [barato, caro] = [
  () => productosSimples(carta).find(p => Number(p.priceFrom) <= 3),
  () => productosSimples(carta).find(p => Number(p.priceFrom) >= 5),
]

/** Su saldo, como lo ve la app. */
const yo = () => exigir(200, http('GET', '/api/v1/yo', { token: cliente.tokenApp }))
const saldo = async () => (await yo()).saldo.cents

/** Un pedido suyo, entregado: de él salen el saldo y los rechazos. */
async function entregado() {
  const pedido = await exigir(201, cliente.pedir_({
    items: [{ productId: caro().id, quantity: 2 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
  }))
  await llevarHastaEntregar(local, pedido.id)
  const [{ order_number: numero }] = await sql('select order_number from orders where id = $1', [pedido.id])
  return numero
}

/** El superadmin le resuelve a su favor un reclamo de lo que faltó: saldo en su cuenta. */
async function darleSaldo(cents) {
  const { id } = await exigir(201, admin.pedir('POST', '/api/admin/incidencias', {
    localId: negocio, numero: numeroBase, tipo: 'falta_producto', nota: 'Faltó la bebida (recorrido del saldo)',
  }))
  const r = await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${id}/resolver`, {
    estado: 'resuelta', responsable: 'local', compensacionCents: cents, nota: 'El local la olvidó',
  }))
  expect(r.saldoCents).toBe(cents)
}

describe('el saldo paga lo que alcanza, con cualquier método', () => {
  it('cotiza con su saldo: el total no cambia y dice cuánto falta', async () => {
    await darleSaldo(150)
    expect(await saldo()).toBe(150)
    const cuerpo = { items: [{ productId: caro().id, quantity: 1 }], fulfillment: 'delivery' }
    const sin = await cliente.cotizar(cuerpo)
    const con = await cliente.cotizar({ ...cuerpo, usarSaldo: true })
    expect(con.total).toBe(sin.total)
    expect(sin).toMatchObject({ saldoUsadoCents: 0, aPagarCents: centavos(sin.total) })
    expect(con).toMatchObject({ saldoUsadoCents: 150, aPagarCents: centavos(con.total) - 150 })
  })

  it('EFECTIVO + saldo: paga lo que falta, el local lo ve, y en el libro lo pone Umbani', async () => {
    const pedido = await exigir(201, cliente.pedir_({
      items: [{ productId: caro().id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId, usarSaldo: true,
    }))
    expect(pedido).toMatchObject({ payment_method: 'efectivo', saldoUsadoCents: 150, aPagarCents: centavos(pedido.total) - 150 })
    expect(await saldo()).toBe(0)
    // El seguimiento dice lo mismo, y no lleva `credit_cents`: un solo nombre.
    const visto = await cliente.pedido(pedido.id)
    expect(visto).toMatchObject({ saldoUsadoCents: 150, aPagarCents: centavos(pedido.total) - 150 })
    expect(visto).not.toHaveProperty('credit_cents')
    // El local lo ve en su panel (lo enseña el paso de las pantallas).
    const enElPanel = (await local.pedidos()).find(p => p.id === pedido.id)
    expect(enElPanel.credit_cents).toBe(150)

    await llevarHastaEntregar(local, pedido.id)
    const libro = await lineaDelLibro(pedido.id)
    expect(libro).toMatchObject({ en_mano: 'local', credit_cents: 150, total_cents: centavos(pedido.total) })
    expect(libro.en_mano_cents).toBe(centavos(pedido.total) - 150)
  })

  it('si el pedido se cancela, el saldo VUELVE', async () => {
    await darleSaldo(200)
    const pedido = await exigir(201, cliente.pedir_({
      items: [{ productId: caro().id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'transferencia', addressId, usarSaldo: true,
    }))
    expect(pedido).toMatchObject({ status: 'esperando_pago', saldoUsadoCents: 200 })
    expect(await saldo()).toBe(0)
    await exigir(200, local.cambiarEstado(pedido.id, 'cancelado'))
    expect(await saldo()).toBe(200)
  })

  it('si lo cubre ENTERO, el pedido nace pagado y no pasa por PayPhone', async () => {
    await darleSaldo(300)
    const pedido = await exigir(201, cliente.pedir_({
      items: [{ productId: barato().id, quantity: 1 }], fulfillment: 'pickup', paymentMethod: 'tarjeta', usarSaldo: true,
    }))
    expect(pedido).toMatchObject({
      payment_method: 'saldo', status: 'pendiente', aPagarCents: 0, saldoUsadoCents: centavos(pedido.total),
    })
    expect(await saldo()).toBe(500 - centavos(pedido.total))
    // No hay nada que cobrar con la tarjeta: ni se preparó un cobro, y ya está pagado.
    expect(await cobroDelPedido(pedido.id)).toBeUndefined()
    expect((await cliente.pedido(pedido.id)).payment_confirmed_at).toBeTruthy()

    await llevarHastaEntregar(local, pedido.id, { aDomicilio: false })
    const libro = await lineaDelLibro(pedido.id)
    expect(libro).toMatchObject({
      payment_method: 'saldo', en_mano: 'umbani', en_mano_cents: 0, credit_cents: centavos(pedido.total), provider_fee_cents: 0,
    })
  })

  it('TARJETA + saldo: PayPhone cobra solo lo que falta, al centavo', async () => {
    const disponible = await saldo()
    expect(disponible).toBeGreaterThan(0)
    // Dos de lo caro: más de lo que le queda, así que paga una parte con tarjeta.
    const { pedido, cobro } = await pedirYPagarConTarjeta(cliente, {
      items: [{ productId: caro().id, quantity: 2 }], fulfillment: 'delivery', addressId, usarSaldo: true,
    })
    const usado = Math.min(disponible, centavos(pedido.total))
    expect(pedido).toMatchObject({ saldoUsadoCents: usado, aPagarCents: centavos(pedido.total) - usado })
    expect(cobro).toMatchObject({ amount_cents: centavos(pedido.total) - usado, captured_cents: centavos(pedido.total) - usado, status: 'aprobado' })
    expect((await cliente.pedido(pedido.id)).payment_confirmed_at).toBeTruthy()

    await llevarHastaEntregar(local, pedido.id)
    const libro = await lineaDelLibro(pedido.id)
    expect(libro).toMatchObject({ en_mano: 'umbani', credit_cents: usado, en_mano_cents: centavos(pedido.total) - usado })
  })
})

describe('el escalón 3 paga por adelantado', () => {
  it('con dos reclamos rechazados no le ofrece efectivo, y la base lo exige', async () => {
    for (let i = 0; i < 2; i++) {
      const { id } = await exigir(201, admin.pedir('POST', '/api/admin/incidencias', {
        localId: negocio, numero: numeroBase, tipo: 'falta_producto', nota: 'Dice que faltó algo',
      }))
      await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${id}/resolver`, { estado: 'descartada', nota: 'Sí iba en la bolsa' }))
    }
    const cuenta = await yo()
    expect(cuenta.soloPagoPorAdelantado).toBe(true)
    expect(JSON.stringify(cuenta)).not.toMatch(/rechaz|escal/i)

    const cuerpo = { items: [{ productId: caro().id, quantity: 1 }], fulfillment: 'delivery', addressId }
    // (Que con tarjeta o transferencia SÍ puede, lo prueba la base: bloque «USAR EL SALDO».)
    const efectivo = await cliente.pedir_({ ...cuerpo, paymentMethod: 'efectivo' })
    expect(efectivo.status).toBe(400)
    expect(efectivo.body.error).toBe('Para este pedido elige tarjeta o transferencia.')
  })
})
