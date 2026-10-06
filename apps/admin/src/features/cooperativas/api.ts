import { api } from '../../api/client'

/** Una cooperativa de reparto (2026-10-06): la tercera flota. */
export type Cooperativa = {
  id: string
  nombre: string
  ciudadId: string
  ciudad: string | null
  telefono: string | null
  activa: boolean
  /** Cuántos motorizados registró. */
  repartidores: number
  /** Quién entra a su panel `/cooperativa`. Nunca viaja la clave. */
  usuarios: { id: string; email: string; nombre: string | null; activo: boolean }[]
}

export type NuevaCooperativa = {
  nombre: string
  ciudadId: string
  telefono: string
  usuario: { email: string; clave: string; nombre: string }
}

// Una respuesta sin lista cuenta como «ninguna», como las ciudades: la ficha
// del local no puede caerse por no saberlas.
export const getCooperativas = () =>
  api<{ cooperativas?: Cooperativa[] }>('/api/admin/cooperativas').then(r => r?.cooperativas ?? [])

export const crearCooperativa = (datos: NuevaCooperativa) =>
  api<{ id: string }>('/api/admin/cooperativas', { method: 'POST', body: JSON.stringify(datos) })

export const activarCooperativa = (id: string, activa: boolean) =>
  api<{ activa: boolean }>(`/api/admin/cooperativas/${id}/activa`, { method: 'PUT', body: JSON.stringify({ activa }) })

export const crearAcceso = (id: string, datos: { email: string; clave: string; nombre: string }) =>
  api<{ id: string }>(`/api/admin/cooperativas/${id}/usuarios`, { method: 'POST', body: JSON.stringify(datos) })

export const darClaveNueva = (usuarioId: string, clave: string) =>
  api<{ ok: true }>(`/api/admin/cooperativas/usuarios/${usuarioId}/clave`, { method: 'PUT', body: JSON.stringify({ clave }) })
