import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// PAGOS (SUPERADMIN): COBROS CON TARJETA, SALDOS Y LIQUIDACIONES
// ═══════════════════════════════════════════════════════════════════════════
//
// Solo lee y marca. Ningún importe se calcula aquí: el libro, los saldos y el
// cierre semanal viven en PostgreSQL. Lo único que escribe es «pagada» o
// «cobrada», con la referencia de la transferencia.

interface ModuloAuth { authAdmin: RequestHandler }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const db = require('../db') as typeof import('../db')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const router = createRouter()

router.get('/api/admin/pagos', auth.authAdmin, async (_req, res) => {
  const [saldos, liquidaciones, cobros, cuadre, demos] = await Promise.all([
    db.getSettlementBalances(null),
    db.listSettlements({ limite: 100 }),
    db.listCardPayments(100),
    // El último cuadre contra PayPhone (2026-09-29). Si no se puede leer, la
    // pantalla sigue: el cuadre es un dato más, no la condición para ver pagos.
    db.leerUltimoCuadre().catch(() => null),
    // Los locales de demostración (2026-09-30): se marcan, no se esconden.
    db.getDemoBusinessIds(),
  ])
  const conDemo = <T extends { business_id: string }>(filas: T[]) => (
    filas.map(f => ({ ...f, demo: demos.has(f.business_id) }))
  )

  // A quién hay que transferirle: la cuenta ACTIVA de cada local con saldo a
  // su favor, leída por la única función que lee esa tabla
  // (`la-cuenta-del-panel-manda.test.js`).
  const porPagar = new Set<string>()
  for (const s of saldos) if (s.neto_cents > 0) porPagar.add(s.business_id)
  for (const l of liquidaciones) if (l.status === 'por_pagar') porPagar.add(l.business_id)
  const cuentas: Record<string, unknown> = {}
  await Promise.all([...porPagar].map(async (id) => {
    cuentas[id] = await db.getBusinessBankAccount(id).catch(() => null)
  }))

  return res.json({
    saldos: conDemo(saldos),
    liquidaciones: conDemo(liquidaciones),
    cobros: conDemo(cobros),
    cuentas,
    cuadre,
  })
})

router.post('/api/admin/pagos/liquidaciones/:id/marcar', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(400).json({ error: 'Liquidación no válida' })
  const referencia = String((req.body as Record<string, unknown> | undefined)?.referencia || '').trim()
  if (referencia.length < 3 || referencia.length > 120) {
    return res.status(400).json({ error: 'Escribe la referencia de la transferencia' })
  }
  const r = await db.markSettlementPaid(id, referencia)
  // La base no deja pagar un local de demostración (2026-09-30).
  if (r.result === 'demo') {
    return res.status(409).json({ error: 'Es un local de demostración: su dinero es de prueba y su liquidación no se paga' })
  }
  if (r.result !== 'updated') return res.status(409).json({ error: 'Esa liquidación ya no está pendiente' })
  return res.json({ status: r.status })
})

// ── El registro de quién mueve dinero (2026-09-29) ──────────────────────────
//
// Solo lectura: lo escribe la base. `antes` pagina hacia atrás por id, y
// `negocio` lo acota a un local.
router.get('/api/admin/pagos/registro', auth.authAdmin, async (req, res) => {
  const negocio = typeof req.query.negocio === 'string' && UUID.test(req.query.negocio)
    ? req.query.negocio
    : null
  const antes = Number(req.query.antes)
  const movimientos = await db.getMoneyAuditLog({
    limite: 200,
    businessId: negocio,
    antesDe: Number.isSafeInteger(antes) && antes > 0 ? antes : null,
  })
  return res.json({ movimientos })
})

export = router
