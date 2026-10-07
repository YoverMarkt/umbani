import { api } from '../../api/client'

/** Un motorizado de la cooperativa. Los importes, en centavos, del servidor. */
export type Repartidor = {
  id: string
  nombre: string
  telefono: string
  vehiculo: string | null
  placa: string | null
  cedula: string | null
  licencia: string | null
  activo: boolean
  disponible: boolean
  topeEfectivoCents: number
  efectivoEncimaCents: number
}

export type NuevoRepartidor = { nombre: string; telefono: string; correo: string; vehiculo: string; cedula: string; placa: string; licencia: string }

export const getRepartidores = () =>
  api<{ repartidores?: Repartidor[] }>('/api/cooperativa/repartidores').then(r => r?.repartidores ?? [])

export const crearRepartidor = (datos: NuevoRepartidor) =>
  api<{ id: string }>('/api/cooperativa/repartidores', { method: 'POST', body: JSON.stringify(datos) })

export const activarRepartidor = (id: string, activo: boolean) =>
  api<{ activo: boolean }>(`/api/cooperativa/repartidores/${id}/activo`, { method: 'PUT', body: JSON.stringify({ activo }) })
