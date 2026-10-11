import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { createRouter } from '../middleware/async'

// El alta MANUAL de ventas se retiró el 2026-08-02: hoy toda venta nace de un
// pedido entregado, una cita atendida o una estadía confirmada, y la crea
// PostgreSQL. Lo que queda aquí solo LEE. Con ella se fueron `WriteResult`,
// `SaleInputItem`, `NormalizedSaleItem`, `SaleRecord` y `SaleValidationError`,
// que describían la escritura y ya no los nombra nadie.

interface ProductRecord {
  id: string
  name: string
  price: unknown
  price_sale?: unknown
  stock?: string | null
}

interface SessionRecord {
  contact_name?: unknown
}

interface OrderItemRecord {
  product_id?: unknown
  product_name?: unknown
  unit_price?: unknown
  quantity?: unknown
}

interface OrderRecord {
  contact_phone?: unknown
  status?: unknown
  order_items?: OrderItemRecord[]
}

interface DatabaseResult {
  error?: { message?: string } | null
}

const db: {
  getProducts(businessId: string): Promise<ProductRecord[]>
  getSession(businessId: string, phone: string): Promise<SessionRecord | null>
  getOrders(businessId: string, limit: number): Promise<OrderRecord[]>
  upsertSession(
    businessId: string,
    phone: string,
    data: { unread_owner: false },
  ): Promise<unknown>
  voidSale(businessId: string, saleId: string): Promise<DatabaseResult>
  getSalesByContact(businessId: string, phone: string): Promise<unknown>
} = require('../db') as typeof import('../db')
const auth: {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
} = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()
const canManageSales = auth.requirePermission('ventas')

// ⚠️ Aquí vivían el alta manual de ventas y su cotización. Se retiraron el
// 2026-08-02: toda venta nace ahora de un pedido entregado, de un pedido de
// mostrador o de una cita atendida. Un solo camino hasta el reporte, en vez de
// dos formas distintas de anotar dinero que había que mantener en paralelo.
//
// Lo que queda: consultar el historial de un contacto y anular una venta.

router.post(
  '/api/client/sales/:id/void',
  auth.authClient,
    canManageSales,
    async (req, res) => {
    try {
      const { error } = await db.voidSale(getClientBusinessId(req), req.params.id)
      // ⚠️ Un pedido de la APP ya entregado solo lo anula Umbani (2026-10-11):
      // lo exige la base (`sales_anular_solo_umbani`). Antes, anularlo aquí le
      // ahorraba al local la comisión, sin dejar rastro.
      if (error && (error as { code?: string }).code === '42501') {
        return res.status(403).json({
          error: 'Este pedido es de la app: solo Umbani puede anularlo. Si hubo un problema, escríbenos.',
        })
      }
      if (error) {
        console.error('❌ anular venta:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo anular la venta' })
      }
      res.json({ ok: true })
    } catch (error) {
      console.error(
        '❌ anular venta:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      res.status(500).json({ error: 'No se pudo anular la venta' })
    }
  },
)

router.get('/api/client/sales', auth.authClient, canManageSales, async (req, res) => {
  const phone = req.query.phone ? decodeURIComponent(String(req.query.phone)) : null
  if (!phone) return res.json([])
  res.json(await db.getSalesByContact(getClientBusinessId(req), phone))
})

export = router
