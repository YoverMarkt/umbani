import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  admin, cerrarSql, clientePorWhatsApp, configurarElDinero, entrarComoLocal, exigir,
  lineaDelLibro, llevarHastaEntregar, pedirYPagarConTarjeta, productosSimples, recogerLaMesa, reloj, sql,
} from './actores.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// EL LUNES: LA SEMANA SE LIQUIDA, AL CENTAVO
// ═══════════════════════════════════════════════════════════════════════════
//
// Una semana de un local con los tres cobros de verdad:
//   · EFECTIVO      → el dinero lo tiene el local;
//   · TRANSFERENCIA → también (le transfirieron a él);
//   · TARJETA       → lo tiene Umbani (entró por PayPhone).
// El lunes se cruza lo que es de cada uno con lo que tiene en la mano, y sale
// UN número: lo que Umbani le deposita al local, o lo que el local le debe.
//
// ⚠️ El reloj: la semana tiene que haber TERMINADO para cerrarse, así que los
// pedidos de hoy se llevan a una semana pasada (`reloj.llevarALaSemana`). Es lo
// único que no pasa por una pantalla, y está escrito en `actores.mjs`.

const SEMANA = '2026-09-14'

let local
const pedidos = {}

beforeAll(async () => {
  await recogerLaMesa()
  await configurarElDinero({ envio: 1.5, margen: 10, tarifa: 0.1 })
  const cliente = await clientePorWhatsApp()
  local = await entrarComoLocal()
  const [primero, segundo] = productosSimples(await cliente.catalogo())
  const addressId = await cliente.direccion()
  const base = { fulfillment: 'delivery', addressId }

  pedidos.efectivo = await exigir(201, cliente.pedir_({ ...base, paymentMethod: 'efectivo', items: [{ productId: primero.id, quantity: 1 }] }))
  await llevarHastaEntregar(local, pedidos.efectivo.id)

  pedidos.transferencia = await exigir(201, cliente.pedir_({ ...base, paymentMethod: 'transferencia', items: [{ productId: primero.id, quantity: 2 }] }))
  await exigir(200, local.confirmarPago(pedidos.transferencia.id))
  await llevarHastaEntregar(local, pedidos.transferencia.id)

  // La tarjeta, más grande: así esta semana Umbani le DEBE al local.
  const { pedido } = await pedirYPagarConTarjeta(cliente, { ...base, items: [{ productId: segundo.id, quantity: 4 }] })
  pedidos.tarjeta = pedido
  await llevarHastaEntregar(local, pedidos.tarjeta.id)

  await reloj.llevarALaSemana(Object.values(pedidos).map(p => p.id), SEMANA)
})
afterAll(cerrarSql)

