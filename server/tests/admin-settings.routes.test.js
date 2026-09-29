import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import settingsRouter from '../dist/routes/admin-settings.routes.js'

const require = createRequire(import.meta.url)
const axios = require('axios')
const settings = require('../dist/services/settings')
const cloudinary = require('../dist/integrations/cloudinary')
const JWT_SECRET = 'admin-settings-test-secret'
const originalEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
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

async function dispatch(method, path, { auth, body = {} } = {}) {
  const layer = settingsRouter.stack.find(item => (
    item.route?.path === path && item.route?.methods?.[method]
  ))
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body }
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

describe('configuración global del superadmin', () => {
  it('protege los cuatro endpoints exclusivamente con autenticación admin', async () => {
    expect(settingsRouter.stack).toHaveLength(4)
    expect(settingsRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    expect((await dispatch('get', '/api/admin/server-settings')).status).toBe(401)
    expect((await dispatch('get', '/api/admin/server-settings', {
      auth: authorization('client'),
    })).status).toBe(403)
  })

  it('enmascara todas las claves y conserva configuraciones no sensibles', async () => {
    vi.spyOn(settings, 'getAll').mockResolvedValue({
      ai_provider: 'groq',
      groq_api_key: 'gsk_1234567890_secret',
      cloudinary_api_secret: 'short',
      cloudinary_cloud_name: 'botpanel-cloud',
      telegram_bot_token: null,
    })

    const response = await dispatch('get', '/api/admin/server-settings', {
      auth: authorization(),
    })

    expect(response.body).toEqual({
      ai_provider: 'groq',
      groq_api_key: 'gsk_12••••••cret',
      cloudinary_api_secret: '••••••',
      cloudinary_cloud_name: 'botpanel-cloud',
      telegram_bot_token: '',
    })
    expect(JSON.stringify(response.body)).not.toContain('gsk_1234567890_secret')
  })

  it('solo confirma guardado cuando el servicio termina correctamente', async () => {
    const setMany = vi.spyOn(settings, 'setMany').mockResolvedValue()
    const payload = { ai_provider: 'gemini', gemini_api_key: 'gemini-secret' }

    const response = await dispatch('post', '/api/admin/server-settings', {
      auth: authorization(), body: payload,
    })

    expect(setMany).toHaveBeenCalledWith(payload)
    expect(response.body).toEqual({ ok: true })
  })

  it('no responde éxito ni expone PostgreSQL cuando guardar falla', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(settings, 'setMany').mockRejectedValue(
      new Error('detalle interno PostgreSQL'),
    )

    const response = await dispatch('post', '/api/admin/server-settings', {
      auth: authorization(), body: { ai_provider: 'openai' },
    })

    expect(response).toEqual({
      status: 500,
      body: { error: 'No se pudo guardar la configuración' },
    })
    expect(JSON.stringify(response.body)).not.toContain('PostgreSQL')
  })

  it.each([
    ['groq', 'Falta Groq API Key'],
    ['deepseek', 'Falta DeepSeek API Key'],
    ['gemini', 'Falta Gemini API Key'],
    ['openai', 'Falta OpenAI API Key'],
    ['claude', 'Falta Anthropic API Key'],
  ])('valida la clave requerida para %s sin llamar APIs', async (provider, info) => {
    delete process.env.ANTHROPIC_API_KEY
    vi.spyOn(settings, 'get').mockResolvedValue(null)
    const post = vi.spyOn(axios, 'post')
    const get = vi.spyOn(axios, 'get')

    const response = await dispatch('post', '/api/admin/server-settings/verify-ai', {
      auth: authorization(), body: { provider },
    })

    expect(response.body).toEqual({ ok: false, info })
    expect(post).not.toHaveBeenCalled()
    expect(get).not.toHaveBeenCalled()
  })

  it('verifica Gemini con una respuesta simulada y timeout acotado', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ data: { candidates: [{}] } })

    const response = await dispatch('post', '/api/admin/server-settings/verify-ai', {
      auth: authorization(),
      body: { provider: 'gemini', gemini_api_key: 'gemini-test-secret' },
    })

    expect(response.body).toEqual({
      ok: true,
      info: '✅ Gemini 2.0 Flash activo y conectado',
    })
    expect(post).toHaveBeenCalledWith(
      expect.stringContaining('gemini-2.0-flash:generateContent'),
      expect.any(Object),
      expect.objectContaining({ timeout: 10000 }),
    )
  })

  it('elimina claves de los errores devueltos por la IA', async () => {
    const secret = 'gemini-super-secret'
    const error = new Error('Request failed')
    error.isAxiosError = true
    error.response = { status: 401, data: { error: { message: `Key ${secret} inválida` } } }
    vi.spyOn(axios, 'post').mockRejectedValue(error)

    const response = await dispatch('post', '/api/admin/server-settings/verify-ai', {
      auth: authorization(),
      body: { provider: 'gemini', gemini_api_key: secret },
    })

    expect(response.body.ok).toBe(false)
    expect(response.body.info).toContain('[HTTP 401]')
    expect(response.body.info).not.toContain(secret)
  })

  it('verifica Cloudinary sin exponer su API secret en errores', async () => {
    const secret = 'cloudinary-super-secret'
    vi.spyOn(cloudinary, 'verify').mockRejectedValue({
      http_code: 401,
      error: { message: `Secret ${secret} inválido` },
    })

    const response = await dispatch(
      'post',
      '/api/admin/server-settings/verify-cloudinary',
      {
        auth: authorization(),
        body: {
          cloudinary_cloud_name: 'demo',
          cloudinary_api_key: 'cloud-key',
          cloudinary_api_secret: secret,
        },
      },
    )

    expect(response.body.ok).toBe(false)
    expect(response.body.info).toContain('[HTTP 401]')
    expect(response.body.info).not.toContain(secret)
  })
})
