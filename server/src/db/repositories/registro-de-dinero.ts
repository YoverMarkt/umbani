import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// EL REGISTRO DE QUIÉN MUEVE DINERO — solo LECTURA
//
// Lo ESCRIBE la base, con disparadores en cada tabla de dinero
// (`migration-2026-09-29-registro-de-dinero.sql`), y quién lo hizo llega en la
// cabecera que pone `lib/actor-de-la-peticion.ts`. Aquí no hay ninguna función
// que escriba, y es a propósito: el registro que se puede escribir desde el
// código se puede escribir mal.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

export type MovimientoDeDinero = Database['public']['Tables']['money_audit_log']['Row']

/** Lo último que movió dinero, de toda la plataforma o de un local. */
const getMoneyAuditLog = async (opciones: {
  limite?: number
  businessId?: string | null
  antesDe?: number | null
} = {}): Promise<MovimientoDeDinero[]> => {
  const { data, error } = await db.rpc('money_audit_log_recent', {
    p_limite: opciones.limite ?? 200,
    p_business_id: opciones.businessId ?? undefined,
    p_antes_de: opciones.antesDe ?? undefined,
  })
  if (error) throw new Error(error.message)
  return data ?? []
}

export { getMoneyAuditLog }
