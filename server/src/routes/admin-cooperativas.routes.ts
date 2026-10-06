import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { telefonoDelRepartidor } from '../lib/telefono-del-repartidor'

// ═══════════════════════════════════════════════════════════════════════════
// COOPERATIVAS (SUPERADMIN, 2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// El superadmin da de alta cada cooperativa —con su ciudad y su primer acceso
// al panel `/cooperativa`—, la apaga o la enciende, y le da una clave nueva a
// quien la olvidó. Lo demás lo hace la cooperativa en su panel: registrar a
// sus motorizados, ver sus carreras y sus problemas.
//
// ⚠️ No se borran: apagar una cooperativa le corta el panel al momento y sus
// motorizados dejan de recibir pedidos nuevos (lo decide la base), sin perder
// su historia ni su dinero.

interface ModuloAuth { authAdmin: RequestHandler }
interface ModuloBcrypt { hash(valor: string, vueltas: number): Promise<string> }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const bcrypt: ModuloBcrypt = require('bcryptjs') as typeof import('bcryptjs')
const db = require('../db') as typeof import('../db')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CORREO = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const MINIMO_CLAVE = 12
const router = createRouter()

const correoDe = (valor: unknown) => String(valor ?? '').trim().toLowerCase()
const claveValida = (valor: unknown): valor is string => typeof valor === 'string' && valor.length >= MINIMO_CLAVE && valor.length <= 200
const ERROR_CLAVE = `La contraseña necesita al menos ${MINIMO_CLAVE} caracteres`

router.get('/api/admin/cooperativas', auth.authAdmin, async (_req, res) => {
  const filas = await db.listCooperatives()
  return res.json({
    cooperativas: filas.map(c => ({
      id: c.id,
      nombre: c.name,
      ciudadId: c.city_id,
      ciudad: c.cities?.name ?? null,
      telefono: c.contact_phone,
      activa: c.active,
      repartidores: Number(c.couriers?.[0]?.count) || 0,
      // Nunca la contraseña: ni su hash sale de la base para esto.
      usuarios: (c.cooperative_users || []).map(u => ({ id: u.id, email: u.email, nombre: u.name, activo: u.active })),
    })),
  })
})

router.post('/api/admin/cooperativas', auth.authAdmin, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const nombre = String(body.nombre ?? '').trim().replace(/\s+/g, ' ')
  const ciudadId = String(body.ciudadId ?? '').trim()
  const telefonoEscrito = String(body.telefono ?? '').trim()
  const telefono = telefonoEscrito ? telefonoDelRepartidor(telefonoEscrito) : null
  const usuario = (body.usuario || {}) as Record<string, unknown>
  const email = correoDe(usuario.email)
  const nombreUsuario = String(usuario.nombre ?? '').trim() || null

  if (nombre.length < 2 || nombre.length > 80) return res.status(400).json({ error: 'Escribe el nombre de la cooperativa' })
  if (telefonoEscrito && !telefono) return res.status(400).json({ error: 'El teléfono de contacto no es válido' })
  if (!CORREO.test(email)) return res.status(400).json({ error: 'Escribe el correo con el que entrará a su panel' })
  if (!claveValida(usuario.clave)) return res.status(400).json({ error: ERROR_CLAVE })
  if (nombreUsuario && (nombreUsuario.length < 2 || nombreUsuario.length > 80)) return res.status(400).json({ error: 'El nombre de la persona no es válido' })
  const ciudad = UUID.test(ciudadId) ? await db.getCity(ciudadId) : null
  if (!ciudad || !ciudad.active) return res.status(400).json({ error: 'Elige la ciudad donde reparte' })
  if (await db.getCooperativeUserByEmail(email)) return res.status(409).json({ error: 'Ese correo ya tiene acceso a una cooperativa' })

  let creada: { id: string }
  try {
    creada = await db.createCooperative({ name: nombre, cityId: ciudadId, contactPhone: telefono })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'Ya existe una cooperativa con ese nombre' })
    throw error
  }
  try {
    await db.createCooperativeUser({
      cooperativeId: creada.id, email, name: nombreUsuario, passwordHash: await bcrypt.hash(usuario.clave as string, 10),
    })
  } catch (error) {
    // Sin su acceso, la cooperativa no sirve: se deshace para no dejarla a medias.
    await db.deleteCooperative(creada.id).catch(e => console.error('❌ No se pudo deshacer la cooperativa a medias:', (e as Error).message))
    if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'Ese correo ya tiene acceso a una cooperativa' })
    throw error
  }
  return res.status(201).json({ id: creada.id, nombre })
})

router.put('/api/admin/cooperativas/:id/activa', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  const activa = (req.body as Record<string, unknown> | undefined)?.activa
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos esa cooperativa' })
  if (typeof activa !== 'boolean') return res.status(400).json({ error: 'Di si queda activa o no' })
  if (!await db.setCooperativeActive(id, activa)) return res.status(404).json({ error: 'No encontramos esa cooperativa' })
  return res.json({ activa })
})

/** Otra persona de la misma cooperativa con acceso a su panel. */
router.post('/api/admin/cooperativas/:id/usuarios', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  const body = (req.body || {}) as Record<string, unknown>
  const email = correoDe(body.email)
  const nombre = String(body.nombre ?? '').trim() || null
  if (!UUID.test(id) || !await db.getCooperative(id)) return res.status(404).json({ error: 'No encontramos esa cooperativa' })
  if (!CORREO.test(email)) return res.status(400).json({ error: 'Escribe su correo' })
  if (!claveValida(body.clave)) return res.status(400).json({ error: ERROR_CLAVE })
  if (nombre && (nombre.length < 2 || nombre.length > 80)) return res.status(400).json({ error: 'El nombre no es válido' })
  try {
    const creado = await db.createCooperativeUser({ cooperativeId: id, email, name: nombre, passwordHash: await bcrypt.hash(body.clave as string, 10) })
    return res.status(201).json({ id: creado.id, email: creado.email })
  } catch (error) {
    if ((error as { code?: string }).code === '23505') return res.status(409).json({ error: 'Ese correo ya tiene acceso a una cooperativa' })
    throw error
  }
})

/** La clave nueva, cuando la olvidan. El superadmin se la da en persona. */
router.put('/api/admin/cooperativas/usuarios/:id/clave', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  const clave = (req.body as Record<string, unknown> | undefined)?.clave
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese acceso' })
  if (!claveValida(clave)) return res.status(400).json({ error: ERROR_CLAVE })
  if (!await db.setCooperativeUserPassword(id, await bcrypt.hash(clave, 10))) {
    return res.status(404).json({ error: 'No encontramos ese acceso' })
  }
  return res.json({ ok: true })
})

export = router
