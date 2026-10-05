import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// MOTORIZADOS (SUPERADMIN): registrarlos, su semana y su liquidación
// ═══════════════════════════════════════════════════════════════════════════
//
// Las reglas del dinero viven en la base. Aquí se registran, se activan, se
// marca pagada/cobrada su liquidación y se retiene una carrera (se le cayó la
// comida: responde quien la dejó caer, el local cobra igual).

interface ModuloAuth { authAdmin: RequestHandler }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const db = require('../db') as typeof import('../db')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const router = createRouter()

router.get('/api/admin/motorizados', auth.authAdmin, async (_req, res) => {
  const [motorizados, liquidaciones] = await Promise.all([db.listCouriers(), db.listCourierSettlements(null, 100)])
  const conSemana = await Promise.all(motorizados.map(async m => ({ ...m, semana: await db.getCourierBalance(m.id).catch(() => null) })))
  return res.json({ motorizados: conSemana, liquidaciones })
})

router.post('/api/admin/motorizados', auth.authAdmin, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const phone = String(body.telefono || '').replace(/[^\d+]/g, '')
  const name = String(body.nombre || '').trim()
  const flota = String(body.flotaLocalId || '').trim()
  const tope = body.topeEfectivo == null || body.topeEfectivo === '' ? null : Math.round(Number(body.topeEfectivo) * 100)
  if (!/^\+?\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Teléfono no válido' })
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Escribe el nombre' })
  if (flota && !UUID.test(flota)) return res.status(400).json({ error: 'Local no válido' })
  if (tope != null && (!Number.isInteger(tope) || tope < 0 || tope > 100000)) return res.status(400).json({ error: 'Tope de efectivo no válido' })
  try {
    const creado = await db.createCourier({
      phone, name, vehicle: String(body.vehiculo || '').trim() || null,
      fleetBusinessId: flota || null, cashLimitCents: tope ?? undefined,
    })
    return res.status(201).json(creado)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'Ese teléfono ya es de un motorizado' })
    throw error
  }
})

router.put('/api/admin/motorizados/:id/activo', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(400).json({ error: 'Motorizado no válido' })
  const activo = (req.body as Record<string, unknown> | undefined)?.activo === true
  await db.setCourierActive(id, activo)
  return res.json({ activo })
})

router.post('/api/admin/motorizados/liquidaciones/:id/marcar', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  const referencia = String((req.body as Record<string, unknown> | undefined)?.referencia || '').trim()
  if (!UUID.test(id)) return res.status(400).json({ error: 'Liquidación no válida' })
  if (referencia.length < 3 || referencia.length > 120) return res.status(400).json({ error: 'Escribe la referencia' })
  const r = await db.markCourierSettlementPaid(id, referencia)
  if (r.result !== 'updated') return res.status(409).json({ error: 'Esa liquidación ya no está pendiente' })
  return res.json({ status: r.status })
})

// Las carreras sin liquidar de UN motorizado: de aquí se elige la que se
// retiene (2026-10-02). La retención la hace la base y queda en el registro
// de dinero con quién la hizo.
router.get('/api/admin/motorizados/:id/carreras', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(400).json({ error: 'Motorizado no válido' })
  return res.json({ carreras: await db.listCourierRuns(id) })
})

router.post('/api/admin/motorizados/retener', auth.authAdmin, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const pedido = String(body.pedidoId || '')
  const motivo = String(body.motivo || '').trim()
  if (!UUID.test(pedido)) return res.status(400).json({ error: 'Pedido no válido' })
  if (motivo.length < 3) return res.status(400).json({ error: 'Escribe el motivo' })
  const r = await db.retainCourierFee(pedido, motivo)
  if (r.result !== 'retenida') return res.status(409).json({ error: 'Ese pedido no tiene una carrera de motorizado por liquidar' })
  return res.json({ ok: true })
})

export = router
