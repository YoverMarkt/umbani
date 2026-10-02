import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, esperarHasta, exigir,
  lineaDelLibro, llevarHastaEntregar, payphone, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE NO TERMINA EN VENTA: RECHAZOS, CANCELACIONES Y PAGOS QUE NO LLEGAN
// ═══════════════════════════════════════════════════════════════════════════
//
// Un pedido que no se entrega no puede dejar rastro en el dinero —ni venta,
// ni comisión, ni línea en el libro— y el cliente tiene que enterarse. Y uno
// ya entregado no se puede «des-entregar» para borrar lo cobrado.

let cliente
let local
let carta
let addressId

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorWhatsApp()
  local = await entrarComoLocal()
  carta = await cliente.catalogo()
  addressId = await cliente.direccion()
})
beforeEach(recogerLaMesa)
afterAll(cerrarSql)

async function pedirEn(metodo) {
  const [primero] = productosSimples(carta)
  return exigir(201, cliente.pedir_({
    items: [{ productId: primero.id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: metodo, addressId,
  }))
}

const sinRastroEnElDinero = async (pedidoId) => {
  expect(await sql('select 1 from sales where order_id = $1', [pedidoId])).toHaveLength(0)
  expect(await lineaDelLibro(pedidoId)).toBeUndefined()
}

const avisosDe = async numero => (await payphone.estado()).mensajes
  .filter(m => m.to.replace(/\D/g, '') === '000000000000' && m.texto.includes(`#${numero}`))

describe('cancelaciones y pagos que no llegan', () => {
  it('el local RECHAZA un pedido: no queda venta y el cliente se entera', async () => {
    const pedido = await pedirEn('efectivo')
    await exigir(200, local.cambiarEstado(pedido.id, 'rechazado'))
    await sinRastroEnElDinero(pedido.id)
    const avisos = await esperarHasta(async () => {
      const suyos = await avisosDe(pedido.order_number)
      return suyos.length ? suyos : null
    }, { segundos: 20, que: 'el aviso del rechazo' })
    expect(avisos.length).toBeGreaterThanOrEqual(1)
  })

  it('la transferencia que nunca se paga CADUCA sola, sin venta', async () => {
    const pedido = await pedirEn('transferencia')
    expect(pedido.status).toBe('esperando_pago')
    const [{ ventana }] = await sql(
      'select payment_window_minutes as ventana from businesses b join orders o on o.business_id = b.id where o.id = $1',
      [pedido.id],
    )
    // El reloj: el pedido se hizo hace más que la ventana de pago del local.
    await sql(`update orders set created_at = now() - make_interval(mins => $2::int + 5) where id = $1`, [pedido.id, ventana])
    await sql('select * from expire_unpaid_orders(20)')

    const [{ status }] = await sql('select status from orders where id = $1', [pedido.id])
    expect(status).toBe('expirado')
    await sinRastroEnElDinero(pedido.id)
  })

  it('se cancela un pedido que ya iba EN CAMINO: no hay venta', async () => {
    const pedido = await pedirEn('efectivo')
    await exigir(200, local.cambiarEstado(pedido.id, 'aceptado'))
    await exigir(200, local.cambiarEstado(pedido.id, 'preparacion'))
    for (const linea of (await local.pedidos()).find(p => p.id === pedido.id).order_items) {
      await exigir(200, local.marcarPreparado(pedido.id, linea.id))
    }
    await exigir(200, local.cambiarEstado(pedido.id, 'en_camino'))
    await exigir(200, local.cambiarEstado(pedido.id, 'cancelado'))
    await sinRastroEnElDinero(pedido.id)
  })

  it('un pedido ENTREGADO no se puede cancelar: la venta y el libro se quedan', async () => {
    const pedido = await pedirEn('efectivo')
    await llevarHastaEntregar(local, pedido.id)
    const cancelar = await local.cambiarEstado(pedido.id, 'cancelado')
    expect(cancelar.status).toBe(409)
    expect(await sql('select 1 from sales where order_id = $1', [pedido.id])).toHaveLength(1)
    expect(await lineaDelLibro(pedido.id)).toBeTruthy()
  })
})
