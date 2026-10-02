import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  centavos, cerrarSql, clientePorLaApp, cobroDelPedido, configurarElDinero, entrarComoLocal, esperarHasta, exigir,
  lineaDelLibro, llevarHastaEntregar, payphone, productosSimples, recogerLaMesa, sql, volverDePayPhone,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// LA TARJETA: COBRAR, CUADRAR AL CENTAVO Y DEVOLVER
// ═══════════════════════════════════════════════════════════════════════════
//
// El dinero de la tarjeta entra en la cuenta de UMBANI (PayPhone) y Umbani le
// paga al local el lunes. Aquí se recorre lo que más miedo da:
//
//   · el cliente paga y VUELVE a la app → se confirma al instante;
//   · el cliente paga y NO vuelve (se le fue el 4G) → la tarea lo confirma
//     igual, porque PayPhone devuelve el dinero si nadie confirma en 5 min;
//   · se cancela un pedido ya cobrado → se DEVUELVE solo;
//   · PayPhone cobró otro monto → no se da por pagado y se devuelve;
//   · la tarjeta rechazada → el pedido sigue esperando su pago.
//
// PayPhone es el falso de `proveedores-falsos.mjs`: contesta como el de verdad.

let cliente
let local
let carta
let addressId

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  cliente = await clientePorLaApp()
  local = await entrarComoLocal()
  carta = await cliente.catalogo()
  addressId = await cliente.direccion()
})
afterAll(cerrarSql)

