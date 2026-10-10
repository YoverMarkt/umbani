import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LAS INCIDENCIAS Y EL «¿LLEGÓ TODO BIEN?» (2026-10-06, fase 1)
//
// Las reglas —de quién es el pedido, el plazo de 48 h, una vez por pedido,
// cuánto le corresponde al cliente— viven en PostgreSQL
// (`migration-2026-10-06-incidencias.sql`). Aquí se piden.
//
// Fase 2 (2026-10-10, `migration-2026-10-10-saldo-umbani.sql`): lo que el
// cliente no recibió bien se le devuelve como SALDO UMBANI, lo pequeño al
// instante con la escalera de confianza. También vive en la base.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

const leer = (datos: unknown): Record<string, unknown> => (
  datos && typeof datos === 'object' && !Array.isArray(datos) ? datos as Record<string, unknown> : {}
)
const sinError = <T>(r: { data: T; error: { message: string } | null }): T => {
  if (r.error) throw new Error(r.error.message)
  return r.data
}

/** El plazo para reclamar. ⚠️ La base lo exige igual: aquí solo se enseña hasta cuándo. */
const PLAZO_MS = 48 * 60 * 60 * 1000

export interface EstadoDelReclamo {
  todoBien: boolean
  reclamo: { tipo: string; estado: string; sugeridoCents: number; compensacionCents: number | null } | null
  /** Hasta cuándo puede reclamar; null si ya no (o si aún no se entregó). */
  reclamableHasta: string | null
}

// ── El cliente ─────────────────────────────────────────────────────────────

const confirmOrderReceived = async (orderId: string, phone: string) =>
  leer(sinError(await db.rpc('customer_confirm_order', { p_order_id: orderId, p_phone: phone })))

const reportOrderProblem = async (
  orderId: string, phone: string, kind: string, lines: unknown, note: string | null, photo: string | null = null,
) =>
  leer(sinError(await db.rpc('customer_report_order', {
    p_order_id: orderId, p_phone: phone, p_kind: kind,
    p_lines: (Array.isArray(lines) ? lines : []) as Database['public']['Functions']['customer_report_order']['Args']['p_lines'],
    p_note: note ?? '',
    // La foto la subió el servidor en la carpeta de este pedido; la base lo comprueba.
    ...(photo ? { p_photo: photo } : {}),
  })))

/** El saldo Umbani de una persona: lo que queda vigente y el próximo que vence. */
const customerCreditBalance = async (customerId: string) => {
  const datos = leer(sinError(await db.rpc('saldo_del_cliente', { p_customer_id: customerId })))
  const proximo = leer(datos.proximo)
  return {
    cents: Number(datos.cents) || 0,
    proximo: datos.proximo ? { cents: Number(proximo.cents) || 0, venceEl: String(proximo.venceEl ?? '') } : null,
  }
}

/**
 * Lo que el cliente ve de cada pedido suyo: si dijo «todo bien», su reclamo
 * y hasta cuándo puede reclamar. De TODOS los pedidos de una lista a la vez:
 * tres consultas, no tres por pedido.
 */
const claimStates = async (orders: { id: string; status: string; received_ok_at?: string | null }[]) => {
  const estados = new Map<string, EstadoDelReclamo>()
  const entregados = orders.filter(o => o.status === 'completado').map(o => o.id)
  const reclamos = new Map<string, EstadoDelReclamo['reclamo']>()
  const entregadoEn = new Map<string, string>()
  if (entregados.length) {
    const [r, v] = await Promise.all([
      db.from('order_incidents').select('order_id, kind, status, suggested_cents, compensation_cents')
        .in('order_id', entregados).eq('origin', 'cliente'),
      db.from('sales').select('order_id, sold_at').in('order_id', entregados),
    ])
    if (r.error) throw new Error(r.error.message)
    if (v.error) throw new Error(v.error.message)
    for (const fila of r.data || []) {
      reclamos.set(fila.order_id, {
        tipo: fila.kind, estado: fila.status, sugeridoCents: fila.suggested_cents, compensacionCents: fila.compensation_cents,
      })
    }
    for (const fila of v.data || []) if (fila.order_id) entregadoEn.set(fila.order_id, fila.sold_at)
  }
  const ahora = Date.now()
  for (const o of orders) {
    const reclamo = reclamos.get(o.id) ?? null
    const desde = entregadoEn.get(o.id)
    const hasta = desde ? new Date(new Date(desde).getTime() + PLAZO_MS) : null
    estados.set(o.id, {
      todoBien: Boolean(o.received_ok_at),
      reclamo,
      reclamableHasta: !reclamo && hasta && hasta.getTime() > ahora ? hasta.toISOString() : null,
    })
  }
  return estados
}

// ── El superadmin ──────────────────────────────────────────────────────────

/**
 * `abierta` = lo que le toca al superadmin: las abiertas y las COMPENSADAS
 * (saldo dado al instante, falta confirmar quién responde). Sin confirmarlo,
 * al responsable no se le cobra nada el lunes.
 */
const listIncidents = async (estado: 'abierta' | 'todas', limite = 200) => {
  let consulta = db.from('order_incidents')
    .select(`id, kind, origin, status, responsible, lines, note, suggested_cents, compensation_cents, resolution_note,
      resolved_by, created_at, resolved_at, order_id, business_id, auto_approved, compensated_at,
      local_cents, umbani_cents, reparto_cents, photo_public_id, escalon, review_reasons,
      orders!order_incidents_order_fk(order_number, total, payment_method, contact_name, contact_phone),
      businesses(name), couriers(name, cooperative_id, cooperatives(name))`)
    .order('created_at', { ascending: false })
    .limit(Math.min(Math.max(limite, 1), 500))
  if (estado === 'abierta') consulta = consulta.in('status', ['abierta', 'compensada'])
  const { data, error } = await consulta
  if (error) throw new Error(error.message)
  return data || []
}

const registerIncident = async (businessId: string, orderNumber: number, kind: string, note: string) =>
  leer(sinError(await db.rpc('register_incident', {
    p_business_id: businessId, p_order_number: orderNumber, p_kind: kind, p_note: note,
  })))

const resolveIncident = async (input: {
  id: string; status: string; responsible: string | null; compensationCents: number | null; note: string; actor: string
}) => leer(sinError(await db.rpc('resolve_incident', {
  p_id: input.id, p_status: input.status, p_responsible: input.responsible ?? '',
  p_compensation_cents: input.compensationCents ?? -1, p_note: input.note, p_actor: input.actor,
})))

// ── La cooperativa ─────────────────────────────────────────────────────────

/** Las incidencias de SUS motorizados. ⚠️ Sin datos del cliente: ni su nota. */
const cooperativeIncidents = async (courierIds: string[]) => {
  if (!courierIds.length) return []
  const { data, error } = await db.from('order_incidents')
    .select('id, kind, status, responsible, created_at, resolved_at, courier_id, orders!order_incidents_order_fk(order_number), businesses(name)')
    .in('courier_id', courierIds)
    .order('created_at', { ascending: false })
    .limit(100)
  if (error) throw new Error(error.message)
  return data || []
}

export {
  confirmOrderReceived, reportOrderProblem, claimStates, customerCreditBalance,
  listIncidents, registerIncident, resolveIncident, cooperativeIncidents,
}
