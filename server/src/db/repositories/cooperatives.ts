import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LAS COOPERATIVAS DE REPARTO (2026-10-06)
//
// La tercera flota. Las reglas —qué pedidos lleva cada motorizado, que su
// ciudad sea la de su cooperativa, que el dinero sea como el de Umbani— viven
// en PostgreSQL (`migration-2026-10-06-cooperativas.sql`). Aquí se piden.
//
// ⚠️ TODO lo de una cooperativa va filtrado por SU id, que sale del token de
// su panel, nunca de la petición: una cooperativa no ve ni toca a los
// motorizados de otra, ni a los de Umbani, ni a los de un local.
// ⚠️ Sin datos de clientes: de un pedido solo sale su número y el local.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

/** Un error de la base se lanza (con su código: 23505 es un repetido), nunca se traga. */
const fallo = (error: { message: string; code?: string }) => Object.assign(new Error(error.message), { code: error.code })

export interface Cooperative {
  id: string
  name: string
  city_id: string
  contact_phone: string | null
  active: boolean
}

export interface CooperativeUser {
  id: string
  cooperative_id: string
  email: string
  name: string | null
  active: boolean
}

const COLUMNAS = 'id, name, city_id, contact_phone, active, created_at'
const COLUMNAS_USUARIO = 'id, cooperative_id, email, name, active'
const COLUMNAS_MOTORIZADO = 'id, phone, email, name, vehicle, id_number, plate, license_number, active, available, cash_limit_cents, created_at'

// ── El superadmin ──────────────────────────────────────────────────────────

const listCooperatives = async () => {
  const { data, error } = await db.from('cooperatives')
    .select(`${COLUMNAS}, cities(name), cooperative_users(id, email, name, active), couriers(count)`)
    .order('created_at', { ascending: true })
  if (error) throw fallo(error)
  return data || []
}

const getCooperative = async (id: string) => {
  const { data, error } = await db.from('cooperatives').select(`${COLUMNAS}, cities(name)`).eq('id', id).maybeSingle()
  if (error) throw fallo(error)
  return data || null
}

const createCooperative = async (input: { name: string; cityId: string; contactPhone?: string | null }) => {
  const { data, error } = await db.from('cooperatives').insert({
    name: input.name, city_id: input.cityId, contact_phone: input.contactPhone ?? null,
  }).select(COLUMNAS).single()
  if (error) throw fallo(error)
  return data
}

/** Solo si nació hace un momento y su primer usuario no se pudo crear. */
const deleteCooperative = async (id: string): Promise<void> => {
  const { error } = await db.from('cooperatives').delete().eq('id', id)
  if (error) throw fallo(error)
}

/** `true` si existía y se cambió. */
const setCooperativeActive = async (id: string, active: boolean): Promise<boolean> => {
  const { data, error } = await db.from('cooperatives')
    .update({ active, updated_at: new Date().toISOString() }).eq('id', id).select('id')
  if (error) throw fallo(error)
  return (data || []).length > 0
}

const createCooperativeUser = async (input: { cooperativeId: string; email: string; passwordHash: string; name?: string | null }) => {
  const { data, error } = await db.from('cooperative_users').insert({
    cooperative_id: input.cooperativeId, email: input.email, password_hash: input.passwordHash, name: input.name ?? null,
  }).select(COLUMNAS_USUARIO).single()
  if (error) throw fallo(error)
  return data
}

/** La clave nueva que le da el superadmin cuando la olvidan. `true` si el usuario existía. */
const setCooperativeUserPassword = async (userId: string, passwordHash: string): Promise<boolean> => {
  const { data, error } = await db.from('cooperative_users')
    .update({ password_hash: passwordHash, updated_at: new Date().toISOString() }).eq('id', userId).select('id')
  if (error) throw fallo(error)
  return (data || []).length > 0
}

// ── La sesión de su panel ──────────────────────────────────────────────────

/** Para el inicio de sesión: lleva el hash, y solo lo lee la ruta del login. */
const getCooperativeUserByEmail = async (email: string) => {
  const { data, error } = await db.from('cooperative_users')
    .select(`${COLUMNAS_USUARIO}, password_hash`).eq('email', email).maybeSingle()
  if (error) throw fallo(error)
  return data || null
}

