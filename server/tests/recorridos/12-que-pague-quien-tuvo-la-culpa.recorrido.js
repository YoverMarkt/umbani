import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, centavos, cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, exigir,
  llevarHastaEntregar, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// QUE PAGUE QUIEN TUVO LA CULPA, DE PUNTA A PUNTA (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
//
// Primero el cliente: su saldo ya lo prueba `09-reclamos`. Aquí, lo que viene
// después, como en las grandes: el superadmin ve ANTES de confirmar a quién se
// le descuenta o reconoce cuánto, confirma, y el dueño lo ve en «Mis pagos»
// con su porqué. Lo que se perdió antes de entregar se le reconoce al local;
// si el cliente no estaba, además queda bloqueado y ya no puede pedir.
//
// Cuánto paga cada uno, en cada caso, lo prueba la base (bloque «QUE PAGUE
// QUIEN TUVO LA CULPA» de verify:schema). Aquí, que llegue a cada pantalla.

let cliente
let local
let carta
let addressId
let negocio
let comoEstaba
let clienteBloqueado

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
  // El cliente de prueba es el MISMO en todos los recorridos: se le quita el
  // bloqueo que le puso este, o el siguiente no podría pedir.
  if (clienteBloqueado) {
    await sql(`update customers set blocked_at = null, blocked_until = null, blocked_kind = null, blocked_reason = null
                where id = $1`, [clienteBloqueado])
  }
  await cerrarSql()
})

