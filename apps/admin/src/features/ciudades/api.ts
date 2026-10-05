import { api } from '../../api/client'

/** Una ciudad donde atiende Umbani (2026-10-05). */
export type Ciudad = {
  id: string
  name: string
  province: string | null
  active: boolean
  sort: number
}

// Una respuesta sin lista cuenta como «ninguna»: la ficha del local no puede
// caerse por no saber las ciudades (lo cazó el E2E).
export const getCiudades = () => api<{ ciudades?: Ciudad[] }>('/api/admin/ciudades').then(r => r?.ciudades ?? [])

export const crearCiudad = (nombre: string, provincia: string) =>
  api<Ciudad>('/api/admin/ciudades', { method: 'POST', body: JSON.stringify({ nombre, provincia }) })

export const activarCiudad = (id: string, activa: boolean) =>
  api<{ activa: boolean }>(`/api/admin/ciudades/${id}/activa`, { method: 'PUT', body: JSON.stringify({ activa }) })
