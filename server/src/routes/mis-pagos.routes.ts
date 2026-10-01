import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { getClientBusinessId } from '../lib/request'

// ═══════════════════════════════════════════════════════════════════════════
// MIS PAGOS (PANEL DEL DUEÑO): LO QUE UMBANI LE DEPOSITA, Y POR QUÉ
// ═══════════════════════════════════════════════════════════════════════════
//
// Como el «Estado de cuenta» de las grandes: la semana en curso, cada pedido
// con su parte, y el historial de depósitos.
//
// ⚠️ SOLO EL DUEÑO: son los depósitos a su cuenta bancaria. Y el negocio sale
// del JWT, nunca de la petición.
//
// ⚠️ Se le enseña su parte y la comisión de Umbani, NUNCA lo que Umbani le
// paga a PayPhone: ese es costo de Umbani y no cambia nada de lo suyo.

interface ModuloAuth { authClient: RequestHandler; requireOwner: RequestHandler }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const db = require('../db') as typeof import('../db')

const router = createRouter()

router.get('/api/client/mis-pagos', auth.authClient, auth.requireOwner, async (req, res) => {
  const businessId = getClientBusinessId(req)
  const [saldos, pedidos, depositos, negocio] = await Promise.all([
    db.getSettlementBalances(businessId),
    db.listLedger(businessId, { soloSinLiquidar: true, limite: 200 }),
    db.listSettlements({ businessId, limite: 52 }),
    db.getBusinessById(businessId),
  ])
  const s = saldos[0]
  return res.json({
    // Local de demostración (2026-09-30): los montos son de prueba.
    demo: Boolean(negocio?.is_demo),
    semana: {
      pedidos: s?.pedidos ?? 0,
      pedidosTarjeta: s?.pedidos_tarjeta ?? 0,
      tuyoCents: s?.derecho_cents ?? 0,
      yaCobrasteCents: s?.en_mano_cents ?? 0,
      deAntesCents: s?.arrastre_cents ?? 0,
      comisionCents: s?.umbani_cents ?? 0,
      netoCents: s?.neto_cents ?? 0,
    },
    pedidos: pedidos.map(p => ({
      numero: p.orders?.order_number ?? null,
      fecha: p.sold_at,
      tipo: p.kind,
      metodo: p.payment_method,
      totalCents: p.total_cents,
      tuyoCents: p.local_cents + (p.reparto_para === 'local' ? p.reparto_cents : 0),
      comisionCents: p.umbani_cents,
      cobro: p.en_mano === 'local' ? 'tu' : 'umbani',
    })),
    depositos: depositos.map(d => ({
      id: d.id,
      desde: d.period_start,
      hasta: d.period_end,
      pedidos: d.orders_count,
      tuyoCents: d.derecho_cents,
      yaCobrasteCents: d.en_mano_cents,
      deAntesCents: d.arrastre_cents,
      cuotaCents: d.cuota_cents,
      netoCents: d.neto_cents,
      estado: d.status,
      pagadoEl: d.paid_at,
      referencia: d.reference,
    })),
  })
})

export = router
