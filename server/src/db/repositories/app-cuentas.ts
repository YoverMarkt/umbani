import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// ═══════════════════════════════════════════════════════════════════════════
// LAS CUENTAS DE LAS APPS: ENTRAR CON CORREO (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// La persona es la fila de `customers` (de la plataforma, sin `business_id`):
// la de WhatsApp se reconoce por su teléfono y la de las apps por su correo.
// Las reglas viven en `services/entrar-con-correo.ts`; aquí solo se piden, y
// cada paso que podría pisarse con otro es UNA sentencia condicional.
// Ver `migration-2026-10-06-entrar-con-correo.sql`.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

const UN_DIA_MS = 24 * 60 * 60 * 1000

// ── Los códigos ──────────────────────────────────────────────────────────────

/** Guarda la huella de un código nuevo y retira los de más de un día de ese correo. */
const guardarCodigoDeCorreo = async (email: string, codeHash: string, expiresAt: Date): Promise<void> => {
  // Sin tarea aparte: cada correo limpia lo suyo al pedir otro.
  await db.from('app_email_codes').delete().eq('email', email)
    .lt('created_at', new Date(Date.now() - UN_DIA_MS).toISOString())
  const { error } = await db.from('app_email_codes')
    .insert({ email, code_hash: codeHash, expires_at: expiresAt.toISOString() })
  if (error) throw new Error(error.message)
}

const contarCodigosDeCorreo = async (email: string, desde: Date): Promise<number> => {
  const { count, error } = await db.from('app_email_codes')
    .select('id', { count: 'exact', head: true })
    .eq('email', email).gte('created_at', desde.toISOString())
  if (error) throw new Error(error.message)
  return count ?? 0
}

/** El ÚLTIMO código pedido, si sigue vivo: los anteriores ya no valen. */
const codigoDeCorreoVigente = async (email: string) => {
  const { data, error } = await db.from('app_email_codes')
    .select('id,code_hash,attempts,used_at,expires_at')
    .eq('email', email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  if (!data || data.used_at || new Date(data.expires_at).getTime() <= Date.now()) return null
  return { id: data.id, code_hash: data.code_hash, attempts: data.attempts }
}

/** Gasta un intento solo si nadie lo gastó a la vez (mismo número de intentos). */
const gastarIntentoDeCodigoDeCorreo = async (id: string, intentosAntes: number): Promise<boolean> => {
  const { data, error } = await db.from('app_email_codes')
    .update({ attempts: intentosAntes + 1 })
    .eq('id', id).eq('attempts', intentosAntes).is('used_at', null)
    .select('id')
  if (error) throw new Error(error.message)
  return (data || []).length > 0
}

/** Un solo uso: dos canjes a la vez no pueden marcarlo los dos. */
const marcarCodigoDeCorreoUsado = async (id: string): Promise<boolean> => {
  const { data, error } = await db.from('app_email_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('id', id).is('used_at', null)
    .select('id')
  if (error) throw new Error(error.message)
  return (data || []).length > 0
}

// ── La cuenta ────────────────────────────────────────────────────────────────

export interface CuentaDeLaApp {
  id: string
  phone: string | null
  email: string | null
  city_id: string | null
}

const COLUMNAS = 'id,phone,email,city_id'

/** La persona de ese correo; si es la primera vez, nace (sin teléfono). */
const cuentaPorCorreo = async (email: string): Promise<CuentaDeLaApp> => {
  const buscar = async () => {
    const { data, error } = await db.from('customers').select(COLUMNAS).eq('email', email).maybeSingle()
    if (error) throw new Error(error.message)
    return data
  }
  const existente = await buscar()
  if (existente) return existente
  const { data, error } = await db.from('customers').insert({ email }).select(COLUMNAS).single()
  if (!error) return data
  // Dos peticiones a la vez la crearon: el índice único dejó pasar una.
  if (error.code === '23505') {
    const ganadora = await buscar()
    if (ganadora) return ganadora
  }
  throw new Error(error.message)
}

/**
 * Desde cuándo valen las sesiones de la app de este correo; `null`, todas.
 * ⚠️ LANZA si la base no responde: `authApp` falla CERRADO.
 */
const sesionesDeLaAppValidasDesdeCorreo = async (email: string): Promise<string | null> => {
  const { data, error } = await db.from('customers')
    .select('app_sessions_valid_after').eq('email', email).maybeSingle()
  if (error) throw new Error(error.message)
  return data?.app_sessions_valid_after ?? null
}

/**
 * La cuenta reclama SU teléfono, en exclusiva.
 *
 * ⚠️ De ese número cuelgan «Mis pedidos», los reclamos y la tienda
 * (`orders.contact_phone`), así que no puede ser de dos personas: si ya hay
 * alguien con él —de WhatsApp o de otra cuenta— o pedidos hechos con él, no
 * se le da. El índice único de `customers.phone` decide si dos cuentas lo
 * piden a la vez.
 */
const reclamarTelefono = async (cuentaId: string, telefono: string): Promise<'ok' | 'ocupado' | 'ya_tiene'> => {
  const persona = await db.from('customers').select('id').eq('phone', telefono).maybeSingle()
  if (persona.error) throw new Error(persona.error.message)
  if (persona.data) return persona.data.id === cuentaId ? 'ok' : 'ocupado'

  const pedidos = await db.from('orders').select('id', { count: 'exact', head: true })
    .in('contact_phone', [telefono, `+${telefono}`])
  if (pedidos.error) throw new Error(pedidos.error.message)
  if (pedidos.count) return 'ocupado'

  const { data, error } = await db.from('customers')
    .update({ phone: telefono, updated_at: new Date().toISOString() })
    .eq('id', cuentaId).is('phone', null)
    .select('id')
  if (error) {
    if (error.code === '23505') return 'ocupado'
    throw new Error(error.message)
  }
  return (data || []).length ? 'ok' : 'ya_tiene'
}

export {
  guardarCodigoDeCorreo,
  contarCodigosDeCorreo,
  codigoDeCorreoVigente,
  gastarIntentoDeCodigoDeCorreo,
  marcarCodigoDeCorreoUsado,
  cuentaPorCorreo,
  sesionesDeLaAppValidasDesdeCorreo,
  reclamarTelefono,
}
