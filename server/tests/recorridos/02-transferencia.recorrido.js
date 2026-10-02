import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  centavos, cerrarSql, clientePorLaApp, configurarElDinero, entrarComoLocal, exigir,
  lineaDelLibro, llevarHastaEntregar, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// UN PEDIDO PAGADO POR TRANSFERENCIA, DESDE LA APP
// ═══════════════════════════════════════════════════════════════════════════
//
// Entra por la puerta de la app (la que construirá Flutter): sesión con el
// código por WhatsApp, sesión de tienda atada al dispositivo. El cliente
// transfiere a la cuenta DEL LOCAL —el dinero no pasa por Umbani— y el local
// confirma el pago antes de cocinar.

let cliente
let local
let cotizacion
let pedido

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorLaApp()
  local = await entrarComoLocal()
})
afterAll(cerrarSql)

describe('un pedido por TRANSFERENCIA, de punta a punta', () => {
  it('la app pide la cuenta del local para transferir', async () => {
    const cuenta = await exigir(200, cliente.pedir('GET', '/api/store/:slug/payment-info'))
    const texto = JSON.stringify(cuenta)
    expect(texto).toContain('Banco de Pruebas')
    expect(texto).toContain('2200000000')
  })

  it('el pedido nace «esperando_pago»: el local no cocina sin pago', async () => {
    const carta = await cliente.catalogo()
    const [primero] = productosSimples(carta)
    const items = [{ productId: primero.id, quantity: 3 }]
    cotizacion = await cliente.cotizar({ items, fulfillment: 'delivery' })
    const addressId = await cliente.direccion()
    pedido = await exigir(201, cliente.pedir_({ items, fulfillment: 'delivery', paymentMethod: 'transferencia', addressId }))
    expect(pedido.status).toBe('esperando_pago')
    expect(centavos(pedido.total)).toBe(centavos(cotizacion.total))
  })

  it('el local confirma el pago, y confirmarlo dos veces no hace nada la segunda', async () => {
    await exigir(200, local.confirmarPago(pedido.id))
    const [{ payment_confirmed_at: primera }] = await sql('select payment_confirmed_at from orders where id = $1', [pedido.id])
    expect(primera).toBeTruthy()

    const otraVez = await local.confirmarPago(pedido.id)
    expect(otraVez.status).toBe(409)
    const [{ payment_confirmed_at: sigue }] = await sql('select payment_confirmed_at from orders where id = $1', [pedido.id])
    expect(sigue.getTime()).toBe(primera.getTime())
  })

  it('el local lo prepara y lo entrega', async () => {
    await llevarHastaEntregar(local, pedido.id)
    const visto = await cliente.pedido(pedido.id)
    expect((visto.order || visto).status).toBe('completado')
  })

  it('el libro: el dinero lo tiene el LOCAL (le transfirieron a él)', async () => {
    const linea = await lineaDelLibro(pedido.id)
    expect(linea.payment_method).toBe('transferencia')
    expect(linea.en_mano).toBe('local')
    expect(linea.total_cents).toBe(centavos(cotizacion.total))
    expect(linea.local_cents + linea.reparto_cents + linea.umbani_cents).toBe(linea.total_cents)
    expect(linea.umbani_cents).toBe(centavos(cotizacion.platformMarkup))
    expect(linea.provider_fee_cents).toBe(0)
  })

  it('la app ve el pedido en «Mis pedidos» del local', async () => {
    const mios = await exigir(200, cliente.pedir('GET', '/api/store/:slug/orders'))
    const lista = Array.isArray(mios) ? mios : mios.orders || []
    expect(lista.some(p => p.id === pedido.id)).toBe(true)
  })
})
