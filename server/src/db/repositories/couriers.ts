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
  active: boolean
  available: boolean
  cash_limit_cents: number
}

const COLUMNAS = 'id, phone, name, vehicle, fleet_business_id, active, available, cash_limit_cents'

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
  const { data, error } = await db.from('couriers').select(`${COLUMNAS}, created_at, businesses(name)`).order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return data || []
}

const createCourier = async (input: { phone: string; name: string; vehicle?: string | null; fleetBusinessId?: string | null; cashLimitCents?: number }) => {
  const { data, error } = await db.from('couriers').insert({
    phone: input.phone,
    name: input.name,
    vehicle: input.vehicle ?? null,
    fleet_business_id: input.fleetBusinessId ?? null,
    ...(input.cashLimitCents != null ? { cash_limit_cents: input.cashLimitCents } : {}),
  }).select(COLUMNAS).single()
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return data
}

const setCourierActive = async (courierId: string, active: boolean) => {
  const { error } = await db.from('couriers').update({ active, available: active ? undefined : false, updated_at: new Date().toISOString() }).eq('id', courierId)
  if (error) throw new Error(error.message)
}

export {
  getActiveCourierByPhone, setCourierAvailable, getCourierOrders, courierTakeOrder, courierAdvanceOrder,
  getCourierBalance, retainCourierFee, closeWeeklyCourierSettlements, markCourierSettlementPaid,
  listCourierSettlements, listCouriers, createCourier, setCourierActive,
}
