import type { RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { getClientBusinessId } from '../lib/request'

// ═══════════════════════════════════════════════════════════════════════════
// LOS REPARTIDORES DEL LOCAL (PANEL DEL DUEÑO, 2026-10-02)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-09-27): «si el local tiene su propia flota, el
// repartidor se registra como del local, la carrera es del local y la app le
// enseña cuánto efectivo trae cada uno». Hasta hoy solo el superadmin podía
// registrarlos; aquí lo hace el propio local.
//
// ⚠️ APAGADO por defecto (`flota_del_local` en Ajustes del superadmin): sin
// la app del motorizado, registrar repartidores no sirve de nada. Apagado, la
// API responde 404 —no solo se esconde el menú—.
//
// ⚠️ SOLO EL DUEÑO, y el negocio sale del JWT, nunca de la petición. Un local
// no ve ni toca a los repartidores de otro: cada consulta va filtrada por
// `fleet_business_id` = su negocio. Qué pedidos puede llevar cada repartidor
// lo decide la base (`orders_courier_permitido`): solo los de SU local.

interface ModuloAuth { authClient: RequestHandler; requireOwner: RequestHandler }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const db = require('../db') as typeof import('../db')
const settings = require('../services/settings') as typeof import('../services/settings')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const router = createRouter()

/** Apagado = 404 para todo, como si no existiera. */
const soloSiEstaEncendido: RequestHandler = async (_req, res, next) => {
  if ((await settings.get('flota_del_local').catch(() => null)) === '1') return next()
  return res.status(404).json({ error: 'Los repartidores propios todavía no están disponibles' })
}

/** El inicio del día de HOY en Ecuador, en ISO (Ecuador no cambia de hora). */
const inicioDeHoyEnEcuador = (ahora = new Date()): string => {
  const hoy = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Guayaquil' })
  return new Date(`${hoy}T00:00:00-05:00`).toISOString()
}

const puerta = [auth.authClient, auth.requireOwner, soloSiEstaEncendido]

router.get('/api/client/repartidores', ...puerta, async (req, res) => {
  const businessId = getClientBusinessId(req)
  const repartidores = await db.listFleetCouriers(businessId)
  const efectivo = await db.fleetCash(businessId, repartidores.map(r => r.id), inicioDeHoyEnEcuador())
  return res.json({
    repartidores: repartidores.map(r => ({
      id: r.id,
      nombre: r.name,
      telefono: r.phone,
      vehiculo: r.vehicle,
      activo: r.active,
      disponible: r.available,
      // Lo que va a cobrar en los pedidos que lleva AHORA, y lo que ya cobró hoy.
      efectivoEnCursoCents: efectivo.get(r.id)?.enCursoCents ?? 0,
      cobradoHoyCents: efectivo.get(r.id)?.cobradoHoyCents ?? 0,
      entregasHoy: efectivo.get(r.id)?.entregasHoy ?? 0,
    })),
  })
})

router.post('/api/client/repartidores', ...puerta, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const phone = String(body.telefono || '').replace(/[^\d+]/g, '')
  const name = String(body.nombre || '').trim()
  if (!/^\+?\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'Teléfono no válido' })
  if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Escribe el nombre' })
  try {
    const creado = await db.createCourier({
      phone, name, vehicle: String(body.vehiculo || '').trim().slice(0, 60) || null,
      // ⚠️ Del JWT, NUNCA del cuerpo: si viniera de la petición, un local
      // podría meter repartidores en la flota de otro.
      fleetBusinessId: getClientBusinessId(req),
    })
    return res.status(201).json({ id: creado.id, nombre: creado.name, telefono: creado.phone, vehiculo: creado.vehicle, activo: creado.active })
  } catch (error) {
    // El mismo texto si el número es de otro local o de Umbani: no se dice de quién.
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: 'Ese teléfono ya está registrado como repartidor' })
    }
    throw error
  }
})

router.put('/api/client/repartidores/:id/activo', ...puerta, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese repartidor' })
  const activo = (req.body as Record<string, unknown> | undefined)?.activo === true
  // El mismo 404 si no existe o es de otro local: no se confirma qué ids hay.
  if (!await db.setFleetCourierActive(getClientBusinessId(req), id, activo)) {
    return res.status(404).json({ error: 'No encontramos ese repartidor' })
  }
  return res.json({ activo })
})

export = router
