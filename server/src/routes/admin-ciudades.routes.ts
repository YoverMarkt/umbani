import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// CIUDADES (SUPERADMIN, 2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Dónde atiende Umbani. Se crean y se apagan aquí; un local sin ciudad no
// aparece a ningún cliente, y el motorizado de Umbani solo ve los pedidos de
// la suya. ⚠️ No se borran: apagar una ciudad la quita del chat y de la app
// sin perder a qué ciudad pertenecía cada local y cada cliente.

interface ModuloAuth { authAdmin: RequestHandler }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const db = require('../db') as typeof import('../db')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const router = createRouter()

router.get('/api/admin/ciudades', auth.authAdmin, async (_req, res) => {
  return res.json({ ciudades: await db.listCities() })
})

router.post('/api/admin/ciudades', auth.authAdmin, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const nombre = String(body.nombre || '').trim().replace(/\s+/g, ' ')
  const provincia = String(body.provincia || '').trim() || null
  if (nombre.length < 2 || nombre.length > 60) return res.status(400).json({ error: 'Escribe el nombre de la ciudad' })
  if (provincia && provincia.length > 60) return res.status(400).json({ error: 'Provincia no válida' })
  try {
    const creada = await db.createCity({ name: nombre, province: provincia })
    return res.status(201).json(creada)
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'Esa ciudad ya existe' })
    throw error
  }
})

router.put('/api/admin/ciudades/:id/activa', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(400).json({ error: 'Ciudad no válida' })
  const activa = (req.body as Record<string, unknown> | undefined)?.activa === true
  if (!(await db.setCityActive(id, activa))) return res.status(404).json({ error: 'No encontramos esa ciudad' })
  return res.json({ activa })
})

export = router
