import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// ═══════════════════════════════════════════════════════════════════════════
// LAS CIUDADES DONDE ATIENDE UMBANI (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Son de la plataforma, como `customers` y `couriers`: no llevan `business_id`.
// Las crea y las apaga el superadmin. Un local sin ciudad no aparece a ningún
// cliente; el motorizado de Umbani solo ve pedidos de la suya.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

export interface Ciudad {
  id: string
  name: string
  province: string | null
  active: boolean
  sort: number
}

const COLUMNAS = 'id, name, province, active, sort'

/** Todas, también las apagadas: es la lista del superadmin. */
const listCities = async (): Promise<Ciudad[]> => {
  const { data, error } = await db.from('cities').select(COLUMNAS)
    .order('sort', { ascending: true }).order('name', { ascending: true })
  if (error) throw new Error(error.message)
  return (data || []) as Ciudad[]
}

const getCity = async (id: string): Promise<Ciudad | null> => {
  const { data, error } = await db.from('cities').select(COLUMNAS).eq('id', id).maybeSingle()
  if (error) throw new Error(error.message)
  return (data as Ciudad | null) ?? null
}

/** Un nombre repetido (sin distinguir mayúsculas) lo rechaza la base: 23505. */
const createCity = async (input: { name: string; province?: string | null; sort?: number }): Promise<Ciudad> => {
  const { data, error } = await db.from('cities').insert({
    name: input.name,
    province: input.province ?? null,
    sort: input.sort ?? 0,
  }).select(COLUMNAS).single()
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return data as Ciudad
}

const setCityActive = async (id: string, active: boolean): Promise<boolean> => {
  const { data, error } = await db.from('cities').update({ active }).eq('id', id).select('id')
  if (error) throw new Error(error.message)
  return Boolean(data?.length)
}

/**
 * La ciudad que eligió el cliente. Solo se guarda cuando ÉL la elige: con una
 * sola ciudad con locales no se le pregunta ni se le anota, para que el día
 * que abra otra se le pregunte.
 */
const setCustomerCity = async (customerId: string, cityId: string): Promise<void> => {
  const { error } = await db.from('customers').update({ city_id: cityId }).eq('id', customerId)
  if (error) throw new Error(error.message)
}

export { listCities, getCity, createCity, setCityActive, setCustomerCity }
