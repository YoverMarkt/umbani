import { request } from './api'

// ═══════════════════════════════════════════════════════════════════════════
// «¿LLEGÓ TODO BIEN?» (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// El cliente dice «Todo bien» o reporta qué faltó, qué vino mal o que no
// llegó. ⚠️ Aparte de `lib/api.ts`: solo lo carga «Mi cuenta», que viaja en
// su propio trozo; la primera carga de la tienda no paga por esto.
// Lo que le corresponde lo calcula el SERVIDOR: aquí no se suma nada.

export type TipoDeReclamo = 'falta_producto' | 'vino_mal' | 'no_llego'

export const confirmarTodoBien = (slug: string, orderId: string) =>
  request<{ ok: true }>(`/${slug}/orders/${encodeURIComponent(orderId)}/todo-bien`, { method: 'POST' })

export const reportarProblema = (slug: string, orderId: string, datos: {
  tipo: TipoDeReclamo
  lineas: { item: string; cantidad: number }[]
  nota: string
}) => request<{ ok: true; sugeridoCents: number }>(
  `/${slug}/orders/${encodeURIComponent(orderId)}/reclamo`, { method: 'POST', body: datos },
)
