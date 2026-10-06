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
  /** Centro y radio de cobertura (2026-10-05): de ahí sale la ciudad del cliente por su GPS. */
  latitude: number | null
  longitude: number | null
  radius_km: number
}

const COLUMNAS = 'id, name, province, active, sort, latitude, longitude, radius_km'

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

/** Centro y radio. La base comprueba los rangos (`cities_centro_check`). */
const updateCityArea = async (id: string, area: { latitude: number; longitude: number; radius_km: number }): Promise<boolean> => {
  const { data, error } = await db.from('cities').update(area).eq('id', id).select('id')
  if (error) throw Object.assign(new Error(error.message), { code: error.code })
  return Boolean(data?.length)
}

export interface CiudadDelPunto { id: string; name: string; km: number; dentro: boolean }

/**
 * La ciudad activa más cercana a un punto y si cae dentro de su radio. `null`
 * si no hay ninguna ciudad con centro.
 */
const cityAt = async (lat: number, lng: number): Promise<CiudadDelPunto | null> => {
  const { data, error } = await db.rpc('ciudad_de_la_ubicacion', { p_lat: lat, p_lng: lng })
  if (error) throw new Error(error.message)
  const fila = (data as CiudadDelPunto[] | null)?.[0]
  return fila ? { ...fila, km: Number(fila.km) } : null
}

/**
 * Quien abre la app fuera de toda ciudad. La base lo redondea a ~1 km y lo
 * cuenta una vez por día, celda y dispositivo (que llega ya resumido).
 */
const recordCoverageRequest = async (lat: number, lng: number, deviceHash: string): Promise<void> => {
  const { error } = await db.rpc('registrar_sin_cobertura', { p_lat: lat, p_lng: lng, p_dispositivo: deviceHash })
  if (error) throw new Error(error.message)
}

export interface CoberturaPedida {
  lat_aprox: number; lng_aprox: number; ciudad_cercana: string | null; km: number | null; personas: number; ultima: string
}

/** Dónde se pide desde fuera, de más a menos personas (superadmin). */
const coverageRequests = async (dias = 30): Promise<CoberturaPedida[]> => {
  const { data, error } = await db.rpc('cobertura_pedida', { p_dias: dias })
  if (error) throw new Error(error.message)
  return ((data || []) as CoberturaPedida[]).map(f => ({ ...f, personas: Number(f.personas) }))
}

export {
  listCities, getCity, createCity, setCityActive, setCustomerCity,
  updateCityArea, cityAt, recordCoverageRequest, coverageRequests,
}
