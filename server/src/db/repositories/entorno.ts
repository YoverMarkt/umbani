import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LA MARCA DE LA BASE: ¿ES DE STAGING?
//
// La lee el candado del arranque (`config/identidad-de-la-base.ts`) para que
// un staging nunca corra contra producción ni al revés. Vive en
// `server_settings` pero FUERA de `ALLOWED_KEYS`: ninguna pantalla la escribe,
// solo la semilla del staging.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

const CLAVE = 'entorno'

/**
 * Lo que la base dice de sí misma: `'staging'`, o `null` si no dice nada (la
 * de producción no lleva marca). ⚠️ LANZA si la base no responde: decide
 * quien llama.
 */
const leerMarcaDeEntorno = async (): Promise<string | null> => {
  const { data, error } = await db.from('server_settings').select('value').eq('key', CLAVE).maybeSingle()
  if (error) throw new Error(error.message)
  return data?.value?.trim() || null
}

export { leerMarcaDeEntorno }
