import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  centavos, cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, exigir,
  lineaDelLibro, llevarHastaEntregar, payphone, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// UN PEDIDO A DOMICILIO EN EFECTIVO, DE PUNTA A PUNTA
// ═══════════════════════════════════════════════════════════════════════════
//
// El cliente de hoy: escribe al WhatsApp de Umbani, abre la tienda, pide y
// paga en la puerta. El local lo acepta, lo prepara, lo entrega. Y el dinero
// queda repartido al centavo en el libro: lo del local, el envío y lo de
// Umbani suman exactamente lo que pagó el cliente.
//
// ⚠️ Cómo se lee el dinero (desde el 2026-10-01, con el margen ESCONDIDO):
//   · la cotización y el seguimiento traen solo lo del CLIENTE: `subtotal`
//     (sus productos, a precio de carta), envío, tarifa y total, y suman;
//   · lo del LOCAL (`merchant_subtotal`) y lo de UMBANI (`platform_markup`: su
//     margen MÁS la tarifa) solo existen en la base, y de ahí se leen aquí.
// Total = subtotal + envío + tarifa = merchant_subtotal + platform_markup + envío.

let cliente
let local
let carta
let cotizacion
let pedido

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorWhatsApp()
  local = await entrarComoLocal()
  carta = await cliente.catalogo()
})
afterAll(cerrarSql)

