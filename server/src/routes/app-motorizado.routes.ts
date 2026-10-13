import rateLimit from 'express-rate-limit'
import type { Request, RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { authApp, correoDe, telefonoDe } from '../services/sesion-app'
import { avisarAlCliente } from '../services/order-status-notice'
import { conActor } from '../lib/actor-de-la-peticion'
import { idDelPedido, leerUbicacion, respuestaDeLaPuerta } from '../lib/no-estaba-el-cliente'

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

/**
 * El motorizado activo de la sesión, o 403. Desde el 2026-10-06 entra con el
 * CORREO con el que lo registraron; el teléfono queda para la puerta de
 * WhatsApp, en espera.
 */
const soloMotorizado: RequestHandler = async (req, res, next) => {
  const correo = correoDe(req)
  const courier = await (correo ? db.getActiveCourierByEmail(correo) : db.getActiveCourierByPhone(telefonoDe(req))).catch(() => null)
  if (!courier) {
    return res.status(403).json({ error: correo
      ? 'Este correo no es de un repartidor activo de Umbani'
      : 'Este número no es de un motorizado activo de Umbani' })
  }
  ;(req as ConMotorizado).motorizado = courier
  // Quién, para el registro de dinero (2026-10-12): lo que mueve dinero desde
  // su app —un «no estaba el cliente»— dice que fue él, no «sistema».
  return conActor(actorDelRepartidor(courier), next)
}
const yo = (req: Request) => (req as ConMotorizado).motorizado!
const actorDelRepartidor = (m: import('../db/repositories/couriers').Courier) => `repartidor:${m.email || m.phone}`

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
  // La de una cooperativa (2026-10-06) cobra y liquida como la de Umbani; la
  // app solo necesita saber de cuál es para decírselo.
  const cooperativa = m.cooperative_id ? await db.getCooperative(m.cooperative_id).catch(() => null) : null
  const [semana, ajustes] = await Promise.all([
    db.getCourierBalance(m.id),
    db.listUnsettledAdjustments({ courierId: m.id }),
  ])
  return res.json({
    nombre: m.name,
    vehiculo: m.vehicle,
    flota: m.fleet_business_id ? 'local' : m.cooperative_id ? 'cooperativa' : 'umbani',
    cooperativa: cooperativa?.name ?? null,
    disponible: m.available,
    topeEfectivoCents: m.cash_limit_cents,
    semana,
    // Lo que se le descontó (o reconoció) esta semana por una incidencia, y
    // por qué (2026-10-12). Suma `semana.ajustesCents`.
    ajustes: ajustes.map(a => ({
      numero: a.orders?.order_number ?? null,
      local: a.businesses?.name ?? null,
      fecha: a.created_at,
      tipo: a.order_incidents?.kind ?? null,
      concepto: a.concepto,
      cents: a.cents,
    })),
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

/**
 * «Llegué» (2026-10-12): en la puerta del cliente. Desde aquí cuentan los
 * minutos para «No estaba el cliente» y su lista le enseña el teléfono del
 * cliente para llamarlo. La ubicación es opcional: se guarda a cuántos metros
 * de la dirección estaba —la prueba si el cliente dice «sí estaba»— y no
 * bloquea nada. El primer toque cuenta.
 */
router.post(`${base}/pedidos/:id/llegue`, limiter, authApp, soloMotorizado, async (req, res) => {
  const pedidoId = idDelPedido(req.params.id)
  if (!pedidoId) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const r = await db.markArrived({ courierId: yo(req).id }, pedidoId, leerUbicacion(req.body))
  if (r.result === 'ok') return res.json({ llegoEn: r.llegoEn, noEstabaDesde: r.noEstabaDesde })
  const e = respuestaDeLaPuerta(r)
  return res.status(e.status).json(e.body)
})

/**
 * «No estaba el cliente» (2026-10-12), pasados los minutos desde «Llegué». El
 * pedido se cierra como entregado y se cobra sin devolución; su carrera la
 * cobra igual y, si era en efectivo, no debe nada por él. La comida se la
 * queda. ⚠️ Sin aviso al cliente: «entregado» le diría que lo recibió.
 */
router.post(`${base}/pedidos/:id/no-estaba`, limiter, authApp, soloMotorizado, async (req, res) => {
  const pedidoId = idDelPedido(req.params.id)
  if (!pedidoId) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const r = await db.markCustomerAbsent({ courierId: yo(req).id }, pedidoId, actorDelRepartidor(yo(req)))
  if (r.result === 'ok') return res.json({ ok: true })
  const e = respuestaDeLaPuerta(r)
  return res.status(e.status).json(e.body)
})

router.get(`${base}/liquidaciones`, limiter, authApp, soloMotorizado, async (req, res) => (
  res.json({ liquidaciones: await db.listCourierSettlements(yo(req).id, 52) })
))

export = router
