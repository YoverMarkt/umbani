import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LAS CUENTAS DE CADA LOCAL Y SU LIQUIDACIÓN SEMANAL
//
// Aquí no se calcula ni un centavo: el libro por pedido (`order_ledger`), el
// cierre de cada semana y los saldos los hace PostgreSQL
// (`migration-2026-09-28-cuentas-y-liquidacion-semanal.sql`). Esto solo los
// pide y los devuelve.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

/** Cierra la semana que empieza ese lunes. Idempotente. */
const closeWeeklySettlements = async (weekStart: string): Promise<{ creadas: number; motivo?: string }> => {
  const { data, error } = await db.rpc('close_weekly_settlements', { p_week_start: weekStart })
  if (error) throw new Error(error.message)
  const fila = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return {
    creadas: Number(fila.creadas) || 0,
    motivo: typeof fila.motivo === 'string' ? fila.motivo : undefined,
  }
}

export interface SaldoEnCurso {
  business_id: string
  business_name: string
  pedidos: number
  pedidos_tarjeta: number
  derecho_cents: number
  en_mano_cents: number
  arrastre_cents: number
  neto_cents: number
  umbani_cents: number
  payphone_cents: number
  // Por incidencias (2026-10-12): + se le reconoce, − se le descuenta.
  ajustes_cents: number
}

/** Lo aún sin liquidar de cada local (o de uno). */
const getSettlementBalances = async (businessId?: string | null): Promise<SaldoEnCurso[]> => {
  const { data, error } = await db.rpc('settlement_balances', {
    p_business_id: businessId ?? undefined,
  })
  if (error) throw new Error(error.message)
  return data || []
}

/** Las liquidaciones, las más recientes primero. Con negocio, solo las suyas. */
const listSettlements = async (input: { businessId?: string | null; limite?: number } = {}) => {
  let consulta = db
    .from('settlements')
    .select('id, business_id, party, period_start, period_end, orders_count, derecho_cents, en_mano_cents, arrastre_cents, cuota_cents, ajustes_cents, neto_cents, status, paid_at, reference, created_at, businesses(name)')
    .order('period_start', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(input.limite ?? 100, 1), 300))
  if (input.businessId) consulta = consulta.eq('business_id', input.businessId)
  const { data, error } = await consulta
  if (error) throw new Error(error.message)
  return data || []
}

/** Marca pagada (Umbani al local) o cobrada (el local a Umbani). */
const markSettlementPaid = async (settlementId: string, reference: string): Promise<{ result: string; status?: string }> => {
  const { data, error } = await db.rpc('mark_settlement_paid', {
    p_settlement_id: settlementId,
    p_reference: reference,
  })
  if (error) throw new Error(error.message)
  const fila = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>
  return { result: String(fila.result || 'error'), status: typeof fila.status === 'string' ? fila.status : undefined }
}

/** Los cobros con tarjeta de todos los locales, para la pantalla «Pagos». */
/**
 * Los locales de DEMOSTRACIÓN (2026-09-30): su dinero es de prueba. Pagos los
 * marca y no los suma a lo que Umbani debe; la base ya impide pagarlos.
 */
const getDemoBusinessIds = async (): Promise<Set<string>> => {
  const { data, error } = await db.from('businesses').select('id').eq('is_demo', true)
  if (error) throw new Error(error.message)
  return new Set((data || []).map(b => b.id))
}

const listCardPayments = async (limite = 100) => {
  const { data, error } = await db
    .from('payments')
    .select('id, business_id, order_id, environment, status, status_detail, amount_cents, captured_cents, card_brand, card_last_digits, provider_transaction_id, created_at, approved_at, reversed_at, reconciled_at, reconciliation, reconciliation_detail, businesses(name), orders(order_number)')
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limite, 1), 300))
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * El libro de UN local: sus pedidos entregados con lo que le tocó a cada uno.
 * ⚠️ El negocio es obligatorio: esto lo pide el panel del dueño.
 */
const listLedger = async (businessId: string, input: { soloSinLiquidar?: boolean; limite?: number } = {}) => {
  let consulta = db
    .from('order_ledger')
    // `credit_cents` y `en_mano_cents` (2026-10-10): lo que pagó el cliente con
    // saldo Umbani (lo pone Umbani) y lo que de verdad tiene en la mano quien cobró.
    .select('id, order_id, kind, sold_at, payment_method, total_cents, local_cents, reparto_cents, reparto_para, umbani_cents, en_mano, credit_cents, en_mano_cents, settlement_id, orders(order_number)')
    .eq('business_id', businessId)
    .order('sold_at', { ascending: false })
    .limit(Math.min(Math.max(input.limite ?? 200, 1), 500))
  if (input.soloSinLiquidar) consulta = consulta.is('settlement_id', null)
  const { data, error } = await consulta
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * Los ajustes por incidencias que aún no se liquidaron (2026-10-12): lo que se
 * le reconoce (+) o se le cobra (−) a UN local o a UN repartidor, y por qué.
 * ⚠️ El dueño es obligatorio: esto lo piden el panel del local y la app del
 * repartidor, cada uno lo suyo.
 */
const listUnsettledAdjustments = async (de: { businessId: string } | { courierId: string }) => {
  const consulta = db
    .from('settlement_adjustments')
    .select('cents, concepto, created_at, businesses(name), orders!settlement_adjustments_order_fk(order_number), order_incidents!settlement_adjustments_incident_fk(kind)')
    .order('created_at', { ascending: false })
    .limit(200)
  const { data, error } = 'businessId' in de
    ? await consulta.eq('business_id', de.businessId).eq('party', 'local').is('settlement_id', null)
    : await consulta.eq('courier_id', de.courierId).eq('party', 'motorizado').is('courier_settlement_id', null)
  if (error) throw new Error(error.message)
  return data || []
}

/** La tarifa de servicio vigente, tal como la cobra la base. */
const getServiceFee = async (): Promise<number> => {
  const { data, error } = await db.rpc('tarifa_de_servicio')
  if (error) throw new Error(error.message)
  const tarifa = Number(data)
  return Number.isFinite(tarifa) && tarifa > 0 ? tarifa : 0
}

export {
  getServiceFee,
  listLedger,
  closeWeeklySettlements,
  getSettlementBalances,
  listSettlements,
  listUnsettledAdjustments,
  markSettlementPaid,
  listCardPayments,
  getDemoBusinessIds,
}
