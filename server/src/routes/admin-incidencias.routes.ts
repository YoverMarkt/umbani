import type { Request, RequestHandler } from 'express'
import { createRouter } from '../middleware/async'

// ═══════════════════════════════════════════════════════════════════════════
// INCIDENCIAS (SUPERADMIN, 2026-10-06, fase 1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Los reclamos de los clientes («faltó algo», «vino mal», «no llegó») y las
// incidencias que el cliente no ve (comida caída, cliente ausente, accidente,
// el repartidor que no apareció). El superadmin decide quién responde —el
// local, el repartidor, el cliente o Umbani— y cuánto se compensa.
//
// ⚠️ Esta fase NO mueve dinero: la compensación queda decidida y anotada. El
// saldo Umbani y el descuento en la liquidación llegan en la fase 2.

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
}
const responder = (res: Parameters<RequestHandler>[1], resultado: unknown, ok: () => void) => {
  if (resultado === 'ok') return ok()
  const e = RESPUESTA[String(resultado)] || { status: 409, error: 'No se pudo. Inténtalo de nuevo.' }
  return res.status(e.status).json({ error: e.error })
}
const quien = (req: Request) => `superadmin:${(req.user as { email?: string } | undefined)?.email || 'sin-correo'}`

router.get('/api/admin/incidencias', auth.authAdmin, async (req, res) => {
  const estado = req.query.estado === 'todas' ? 'todas' : 'abierta'
  const filas = await db.listIncidents(estado)
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
      pedido: {
        id: i.order_id,
        numero: i.orders?.order_number ?? null,
        totalCents: Math.round((Number(i.orders?.total) || 0) * 100),
        pago: i.orders?.payment_method ?? null,
        cliente: i.orders?.contact_name ?? null,
        telefono: i.orders?.contact_phone ?? null,
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
  return responder(res, r.result, () => res.json({ ok: true }))
})

export = router