describe('la liquidación de la semana', () => {
  let liquidacion
  let lineas

  it('cada pedido entregado dejó su línea en el libro, cuadrada', async () => {
    lineas = await Promise.all(Object.values(pedidos).map(p => lineaDelLibro(p.id)))
    for (const linea of lineas) {
      expect(linea.local_cents + linea.reparto_cents + linea.umbani_cents).toBe(linea.total_cents)
      expect(linea.settlement_id).toBeNull()
    }
    expect(lineas.map(l => l.en_mano).sort()).toEqual(['local', 'local', 'umbani'])
  })

  it('el lunes se cierra la semana: UNA liquidación con esos tres pedidos', async () => {
    const [{ r }] = await sql('select close_weekly_settlements($1::date) as r', [SEMANA])
    expect(r.creadas).toBe(1)
    // `s.*` y no `*`: con la unión, el `id` del negocio pisaría el de la liquidación.
    ;[liquidacion] = await sql(`select s.* from settlements s join businesses b on b.id = s.business_id
                                 where b.slug = 'demo' and s.period_start = $1`, [SEMANA])
    expect(liquidacion.orders_count).toBe(3)
    expect(liquidacion.period_end.toISOString().slice(0, 10)).toBe('2026-09-20')
  })

  it('lo que es del local, menos lo que ya tiene en la mano, al centavo', async () => {
    const suyo = lineas.reduce((t, l) => t + l.local_cents + (l.reparto_para === 'local' ? l.reparto_cents : 0), 0)
    const enLaMano = lineas.filter(l => l.en_mano === 'local').reduce((t, l) => t + l.total_cents, 0)
    expect(liquidacion.derecho_cents).toBe(suyo)
    expect(liquidacion.en_mano_cents).toBe(enLaMano)
    expect(liquidacion.neto_cents).toBe(suyo - enLaMano + liquidacion.arrastre_cents - liquidacion.cuota_cents)
    // La tarjeta la cobró Umbani: esta semana Umbani le deposita al local.
    expect(liquidacion.neto_cents).toBeGreaterThan(0)
    expect(liquidacion.status).toBe('por_pagar')
  })

  it('cada pedido queda liquidado UNA vez: cerrar otra vez no crea nada', async () => {
    const atados = await sql('select settlement_id from order_ledger where order_id = any($1::uuid[])', [Object.values(pedidos).map(p => p.id)])
    expect(atados.every(l => l.settlement_id === liquidacion.id)).toBe(true)
    const [{ r }] = await sql('select close_weekly_settlements($1::date) as r', [SEMANA])
    expect(r.creadas).toBe(0)
  })

  it('el superadmin la ve en Pagos, con la cuenta del local para depositar', async () => {
    const pagos = await exigir(200, admin.pedir('GET', '/api/admin/pagos'))
    const enPagos = pagos.liquidaciones.find(l => l.id === liquidacion.id)
    expect(enPagos?.neto_cents).toBe(liquidacion.neto_cents)
    expect(JSON.stringify(pagos.cuentas[liquidacion.business_id] || {})).toContain('2200000000')
  })

  it('el local la ve en «Mis pagos» con el mismo número', async () => {
    const mis = await exigir(200, local.pedir('GET', '/api/client/mis-pagos'))
    const deposito = mis.depositos.find(d => d.id === liquidacion.id)
    expect(deposito?.netoCents).toBe(liquidacion.neto_cents)
    expect(deposito?.estado).toBe('por_pagar')
    // Lo liquidado ya no aparece entre lo pendiente de la semana.
    const pendientes = mis.pedidos.map(p => p.numero)
    for (const pedido of Object.values(pedidos)) expect(pendientes).not.toContain(pedido.order_number)
  })

  it('el superadmin la marca pagada con su referencia, y queda en el registro de dinero', async () => {
    const r = await exigir(200, admin.pedir('POST', `/api/admin/pagos/liquidaciones/${liquidacion.id}/marcar`, { referencia: 'TRF-PRUEBA-0001' }))
    expect(r.status).toBe('pagada')
    const [marcada] = await sql('select status, reference, paid_at from settlements where id = $1', [liquidacion.id])
    expect(marcada.status).toBe('pagada')
    expect(marcada.reference).toBe('TRF-PRUEBA-0001')
    const registro = await sql(`select actor, action from money_audit_log
                                 where target_table = 'settlements' and target_id = $1 order by id`, [liquidacion.id])
    expect(registro.length).toBeGreaterThanOrEqual(1)
    expect(registro.some(r => /admin|superadmin|@/i.test(r.actor))).toBe(true)
  })

  it('marcarla pagada dos veces no paga dos veces', async () => {
    const otraVez = await admin.pedir('POST', `/api/admin/pagos/liquidaciones/${liquidacion.id}/marcar`, { referencia: 'TRF-PRUEBA-0002' })
    expect(otraVez.status).toBe(409)
    const [{ reference }] = await sql('select reference from settlements where id = $1', [liquidacion.id])
    expect(reference).toBe('TRF-PRUEBA-0001')
  })
})