/** Algo de $5 o más: con el margen, Umbani tiene comisión en lo que se devuelve. */
function caro() {
  const producto = productosSimples(carta).find(p => Number(p.priceFrom) >= 5)
  if (!producto) throw new Error('La carta del staging no tiene un producto simple de $5 o más: revisa la siembra')
  return producto
}
const pedirEnEfectivo = () => cliente.pedir_({
  items: [{ productId: caro().id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
})
const numeroDe = async id => (await sql('select order_number from orders where id = $1', [id]))[0].order_number
const misPagos = () => exigir(200, local.pedir('GET', '/api/client/mis-pagos'))
const efecto = (id, responsable, compensacionCents) => exigir(200,
  admin.pedir('GET', `/api/admin/incidencias/${id}/efecto?responsable=${responsable}&compensacionCents=${compensacionCents}`))
const incidencia = async id => (await exigir(200, admin.pedir('GET', '/api/admin/incidencias?estado=todas'))).incidencias.find(i => i.id === id)

/** El superadmin registra lo que el cliente no ve, sobre un pedido que no se entregó. */
async function perdidaAntesDeEntregar(tipo, nota) {
  const pedido = await exigir(201, pedirEnEfectivo())
  await exigir(200, local.cambiarEstado(pedido.id, 'cancelado'))
  const creada = await exigir(201, admin.pedir('POST', '/api/admin/incidencias', {
    localId: negocio, numero: await numeroDe(pedido.id), tipo, nota,
  }))
  return { pedido, suya: await incidencia(creada.id) }
}

describe('que pague quien tuvo la culpa', () => {
  it('faltó algo y respondía el local: ve antes cuánto se le descuenta, y lo ve en «Mis pagos»', async () => {
    const pedido = await exigir(201, pedirEnEfectivo())
    await llevarHastaEntregar(local, pedido.id)
    const linea = (await cliente.pedido(pedido.id)).order_items[0]
    const r = await exigir(201, cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/reclamo`, {
      tipo: 'falta_producto', lineas: [{ item: linea.id, cantidad: 1 }], nota: 'No vino',
    }))
    const { incidencias } = await exigir(200, admin.pedir('GET', '/api/admin/incidencias'))
    const suya = incidencias.find(i => i.pedido.id === pedido.id)
    expect(suya.reparto.umbaniCents).toBeGreaterThan(0)

    // Antes de confirmar: el local paga lo devuelto MENOS la comisión de Umbani.
    const vista = await efecto(suya.id, 'local', r.sugeridoCents)
    expect(vista).toEqual({
      ajustes: [{ parte: 'local', cents: -(r.sugeridoCents - suya.reparto.umbaniCents), concepto: 'reclamo' }],
      bloquea: false,
    })

    const antes = await misPagos()
    const resuelta = await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'local', compensacionCents: r.sugeridoCents, nota: 'El local no lo mandó',
    }))
    // Lo que vio es lo que se aplicó.
    expect(resuelta.ajustes).toEqual(vista.ajustes)
    expect((await incidencia(suya.id)).ajustes).toEqual(vista.ajustes)

    const despues = await misPagos()
    const [{ cents }] = vista.ajustes
    expect(despues.semana.ajustesCents - antes.semana.ajustesCents).toBe(cents)
    expect(despues.semana.netoCents - antes.semana.netoCents).toBe(cents)
    expect(despues.ajustes).toContainEqual(expect.objectContaining({
      numero: await numeroDe(pedido.id), tipo: 'falta_producto', concepto: 'reclamo', cents,
    }))
    // Una vez: resolverla de nuevo no cobra dos veces.
    expect((await admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'local', compensacionCents: r.sugeridoCents, nota: 'Otra vez',
    })).status).toBe(409)
    expect((await misPagos()).semana.ajustesCents).toBe(despues.semana.ajustesCents)
  })

  it('un accidente antes de entregar: al local se le reconoce su comida y lo pone Umbani', async () => {
    const { pedido, suya } = await perdidaAntesDeEntregar('accidente', 'Choque camino al cliente')
    const [{ merchant_subtotal: comida }] = await sql('select merchant_subtotal from orders where id = $1', [pedido.id])
    // Lo que se propone: lo que el local recibe por los productos.
    expect(suya.comidaSugeridaCents).toBe(centavos(comida))
    expect(suya.comidaSugeridaCents).toBeGreaterThan(0)

    const vista = await efecto(suya.id, 'umbani', suya.comidaSugeridaCents)
    expect(vista).toEqual({ ajustes: [{ parte: 'local', cents: suya.comidaSugeridaCents, concepto: 'comida_reconocida' }], bloquea: false })
    const antes = await misPagos()
    const resuelta = await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'umbani', compensacionCents: suya.comidaSugeridaCents, nota: 'Accidente: lo pone Umbani',
    }))
    expect(resuelta).toEqual({ ok: true, saldoCents: 0, ajustes: vista.ajustes })
    expect((await misPagos()).semana.ajustesCents - antes.semana.ajustesCents).toBe(suya.comidaSugeridaCents)
  })

  it('el cliente no estaba: Umbani le paga la comida al local y el cliente ya no puede pedir', async () => {
    const { pedido, suya } = await perdidaAntesDeEntregar('cliente_ausente', 'No abrió la puerta ni contestó')
    const vista = await efecto(suya.id, 'cliente', suya.comidaSugeridaCents)
    expect(vista).toEqual({ ajustes: [{ parte: 'local', cents: suya.comidaSugeridaCents, concepto: 'comida_reconocida' }], bloquea: true })
    await exigir(200, admin.pedir('POST', `/api/admin/incidencias/${suya.id}/resolver`, {
      estado: 'resuelta', responsable: 'cliente', compensacionCents: suya.comidaSugeridaCents, nota: 'No estaba',
    }))

    ;[{ customer_id: clienteBloqueado }] = await sql('select customer_id from orders where id = $1', [pedido.id])
    const [bloqueo] = await sql('select blocked_at, blocked_until, blocked_kind, blocked_reason from customers where id = $1', [clienteBloqueado])
    expect(bloqueo).toMatchObject({ blocked_until: null, blocked_kind: 'manual', blocked_reason: `No estaba para recibir su pedido #${await numeroDe(pedido.id)}` })
    expect(bloqueo.blocked_at).not.toBeNull()
    // El bloqueo es de verdad: la base no deja entrar su próximo pedido.
    const otro = await pedirEnEfectivo()
    expect(otro.status).toBe(403)
    expect(otro.body.error).toBe('No podemos procesar este pedido.')
  })
})
