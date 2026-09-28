import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const router = require('../dist/routes/mis-pagos.routes')

// «Mis pagos»: el estado de cuenta del local. Solo el DUEÑO, el negocio sale
// del JWT, y nunca se le enseña lo que Umbani le paga a PayPhone.

const SECRET = 'mis-pagos-test'
let anterior
beforeEach(() => { anterior = process.env.JWT_SECRET; process.env.JWT_SECRET = SECRET })
afterEach(() => {
  vi.restoreAllMocks()
  if (anterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = anterior
})

async function pedir(claims, query = {}) {
  const layer = router.stack.find(l => l.route?.path === '/api/client/mis-pagos')
  const handlers = layer.route.stack.map(l => l.handle)
  const req = { headers: { authorization: `Bearer ${jwt.sign(claims, SECRET)}` }, query, params: {}, body: {} }
  const r = { status: 200, body: undefined }
  const res = { status(c) { r.status = c; return this }, json(v) { r.body = v; return this } }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return r
}

describe('Mis pagos', () => {
  it('un empleado NO ve los depósitos del dueño', async () => {
    const r = await pedir({ role: 'client', businessId: 'b1', urole: 'employee', perms: ['reportes', 'ventas'] })
    expect(r.status).toBe(403)
  })

  it('el dueño ve SOLO su negocio (del JWT) y sin el costo de PayPhone', async () => {
    const saldos = vi.spyOn(db, 'getSettlementBalances').mockResolvedValue([{
      business_id: 'b1', pedidos: 2, pedidos_tarjeta: 1, derecho_cents: 2796, en_mano_cents: 1518,
      arrastre_cents: 0, neto_cents: 1278, umbani_cents: 240, payphone_cents: 87,
    }])
    const libro = vi.spyOn(db, 'listLedger').mockResolvedValue([
      { orders: { order_number: 7 }, sold_at: '2026-10-01T20:00:00Z', kind: 'venta', payment_method: 'tarjeta',
        total_cents: 1518, local_cents: 1198, reparto_cents: 200, reparto_para: 'local', umbani_cents: 120, en_mano: 'umbani' },
    ])
    const liq = vi.spyOn(db, 'listSettlements').mockResolvedValue([])
    const r = await pedir({ role: 'client', businessId: 'b1', urole: 'owner' }, { businessId: 'OTRO' })
    expect(r.status).toBe(200)
    expect(saldos).toHaveBeenCalledWith('b1')
    expect(libro.mock.calls[0][0]).toBe('b1')
    expect(liq.mock.calls[0][0]).toMatchObject({ businessId: 'b1' })
    expect(r.body.semana).toMatchObject({ tuyoCents: 2796, yaCobrasteCents: 1518, netoCents: 1278, comisionCents: 240 })
    expect(r.body.pedidos[0]).toMatchObject({ numero: 7, tuyoCents: 1398, comisionCents: 120, cobro: 'umbani' })
    expect(JSON.stringify(r.body)).not.toMatch(/payphone/i)
  })

  it('sin pedidos todavía, todo en cero', async () => {
    vi.spyOn(db, 'getSettlementBalances').mockResolvedValue([])
    vi.spyOn(db, 'listLedger').mockResolvedValue([])
    vi.spyOn(db, 'listSettlements').mockResolvedValue([{ id: 's', period_start: '2026-10-05', period_end: '2026-10-11',
      orders_count: 0, derecho_cents: 0, en_mano_cents: 0, arrastre_cents: 0, cuota_cents: 0, neto_cents: 0,
      status: 'en_cero', paid_at: null, reference: null }])
    const r = await pedir({ role: 'client', businessId: 'b1', urole: 'owner' })
    expect(r.body.semana.netoCents).toBe(0)
    expect(r.body.depositos[0]).toMatchObject({ estado: 'en_cero', desde: '2026-10-05' })
  })
})
