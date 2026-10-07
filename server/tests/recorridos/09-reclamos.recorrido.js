import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, centavos, cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, exigir, http,
  llevarHastaEntregar, productosSimples, recogerLaMesa, sesionDeLaAppPara, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// «¿LLEGÓ TODO BIEN?» Y LOS RECLAMOS, DE PUNTA A PUNTA (2026-10-06, fase 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como las grandes: al recibir, el cliente dice «Todo bien» o reporta qué
// faltó, qué vino mal o que no llegó, una vez y en 48 horas. La base calcula
// lo que le corresponde —lo que pagó por eso— y el superadmin decide quién
// responde. Esta fase no mueve dinero.

let cliente
let local
let carta
let addressId
let negocio
let comoEstaba

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorWhatsApp()
  local = await entrarComoLocal()
  carta = await cliente.catalogo()
  addressId = await cliente.direccion()
  ;[{ id: negocio, ...comoEstaba }] = await sql(`select id, delivery_by, own_fleet, cooperative_id from businesses where slug = 'demo'`)
  // El local reparte él mismo: lo entrega desde su panel.
  await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'local', own_fleet: false }))
})
afterAll(async () => {
  await admin.pedir('PUT', `/api/admin/clients/${negocio}`, comoEstaba)
  await cerrarSql()
})

async function pedidoEntregado(cantidad) {
  const [primero] = productosSimples(carta)
  const pedido = await exigir(201, cliente.pedir_({
    items: [{ productId: primero.id, quantity: cantidad }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
  }))
  await llevarHastaEntregar(local, pedido.id)
  return pedido
}

describe('«¿Llegó todo bien?»', () => {
  it('sin entregar no se reclama; entregado, su pedido dice hasta cuándo puede', async () => {
    const [primero] = productosSimples(carta)
    const sinEntregar = await exigir(201, cliente.pedir_({
      items: [{ productId: primero.id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
    }))
    expect((await cliente.pedir('POST', `/api/store/:slug/orders/${sinEntregar.id}/reclamo`, { tipo: 'no_llego' })).status).toBe(409)
    await exigir(200, local.cambiarEstado(sinEntregar.id, 'cancelado'))

    const entregado = await pedidoEntregado(1)
    const visto = await cliente.pedido(entregado.id)
    expect(visto.confirmacion).toMatchObject({ todoBien: false, reclamo: null })
    expect(new Date(visto.confirmacion.reclamableHasta).getTime()).toBeGreaterThan(Date.now() + 47 * 3600_000)
  })

  it('faltó una unidad: la base le reconoce lo que pagó por ella, lo mismo que vio en su pedido', async () => {
    const pedido = await pedidoEntregado(2)
    const linea = (await cliente.pedido(pedido.id)).order_items[0]
    const r = await exigir(201, cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/reclamo`, {
      tipo: 'falta_producto', lineas: [{ item: linea.id, cantidad: 1 }], nota: 'Faltó una',
    }))
    // Su precio por unidad con el margen, en centavos (±1 por cómo se reparte el redondeo).
    expect(Math.abs(r.sugeridoCents - centavos(linea.line_total) / linea.quantity)).toBeLessThanOrEqual(1)
    // Una vez por pedido.
    expect((await cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/reclamo`, { tipo: 'no_llego' })).status).toBe(409)
    const despues = await cliente.pedido(pedido.id)
    expect(despues.confirmacion.reclamo).toMatchObject({ tipo: 'falta_producto', estado: 'abierta', sugeridoCents: r.sugeridoCents })
    expect(despues.confirmacion.reclamableHasta).toBeNull()

    // El superadmin lo ve y decide quién responde.
    const { incidencias } = await exigir(200, admin.pedir('GET', '/api/admin/incidencias'))
    const suya = incidencias.find(i => i.pedido.id === pedido.id)
    expect(suya).toMatchObject({ tipo: 'falta_producto', origen: 'cliente', estado: 'abierta', sugeridoCents: r.sugeridoCents })
    await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'local', compensacionCents: r.sugeridoCents, nota: 'El local olvidó una unidad',
    }))
    expect((await cliente.pedido(pedido.id)).confirmacion.reclamo).toMatchObject({ estado: 'resuelta', compensacionCents: r.sugeridoCents })
    // Resuelta no se reescribe.
    expect((await admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, { estado: 'descartada', nota: 'Cambio' })).status).toBe(409)
  })

  it('«Todo bien» queda anotado, y otro teléfono no reclama un pedido ajeno', async () => {
    const pedido = await pedidoEntregado(1)
    await exigir(200, cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/todo-bien`))
    expect((await cliente.pedido(pedido.id)).confirmacion.todoBien).toBe(true)
    // Por la app, con otro teléfono: el mismo 404 que si no existiera.
    const ajeno = await http('POST', `/api/v1/pedidos/${pedido.id}/reclamo`, { token: sesionDeLaAppPara('593990000999'), cuerpo: { tipo: 'no_llego' } })
    expect(ajeno.status).toBe(404)
  })

  it('«No llegó», por la app: le corresponde el pedido entero', async () => {
    const pedido = await pedidoEntregado(1)
    const r = await exigir(201, http('POST', `/api/v1/pedidos/${pedido.id}/reclamo`, {
      token: sesionDeLaAppPara('000000000000'), cuerpo: { tipo: 'no_llego' },
    }))
    expect(r.sugeridoCents).toBe(centavos(pedido.total))
    const { pedidos } = await exigir(200, http('GET', '/api/v1/pedidos', { token: sesionDeLaAppPara('000000000000') }))
    expect(pedidos.find(p => p.id === pedido.id).confirmacion.reclamo).toMatchObject({ tipo: 'no_llego', estado: 'abierta' })
  })

  it('el superadmin registra lo que el cliente no ve (se cayó la comida) y lo descarta con motivo', async () => {
    const pedido = await pedidoEntregado(1)
    const [{ order_number: numero }] = await sql('select order_number from orders where id = $1', [pedido.id])
    const creada = await exigir(201, admin.pedir('POST', '/api/admin/incidencias', {
      localId: negocio, numero, tipo: 'comida_caida', nota: 'Se le cayó la bebida al repartidor',
    }))
    await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${creada.id}/resolver`, { estado: 'descartada', nota: 'El cliente la recibió igual' }))
    const { incidencias } = await exigir(200, admin.pedir('GET', '/api/admin/incidencias?estado=todas'))
    expect(incidencias.find(i => i.id === creada.id)).toMatchObject({ origen: 'superadmin', estado: 'descartada' })
  })
})
