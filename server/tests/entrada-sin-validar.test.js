import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import scheduleRouter from '../dist/routes/schedule.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'entrada-sin-validar-test-secret'

// ═══════════════════════════════════════════════════════════════════════════
// UN CUERPO MALFORMADO ES 400, NUNCA 500
// ═══════════════════════════════════════════════════════════════════════════
//
// Los dos casos que hay aquí salieron de barrer las escrituras del panel por
// HTTP contra la base real (2026-08-02). Ninguno lo veían los tests de ruta:
// falsean la capa `db`, así que un cuerpo raro nunca llegaba a PostgreSQL.
//
//   PUT /api/client/schedule   `req.body.days` iba directo a `.map()`.
//                              Sin `days` → «Cannot read properties of
//                              undefined» → 500.
//
//   PUT /api/client/policies   `req.body` ENTERO se pasaba a la base, así que
//                              cualquier clave se volvía una columna a
//                              escribir. Una que no existiera → 500.
//
// Que devuelvan 500 no es cosmético: un 500 dice «me rompí yo», entra en el
// registro de errores de la plataforma y tapa los fallos de verdad. Además
// `policies` metía entrada sin filtrar en la base — no era un agujero
// multi-tenant, porque `business_id` se fija después desde el JWT y siempre
// gana, pero no es forma de hablar con una tabla.

let originalJwtSecret

beforeEach(() => {
  originalJwtSecret = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  if (originalJwtSecret === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = originalJwtSecret
})

const auth = (claims = {}) => `Bearer ${jwt.sign({
  role: 'client', businessId: 'business-a', urole: 'owner', perms: [], ...claims,
}, JWT_SECRET)}`

async function dispatch(router, method, path, { body = {}, query = {} } = {}) {
  const routeLayer = router.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.[method]
  ))
  const handlers = routeLayer.route.stack.map(layer => layer.handle)
  const req = { headers: { authorization: auth() }, body, query, params: {} }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(responseBody) { result.body = responseBody; return this },
  }
  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => { nextCalled = true; nextError = error })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }
  await run(0)
  return result
}

describe('horario: un cuerpo malformado no revienta el servidor', () => {
  const malos = [
    ['sin cuerpo', {}],
    ['days ausente', { schedule: [] }],
    ['days no es lista', { days: 'lunes' }],
    ['days vacío', { days: [] }],
    ['days con basura', { days: [null, 'x'] }],
    ['days con más de siete', { days: Array.from({ length: 8 }, () => ({ day_of_week: 1 })) }],
  ]

  for (const [nombre, body] of malos) {
    it(`${nombre} → 400`, async () => {
      const upsert = vi.spyOn(db, 'upsertSchedule')
      const res = await dispatch(scheduleRouter, 'put', '/api/client/schedule', { body })
      expect(res.status).toBe(400)
      // Lo importante no es solo el código: la base ni se entera.
      expect(upsert).not.toHaveBeenCalled()
    })
  }

  it('un horario válido sí llega a la base', async () => {
    const upsert = vi.spyOn(db, 'upsertSchedule').mockResolvedValue({ error: null })
    const dias = [{ day_of_week: 1, is_active: true, open_time: '09:00', close_time: '18:00' }]
    const res = await dispatch(scheduleRouter, 'put', '/api/client/schedule', {
      body: { days: dias },
    })
    expect(res.status).toBe(200)
    expect(upsert).toHaveBeenCalledWith('business-a', dias)
  })
})

// ⚠️ Aquí vivía «políticas: solo se escriben las columnas que existen», que
// cubría `PUT /api/client/policies`. Esa ruta y la tabla `bot_policies` se
// retiraron el 2026-09-20: el saludo y las políticas que guardaban no los
// leía nadie. La lección que dejó —filtrar las claves del cuerpo en vez de
// pasarlo entero a la base— sigue viva en el resto de este archivo.
