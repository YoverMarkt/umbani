import { api } from '../../api/client'

/**
 * Una incidencia de un pedido (2026-10-06). Desde la fase 2 (2026-10-10) lo
 * que el cliente no recibió bien se le devuelve como saldo Umbani: al instante
 * si es pequeño (`compensada`, falta confirmar quién responde), o al resolver.
 */
export type Incidencia = {
  id: string
  tipo: TipoDeIncidencia
  origen: 'cliente' | 'superadmin'
  estado: 'abierta' | 'compensada' | 'resuelta' | 'descartada'
  responsable: Responsable | null
  lineas: { nombre: string; cantidad: number; centavos: number }[]
  nota: string | null
  /** Lo que calculó la base: lo que pagó el cliente por eso. */
  sugeridoCents: number
  compensacionCents: number | null
  resolucion: string | null
  resueltaPor: string | null
  creadaEn: string
  resueltaEn: string | null
  pedido: { id: string; numero: number | null; totalCents: number; pago: string | null; cliente: string | null; telefono: string | null }
  local: { id: string; nombre: string | null }
  repartidor: { nombre: string; cooperativa: string | null } | null
  /** El saldo se le dio por la regla, sin revisión. */
  alInstante: boolean
  saldoDadoEn: string | null
  /** De lo reportado: lo del local, la comisión de Umbani y la carrera. */
  reparto: { localCents: number | null; umbaniCents: number | null; carreraCents: number | null }
  /** La escalera del cliente al reportar: 1 normal, 2 en revisión, 3 sin saldo al instante. */
  escalon: number | null
  /** Por qué no salió al instante. Al cliente no se le dice. */
  motivos: string[]
  /** La foto del cliente, con un enlace que caduca solo. */
  fotoUrl: string | null
}

/** Por qué un reporte no salió al instante (2026-10-10). */
export const MOTIVOS: Record<string, string> = {
  no_llego: '«No llegó» siempre lo revisa una persona',
  sin_monto: 'No pagó (efectivo al recibir): no hay saldo que dar',
  tope: 'Pasa del tope para darlo al instante',
  al_instante_reciente: 'Ya recibió saldo al instante hace poco',
  sin_foto: '«Vino mal» sin foto',
  reportes_seguidos: 'Varios reportes en los últimos 90 días',
  proporcion: 'Reporta más de 1 de cada 5 pedidos',
  rechazo_reciente: 'Tuvo un reporte rechazado hace poco',
  rechazos: 'Escalón 3: dos o más reportes rechazados',
  sin_cuenta: 'No encontramos su cuenta',
}

export type TipoDeIncidencia = 'falta_producto' | 'vino_mal' | 'no_llego' | 'comida_caida' | 'cliente_ausente' | 'accidente' | 'no_aparecio' | 'otro'
export type Responsable = 'local' | 'repartidor' | 'cliente' | 'umbani'

export const TIPOS: Record<TipoDeIncidencia, string> = {
  falta_producto: 'Faltó un producto',
  vino_mal: 'Vino mal o era otro',
  no_llego: 'No llegó',
  comida_caida: 'Se cayó o se dañó la comida',
  cliente_ausente: 'El cliente no estaba',
  accidente: 'Accidente o robo',
  no_aparecio: 'El repartidor no apareció',
  otro: 'Otro',
}

export const RESPONSABLES: Record<Responsable, string> = {
  local: 'El local',
  repartidor: 'El repartidor (y su cooperativa)',
  cliente: 'El cliente',
  umbani: 'Umbani',
}

/** Quién responde normalmente, según la tabla aprobada por el dueño (2026-10-05). */
export const QUIEN_RESPONDE: Record<TipoDeIncidencia, Responsable> = {
  falta_producto: 'local',
  vino_mal: 'local',
  no_llego: 'repartidor',
  comida_caida: 'repartidor',
  cliente_ausente: 'cliente',
  accidente: 'umbani',
  no_aparecio: 'repartidor',
  otro: 'umbani',
}

export const getIncidencias = (estado: 'abierta' | 'todas') =>
  api<{ incidencias?: Incidencia[] }>(`/api/admin/incidencias?estado=${estado}`).then(r => r?.incidencias ?? [])

export const registrarIncidencia = (datos: { localId: string; numero: number; tipo: TipoDeIncidencia; nota: string }) =>
  api<{ id: string }>('/api/admin/incidencias', { method: 'POST', body: JSON.stringify(datos) })

export const resolverIncidencia = (id: string, datos: { estado: 'resuelta' | 'descartada'; responsable: Responsable | null; compensacionCents: number | null; nota: string }) =>
  api<{ ok: true; saldoCents?: number }>(`/api/admin/incidencias/${id}/resolver`, { method: 'POST', body: JSON.stringify(datos) })
