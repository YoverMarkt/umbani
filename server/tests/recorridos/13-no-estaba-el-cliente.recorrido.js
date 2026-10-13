import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, centavos, cerrarSql, clientePorLaApp, comoMotorizado, configurarElDinero, entrarComoLocal, exigir,
  http, lineaDelLibro, payphone, pedirYPagarConTarjeta, productosSimples, recogerLaMesa, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// «NO ESTABA EL CLIENTE», DE PUNTA A PUNTA (2026-10-12)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como Uber Eats y DoorDash: quien reparte toca «Llegué» en la puerta, ve el
// teléfono del cliente para llamarlo, y a los 10 minutos puede marcar «No
// estaba el cliente». El pedido se cierra como entregado y se cobra SIN
// devolución; en efectivo nadie cobró y la comida y la carrera las pone
// Umbani; la incidencia nace sola y el cliente pasa a pagar por adelantado.
//
// Cuánto paga cada uno en cada forma de pago lo prueba la base (bloque «NO
// ESTABA EL CLIENTE» de verify:schema). Aquí, que llegue a cada pantalla: la
// app del repartidor, el panel del local que reparte él mismo, la app del
// cliente y el superadmin.
//
// ⚠️ Los 10 minutos no se esperan: se adelanta la hora del «Llegué» en la
// base, que es lo único que mira la regla.

let local
let carta
let negocio
let comoEstaba

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  local = await entrarComoLocal()
  ;[{ id: negocio, ...comoEstaba }] = await sql(`select id, delivery_by, own_fleet, cooperative_id from businesses where slug = 'demo'`)
})
afterAll(async () => {
  await admin.pedir('PUT', `/api/admin/clients/${negocio}`, comoEstaba)
  // Nadie se queda en «solo por adelantado» para los recorridos que vienen.
  await sql(`update order_incidents set prepaid_only_until = now()
              where kind = 'cliente_ausente' and prepaid_only_until > now()`)
  await cerrarSql()
})

/** Un cliente NUEVO de la app (su historial no toca el de los demás recorridos). */
async function clienteNuevo() {
  const cliente = await clientePorLaApp()
  carta = carta || await cliente.catalogo()
  return { cliente, addressId: await cliente.direccion() }
}
const unPlato = () => [{ productId: productosSimples(carta)[0].id, quantity: 1 }]
const yaEspero = id => sql(`update orders set arrived_at = now() - interval '11 minutes' where id = $1`, [id])

/** Aceptado, en la cocina y empacado: lo demás lo hace quien reparte. */
async function empacado(pedidoId) {
  await exigir(200, local.cambiarEstado(pedidoId, 'aceptado'))
  await exigir(200, local.cambiarEstado(pedidoId, 'preparacion'))
  for (const linea of (await local.pedidos()).find(p => p.id === pedidoId).order_items) {
    await exigir(200, local.marcarPreparado(pedidoId, linea.id))
  }
}

