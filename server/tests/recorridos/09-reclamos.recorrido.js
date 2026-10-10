import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, centavos, cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, exigir, http,
  llevarHastaEntregar, productosSimples, recogerLaMesa, sesionDeLaAppPara, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LOS RECLAMOS Y EL SALDO UMBANI, DE PUNTA A PUNTA (2026-10-06 / 2026-10-10)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como las grandes: el cliente reporta qué faltó, qué vino mal o que no
// llegó, una vez y en 48 horas. La base calcula lo que le corresponde —lo que
// pagó por eso— y se le devuelve como SALDO UMBANI (fase 2): lo pequeño al
// instante si su historial está limpio; lo demás, cuando el superadmin decide
// quién responde. ⚠️ El ORDEN de las pruebas importa (vitest las corre en el
// orden del archivo): el primer reclamo del cliente es el que sale al instante.

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

/** Algo barato (sale al instante) y algo caro (pasa del tope de $5: a revisión). `priceFrom` ya lleva el margen. */
function deLaCarta(cumple, que) {
  const producto = productosSimples(carta).find(p => cumple(Number(p.priceFrom)))
  if (!producto) throw new Error(`La carta del staging no tiene ${que}: revisa la siembra`)
  return producto
}
const barato = () => deLaCarta(precio => precio <= 3, 'un producto simple de $3 o menos')
const caro = () => deLaCarta(precio => precio >= 5, 'un producto simple de $5 o más')

async function pedidoEntregado(cantidad, producto = caro()) {
  const pedido = await exigir(201, cliente.pedir_({
    items: [{ productId: producto.id, quantity: cantidad }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
  }))
  await llevarHastaEntregar(local, pedido.id)
  return pedido
}

/** Su saldo, como lo ve la app: `GET /api/v1/yo`. */
const saldoDeLaApp = async () =>
  (await exigir(200, http('GET', '/api/v1/yo', { token: sesionDeLaAppPara('000000000000') }))).saldo

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

  it('AL INSTANTE: el primer reclamo, pequeño y con el historial limpio, ya es saldo en su app', async () => {
    const antes = await saldoDeLaApp()
    const pedido = await pedidoEntregado(1, barato())
    const linea = (await cliente.pedido(pedido.id)).order_items[0]
    const r = await exigir(201, cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/reclamo`, {
      tipo: 'falta_producto', lineas: [{ item: linea.id, cantidad: 1 }],
    }))
    expect(r).toMatchObject({ estado: 'compensada', saldoCents: r.sugeridoCents })
    expect(r.saldoCents).toBeGreaterThan(0)
    expect(r.mensaje).toMatch(/^Listo: te devolvimos \$\d+,\d{2} en saldo Umbani/)
    const ahora = await saldoDeLaApp()
    expect(ahora.cents - antes.cents).toBe(r.saldoCents)
    expect(new Date(ahora.proximo.venceEl).getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 3600_000)

    // Al superadmin le queda confirmar quién responde; el monto ya no cambia.
    const { incidencias } = await exigir(200, admin.pedir('GET', '/api/admin/incidencias'))
    const suya = incidencias.find(i => i.pedido.id === pedido.id)
    expect(suya).toMatchObject({ estado: 'compensada', alInstante: true, compensacionCents: r.saldoCents, motivos: [] })
    expect((await admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'local', compensacionCents: r.saldoCents + 100, nota: 'Otro monto',
    })).status).toBe(409)
    const confirmada = await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'local', compensacionCents: r.saldoCents, nota: 'El local olvidó la bebida',
    }))
    expect(confirmada.saldoCents).toBe(0)
    expect((await saldoDeLaApp()).cents).toBe(ahora.cents)
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
    // No salió al instante, y el superadmin ve por qué (el cliente, no).
    expect(suya.motivos).toEqual(expect.arrayContaining(['reportes_seguidos', 'al_instante_reciente', 'tope']))
    expect(r.mensaje).toBe('Lo estamos revisando. Te avisamos apenas tengamos una respuesta.')
    const antes = await saldoDeLaApp()
    const resuelta = await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'local', compensacionCents: r.sugeridoCents, nota: 'El local olvidó una unidad',
    }))
    // Al resolverlo a su favor, el saldo.
    expect(resuelta.saldoCents).toBe(r.sugeridoCents)
    expect((await saldoDeLaApp()).cents - antes.cents).toBe(r.sugeridoCents)
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

  it('«No llegó» en EFECTIVO, por la app: no pagó, así que no hay saldo; lo revisa una persona', async () => {
    const pedido = await pedidoEntregado(1)
    const r = await exigir(201, http('POST', `/api/v1/pedidos/${pedido.id}/reclamo`, {
      token: sesionDeLaAppPara('000000000000'), cuerpo: { tipo: 'no_llego' },
    }))
    expect(r).toMatchObject({ estado: 'abierta', sugeridoCents: 0, saldoCents: 0 })
    expect(r.mensaje).toBe('Como ibas a pagar al recibir, no se te cobró nada. Revisamos qué pasó con el repartidor.')
    expect(centavos(pedido.total)).toBeGreaterThan(0)
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
