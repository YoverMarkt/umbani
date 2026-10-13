import type { Request, RequestHandler } from 'express'
import { createRouter } from '../middleware/async'
import { signedMediaUrl } from '../integrations/cloudinary'

// ═══════════════════════════════════════════════════════════════════════════
// INCIDENCIAS (SUPERADMIN, 2026-10-06, fase 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Los reclamos de los clientes («faltó algo», «vino mal», «no llegó») y las
// incidencias que el cliente no ve (comida caída, cliente ausente, accidente,
// el repartidor que no apareció). El superadmin decide quién responde —el
// local, el repartidor, el cliente o Umbani— y cuánto se compensa.
//
// Fase 2 (2026-10-10): lo que el cliente no recibió bien se le devuelve como
// SALDO UMBANI. Lo pequeño llega al instante (estado `compensada`) y aquí solo
// se confirma quién responde; el resto se decide aquí, y al resolverlo se le
// da el saldo.
//
// Parte 3 (2026-10-12): al confirmar quién responde, la BASE ajusta la
// liquidación del lunes de cada uno (`settlement_adjustments`). Antes de
// confirmar, el superadmin ve el efecto exacto (`/efecto`): es la misma
// función la que lo enseña y la que lo aplica. ⚠️ Sin esa confirmación, al
// responsable no se le cobra nada.

interface ModuloAuth { authAdmin: RequestHandler }
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')
const db = require('../db') as typeof import('../db')

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const router = createRouter()

const RESPUESTA: Record<string, { status: number; error: string }> = {
  not_found: { status: 404, error: 'No encontramos ese pedido o esa incidencia' },
  tipo_invalido: { status: 400, error: 'Elige qué pasó' },
  nota_invalida: { status: 400, error: 'Escribe qué pasó (entre 3 y 500 caracteres)' },
  ya_resuelta: { status: 409, error: 'Esa incidencia ya se resolvió: no se reescribe' },
  datos_invalidos: { status: 400, error: 'Di quién responde: el local, el repartidor, el cliente o Umbani' },
  compensacion_invalida: { status: 400, error: 'La compensación no puede pasar del total del pedido' },
  compensacion_ya_dada: { status: 409, error: 'El saldo ya se le dio al instante: aquí solo se confirma quién responde, el monto no cambia' },
  cliente_sin_compensacion: { status: 400, error: 'Si responde el cliente, no hay nada que devolverle: deja la compensación en 0' },
  sin_cuenta: { status: 409, error: 'No encontramos la cuenta de ese cliente para darle el saldo' },
  no_activa: { status: 409, error: 'Ese cliente ya no tiene la restricción: no hay nada que levantar' },
}
const responder = (res: Parameters<RequestHandler>[1], resultado: unknown, ok: () => void) => {
  if (resultado === 'ok') return ok()
  const e = RESPUESTA[String(resultado)] || { status: 409, error: 'No se pudo. Inténtalo de nuevo.' }
  return res.status(e.status).json({ error: e.error })
}
const quien = (req: Request) => `superadmin:${(req.user as { email?: string } | undefined)?.email || 'sin-correo'}`

const RESPONSABLES = new Set(['local', 'repartidor', 'cliente', 'umbani'])
// Lo que se perdió ANTES de entregar: ahí la compensación es la comida que se
// le reconoce al local, no un saldo para el cliente.
const RECLAMOS = new Set(['falta_producto', 'vino_mal', 'no_llego'])

/** Un ajuste, como lo enseñan las pantallas: + a favor, − se le cobra. */
const ajuste = (a: { party?: unknown; cents?: unknown; concepto?: unknown }) => ({
  parte: String(a.party ?? ''), cents: Number(a.cents) || 0, concepto: String(a.concepto ?? ''),
})

