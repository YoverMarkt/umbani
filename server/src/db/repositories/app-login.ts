import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LOS CÓDIGOS DE INICIO DE SESIÓN DE LAS APPS
//
// Cada paso es UNA sentencia condicional: dos mensajes a la vez, o la app
// preguntando dos veces, no pueden verificar ni consumir el mismo código dos
// veces. Ver `migration-2026-09-28-login-con-whatsapp.sql`.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

/** Guarda un código nuevo. Devuelve false si chocó con uno existente. */
const createAppLoginCode = async (code: string, expiresAt: Date): Promise<boolean> => {
  const { error } = await db.from('app_login_codes').insert({ code, expires_at: expiresAt.toISOString() })
  if (!error) return true
  if (error.code === '23505') return false
  throw new Error(error.message)
}

/** El bot lo verifica con el REMITENTE de WhatsApp. Solo una vez y en plazo. */
const verifyAppLoginCode = async (code: string, phone: string): Promise<boolean> => {
  const { data, error } = await db
    .from('app_login_codes')
    .update({ phone, verified_at: new Date().toISOString() })
    .eq('code', code)
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('id')
  if (error) throw new Error(error.message)
  return (data || []).length > 0
}

/** La app lo canjea por su sesión. Devuelve el teléfono, o por qué no. */
const consumeAppLoginCode = async (code: string): Promise<{ estado: 'ok'; phone: string } | { estado: 'pendiente' | 'invalido' }> => {
  const { data, error } = await db
    .from('app_login_codes')
    .update({ used_at: new Date().toISOString() })
    .eq('code', code)
    .not('verified_at', 'is', null)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .select('phone')
  if (error) throw new Error(error.message)
  const fila = (data || [])[0]
  if (fila?.phone) return { estado: 'ok', phone: fila.phone }
  // ¿Existe, en plazo y sin verificar todavía? Entonces la app sigue esperando.
  const { data: vivo } = await db
    .from('app_login_codes')
    .select('id')
    .eq('code', code)
    .is('verified_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  return { estado: vivo ? 'pendiente' : 'invalido' }
}

/**
 * «CERRAR SESIÓN» desde WhatsApp (2026-09-29): las sesiones de la app de este
 * cliente emitidas hasta ahora dejan de valer. Ver
 * `migration-2026-09-29-cerrar-sesion-de-la-app.sql`.
 */
const cerrarSesionesDeLaApp = async (customerId: string): Promise<void> => {
  const { error } = await db
    .from('customers')
    .update({ app_sessions_valid_after: new Date().toISOString() })
    .eq('id', customerId)
  if (error) throw new Error(error.message)
}

/**
 * Desde cuándo valen las sesiones de la app de este teléfono. `null`: nunca
 * se cerraron, valen todas. ⚠️ LANZA si la base no responde: `authApp` falla
 * CERRADO, porque una sesión cerrada que vuelve a abrir cuando la base va lenta
 * no está cerrada.
 */
const sesionesDeLaAppValidasDesde = async (phone: string): Promise<string | null> => {
  const digitos = String(phone || '').replace(/\D/g, '')
  if (!digitos) return null
  const { data, error } = await db
    .from('customers')
    .select('app_sessions_valid_after')
    .eq('phone', digitos)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data?.app_sessions_valid_after ?? null
}

export {
  createAppLoginCode,
  verifyAppLoginCode,
  consumeAppLoginCode,
  cerrarSesionesDeLaApp,
  sesionesDeLaAppValidasDesde,
}