describe('el repartidor de Umbani, en EFECTIVO', () => {
  const TELEFONO = '593990000813'
  let moto
  let motorizadoId
  let cliente
  let pedido

  beforeAll(async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'umbani' }))
    const [{ id: chone }] = await sql(`select id from cities where lower(name) = 'chone'`)
    const creado = await exigir(201, admin.pedir('POST', '/api/admin/motorizados', {
      nombre: 'Moto que espera', telefono: TELEFONO, correo: 'moto.espera@umbani.test', vehiculo: 'Moto', topeEfectivo: '150', ciudadId: chone,
    }))
    motorizadoId = creado.id
    moto = comoMotorizado(TELEFONO)
    await moto.disponible()
    let addressId
    ;({ cliente, addressId } = await clienteNuevo())
    pedido = await exigir(201, cliente.pedir_({ items: unPlato(), fulfillment: 'delivery', paymentMethod: 'efectivo', addressId }))
    await empacado(pedido.id)
    await exigir(200, moto.tomar(pedido.id))
    await exigir(200, moto.recogido(pedido.id))
  })

  it('el teléfono del cliente aparece SOLO desde «Llegué», y la base guarda a cuántos metros estaba', async () => {
    const enCamino = (await moto.pedidos()).find(p => p.id === pedido.id)
    expect(enCamino.entregar.telefono).toBeNull()
    expect(enCamino.llegoEn).toBeNull()
    // «No estaba» antes de llegar: primero «Llegué».
    const sinLlegar = await moto.pedir('POST', `/pedidos/${pedido.id}/no-estaba`)
    expect(sinLlegar.status).toBe(409)
    expect(sinLlegar.body.reason).toBe('sin_llegada')

    const [{ delivery_latitude: lat, delivery_longitude: lng }] = await sql(
      'select delivery_latitude, delivery_longitude from orders where id = $1', [pedido.id])
    const llegue = await exigir(200, moto.pedir('POST', `/pedidos/${pedido.id}/llegue`, { lat: Number(lat), lng: Number(lng) + 0.0005 }))
    expect(new Date(llegue.noEstabaDesde) - new Date(llegue.llegoEn)).toBe(10 * 60_000)
    const [{ arrived_distance_m: metros }] = await sql('select arrived_distance_m from orders where id = $1', [pedido.id])
    expect(metros).toBeGreaterThan(40)
    expect(metros).toBeLessThan(70)

    const enLaPuerta = (await moto.pedidos()).find(p => p.id === pedido.id)
    const [{ contact_phone: suyo }] = await sql('select contact_phone from orders where id = $1', [pedido.id])
    expect(enLaPuerta.entregar.telefono).toBe(`+${suyo.replace(/\D/g, '')}`)
    // El cliente lo ve en su app: «tu repartidor llegó».
    const visto = await exigir(200, http('GET', `/api/v1/pedidos/${pedido.id}`, { token: cliente.tokenApp }))
    expect(visto.status).toBe('en_camino')
    expect(visto.arrived_at).toBe(llegue.llegoEn)
    expect(visto).not.toHaveProperty('arrived_distance_m')
  })

  it('antes de los 10 minutos, la base dice cuánto falta', async () => {
    const pronto = await moto.pedir('POST', `/pedidos/${pedido.id}/no-estaba`)
    expect(pronto.status).toBe(409)
    expect(pronto.body.error).toMatch(/^Espera al cliente (10|9) minutos más antes de marcarlo$/)
  })

  it('a los 10 minutos lo cierra: nadie cobró, su carrera la cobra igual y el efectivo no le cuenta', async () => {
    const yo = () => exigir(200, moto.pedir('GET', '/yo'))
    const antes = await yo()
    await yaEspero(pedido.id)
    await exigir(200, moto.pedir('POST', `/pedidos/${pedido.id}/no-estaba`))
    // Un segundo toque no repite nada.
    await exigir(200, moto.pedir('POST', `/pedidos/${pedido.id}/no-estaba`))

    const [o] = await sql('select status, customer_absent_at from orders where id = $1', [pedido.id])
    expect(o.status).toBe('completado')
    expect(o.customer_absent_at).not.toBeNull()
    const linea = await lineaDelLibro(pedido.id)
    expect(linea.en_mano).toBe('motorizado')
    expect(linea.reparto_para).toBe('motorizado')
    expect(linea.courier_id).toBe(motorizadoId)
    // Su semana: la carrera, y la línea que deshace el cobro que no hizo.
    const despues = await yo()
    const total = centavos(pedido.total)
    expect(despues.ajustes).toContainEqual(expect.objectContaining({ tipo: 'cliente_ausente', concepto: 'no_cobro', cents: total }))
    expect(despues.semana.carrerasCents - antes.semana.carrerasCents).toBe(linea.reparto_cents)
    // Lo que iba a cobrar en la puerta ya no le cuenta para su tope.
    expect(despues.semana.efectivoEncimaCents).toBe(antes.semana.efectivoEncimaCents - total)
    // Sale de su lista, y con él el teléfono del cliente.
    expect((await moto.pedidos()).some(p => p.id === pedido.id)).toBe(false)
    // Queda quién fue en el registro de dinero.
    const [registro] = await sql(`select actor from money_audit_log where action = 'pedido_no_estaba' and target_id = $1`, [pedido.id])
    expect(registro.actor).toBe('repartidor:moto.espera@umbani.test')
  })

  it('el cliente ve «no se pudo entregar», no «entregado», y solo puede decir que SÍ estaba', async () => {
    const visto = await exigir(200, http('GET', `/api/v1/pedidos/${pedido.id}`, { token: cliente.tokenApp }))
    expect(visto.customer_absent_at).not.toBeNull()
    expect(visto.confirmacion.reclamableHasta).not.toBeNull()
    expect((await http('POST', `/api/v1/pedidos/${pedido.id}/todo-bien`, { token: cliente.tokenApp })).status).toBe(409)
    const otraCosa = await http('POST', `/api/v1/pedidos/${pedido.id}/reclamo`, {
      token: cliente.tokenApp, cuerpo: { tipo: 'falta_producto', lineas: [{ item: visto.order_items[0].id, cantidad: 1 }] },
    })
    expect(otraCosa.status).toBe(409)
    expect(otraCosa.body.error).toMatch(/no te encontramos/)
    // Desde ahora la app ya no le ofrece el efectivo.
    expect((await exigir(200, http('GET', '/api/v1/yo', { token: cliente.tokenApp }))).soloPagoPorAdelantado).toBe(true)

    // «Sí estaba»: va a revisión, con la hora y la distancia del «Llegué».
    const siEstaba = await exigir(201, http('POST', `/api/v1/pedidos/${pedido.id}/reclamo`, {
      token: cliente.tokenApp, cuerpo: { tipo: 'no_llego', nota: 'Estuve en la puerta todo el rato' },
    }))
    expect(siEstaba.estado).toBe('abierta')
    const { incidencias } = await exigir(200, admin.pedir('GET', '/api/admin/incidencias?estado=todas'))
    const delPedido = incidencias.filter(i => i.pedido.id === pedido.id)
    const sola = delPedido.find(i => i.origen === 'reparto')
    expect(sola).toMatchObject({ tipo: 'cliente_ausente', estado: 'resuelta', responsable: 'cliente' })
    expect(sola.ajustes).toEqual([{ parte: 'motorizado', cents: centavos(pedido.total), concepto: 'no_cobro' }])
    const reclamo = delPedido.find(i => i.origen === 'cliente')
    expect(reclamo.motivos).toEqual(expect.arrayContaining(['no_llego', 'dice_que_si_estaba']))
    expect(reclamo.pedido.llegoEn).not.toBeNull()
    expect(reclamo.pedido.noEstabaEn).not.toBeNull()
    expect(reclamo.pedido.metrosDeLaDireccion).toBeGreaterThan(40)
  })
})

