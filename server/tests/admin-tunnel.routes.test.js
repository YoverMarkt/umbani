import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import tunnelRouter from '../dist/routes/admin-tunnel.routes.js'

const require = createRequire(import.meta.url)
const tunnel = require('../dist/services/tunnel')
const JWT_SECRET = 'admin-tunnel-test-secret'
const originalEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  BASE_URL: process.env.BASE_URL,
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY,
  PORT: process.env.PORT,
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function authorization(role = 'admin') {
  return `Bearer ${jwt.sign({ role, mfa: true, businessId: 'business-a' }, JWT_SECRET)}`
}

async function dispatch(method, path, { auth } = {}) {
  const layer = tunnelRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {} }
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

describe('túnel y configuración segura del superadmin', () => {
  it('protege los cuatro endpoints exclusivamente con autenticación admin', async () => {
    expect(tunnelRouter.stack).toHaveLength(4)
    expect(tunnelRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('get', '/api/admin/tunnel')).status).toBe(401)
    expect((await dispatch('get', '/api/admin/tunnel', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('reporta el dominio de producción sin exponer secretos', async () => {
    process.env.BASE_URL = 'https://bot.example.com'
    process.env.SUPABASE_URL = 'https://secret.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-role-secret'

    const response = await dispatch('get', '/api/admin/tunnel', {
      auth: authorization(),
    })

    expect(response.body).toEqual({
      url: 'https://bot.example.com',
      active: true,
      provider: 'dominio propio',
      startedAt: null,
    })
    expect(JSON.stringify(response.body)).not.toContain('supabase.co')
    expect(JSON.stringify(response.body)).not.toContain('service-role-secret')
  })

  it('conserva el estado local e inicia y detiene cloudflared', async () => {
    delete process.env.BASE_URL
    process.env.PORT = '3100'
    vi.spyOn(tunnel, 'getState').mockReturnValue({
      url: null, active: false, provider: null, startedAt: null,
    })
    const start = vi.spyOn(tunnel, 'startTunnel').mockResolvedValue({
      url: 'https://demo.trycloudflare.com',
      active: true,
      provider: 'cloudflared',
      startedAt: '2026-07-12T00:00:00.000Z',
    })
    const stop = vi.spyOn(tunnel, 'stopTunnel').mockImplementation(() => {})
    const auth = authorization()

    const state = await dispatch('get', '/api/admin/tunnel', { auth })
    const started = await dispatch('post', '/api/admin/tunnel/start', { auth })
    const stopped = await dispatch('post', '/api/admin/tunnel/stop', { auth })

    expect(state.body).toEqual({
      url: null, active: false, provider: null, startedAt: null,
    })
    expect(start).toHaveBeenCalledWith('3100')
    expect(started.body.active).toBe(true)
    expect(stop).toHaveBeenCalledOnce()
    expect(stopped.body).toEqual({ ok: true })
  })

  it('reporta de forma controlada un fallo al iniciar el túnel', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(tunnel, 'startTunnel').mockRejectedValue(new Error('cloudflared no disponible'))

    const response = await dispatch('post', '/api/admin/tunnel/start', {
      auth: authorization(),
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'cloudflared no disponible' },
    })
  })

  it('mantiene Supabase completamente desactivado para el frontend', async () => {
    process.env.SUPABASE_URL = 'https://secret.supabase.co'
    process.env.SUPABASE_SERVICE_KEY = 'service-role-secret'

    const response = await dispatch('get', '/api/admin/supabase-config', {
      auth: authorization(),
    })

    expect(response.body).toEqual({})
  })
})
