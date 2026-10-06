import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  admin, cerrarSql, clientePorWhatsApp, comoMotorizado, configurarElDinero, entrarComoLocal,
  esperarHasta, exigir, http, lineaDelLibro, productosSimples, recogerLaMesa, reloj, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// UNA COOPERATIVA DE REPARTO, DE PUNTA A PUNTA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// La tercera flota, con el servidor y la base de verdad:
//   · el superadmin la da de alta en Chone, con su acceso a `/cooperativa`;
//   · ella registra a SU motorizado —como se escribe un celular en Ecuador— y
//     él entra a su app con el número tal como lo manda WhatsApp («+593…»);
//   · «Quién reparte: la cooperativa»: su motorizado lleva el pedido, y el de
//     Umbani ni lo ve (la trampa del «sin local»);
//   · el dinero, como uno de Umbani: la carrera y el efectivo son suyos, y el
//     lunes liquida con Umbani; la cooperativa lo ve y lo descarga;
//   · otra cooperativa no ve nada de esta, y apagada se cierra su panel y su
//     motorizado no toma nada nuevo.

const SEMANA = '2026-08-31'
const sufijo = randomUUID().slice(0, 6)
const CORREO = `cooperativa-${sufijo}@recorridos.ec`
const CLAVE = 'una-clave-de-prueba-12'
let cliente
let local
let carta
let addressId
let negocio
let comoEstaba
let chone

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorWhatsApp()
  local = await entrarComoLocal()
  carta = await cliente.catalogo()
  addressId = await cliente.direccion()
  ;[{ id: negocio, ...comoEstaba }] = await sql(`select id, delivery_by, own_fleet, cooperative_id from businesses where slug = 'demo'`)
  ;[{ id: chone }] = await sql(`select id from cities where lower(name) = 'chone'`)
})
afterAll(async () => {
  // Deja el local como lo encontró: quién reparte, su flota y su cooperativa.
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

/** El panel de una cooperativa, con su sesión. */
async function entrarAlPanel(correo, clave) {
  const { token } = await exigir(200, http('POST', '/api/cooperativa/login', { cuerpo: { email: correo, password: clave } }))
  return { token, pedir: (metodo, ruta, cuerpo) => http(metodo, ruta, { token, cuerpo }) }
}

describe('una cooperativa de reparto, de punta a punta', () => {
  let coop
  let panel
  let motoId
  let pedido
  let linea

  it('el superadmin la da de alta en Chone, con su acceso a su panel', async () => {
    const creada = await exigir(201, admin.pedir('POST', '/api/admin/cooperativas', {
      nombre: `Cooperativa ${sufijo}`, ciudadId: chone, usuario: { email: CORREO, clave: CLAVE, nombre: 'Rosa' },
    }))
    coop = creada.id
    const { cooperativas } = await exigir(200, admin.pedir('GET', '/api/admin/cooperativas'))
    expect(cooperativas.find(c => c.id === coop)).toMatchObject({ ciudad: 'Chone', activa: true, repartidores: 0 })
    expect(JSON.stringify(cooperativas)).not.toContain(CLAVE)
  })

  it('entra a su panel y registra a SU motorizado como se escribe un celular en Ecuador', async () => {
    panel = await entrarAlPanel(CORREO.toUpperCase(), CLAVE)
    const creado = await exigir(201, panel.pedir('POST', '/api/cooperativa/repartidores', {
      nombre: 'Motorizado de Cooperativa', telefono: '099 000 0555', vehiculo: 'Moto', cedula: '1312345678', placa: 'mb123a',
    }))
    motoId = creado.id
    const [fila] = await sql('select phone, plate, city_id, cooperative_id, fleet_business_id from couriers where id = $1', [motoId])
    // En dígitos y con el código del país, como lo verá WhatsApp; su ciudad, la de su cooperativa.
    expect(fila).toEqual({ phone: '593990000555', plate: 'MB123A', city_id: chone, cooperative_id: coop, fleet_business_id: null })
  })

  it('«Quién reparte: la cooperativa»: su motorizado lleva el pedido; el de Umbani ni lo ve', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/clients/${negocio}`, { delivery_by: 'cooperativa', cooperative_id: coop }))
    const deUmbani = await exigir(201, admin.pedir('POST', '/api/admin/motorizados', {
      nombre: 'Motorizado de Umbani', telefono: '593990000556', vehiculo: 'Moto', ciudadId: chone,
    }))

    // Entra con el número tal como lo manda WhatsApp por YCloud: con «+».
    const moto = comoMotorizado('+593990000555')
    expect(await exigir(200, moto.pedir('GET', '/yo'))).toMatchObject({ flota: 'cooperativa', cooperativa: `Cooperativa ${sufijo}` })
    await moto.disponible()

    pedido = await pedirEnEfectivo()
    await empacado(pedido.id)
    const umbani = comoMotorizado('593990000556')
    expect((await umbani.pedidos()).some(p => p.id === pedido.id)).toBe(false)
    expect((await umbani.tomar(pedido.id)).status).toBe(409)

    expect((await moto.pedidos()).some(p => p.id === pedido.id)).toBe(true)
    await exigir(200, moto.tomar(pedido.id))
    await exigir(200, moto.recogido(pedido.id))
    await exigir(200, moto.entregado(pedido.id))
    const [{ status, courier_id: quien }] = await sql('select status, courier_id from orders where id = $1', [pedido.id])
    expect(status).toBe('completado')
    expect(quien).toBe(motoId)
    await exigir(200, admin.pedir('PUT', `/api/admin/motorizados/${deUmbani.id}/activo`, { activo: false }))
  })

  it('el dinero, como uno de Umbani: la carrera es SUYA y el efectivo lo tiene ÉL', async () => {
    linea = await lineaDelLibro(pedido.id)
    expect(linea.reparto_para).toBe('motorizado')
    expect(linea.en_mano).toBe('motorizado')
    expect(linea.courier_id).toBe(motoId)
  })

  it('la cooperativa ve su semana en curso, y la descarga para Excel', async () => {
    const { enCurso } = await exigir(200, panel.pedir('GET', '/api/cooperativa/carreras'))
    expect(enCurso.find(f => f.id === motoId)).toMatchObject({
      pedidos: 1, carrerasCents: linea.reparto_cents, efectivoCobradoCents: linea.total_cents,
    })
    const csv = await panel.pedir('GET', '/api/cooperativa/carreras.csv')
    expect(csv.status).toBe(200)
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(csv.body).toContain('"Motorizado de Cooperativa";"593990000555";"1"')
  })

  it('el lunes: liquida con Umbani, y la cooperativa ve la semana cerrada', async () => {
    await reloj.llevarALaSemana([pedido.id], SEMANA)
    // Las DOS liquidaciones, como la tarea de los lunes.
    const [{ r }] = await sql('select close_weekly_courier_settlements($1::date) as r', [SEMANA])
    await sql('select close_weekly_settlements($1::date)', [SEMANA])
    expect(r.creadas).toBeGreaterThanOrEqual(1)
    const { semanas } = await exigir(200, panel.pedir('GET', '/api/cooperativa/carreras'))
    expect(semanas).toContain(SEMANA)
    const { filas } = await exigir(200, panel.pedir('GET', `/api/cooperativa/carreras/semana/${SEMANA}`))
    expect(filas.find(f => f.id === motoId)).toMatchObject({
      pedidos: 1,
      carrerasCents: linea.reparto_cents,
      efectivoCobradoCents: linea.total_cents,
      // Su carrera menos el efectivo que cobró: lo que entrega a Umbani.
      saldoCents: linea.reparto_cents - linea.total_cents,
      estado: 'por_cobrar',
    })
  })

  it('otra cooperativa no ve ni toca nada de esta', async () => {
    const correo = `otra-${sufijo}@recorridos.ec`
    await exigir(201, admin.pedir('POST', '/api/admin/cooperativas', {
      nombre: `Otra ${sufijo}`, ciudadId: chone, usuario: { email: correo, clave: CLAVE },
    }))
    const otra = await entrarAlPanel(correo, CLAVE)
    const { repartidores } = await exigir(200, otra.pedir('GET', '/api/cooperativa/repartidores'))
    expect(repartidores.some(m => m.id === motoId)).toBe(false)
    expect((await otra.pedir('PUT', `/api/cooperativa/repartidores/${motoId}/activo`, { activo: false })).status).toBe(404)
    const { filas } = await exigir(200, otra.pedir('GET', `/api/cooperativa/carreras/semana/${SEMANA}`))
    expect(filas).toEqual([])
  })

  it('apagada: su panel se cierra y su motorizado no toma nada nuevo', async () => {
    await exigir(200, admin.pedir('PUT', `/api/admin/cooperativas/${coop}/activa`, { activa: false }))
    expect((await http('POST', '/api/cooperativa/login', { cuerpo: { email: CORREO, password: CLAVE } })).status).toBe(403)
    // La sesión abierta se corta en 15 s como mucho, sin esperar a que venza.
    await esperarHasta(async () => ((await panel.pedir('GET', '/api/cooperativa/yo')).status === 401 ? true : null),
      { segundos: 25, que: 'que se cierre el panel de la cooperativa apagada' })

    const otroPedido = await pedirEnEfectivo()
    await empacado(otroPedido.id)
    const moto = comoMotorizado('593990000555')
    expect((await moto.pedidos()).some(p => p.id === otroPedido.id)).toBe(false)
    expect((await moto.tomar(otroPedido.id)).status).toBe(409)
    await exigir(200, local.cambiarEstado(otroPedido.id, 'cancelado'))
    await exigir(200, admin.pedir('PUT', `/api/admin/cooperativas/${coop}/activa`, { activa: true }))
  })
})
