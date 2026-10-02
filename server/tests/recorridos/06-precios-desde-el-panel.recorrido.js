import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  centavos, cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, exigir,
  lineaDelLibro, llevarHastaEntregar, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// TODO SALE DEL PANEL: CAMBIAR UN PRECIO NO TOCA UNA LÍNEA DE CÓDIGO
// ═══════════════════════════════════════════════════════════════════════════
//
// El envío lo fija el dueño; el margen y la tarifa, el superadmin. Tres
// promesas que este recorrido comprueba de punta a punta:
//
//   1. lo que se cambia en un panel llega YA a la carta, a la cotización y al
//      cobro, sin desplegar nada;
//   2. lo que el cliente ve es lo que paga, también justo después de cambiarlo;
//   3. un pedido ya hecho NO cambia: se cobra y se liquida con los números que
//      tenía cuando se pidió (congelado).

let cliente
let local
let producto
let addressId
let viejo

const items = () => [{ productId: producto.id, quantity: 3 }]

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorWhatsApp()
  local = await entrarComoLocal()
  ;[producto] = productosSimples(await cliente.catalogo())
  addressId = await cliente.direccion()
  viejo = await exigir(201, cliente.pedir_({ items: items(), fulfillment: 'delivery', paymentMethod: 'efectivo', addressId }))
})
afterAll(async () => {
  // Deja el dinero como lo encontraron los demás recorridos.
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  await cerrarSql()
})

describe('los precios se cambian desde el panel', () => {
  let antes
  let despues

  it('antes del cambio: envío $1,50, margen 10 %, tarifa $0,10', async () => {
    antes = await cliente.cotizar({ items: items(), fulfillment: 'delivery' })
    expect(antes.shipping).toBe(1.5)
    expect(antes.serviceFee).toBe(0.1)
    expect(antes.markupPercentage).toBe(10)
  })

  it('el dueño sube el envío y el superadmin el margen y la tarifa', async () => {
    await configurarElDinero({ envio: 2, margen: 12, tarifa: 0.25 })
    despues = await cliente.cotizar({ items: items(), fulfillment: 'delivery' })
    expect(despues.shipping).toBe(2)
    expect(despues.serviceFee).toBe(0.25)
    expect(despues.markupPercentage).toBe(12)
    expect(centavos(despues.customerSubtotal)).toBeGreaterThan(centavos(antes.customerSubtotal))
  })

  it('la CARTA ya enseña el precio nuevo, y es el que se cotiza', async () => {
    const carta = await cliente.catalogo()
    const enLaCarta = carta.products.find(p => p.id === producto.id)
    expect(centavos(enLaCarta.priceFrom) * 3).toBe(centavos(despues.customerSubtotal))
  })

  it('lo que el cliente vio es lo que se le cobra, justo después del cambio', async () => {
    const nuevo = await exigir(201, cliente.pedir_({ items: items(), fulfillment: 'delivery', paymentMethod: 'efectivo', addressId }))
    expect(centavos(nuevo.total)).toBe(centavos(despues.total))
    const [fila] = await sql('select service_fee, shipping, platform_markup from orders where id = $1', [nuevo.id])
    expect(centavos(fila.service_fee)).toBe(25)
    expect(centavos(fila.shipping)).toBe(200)
    await exigir(200, local.cambiarEstado(nuevo.id, 'cancelado'))
  })

  it('el pedido de ANTES no cambió: se entrega y se liquida con sus números', async () => {
    const [fila] = await sql('select total, service_fee, shipping, platform_markup from orders where id = $1', [viejo.id])
    expect(centavos(fila.total)).toBe(centavos(antes.total))
    expect(centavos(fila.service_fee)).toBe(10)
    expect(centavos(fila.shipping)).toBe(150)

    await llevarHastaEntregar(local, viejo.id)
    const linea = await lineaDelLibro(viejo.id)
    expect(linea.total_cents).toBe(centavos(antes.total))
    expect(linea.reparto_cents).toBe(150)
    expect(linea.umbani_cents).toBe(centavos(antes.platformMarkup))
  })

  it('con la tarifa en cero, no se cobra ni se enseña', async () => {
    await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0 })
    const sinTarifa = await cliente.cotizar({ items: items(), fulfillment: 'delivery' })
    expect(sinTarifa.serviceFee).toBe(0)
    expect(centavos(sinTarifa.total)).toBe(centavos(sinTarifa.customerSubtotal) + centavos(sinTarifa.shipping))
  })

  it('quien retira en el local no paga envío', async () => {
    const retiro = await cliente.cotizar({ items: items(), fulfillment: 'pickup' })
    expect(retiro.shipping).toBe(0)
  })
})
