import rateLimit from 'express-rate-limit'
import type { Request, RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { authApp, telefonoDe } from '../services/sesion-app'
import { avisarAlCliente } from '../services/order-status-notice'

// ═══════════════════════════════════════════════════════════════════════════
// LA API DE LA APP DEL MOTORIZADO (v1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Inicia sesión igual que el cliente (WhatsApp) y aquí se exige que su
// teléfono sea el de un motorizado ACTIVO. Todas las reglas —qué pedidos le
// tocan, el tope de efectivo, que sea SU pedido— las pone la base. La app
// pinta. Documentada en `docs/apps/APP-MOTORIZADO.md` y `openapi.yaml`.

const db = require('../db') as typeof import('../db')
const router = createRouter()

const limiter = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})

type ConMotorizado = Request & { motorizado?: import('../db/repositories/couriers').Courier }

/** El motorizado activo de la sesión, o 403. */
const soloMotorizado: RequestHandler = async (req, res, next) => {
  const courier = await db.getActiveCourierByPhone(telefonoDe(req)).catch(() => null)
  if (!courier) return res.status(403).json({ error: 'Este número no es de un motorizado activo de Umbani' })
  ;(req as ConMotorizado).motorizado = courier
  return next()
}
const yo = (req: Request) => (req as ConMotorizado).motorizado!

const RESPUESTA_AL_TOMAR: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: 'No encontramos ese pedido' },
  ya_tomado: { status: 409, error: 'Otro motorizado ya lo tomó' },
  no_disponible: { status: 409, error: 'Ese pedido ya no está disponible' },
  tope_de_efectivo: { status: 409, error: 'Llevas mucho efectivo encima. Liquida antes de tomar otro pedido en efectivo.' },
  inactivo: { status: 403, error: 'Tu cuenta de motorizado no está activa' },
}

const base = '/api/v1/motorizado'

router.get(`${base}/yo`, limiter, authApp, soloMotorizado, async (req, res) => {
  const m = yo(req)
  return res.json({
    nombre: m.name,
    vehiculo: m.vehicle,
    flota: m.fleet_business_id ? 'local' : 'umbani',
    disponible: m.available,
    topeEfectivoCents: m.cash_limit_cents,
    semana: await db.getCourierBalance(m.id),
  })
})

router.put(`${base}/disponible`, limiter, authApp, soloMotorizado, async (req, res) => {
  const disponible = (req.body as Record<string, unknown> | undefined)?.disponible === true
  await db.setCourierAvailable(yo(req).id, disponible)
  return res.json({ disponible })
})

router.get(`${base}/pedidos`, limiter, authApp, soloMotorizado, async (req, res) => (
  res.json({ pedidos: await db.getCourierOrders(yo(req).id) })
))

router.post(`${base}/pedidos/:id/tomar`, limiter, authApp, soloMotorizado, async (req, res) => {
  const r = await db.courierTakeOrder(yo(req).id, String(req.params.id || ''))
  if (r.result === 'ok' || r.result === 'ya_es_tuyo') return res.json({ ok: true })
  const e = RESPUESTA_AL_TOMAR[String(r.result)] || RESPUESTA_AL_TOMAR.no_disponible
  return res.status(e.status).json({ error: e.error, reason: r.result })
})

/** Recogido (sale en camino) o entregado. La base exige que sea SU pedido y la checklist completa. */
const avanzar = (estado: 'en_camino' | 'completado'): RequestHandler => async (req, res) => {
  const pedidoId = String(req.params.id || '')
  const r = await db.courierAdvanceOrder(yo(req).id, pedidoId, estado)
  if (r.result === 'updated') {
    // ⚠️ El aviso al cliente, como cuando lo mueve el local (2026-10-02). La
    // ruta cambiaba el estado y NO avisaba: con motorizado, el cliente no se
    // enteraba de «en camino» ni de «entregado». Lo encontró el recorrido de
    // motorizados. Sin esperar, como en el panel: un proveedor lento no puede
    // dejar al motorizado mirando una pantalla quieta en la puerta.
    const negocio = String((r.order as { business_id?: unknown } | undefined)?.business_id || '')
    if (negocio) void avisarAlCliente(negocio, pedidoId, estado)
    return res.json({ ok: true })
  }
  if (r.result === 'not_found') return res.status(404).json({ error: 'No encontramos ese pedido' })
  if (r.result === 'incompleto') return res.status(409).json({ error: `El local aún no termina de empacar: falta ${r.faltan}` })
  return res.status(409).json({ error: 'Ese pedido no puede pasar a ese estado ahora', reason: r.result })
}

router.post(`${base}/pedidos/:id/recogido`, limiter, authApp, soloMotorizado, avanzar('en_camino'))
router.post(`${base}/pedidos/:id/entregado`, limiter, authApp, soloMotorizado, avanzar('completado'))

router.get(`${base}/liquidaciones`, limiter, authApp, soloMotorizado, async (req, res) => (
  res.json({ liquidaciones: await db.listCourierSettlements(yo(req).id, 52) })
))

export = router
