import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LOS MOTORIZADOS
//
// Las reglas (quién puede llevar qué, el tope de efectivo, la carrera
// retenida, la liquidación) viven en PostgreSQL
// (`migration-2026-09-28-motorizados.sql`). Aquí solo se piden.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

const leer = (datos: unknown): Record<string, unknown> => (
  datos && typeof datos === 'object' && !Array.isArray(datos) ? datos as Record<string, unknown> : {}
)
/** Un error de la base se lanza, nunca se traga. */
const sinError = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

export interface Courier {
  id: string
  phone: string
  name: string
  vehicle: string | null
  fleet_business_id: string | null
  /** Su ciudad (2026-10-05): el de Umbani solo ve pedidos de ella. */
  city_id: string | null
  active: boolean
  available: boolean
  cash_limit_cents: number
}

const COLUMNAS = 'id, phone, name, vehicle, fleet_business_id, city_id, active, available, cash_limit_cents'

/** El motorizado ACTIVO de ese teléfono (el de su sesión de la app), o null. */
const getActiveCourierByPhone = async (phone: string): Promise<Courier | null> => {
  const { data, error } = await db.from('couriers').select(COLUMNAS).eq('phone', phone).eq('active', true).maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

const setCourierAvailable = async (courierId: string, available: boolean): Promise<void> => {
  const { error } = await db.from('couriers').update({ available, updated_at: new Date().toISOString() }).eq('id', courierId)
  if (error) throw new Error(error.message)
}

const getCourierOrders = async (courierId: string): Promise<unknown[]> => {
  const data = sinError(await db.rpc('courier_orders', { p_courier_id: courierId }))
  return Array.isArray(data) ? data : []
}

const courierTakeOrder = async (courierId: string, orderId: string) =>
  leer(sinError(await db.rpc('courier_take_order', { p_courier_id: courierId, p_order_id: orderId })))

const courierAdvanceOrder = async (courierId: string, orderId: string, status: 'en_camino' | 'completado') =>
  leer(sinError(await db.rpc('courier_advance_order', { p_courier_id: courierId, p_order_id: orderId, p_status: status })))

const getCourierBalance = async (courierId: string) =>
  leer(sinError(await db.rpc('courier_balance', { p_courier_id: courierId })))

const retainCourierFee = async (orderId: string, motivo: string) =>
  leer(sinError(await db.rpc('retain_courier_fee', { p_order_id: orderId, p_motivo: motivo })))

const closeWeeklyCourierSettlements = async (weekStart: string): Promise<{ creadas: number }> => {
  const fila = leer(sinError(await db.rpc('close_weekly_courier_settlements', { p_week_start: weekStart })))
  return { creadas: Number(fila.creadas) || 0 }
}

const markCourierSettlementPaid = async (id: string, referencia: string) =>
  leer(sinError(await db.rpc('mark_courier_settlement_paid', { p_settlement_id: id, p_reference: referencia })))

/** Liquidaciones de motorizados (de uno, o de todos para el superadmin). */
const listCourierSettlements = async (courierId?: string | null, limite = 100) => {
  let consulta = db
    .from('courier_settlements')
    .select('id, courier_id, period_start, period_end, orders_count, derecho_cents, en_mano_cents, arrastre_cents, neto_cents, status, paid_at, reference, couriers(name, phone)')
    .order('period_start', { ascending: false })
    .limit(Math.min(Math.max(limite, 1), 300))
  if (courierId) consulta = consulta.eq('courier_id', courierId)
  const { data, error } = await consulta
  if (error) throw new Error(error.message)
  return data || []
}

const listCouriers = async () => {
  const { data, error } = await db.from('couriers').select(`${COLUMNAS}, created_at, businesses(name), cities(name)`).order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

const createCourier = async (input: { phone: string; name: string; vehicle?: string | null; fleetBusinessId?: string | null; cityId?: string | null; cashLimitCents?: number }) => {
  const { data, error } = await db.from('couriers').insert({
    phone: input.phone,
    name: input.name,
    vehicle: input.vehicle ?? null,
    fleet_business_id: input.fleetBusinessId ?? null,
    city_id: input.cityId ?? null,
    ...(input.cashLimitCents != null ? { cash_limit_cents: input.cashLimitCents } : {}),
  }).select(COLUMNAS).single()
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return data
}

const setCourierActive = async (courierId: string, active: boolean) => {
  const { error } = await db.from('couriers').update({ active, available: active ? undefined : false, updated_at: new Date().toISOString() }).eq('id', courierId)
  if (error) throw new Error(error.message)
}

/**
 * Las carreras de un motorizado que aún no se liquidaron: de ahí se elige la
 * que se RETIENE cuando se le cae la comida (superadmin). Solo las de Umbani
 * tienen carrera propia: la de un repartidor del local es del local.
 */
const listCourierRuns = async (courierId: string) => {
  const { data, error } = await db
    .from('order_ledger')
    .select('order_id, sold_at, reparto_cents, total_cents, payment_method, en_mano, retenido, retenido_motivo, orders!order_ledger_order_fk(order_number), businesses(name)')
    .eq('courier_id', courierId)
    .eq('kind', 'venta')
    .is('courier_settlement_id', null)
    .order('sold_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return data || []
}

// ── LA FLOTA DE UN LOCAL (2026-10-02) ───────────────────────────────────────
//
// El local registra a SUS repartidores desde su panel. ⚠️ Todo va filtrado
// por `fleet_business_id` = el negocio del JWT: un local no ve ni toca a los
// repartidores de otro, ni a los de Umbani. La regla de qué pedidos puede
// llevar cada uno sigue en la base (`orders_courier_permitido`).

const listFleetCouriers = async (businessId: string): Promise<Courier[]> => {
  const { data, error } = await db.from('couriers').select(COLUMNAS)
    .eq('fleet_business_id', businessId).order('created_at', { ascending: true })
  if (error) throw new Error(error.message)
  return (data || []) as Courier[]
}

/** `true` si el repartidor era de ESTE local y se cambió; `false` si no es suyo. */
const setFleetCourierActive = async (businessId: string, courierId: string, active: boolean): Promise<boolean> => {
  const { data, error } = await db.from('couriers')
    .update({ active, ...(active ? {} : { available: false }), updated_at: new Date().toISOString() })
    .eq('id', courierId).eq('fleet_business_id', businessId)
    .select('id')
  if (error) throw new Error(error.message)
  return (data || []).length > 0
}

/**
 * El efectivo de cada repartidor del local: lo que va a cobrar en los pedidos
 * que lleva ahora, y lo que ya cobró HOY. Es lo que el local le pide al final
 * del turno. Centavos enteros; `desde` es el inicio del día en Ecuador.
 */
const fleetCash = async (businessId: string, courierIds: string[], desde: string) => {
  const porRepartidor = new Map<string, { enCursoCents: number; cobradoHoyCents: number; entregasHoy: number }>()
  for (const id of courierIds) porRepartidor.set(id, { enCursoCents: 0, cobradoHoyCents: 0, entregasHoy: 0 })
  if (!courierIds.length) return porRepartidor
  const efectivo = 'payment_method.is.null,payment_method.in.(efectivo,pago_al_retirar)'
  const centavos = (v: unknown) => Math.round((Number(v) || 0) * 100)

  const enCurso = await db.from('orders').select('courier_id, total')
    .eq('business_id', businessId).in('courier_id', courierIds).or(efectivo)
    .not('status', 'in', '("completado","cancelado","rechazado","expirado")')
  if (enCurso.error) throw new Error(enCurso.error.message)
  for (const p of enCurso.data || []) {
    const fila = porRepartidor.get(String(p.courier_id))
    if (fila) fila.enCursoCents += centavos(p.total)
  }

  // Entregado HOY = su venta es de hoy (la venta nace al entregar).
  const ventas = await db.from('sales').select('order_id, total')
    .eq('business_id', businessId).eq('status', 'completada').gte('sold_at', desde).not('order_id', 'is', null)
  if (ventas.error) throw new Error(ventas.error.message)
  const totalDe = new Map((ventas.data || []).map(v => [String(v.order_id), centavos(v.total)]))
  if (totalDe.size) {
    const suyos = await db.from('orders').select('id, courier_id')
      .eq('business_id', businessId).in('id', [...totalDe.keys()]).in('courier_id', courierIds).or(efectivo)
    if (suyos.error) throw new Error(suyos.error.message)
    for (const p of suyos.data || []) {
      const fila = porRepartidor.get(String(p.courier_id))
      if (!fila) continue
      fila.cobradoHoyCents += totalDe.get(String(p.id)) || 0
      fila.entregasHoy += 1
    }
  }
  return porRepartidor
}

export {
  getActiveCourierByPhone, setCourierAvailable, getCourierOrders, courierTakeOrder, courierAdvanceOrder,
  getCourierBalance, retainCourierFee, closeWeeklyCourierSettlements, markCourierSettlementPaid,
  listCourierSettlements, listCouriers, createCourier, setCourierActive,
  listCourierRuns, listFleetCouriers, setFleetCourierActive, fleetCash,
}
