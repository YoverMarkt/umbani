// ── API de Pagos (routes/admin-pagos.routes.ts) ──────────────────────────
//
// Todo llega calculado en CENTAVOS por el servidor (el libro y el cierre
// semanal viven en PostgreSQL). Esta pantalla solo pinta.
import { api } from '../../api/client'

export type SaldoEnCurso = {
  business_id: string
  business_name: string
  pedidos: number
  pedidos_tarjeta: number
  derecho_cents: number
  en_mano_cents: number
  arrastre_cents: number
  neto_cents: number
  umbani_cents: number
  payphone_cents: number
  /** Local de demostración: su dinero es de prueba (2026-09-30). */
  demo?: boolean
}

export type Liquidacion = {
  id: string
  business_id: string
  period_start: string
  period_end: string
  orders_count: number
  derecho_cents: number
  en_mano_cents: number
  arrastre_cents: number
  cuota_cents: number
  neto_cents: number
  status: 'por_pagar' | 'por_cobrar' | 'en_cero' | 'pagada' | 'cobrada' | 'compensada'
  paid_at: string | null
  reference: string | null
  businesses?: { name: string } | null
  demo?: boolean
}

export type CobroConTarjeta = {
  id: string
  environment: 'pruebas' | 'produccion'
  status: string
  status_detail: string | null
  amount_cents: number
  captured_cents: number | null
  card_brand: string | null
  card_last_digits: string | null
  provider_transaction_id: string | null
  created_at: string
  /** El último cuadre contra PayPhone (2026-09-29). Nunca cambia el estado. */
  reconciled_at?: string | null
  reconciliation?: 'cuadra' | 'descuadre' | null
  reconciliation_detail?: string | null
  businesses?: { name: string } | null
  orders?: { order_number: number } | null
  demo?: boolean
}

/** El resumen del último cuadre diario contra PayPhone. */
export type ResumenDelCuadre = {
  fecha: string
  at: string
  revisados: number
  descuadres: number
  sinRespuesta: number
} | null

export type CuentaBancaria = {
  bank_name?: string | null
  account_type?: string | null
  account_number?: string | null
  holder_name?: string | null
  holder_id?: string | null
} | null

export type Pagos = {
  saldos: SaldoEnCurso[]
  liquidaciones: Liquidacion[]
  cobros: CobroConTarjeta[]
  cuentas: Record<string, CuentaBancaria>
  cuadre?: ResumenDelCuadre
}

export const getPagos = () => api<Pagos>('/api/admin/pagos')

export const marcarLiquidacion = (id: string, referencia: string) =>
  api<{ status: string }>(`/api/admin/pagos/liquidaciones/${id}/marcar`, {
    method: 'POST',
    body: JSON.stringify({ referencia }),
  })

// ── El registro de quién mueve dinero (2026-09-29) ──────────────────────────
//
// Lo escribe la base con disparadores; aquí solo se lee. `actor` es
// `superadmin:<correo>`, `local:<correo>`, `sistema`, `base` o `script:<qué>`.
export type MovimientoDeDinero = {
  id: number
  created_at: string
  actor: string
  business_id: string | null
  business_name: string | null
  action: string
  target_table: string
  target_id: string | null
  detail: Record<string, unknown>
}

export const getRegistro = (antes?: number) =>
  api<{ movimientos: MovimientoDeDinero[] }>(
    `/api/admin/pagos/registro${antes ? `?antes=${antes}` : ''}`,
  )
