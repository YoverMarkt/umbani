import { api } from '../../api/client'

/** Una ciudad donde atiende Umbani (2026-10-05). */
export type Ciudad = {
  id: string
  name: string
  province: string | null
  active: boolean
  sort: number
  /** Centro y radio de cobertura (2026-10-05). */
  latitude: number | null
  longitude: number | null
  radius_km: number
}

/** Un punto desde donde se abrió la app fuera de toda ciudad (redondeado a ~1 km). */
export type PuntoSinCobertura = {
  lat_aprox: number; lng_aprox: number; ciudad_cercana: string | null; km: number | null; personas: number; ultima: string
}

// Una respuesta sin lista cuenta como «ninguna»: la ficha del local no puede
// caerse por no saber las ciudades (lo cazó el E2E).
export const getCiudades = () => api<{ ciudades?: Ciudad[] }>('/api/admin/ciudades').then(r => r?.ciudades ?? [])

export const crearCiudad = (nombre: string, provincia: string) =>
  api<Ciudad>('/api/admin/ciudades', { method: 'POST', body: JSON.stringify({ nombre, provincia }) })

export const activarCiudad = (id: string, activa: boolean) =>
  api<{ activa: boolean }>(`/api/admin/ciudades/${id}/activa`, { method: 'PUT', body: JSON.stringify({ activa }) })

export const guardarArea = (id: string, area: { latitud: number; longitud: number; radioKm: number }) =>
  api(`/api/admin/ciudades/${id}`, { method: 'PUT', body: JSON.stringify(area) })

export const getSinCobertura = (dias = 30) =>
  api<{ puntos?: PuntoSinCobertura[] }>(`/api/admin/ciudades/sin-cobertura?dias=${dias}`).then(r => r?.puntos ?? [])