/** Pide con tarjeta y prepara el cobro: devuelve el pedido y la referencia del cobro. */
async function pedirConTarjeta(cantidad = 1) {
  const [primero] = productosSimples(carta)
  const pedido = await exigir(201, cliente.pedir_({
    items: [{ productId: primero.id, quantity: cantidad }], fulfillment: 'delivery', paymentMethod: 'tarjeta', addressId,
  }))
  const pago = await exigir(200, cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/tarjeta`, {}))
  return { pedido, pago, cobro: await cobroDelPedido(pedido.id) }
}

const estadoDelCobro = async referencia => (await sql(
  'select status, captured_cents from payments where client_transaction_id = $1', [referencia],
))[0]

describe('pagar con tarjeta y volver a la app', () => {
  let pedido
  let cobro

  it('el cobro se prepara desde el servidor, por el total de la base y en centavos', async () => {
    const r = await pedirConTarjeta(2)
    pedido = r.pedido
    cobro = r.cobro
    expect(pedido.status).toBe('esperando_pago')
    expect(r.pago.url).toMatch(/^https:\/\/pay\.payphonetodoesposible\.com\//)
    expect(r.pago.urlApp).toContain('/pagos/payphone/ir?destino=')
    expect(cobro.amount_cents).toBe(centavos(pedido.total))
    const { preparadas } = await payphone.estado()
    expect(preparadas.find(p => p.referencia === cobro.referencia)?.centavos).toBe(centavos(pedido.total))
  })

  it('sin pagar, el pedido no existe para la cocina: el local no puede aceptarlo y lee por qué', async () => {
    const aceptar = await local.cambiarEstado(pedido.id, 'aceptado')
    expect(aceptar.status).toBe(409)
    expect(aceptar.body.error).toMatch(/tarjeta.*no está confirmado/i)
    const [{ status }] = await sql('select status from orders where id = $1', [pedido.id])
    expect(status).toBe('esperando_pago')
  })

  it('el cliente paga, vuelve, y el servidor confirma (captura) al instante', async () => {
    const { id } = await payphone.pagar(cobro.referencia)
    const vuelta = await volverDePayPhone(id, cobro.referencia)
    expect(vuelta.status).toBe(303)
    expect(vuelta.headers.get('location')).toContain(`pago=${pedido.id}`)

    const estado = await exigir(200, cliente.pedir('GET', `/api/store/:slug/orders/${pedido.id}/tarjeta`))
    expect(estado.pagado).toBe(true)
    expect(estado.estado).toBe('aprobado')
    expect((await estadoDelCobro(cobro.referencia)).captured_cents).toBe(centavos(pedido.total))
    const { confirmadas } = await payphone.estado()
    expect(confirmadas.filter(c => c.referencia === cobro.referencia)).toHaveLength(1)
  })

  it('volver dos veces no confirma dos veces', async () => {
    const { preparadas } = await payphone.estado()
    const { id } = preparadas.find(p => p.referencia === cobro.referencia)
    await volverDePayPhone(id, cobro.referencia)
    const { confirmadas } = await payphone.estado()
    expect(confirmadas.filter(c => c.referencia === cobro.referencia).length).toBeLessThanOrEqual(2)
    expect((await estadoDelCobro(cobro.referencia)).status).toBe('aprobado')
  })

  it('ya pagado, el local lo prepara y lo entrega', async () => {
    await llevarHastaEntregar(local, pedido.id)
  })

  it('el libro: el dinero lo tiene UMBANI, y la comisión de PayPhone queda anotada', async () => {
    const linea = await lineaDelLibro(pedido.id)
    expect(linea.payment_method).toBe('tarjeta')
    expect(linea.en_mano).toBe('umbani')
    expect(linea.total_cents).toBe(centavos(pedido.total))
    expect(linea.local_cents + linea.reparto_cents + linea.umbani_cents).toBe(linea.total_cents)
    // 5,75 % de lo cobrado, que absorbe Umbani: el local cobra su precio entero.
    expect(linea.provider_fee_cents).toBe(Math.round(linea.total_cents * 575 / 10000))
  })
})

describe('el cliente paga y NO vuelve a la app', () => {
  // Un solo pedido con tarjeta esperando su pago por cliente: es una regla de
  // verdad, y todos los recorridos son el mismo cliente.
  beforeEach(recogerLaMesa)

  it('la tarea del servidor encuentra el pago por la referencia y lo confirma igual', async () => {
    const { pedido, cobro } = await pedirConTarjeta()
    await payphone.pagar(cobro.referencia)
    // Nadie llama a /retorno: se le fue el 4G. La tarea corre cada 20 s.
    await esperarHasta(async () => (await estadoDelCobro(cobro.referencia)).status === 'aprobado',
      { segundos: 130, que: 'que la tarea confirmara el pago sin el teléfono (primera consulta al minuto, luego cada 20 s)' })
    const [{ payment_confirmed_at: pagado }] = await sql('select payment_confirmed_at from orders where id = $1', [pedido.id])
    expect(pagado).toBeTruthy()
    const { confirmadas } = await payphone.estado()
    expect(confirmadas.some(c => c.referencia === cobro.referencia)).toBe(true)
  })
})

describe('se cancela un pedido ya cobrado', () => {
  // Un solo pedido con tarjeta esperando su pago por cliente: es una regla de
  // verdad, y todos los recorridos son el mismo cliente.
  beforeEach(recogerLaMesa)

  it('el dinero se DEVUELVE solo, y no queda venta ni comisión', async () => {
    const { pedido, cobro } = await pedirConTarjeta()
    const { id } = await payphone.pagar(cobro.referencia)
    await volverDePayPhone(id, cobro.referencia)
    expect((await estadoDelCobro(cobro.referencia)).status).toBe('aprobado')

    await exigir(200, local.cambiarEstado(pedido.id, 'aceptado'))
    await exigir(200, local.cambiarEstado(pedido.id, 'cancelado'))

    await esperarHasta(async () => (await estadoDelCobro(cobro.referencia)).status === 'devuelto',
      { segundos: 90, que: 'que se devolviera el cobro' })
    const { revertidas } = await payphone.estado()
    expect(revertidas.some(r => r.id === id)).toBe(true)
    expect(await sql('select 1 from sales where order_id = $1', [pedido.id])).toHaveLength(0)
    expect(await lineaDelLibro(pedido.id)).toBeUndefined()
  })
})

describe('PayPhone cobró OTRO monto', () => {
  // Un solo pedido con tarjeta esperando su pago por cliente: es una regla de
  // verdad, y todos los recorridos son el mismo cliente.
  beforeEach(recogerLaMesa)

  it('no se da por pagado: el cobro que no cuadra al centavo se devuelve', async () => {
    const { pedido, cobro } = await pedirConTarjeta()
    const { id } = await payphone.pagar(cobro.referencia, { centavos: centavos(pedido.total) - 1 })
    await volverDePayPhone(id, cobro.referencia)

    const [{ payment_confirmed_at: pagado, status }] = await sql(
      'select payment_confirmed_at, status from orders where id = $1', [pedido.id],
    )
    expect(pagado).toBeNull()
    expect(status).not.toBe('pendiente')
    await esperarHasta(async () => ['devuelto', 'devolucion_manual'].includes((await estadoDelCobro(cobro.referencia)).status),
      { segundos: 90, que: 'que se devolviera el cobro que no cuadraba' })
  })
})

describe('la tarjeta rechazada', () => {
  // Un solo pedido con tarjeta esperando su pago por cliente: es una regla de
  // verdad, y todos los recorridos son el mismo cliente.
  beforeEach(recogerLaMesa)

  it('el pedido sigue esperando su pago y el rechazo queda anotado', async () => {
    const { pedido, cobro } = await pedirConTarjeta()
    const { id } = await payphone.pagar(cobro.referencia, { aprobado: false })
    await volverDePayPhone(id, cobro.referencia)
    expect((await estadoDelCobro(cobro.referencia)).status).toBe('rechazado')
    const [{ status, payment_confirmed_at: pagado }] = await sql(
      'select status, payment_confirmed_at from orders where id = $1', [pedido.id],
    )
    expect(status).toBe('esperando_pago')
    expect(pagado).toBeNull()
  })
})
