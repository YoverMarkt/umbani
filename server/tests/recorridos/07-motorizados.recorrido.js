import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, centavos, cerrarSql, clientePorWhatsApp, comoMotorizado, configurarElDinero, entrarComoLocal,
  esperarHasta, exigir, lineaDelLibro, payphone, productosSimples, recogerLaMesa, reloj, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LOS MOTORIZADOS: EL DE UMBANI Y LA FLOTA DEL LOCAL
// ═══════════════════════════════════════════════════════════════════════════
//
// Construidos y APAGADOS hasta el primero (decisión del dueño). Este recorrido
// los enciende en la base de prueba y comprueba las reglas del dinero que el
// dueño decidió el 2026-09-27:
//
//   · el de UMBANI guarda el efectivo que cobra y liquida los lunes; su
//     carrera es suya, y si se le cae la comida se le RETIENE;
//   · tiene un tope de efectivo: por encima no toma pedidos en efectivo;
//   · el de la flota del LOCAL: la carrera es del local, y el local ve cuánto
//     efectivo trae cada uno. Se enciende LOCAL POR LOCAL (2026-10-04), y
//     apagado es apagado: ni el panel la enseña ni la base le da pedidos
//     nuevos a sus repartidores.

const SEMANA = '2026-09-07'
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
  ;[{ id: negocio, ...comoEstaba }] = await sql(`select id, delivery_by, own_fleet from businesses where slug = 'demo'`)
})
afterAll(async () => {
  // Deja el local como lo encontró: quién reparte y su flota propia.
  await admin.pedir('PUT', `/api/admin/clients/${negocio}`, comoEstaba)
  await cerrarSql()
})

async function pedirEnEfectivo() {
  const [primero] = productosSimples(carta)
  return exigir(201, cliente.pedir_({
    items: [{ productId: primero.id, quantity: 1 }], fulfillment: 'delivery', paymentMethod: 'efectivo', addressId,
  }))
}

/** El local lo acepta y lo deja empacado: lo demás lo hace quien reparte. */
async function empacado(pedidoId) {
  await exigir(200, local.cambiarEstado(pedidoId, 'aceptado'))
  await exigir(200, local.cambiarEstado(pedidoId, 'preparacion'))
  for (const linea of (await local.pedidos()).find(p => p.id === pedidoId).order_items) {
    await exigir(200, local.marcarPreparado(pedidoId, linea.id))
  }
}