describe('un pedido en EFECTIVO, de punta a punta', () => {
  let items
  let addressId

  it('el servidor cotiza: lo que vio el cliente en la carta es lo que se cobra', async () => {
    const [primero, segundo] = productosSimples(carta)
    items = [{ productId: primero.id, quantity: 2 }, { productId: segundo.id, quantity: 1 }]
    cotizacion = await cliente.cotizar({ items, fulfillment: 'delivery' })

    // El precio de la CARTA (con el margen dentro) por la cantidad, al centavo.
    expect(centavos(cotizacion.subtotal))
      .toBe(centavos(primero.priceFrom) * 2 + centavos(segundo.priceFrom))
    expect(cotizacion.lines.map(l => l.unitPrice)).toEqual([primero.priceFrom, segundo.priceFrom])
    expect(cotizacion.lines.reduce((t, l) => t + centavos(l.lineTotal), 0)).toBe(centavos(cotizacion.subtotal))
    expect(cotizacion.shipping).toBe(1.5)
    expect(cotizacion.serviceFee).toBe(0.1)
    expect(centavos(cotizacion.total)).toBe(
      centavos(cotizacion.subtotal) + centavos(cotizacion.shipping) + centavos(cotizacion.serviceFee),
    )
  })

  it('🔒 la cotización NO lleva el precio del local ni el margen de Umbani', () => {
    for (const clave of ['merchantSubtotal', 'platformMarkup', 'markupPercentage', 'customerSubtotal']) {
      expect(cotizacion).not.toHaveProperty(clave)
    }
  })

  it('pide a domicilio en efectivo: entra «pendiente» y por lo que dijo la cotización', async () => {
    addressId = await cliente.direccion()
    // Un precio mandado desde el teléfono no cuenta: la base pone el suyo.
    const conPrecioFalso = items.map(i => ({ ...i, unitPrice: 0.01, price: 0.01 }))
    pedido = await exigir(201, cliente.pedir_({
      items: conPrecioFalso, fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
    }))
    expect(pedido.status).toBe('pendiente')
    expect(pedido.payment_method).toBe('efectivo')
    expect(centavos(pedido.total)).toBe(centavos(cotizacion.total))
  })

  it('repetir el envío con la misma clave no crea un segundo pedido', async () => {
    const [{ idempotency_key: clave }] = await sql('select idempotency_key from orders where id = $1', [pedido.id])
    const otraVez = await cliente.pedir('POST', '/api/store/:slug/orders', {
      idempotencyKey: clave, items, fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
    })
    expect([200, 201]).toContain(otraVez.status)
    expect(otraVez.body.id).toBe(pedido.id)
    const [{ n }] = await sql(`select count(*)::int as n from orders where idempotency_key = $1`, [clave])
    expect(n).toBe(1)
  })

  it('el local lo ve en su panel con la dirección y el total', async () => {
    const enElPanel = (await local.pedidos()).find(p => p.id === pedido.id)
    expect(enElPanel).toBeTruthy()
    expect(enElPanel.status).toBe('pendiente')
    expect(enElPanel.delivery_address).toBe('Av. de las Pruebas 123')
    expect(centavos(enElPanel.total)).toBe(centavos(cotizacion.total))
    expect(centavos(enElPanel.shipping)).toBe(150)
  })

  it('el local lo acepta, prepara línea a línea, sale y lo entrega', async () => {
    await llevarHastaEntregar(local, pedido.id)
    const visto = await cliente.pedido(pedido.id)
    expect((visto.order || visto).status).toBe('completado')
  })

  it('🔒 el cliente sigue su pedido con SUS precios: las líneas suman y no hay nada del local', async () => {
    const visto = await cliente.pedido(pedido.id)
    const lineas = cotizacion.lines.map(l => centavos(l.lineTotal))
    expect(visto.order_items.map(i => centavos(i.line_total)).sort()).toEqual(lineas.sort())
    expect(centavos(visto.subtotal) + centavos(visto.shipping) + centavos(visto.service_fee)).toBe(centavos(visto.total))
    expect(visto).not.toHaveProperty('merchant_subtotal')
    expect(visto).not.toHaveProperty('platform_markup')
  })

  it('queda UNA venta por el total del pedido', async () => {
    const ventas = await sql('select total from sales where order_id = $1', [pedido.id])
    expect(ventas).toHaveLength(1)
    expect(centavos(ventas[0].total)).toBe(centavos(cotizacion.total))
  })

  it('el libro reparte el total al centavo: local + envío + Umbani', async () => {
    const linea = await lineaDelLibro(pedido.id)
    // Lo del local y lo de Umbani se leen de la BASE: al teléfono no viajan.
    const [fila] = await sql('select merchant_subtotal, platform_markup, service_fee from orders where id = $1', [pedido.id])
    expect(linea).toBeTruthy()
    expect(linea.total_cents).toBe(centavos(cotizacion.total))
    expect(linea.local_cents + linea.reparto_cents + linea.umbani_cents).toBe(linea.total_cents)
    expect(linea.local_cents).toBe(centavos(fila.merchant_subtotal))
    expect(linea.reparto_cents).toBe(150)
    expect(linea.umbani_cents).toBe(centavos(fila.platform_markup))
    // Lo de Umbani es su margen MÁS la tarifa, y el margen es lo que el
    // cliente pagó por encima de lo del local.
    expect(centavos(fila.platform_markup)).toBe(
      centavos(cotizacion.subtotal) - centavos(fila.merchant_subtotal) + centavos(fila.service_fee),
    )
    // Efectivo cobrado por la gente del local: el dinero y el envío son suyos.
    expect(linea.payment_method).toBe('efectivo')
    expect(linea.en_mano).toBe('local')
    expect(linea.reparto_para).toBe('local')
    expect(linea.provider_fee_cents).toBe(0)
  })

  // Hasta el 2026-10-09 aquí se esperaban tres avisos por WhatsApp. Umbani es
  // solo app: el cliente sigue su pedido en la app y no le sale ni uno.
  it('al cliente ya NO le escribe por WhatsApp: el pedido se sigue en la app', async () => {
    const visto = await cliente.pedido(pedido.id)
    expect((visto.order || visto).status).toBe('completado')
    // Los avisos salían SIN esperar, justo después de cada cambio de estado: se
    // da un margen para que, si saliera alguno, estuviera ya en el buzón falso.
    await new Promise(listo => setTimeout(listo, 1500))
    const { mensajes } = await payphone.estado()
    const deEste = mensajes.filter(m => m.to.replace(/\D/g, '') === '000000000000' && m.texto.includes(`#${pedido.order_number}`))
    expect(deEste).toEqual([])
  })
})

describe('el candado de la bolsa', () => {
  it('no sale a reparto nada a medio preparar, y el local lee QUÉ falta', async () => {
    const [primero] = productosSimples(carta)
    const addressId = await cliente.direccion()
    const otro = await exigir(201, cliente.pedir_({
      items: [{ productId: primero.id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
    }))
    await exigir(200, local.cambiarEstado(otro.id, 'aceptado'))
    await exigir(200, local.cambiarEstado(otro.id, 'preparacion'))

    const saltarse = await local.cambiarEstado(otro.id, 'en_camino')
    expect(saltarse.status).toBe(409)
    expect(saltarse.body.error).toMatch(/falta meter en la bolsa/i)
    expect(saltarse.body.error).toContain(primero.name)

    // Y uno a domicilio tampoco se marca «listo para retirar».
    const retiro = await local.cambiarEstado(otro.id, 'listo_para_retiro')
    expect(retiro.status).toBe(409)

    await exigir(200, local.cambiarEstado(otro.id, 'cancelado'))
  })
})