describe('el local que reparte él mismo, con TARJETA', () => {
  it('lo marca desde su panel: se cobra sin devolución, y a nadie se le ajusta nada', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'local', own_fleet: false }))
    const { cliente, addressId } = await clienteNuevo()
    const { pedido, idPayPhone } = await pedirYPagarConTarjeta(cliente, { items: unPlato(), fulfillment: 'delivery', addressId })
    await empacado(pedido.id)
    await exigir(200, local.cambiarEstado(pedido.id, 'en_camino'))

    const sinLlegar = await local.pedir('POST', `/api/client/orders/${pedido.id}/no-estaba`)
    expect(sinLlegar.status).toBe(409)
    await exigir(200, local.pedir('POST', `/api/client/orders/${pedido.id}/llegue`))
    await yaEspero(pedido.id)
    const cerrado = await exigir(200, local.pedir('POST', `/api/client/orders/${pedido.id}/no-estaba`))
    expect(cerrado.status).toBe('completado')
    expect(cerrado.customer_absent_at).not.toBeNull()

    // ⚠️ La tarjeta NO se devuelve: el cobro sigue aprobado y PayPhone no
    // recibió ninguna devolución.
    const [cobro] = await sql('select status from payments where order_id = $1', [pedido.id])
    expect(cobro.status).toBe('aprobado')
    const { revertidas } = await payphone.estado()
    expect(revertidas.map(r => r.id)).not.toContain(idPayPhone)
    // Como una entrega: el local cobra su comida y su carrera; nada que ajustar.
    const linea = await lineaDelLibro(pedido.id)
    expect(linea.en_mano).toBe('umbani')
    expect(linea.reparto_para).toBe('local')
    const [{ n }] = await sql('select count(*)::int as n from settlement_adjustments where order_id = $1', [pedido.id])
    expect(n).toBe(0)
    // Y el pedido sale de la bandeja de «en camino».
    expect((await local.pedidos('en_camino')).some(p => p.id === pedido.id)).toBe(false)
  })
})
