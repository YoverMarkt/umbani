import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// EL SEGUNDO PASO DEL SUPERADMIN: SU CLAVE DE CÓDIGOS
//
// Vive en `server_settings`, pero FUERA de `ALLOWED_KEYS` (`services/settings.ts`)
// y a propósito: esa lista es la que lee y escribe la pantalla de Ajustes del
// superadmin. Con la clave dentro, cualquiera con una sesión abierta podría
// leerla o pisarla desde el panel —el segundo paso protegiéndose con el
// primero—. Aquí solo la tocan el login y el script de reinicio.
//
// ⚠️ Separada de la contraseña a propósito: la contraseña vive en Railway
// (`ADMIN_PASSWORD`) y la clave en la base. Quien se lleve una sola de las dos
// no entra.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

const CLAVE = 'admin_totp_secret'
const PENDIENTE = 'admin_totp_pending'
const ULTIMO_PASO = 'admin_totp_last_step'

export interface SegundoPasoDelAdmin {
  /** La clave activa. `null`: todavía no configuró su app de códigos. */
  clave: string | null
  /** La que se está configurando, y desde cuándo. */
  pendiente: string | null
  pendienteDesde: string | null
  /** El último paso de 30 s que abrió la puerta: no se acepta dos veces. */
  ultimoPaso: number
}

/**
 * Lo que hay guardado. ⚠️ LANZA si la base no responde: quien llama tiene que
 * fallar CERRADO. Un segundo paso que se salta cuando la base va lenta no es
 * un segundo paso.
 */
const leerSegundoPasoDelAdmin = async (): Promise<SegundoPasoDelAdmin> => {
  const { data, error } = await db
    .from('server_settings')
    .select('key, value, updated_at')
    .in('key', [CLAVE, PENDIENTE, ULTIMO_PASO])
  if (error) throw new Error(error.message)
  const fila = (clave: string) => (data || []).find(f => f.key === clave)
  const ultimo = Number(fila(ULTIMO_PASO)?.value)
  return {
    clave: fila(CLAVE)?.value || null,
    pendiente: fila(PENDIENTE)?.value || null,
    pendienteDesde: fila(PENDIENTE)?.updated_at || null,
    ultimoPaso: Number.isSafeInteger(ultimo) ? ultimo : -1,
  }
}

const guardar = async (filas: { key: string; value: string | null }[]): Promise<void> => {
  const ahora = new Date().toISOString()
  const { error } = await db
    .from('server_settings')
    .upsert(filas.map(f => ({ ...f, updated_at: ahora })), { onConflict: 'key' })
  if (error) throw new Error(error.message)
}

/** Una clave nueva a medio configurar. Sustituye a la anterior pendiente. */
const guardarClavePendiente = async (clave: string): Promise<void> => {
  await guardar([{ key: PENDIENTE, value: clave }])
}

/**
 * La pendiente pasa a ser LA clave, y se apunta el paso con que se confirmó:
 * ese mismo código no puede volver a usarse para entrar.
 */
const activarClave = async (clave: string, paso: number): Promise<void> => {
  await guardar([
    { key: CLAVE, value: clave },
    { key: ULTIMO_PASO, value: String(paso) },
  ])
  const { error } = await db.from('server_settings').delete().eq('key', PENDIENTE)
  if (error) throw new Error(error.message)
}

/** El paso que acaba de abrir la puerta. */
const anotarPasoUsado = async (paso: number): Promise<void> => {
  await guardar([{ key: ULTIMO_PASO, value: String(paso) }])
}

export {
  leerSegundoPasoDelAdmin,
  guardarClavePendiente,
  activarClave,
  anotarPasoUsado,
}
