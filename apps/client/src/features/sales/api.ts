// ── API de Ventas (tipada) ───────────────────────────────────────────
// Mismos endpoints que el panel viejo (routes/sales.routes.js y
// routes/orders.routes.js). El TOTAL oficial siempre lo calcula el
// servidor; lo que se muestra aquí es informativo con centavos exactos.
import { api } from '../../api/client'

export type SaleItem = {
  product_id: string | null
  product_name: string
  quantity: number
  unit_price: number
  line_total: number
}

export type Sale = {
  id: string
  contact_phone: string | null
  contact_name: string | null
  total: number | string
  status: 'completada' | 'anulada'
  /**
   * De dónde salió: `tienda` (la app), `mostrador`, `manual`… Las de la app ya
   * entregadas solo las anula Umbani (2026-10-11).
   */
  source?: string | null
  sold_at: string
  sale_items?: SaleItem[]
  items?: SaleItem[]
}

// `registerSale` (POST /api/client/sales) y `getQuote`
// (GET /api/client/sessions/:phone/quote) vivían aquí para el alta manual de
// ventas. Esa alta se retiró el 2026-08-02 junto con sus rutas, pero las dos
// funciones se quedaron llamando a endpoints que ya no existen —y sin que
// ninguna pantalla las usara. Las encontró el test de contrato.

export const getSalesByPhone = (phone: string) =>
  api<Sale[]>(`/api/client/sales?phone=${encodeURIComponent(phone)}`)

export const voidSale = (id: string) =>
  api(`/api/client/sales/${id}/void`, { method: 'POST' })

export const getProducts = () =>
  api<{ id: string; name: string; price: string | number; price_sale: string | number | null }[]>('/api/client/products')

// Redondeo seguro a centavos (idéntico criterio que money.js del server)
export const cents = (v: number) => Math.round((v + Number.EPSILON) * 100) / 100
export const money = (n: number | string) => `$${(Number(n) || 0).toFixed(2)}`
