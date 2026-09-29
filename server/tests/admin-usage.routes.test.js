import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import usageRouter from '../dist/routes/admin-usage.routes.js'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const JWT_SECRET = 'admin-usage-test-secret'
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

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, mfa: true, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch({ auth, query = {} } = {}) {
  const layer = usageRouter.stack.find(item => (
    item.route?.path === '/api/admin/usage' && item.route?.methods?.get
  ))
  if (!layer) throw new Error('Ruta de medición no encontrada')
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, query }
  const result = { status: 200, body: undefined }
  const res = {
    status(code) { result.status = code; return this },
    json(value) { result.body = value; return this },
  }

  async function run(index) {
    if (index >= handlers.length) return
    let nextCalled = false
    let nextError
    await handlers[index](req, res, error => {
      nextCalled = true
      nextError = error
    })
    if (nextError) throw nextError
    if (nextCalled) await run(index + 1)
  }

  await run(0)
  return result
}

describe('medición del superadmin', () => {
  it('es exclusiva del superadmin', async () => {
    expect((await dispatch()).status).toBe(401)
    expect((await dispatch({ auth: authorization('client') })).status).toBe(403)
  })

  it('consulta todos los negocios del mes solicitado en una sola RPC', async () => {
    const rows = [{ business_id: 'business-a', outbound_messages: 42 }]
    const getUsage = vi.spyOn(db, 'getAdminMonthlyUsage').mockResolvedValue(rows)

    const response = await dispatch({
      auth: authorization(),
      query: { month: '2026-07' },
    })

    expect(response).toEqual({ status: 200, body: rows })
    expect(getUsage).toHaveBeenCalledWith('2026-07-01')
  })

  it('rechaza períodos ambiguos antes de consultar la base', async () => {
    const getUsage = vi.spyOn(db, 'getAdminMonthlyUsage')
    const response = await dispatch({
      auth: authorization(),
      query: { month: '07/2026' },
    })

    expect(response.status).toBe(400)
    expect(response.body.error).toContain('YYYY-MM')
    expect(getUsage).not.toHaveBeenCalled()
  })
})