router.get('/api/admin/incidencias', auth.authAdmin, async (req, res) => {
  const estado = req.query.estado === 'todas' ? 'todas' : 'abierta'
  const filas = await db.listIncidents(estado)
  // La foto del cliente es privada: se ve con un enlace firmado que caduca solo.
  const fotos = new Map<string, string | null>()
  for (const i of filas) {
    if (i.photo_public_id) fotos.set(i.id, await signedMediaUrl(i.photo_public_id).catch(() => null))
  }
  return res.json({
    incidencias: filas.map(i => ({
      id: i.id,
      tipo: i.kind,
      origen: i.origin,
      estado: i.status,
      responsable: i.responsible,
      lineas: i.lines,
      nota: i.note,
      sugeridoCents: i.suggested_cents,
      compensacionCents: i.compensation_cents,
      resolucion: i.resolution_note,
      resueltaPor: i.resolved_by,
      creadaEn: i.created_at,
      resueltaEn: i.resolved_at,
      // Fase 2: el saldo y por qué no salió al instante (al cliente no se le dice).
      alInstante: i.auto_approved,
      saldoDadoEn: i.compensated_at,
      reparto: { localCents: i.local_cents, umbaniCents: i.umbani_cents, carreraCents: i.reparto_cents },
      // Parte 3: lo que ya se le ajustó a cada uno al resolver, y —en lo que se
      // perdió antes de entregar— la comida que se propone reconocerle al
      // local: lo que recibe por los productos, si el pedido no llegó a
      // entregarse (si se entregó igual, no se perdió nada).
      ajustes: (i.settlement_adjustments || []).map(ajuste),
      // «No estaba» (2026-10-12): hasta cuándo solo paga por adelantado, y si
      // Umbani lo levantó antes (quién y cuándo).
      soloPorAdelantadoHasta: i.prepaid_only_until,
      restriccionLevantada: i.restriction_lifted_at ? { en: i.restriction_lifted_at, por: i.restriction_lifted_by } : null,
      comidaSugeridaCents: RECLAMOS.has(i.kind) || i.orders?.status === 'completado'
        ? null
        : Math.round((Number(i.orders?.merchant_subtotal) || 0) * 100),
      escalon: i.escalon,
      motivos: i.review_reasons,
      fotoUrl: fotos.get(i.id) ?? null,
      pedido: {
        id: i.order_id,
        numero: i.orders?.order_number ?? null,
        totalCents: Math.round((Number(i.orders?.total) || 0) * 100),
        pago: i.orders?.payment_method ?? null,
        cliente: i.orders?.contact_name ?? null,
        telefono: i.orders?.contact_phone ?? null,
        // «No estaba el cliente» (2026-10-12): cuándo llegó quien repartía, a
        // cuántos metros de la dirección (si el teléfono lo dijo) y cuándo
        // marcó que no estaba. Es lo que se mira si el cliente dice «sí estaba».
        llegoEn: i.orders?.arrived_at ?? null,
        metrosDeLaDireccion: i.orders?.arrived_distance_m ?? null,
        noEstabaEn: i.orders?.customer_absent_at ?? null,
      },
      local: { id: i.business_id, nombre: i.businesses?.name ?? null },
      repartidor: i.couriers ? { nombre: i.couriers.name, cooperativa: i.couriers.cooperatives?.name ?? null } : null,
    })),
  })
})

/** Las que el cliente no ve: el pedido se nombra por su local y su número. */
router.post('/api/admin/incidencias', auth.authAdmin, async (req, res) => {
  const body = (req.body || {}) as Record<string, unknown>
  const localId = String(body.localId ?? '').trim()
  const numero = Number(body.numero)
  if (!UUID.test(localId) || !Number.isInteger(numero) || numero < 1) {
    return res.status(400).json({ error: 'Elige el local y escribe el número del pedido' })
  }
  const r = await db.registerIncident(localId, numero, String(body.tipo ?? ''), String(body.nota ?? ''))
  return responder(res, r.result, () => res.status(201).json({ id: r.id }))
})

/**
 * Lo que pasaría al resolver, SIN escribir nada: a quién se le reconoce o se
 * le descuenta cuánto en su liquidación del lunes, y si el cliente pasará a
 * pagar solo por adelantado (y cuántos días). La pantalla lo enseña antes de
 * confirmar.
 */
router.get('/api/admin/incidencias/:id/efecto', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos esa incidencia' })
  const responsable = String(req.query.responsable ?? '')
  if (!RESPONSABLES.has(responsable)) return res.status(400).json({ error: RESPUESTA.datos_invalidos.error })
  const compensacion = Number(req.query.compensacionCents ?? 0)
  if (!Number.isInteger(compensacion) || compensacion < 0 || compensacion > 10_000_000) {
    return res.status(400).json({ error: 'La compensación va en centavos enteros' })
  }
  const efecto = await db.incidentEffect(id, responsable, compensacion)
  return res.json({
    ajustes: efecto.ajustes.map(ajuste),
    soloPorAdelantado: efecto.soloPorAdelantado,
    diasSoloPorAdelantado: efecto.diasSoloPorAdelantado,
  })
})

/**
 * Umbani levanta antes el «solo por adelantado» de un cliente que no estaba
 * (2026-10-12): vuelve a poder pagar como quiera. Queda quién fue.
 */
router.post('/api/admin/incidencias/:id/levantar', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos esa incidencia' })
  const r = await db.liftPrepaidOnly(id, quien(req))
  return responder(res, r.result, () => res.json({ ok: true }))
})

router.post('/api/admin/incidencias/:id/resolver', auth.authAdmin, async (req, res) => {
  const id = String(req.params.id || '')
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos esa incidencia' })
  const body = (req.body || {}) as Record<string, unknown>
  const estado = body.estado === 'descartada' ? 'descartada' : 'resuelta'
  const compensacion = body.compensacionCents == null || body.compensacionCents === '' ? null : Number(body.compensacionCents)
  if (compensacion !== null && !Number.isInteger(compensacion)) {
    return res.status(400).json({ error: 'La compensación va en centavos enteros' })
  }
  const r = await db.resolveIncident({
    id, status: estado, responsible: typeof body.responsable === 'string' ? body.responsable : null,
    compensationCents: compensacion, note: String(body.nota ?? ''), actor: quien(req),
  })
  return responder(res, r.result, () => res.json({
    ok: true,
    saldoCents: Number(r.saldoCents) || 0,
    ajustes: Array.isArray(r.ajustes) ? (r.ajustes as Parameters<typeof ajuste>[0][]).map(ajuste) : [],
  }))
})

export = router
