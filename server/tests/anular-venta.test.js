import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'

// ═══════════════════════════════════════════════════════════════════════════
// ANULAR UNA VENTA DE LA APP: SOLO UMBANI (2026-10-11)
// ═══════════════════════════════════════════════════════════════════════════
// Decisión del dueño, «como las grandes»: el local ya no anula un pedido de la
// app entregado (en efectivo se ahorraba la comisión, sin rastro). La regla la
// exige la base —bloque «ANULAR» de verify:schema—; aquí, que el superadmin
// tenga su puerta con motivo y que cada «no» se diga claro.

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const pagosRouter = require('../dist/routes/admin-pagos.routes')

const SECRET = 'anular-venta-secret'
const LOCAL = '22222222-2222-4222-8222-222222222222'
let secretoAnterior

beforeEach(() => {
  secretoAnterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
})
afterEach(() => {
  vi.restoreAllMocks()
  if (secretoAnterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = secretoAnterior
})

async function despachar(method, path, { auth, body = {}, params = {} } = {}) {
  const layer = pagosRouter.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
  const r = { status: 200, body: undefined }
  const res = { status(c) { r.status = c; return this }, json(v) { r.body = v; return this } }
  const correr = async (i) => {
    if (i >= handlers.length) return
    let siguiente = false
    let fallo
    await handlers[i](req, res, (e) => { siguiente = true; fallo = e })
    if (fallo) throw fallo
    if (siguiente) await correr(i + 1)
  }
  await correr(0)
  return r
}
const admin = () => `Bearer ${jwt.sign({ role: 'admin', mfa: true }, SECRET)}`
const RUTA = '/api/admin/pagos/ventas/anular'

describe('el superadmin anula una venta', () => {
  it('un local (ni nadie sin superadmin) no entra por esta puerta', async () => {
    const anular = vi.spyOn(db, 'voidSaleByPlatform')
    expect((await despachar('post', RUTA, { body: { localId: LOCAL, numero: 3, motivo: 'Prueba' } })).status).toBe(401)
    const local = `Bearer ${jwt.sign({ role: 'client', businessId: LOCAL }, SECRET)}`
    expect((await despachar('post', RUTA, { auth: local, body: { localId: LOCAL, numero: 3, motivo: 'Prueba' } })).status).toBe(403)
    expect(anular).not.toHaveBeenCalled()
  })

  it('pide local y número válidos antes de tocar la base', async () => {
    const anular = vi.spyOn(db, 'voidSaleByPlatform')
    for (const body of [{ localId: 'x', numero: 3 }, { localId: LOCAL, numero: 0 }, { localId: LOCAL, numero: 'tres' }]) {
      expect((await despachar('post', RUTA, { auth: admin(), body: { ...body, motivo: 'Prueba' } })).status).toBe(400)
    }
    expect(anular).not.toHaveBeenCalled()
  })

  it('anula con su motivo, y cada «no» de la base se dice con palabras', async () => {
    const anular = vi.spyOn(db, 'voidSaleByPlatform').mockResolvedValue({ result: 'ok', numero: 3, total: 8 })
    const bien = await despachar('post', RUTA, { auth: admin(), body: { localId: LOCAL, numero: 3, motivo: 'El cliente lo devolvió' } })
    expect(bien).toMatchObject({ status: 200, body: { ok: true, numero: 3, total: 8 } })
    expect(anular).toHaveBeenCalledWith(LOCAL, 3, 'El cliente lo devolvió')
    for (const [result, estado] of [['motivo_invalido', 400], ['not_found', 404], ['sin_venta', 409], ['ya_anulada', 409], ['raro', 500]]) {
      anular.mockResolvedValue({ result })
      const r = await despachar('post', RUTA, { auth: admin(), body: { localId: LOCAL, numero: 3, motivo: 'x' } })
      expect(r.status, result).toBe(estado)
      expect(r.body.error, result).toBeTruthy()
    }
  })

  it('el repositorio llama a la función de la base, y un error no se traga', async () => {
    const rpc = vi.spyOn(client, 'rpc').mockResolvedValue({ data: { result: 'ok', numero: 3, total: 8 }, error: null })
    expect(await db.voidSaleByPlatform(LOCAL, 3, 'Motivo')).toEqual({ result: 'ok', numero: 3, total: 8 })
    expect(rpc).toHaveBeenLastCalledWith('anular_venta_por_umbani', { p_business_id: LOCAL, p_order_number: 3, p_motivo: 'Motivo' })
    rpc.mockResolvedValue({ data: null, error: { message: 'caída' } })
    await expect(db.voidSaleByPlatform(LOCAL, 3, 'Motivo')).rejects.toThrow('caída')
  })
})

describe('el panel del local', () => {
  it('solo ofrece «Anular venta» en lo de mostrador, y en lo de la app manda a Umbani', () => {
    const fuente = readFileSync('../apps/client/src/features/sales/Sales.tsx', 'utf8')
    expect(fuente).toMatch(/\['mostrador', 'manual'\]\.includes/)
    expect(fuente).toMatch(/s\.status === 'completada' && anulaElLocal\(s\) && \(\s*<ConfirmAction/)
    expect(fuente).toContain('escríbele a Umbani')
  })
})