describe('el motorizado de UMBANI', () => {
  const TELEFONO = '593990000777'
  let moto
  let motorizadoId
  let pedido

  it('el superadmin pone «Quién reparte: Umbani» en el local y registra al motorizado', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'umbani' }))
    const creado = await exigir(201, admin.pedir('POST', '/api/admin/motorizados', {
      nombre: 'Motorizado de Umbani', telefono: TELEFONO, vehiculo: 'Moto', topeEfectivo: '150',
    }))
    motorizadoId = creado.id
    moto = comoMotorizado(TELEFONO)
    await moto.disponible()
  })

  it('ve el pedido del local cuando el local ya lo aceptó, lo toma, lo recoge y lo entrega', async () => {
    pedido = await pedirEnEfectivo()
    // Antes de que el local lo acepte, no se le ofrece a nadie.
    expect((await moto.pedidos()).some(p => p.id === pedido.id)).toBe(false)
    await empacado(pedido.id)
    const ofrecido = (await moto.pedidos()).find(p => p.id === pedido.id)
    expect(ofrecido?.cobrarEnEfectivo).toBe(true)
    expect(ofrecido?.totalCents).toBe(centavos(pedido.total))
    await exigir(200, moto.tomar(pedido.id))
    await exigir(200, moto.recogido(pedido.id))
    await exigir(200, moto.entregado(pedido.id))
    const [{ status, courier_id: quien }] = await sql('select status, courier_id from orders where id = $1', [pedido.id])
    expect(status).toBe('completado')
    expect(quien).toBe(motorizadoId)
  })

  it('el cliente se entera por WhatsApp de que va en camino y de que llegó', async () => {
    const avisos = await esperarHasta(async () => {
      const { mensajes } = await payphone.estado()
      const deEste = mensajes.filter(m => m.to.replace(/\D/g, '') === '000000000000' && m.texto.includes(`#${pedido.order_number}`))
      return deEste.length >= 3 ? deEste : null
    }, { segundos: 30, que: 'los avisos de en camino y entregado al cliente' })
    expect(avisos.length).toBeGreaterThanOrEqual(3)
  })

  it('el libro: la carrera es SUYA y el efectivo lo tiene ÉL', async () => {
    const linea = await lineaDelLibro(pedido.id)
    expect(linea.reparto_para).toBe('motorizado')
    expect(linea.en_mano).toBe('motorizado')
    expect(linea.courier_id).toBe(motorizadoId)
    expect(linea.local_cents + linea.reparto_cents + linea.umbani_cents).toBe(linea.total_cents)
  })

  it('se le cayó la comida: el superadmin RETIENE su carrera, y queda en el registro de dinero', async () => {
    const { carreras } = await exigir(200, admin.pedir('GET', `/api/admin/motorizados/${motorizadoId}/carreras`))
    expect(carreras.some(c => c.order_id === pedido.id && !c.retenido)).toBe(true)
    await exigir(200, admin.pedir('POST', '/api/admin/motorizados/retener', { pedidoId: pedido.id, motivo: 'Se le cayó la pizza' }))
    const linea = await lineaDelLibro(pedido.id)
    expect(linea.retenido).toBe(true)
    expect(linea.retenido_motivo).toBe('Se le cayó la pizza')
    // Retener dos veces no hace nada la segunda.
    const otraVez = await admin.pedir('POST', '/api/admin/motorizados/retener', { pedidoId: pedido.id, motivo: 'Otra vez' })
    expect(otraVez.status).toBe(409)
    const registro = await sql(`select actor from money_audit_log where target_table = 'order_ledger' order by id desc limit 1`)
    expect(registro[0]?.actor).toMatch(/superadmin/)
  })

  it('el lunes: se le liquida sin esa carrera, y debe el efectivo que cobró', async () => {
    await reloj.llevarALaSemana([pedido.id], SEMANA)
    // ⚠️ Las DOS liquidaciones, como la tarea de los lunes (`cerrarSemanaAnterior`):
    // cerrar solo la del motorizado dejaba el pedido suelto para la del local, y
    // se colaba en el cierre de otro recorrido.
    const [{ r }] = await sql('select close_weekly_courier_settlements($1::date) as r', [SEMANA])
    await sql('select close_weekly_settlements($1::date)', [SEMANA])
    expect(r.creadas).toBe(1)
    const [liq] = await sql('select * from courier_settlements where courier_id = $1 and period_start = $2', [motorizadoId, SEMANA])
    expect(liq.derecho_cents).toBe(0) // la carrera retenida no se le paga
    expect(liq.en_mano_cents).toBe(centavos(pedido.total)) // el efectivo lo cobró él
    expect(liq.neto_cents).toBe(-centavos(pedido.total))
    expect(liq.status).toBe('por_cobrar')
  })

  it('…y el local cobra igual su comida: Umbani se la deposita (el efectivo lo tiene el motorizado)', async () => {
    const linea = await lineaDelLibro(pedido.id)
    const [liq] = await sql(`select s.* from settlements s where s.business_id = $1 and s.period_start = $2`, [negocio, SEMANA])
    expect(liq.orders_count).toBe(1)
    expect(liq.derecho_cents).toBe(linea.local_cents) // sus productos; el envío es del motorizado
    expect(liq.en_mano_cents).toBe(0) // el efectivo no lo tiene el local
    expect(liq.neto_cents).toBe(linea.local_cents)
    expect(liq.status).toBe('por_pagar')
  })

  it('con el tope de efectivo superado no toma pedidos en efectivo', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/motorizados/${motorizadoId}/activo`, { activo: true }))
    await sql('update couriers set cash_limit_cents = 100 where id = $1', [motorizadoId])
    const otro = await pedirEnEfectivo()
    await empacado(otro.id)
    const tomar = await moto.tomar(otro.id)
    expect(tomar.status).toBe(409)
    expect(tomar.body.reason).toBe('tope_de_efectivo')
    await exigir(200, local.cambiarEstado(otro.id, 'cancelado'))
  })
})

describe('la flota propia del LOCAL', () => {
  const TELEFONO = '593990000888'
  let repartidorId

  it('apagada de verdad: el local no la ve y la API responde 404', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'local', own_fleet: false }))
    const ficha = await exigir(200, local.pedir('GET', '/api/client/business'))
    expect(ficha.flota_propia).toBe(false)
    expect((await local.pedir('GET', '/api/client/repartidores')).status).toBe(404)
  })

  it('el superadmin la enciende en ESTE local, y el local registra a SU repartidor', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { own_fleet: true }))
    expect((await exigir(200, local.pedir('GET', '/api/client/business'))).flota_propia).toBe(true)
    const creado = await exigir(201, local.pedir('POST', '/api/client/repartidores', { nombre: 'Repartidor del Local', telefono: TELEFONO }))
    repartidorId = creado.id
    const [{ fleet_business_id: flota }] = await sql('select fleet_business_id from couriers where id = $1', [repartidorId])
    expect(flota).toBe(negocio)
  })

  it('el de Umbani ya no ve los pedidos de un local que reparte él mismo', async () => {
    const pedido = await pedirEnEfectivo()
    await empacado(pedido.id)
    const deUmbani = comoMotorizado('593990000777')
    expect((await deUmbani.pedidos()).some(p => p.id === pedido.id)).toBe(false)
    expect((await deUmbani.tomar(pedido.id)).status).toBe(409)
    await exigir(200, local.cambiarEstado(pedido.id, 'cancelado'))
  })

  it('su repartidor lleva el pedido, la carrera es del LOCAL, y el local ve el efectivo que trae', async () => {
    const pedido = await pedirEnEfectivo()
    await empacado(pedido.id)
    const suyo = comoMotorizado(TELEFONO)
    await suyo.disponible()
    await exigir(200, suyo.tomar(pedido.id))
    // A medio camino, el local ya ve lo que lleva por cobrar.
    const enCamino = (await exigir(200, local.pedir('GET', '/api/client/repartidores'))).repartidores.find(r => r.id === repartidorId)
    expect(enCamino.efectivoEnCursoCents).toBe(centavos(pedido.total))
    await exigir(200, suyo.recogido(pedido.id))
    await exigir(200, suyo.entregado(pedido.id))

    const linea = await lineaDelLibro(pedido.id)
    expect(linea.reparto_para).toBe('local')
    expect(linea.en_mano).toBe('local')
    const alFinal = (await exigir(200, local.pedir('GET', '/api/client/repartidores'))).repartidores.find(r => r.id === repartidorId)
    expect(alFinal.efectivoEnCursoCents).toBe(0)
    expect(alFinal.cobradoHoyCents).toBe(centavos(pedido.total))
    expect(alFinal.entregasHoy).toBe(1)
  })

  // 🔒 El hueco del interruptor global: apagado, un repartidor YA registrado
  // seguía viendo y tomando los pedidos de su local, y el local —con la
  // pestaña escondida— no podía desactivarlo.
  it('el superadmin la apaga: su repartidor ya no ve ni toma pedidos nuevos', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { own_fleet: false }))
    const pedido = await pedirEnEfectivo()
    await empacado(pedido.id)
    const suyo = comoMotorizado(TELEFONO)
    expect((await suyo.pedidos()).some(p => p.id === pedido.id)).toBe(false)
    expect((await suyo.tomar(pedido.id)).status).toBe(409)
    expect((await local.pedir('GET', '/api/client/repartidores')).status).toBe(404)
    await exigir(200, local.cambiarEstado(pedido.id, 'cancelado'))
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { own_fleet: true }))
  })

  it('el local apaga a su repartidor y ya no entra a la app', async () => {
    await exigir(200, local.pedir('PUT', `/api/client/repartidores/${repartidorId}/activo`, { activo: false }))
    expect((await comoMotorizado(TELEFONO).pedir('GET', '/yo')).status).toBe(403)
  })
})
