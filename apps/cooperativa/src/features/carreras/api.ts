import { api } from '../../api/client'

/** La semana EN CURSO de un repartidor (lo aún sin liquidar), en centavos. */
export type FilaEnCurso = {
  id: string; nombre: string; telefono: string; pedidos: number
  carrerasCents: number; retenidasCents: number; efectivoCobradoCents: number; efectivoEncimaCents: number
}

/** Una semana CERRADA: la liquidación de cada uno, tal como la hizo Umbani. */
export type FilaCerrada = {
  id: string; nombre: string; telefono: string; desde: string; hasta: string; pedidos: number
  carrerasCents: number; efectivoCobradoCents: number; arrastreCents: number
  /** > 0: Umbani le paga · < 0: él entrega ese efectivo. */
  saldoCents: number
  estado: string; pagadaEl: string | null
}

export const getCarreras = () =>
  api<{ semanas?: string[]; enCurso?: FilaEnCurso[] }>('/api/cooperativa/carreras')
    .then(r => ({ semanas: r?.semanas ?? [], enCurso: r?.enCurso ?? [] }))

export const getSemana = (semana: string) =>
  api<{ filas?: FilaCerrada[] }>(`/api/cooperativa/carreras/semana/${semana}`).then(r => r?.filas ?? [])