/** El usuario de la sesión, y solo si es de ESA cooperativa. */
const getCooperativeUserById = async (cooperativeId: string, userId: string): Promise<CooperativeUser | null> => {
  const { data, error } = await db.from('cooperative_users')
    .select(COLUMNAS_USUARIO).eq('id', userId).eq('cooperative_id', cooperativeId).maybeSingle()
  if (error) throw fallo(error)
  return data || null
}

// ── Sus motorizados ────────────────────────────────────────────────────────

const listCooperativeCouriers = async (cooperativeId: string) => {
  const { data, error } = await db.from('couriers').select(COLUMNAS_MOTORIZADO)
    .eq('cooperative_id', cooperativeId).order('created_at', { ascending: true })
  if (error) throw fallo(error)
  return data || []
}

const createCooperativeCourier = async (cooperativeId: string, input: {
  phone: string; email: string; name: string; vehicle: string; idNumber: string; plate: string; licenseNumber?: string | null
}) => {
  // La ciudad la pone la base: la de su cooperativa, siempre.
  const { data, error } = await db.from('couriers').insert({
    cooperative_id: cooperativeId,
    phone: input.phone,
    email: input.email,
    name: input.name,
    vehicle: input.vehicle,
    id_number: input.idNumber,
    plate: input.plate,
    license_number: input.licenseNumber ?? null,
  }).select(COLUMNAS_MOTORIZADO).single()
  if (error) throw fallo(error)
  return data
}

/** `true` si era de ESTA cooperativa y se cambió; `false` si no es suyo. */
const setCooperativeCourierActive = async (cooperativeId: string, courierId: string, active: boolean): Promise<boolean> => {
  const { data, error } = await db.from('couriers')
    .update({ active, ...(active ? {} : { available: false }), updated_at: new Date().toISOString() })
    .eq('id', courierId).eq('cooperative_id', cooperativeId)
    .select('id')
  if (error) throw fallo(error)
  return (data || []).length > 0
}

/** Los ids de sus motorizados: todo lo demás se filtra por ellos. */
const idsDeLaCooperativa = async (cooperativeId: string): Promise<string[]> => {
  const { data, error } = await db.from('couriers').select('id').eq('cooperative_id', cooperativeId)
  if (error) throw fallo(error)
  return (data || []).map(f => f.id)
}

// ── Sus carreras y sus problemas ───────────────────────────────────────────

/** Las semanas ya cerradas de sus motorizados, de la más nueva a la más vieja. */
const cooperativeWeeks = async (cooperativeId: string): Promise<string[]> => {
  const ids = await idsDeLaCooperativa(cooperativeId)
  if (!ids.length) return []
  const { data, error } = await db.from('courier_settlements').select('period_start')
    .in('courier_id', ids).order('period_start', { ascending: false }).limit(500)
  if (error) throw fallo(error)
  return [...new Set((data || []).map(f => f.period_start))].slice(0, 26)
}

/** La liquidación de cada uno de sus motorizados en una semana ya cerrada. */
const cooperativeWeek = async (cooperativeId: string, weekStart: string) => {
  const ids = await idsDeLaCooperativa(cooperativeId)
  if (!ids.length) return []
  const { data, error } = await db.from('courier_settlements')
    .select('courier_id, period_start, period_end, orders_count, derecho_cents, en_mano_cents, arrastre_cents, neto_cents, status, paid_at, couriers(name, phone)')
    .in('courier_id', ids).eq('period_start', weekStart)
  if (error) throw fallo(error)
  return data || []
}

/** Las carreras retenidas de sus motorizados (se cayó la comida), con su motivo. */
const cooperativeRetainedRuns = async (cooperativeId: string) => {
  const ids = await idsDeLaCooperativa(cooperativeId)
  if (!ids.length) return []
  const { data, error } = await db.from('order_ledger')
    .select('order_id, courier_id, sold_at, reparto_cents, retenido_motivo, courier_settlement_id, orders!order_ledger_order_fk(order_number), businesses(name)')
    .in('courier_id', ids).eq('kind', 'venta').eq('retenido', true)
    .order('sold_at', { ascending: false }).limit(100)
  if (error) throw fallo(error)
  return data || []
}

export {
  listCooperatives, getCooperative, createCooperative, deleteCooperative, setCooperativeActive,
  createCooperativeUser, setCooperativeUserPassword, getCooperativeUserByEmail, getCooperativeUserById,
  listCooperativeCouriers, createCooperativeCourier, setCooperativeCourierActive,
  cooperativeWeeks, cooperativeWeek, cooperativeRetainedRuns,
}
