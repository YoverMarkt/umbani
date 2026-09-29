import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import providersRouter from '../dist/routes/admin-providers.routes.js'

const require = createRequire(import.meta.url)
const axios = require('axios')
const db = require('../dist/db')
const JWT_SECRET = 'admin-providers-test-secret'
const originalEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  YCLOUD_API_KEY: process.env.YCLOUD_API_KEY,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
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

async function dispatch(path, { auth, body = {}, params = {} } = {}) {
  const layer = providersRouter.stack.find(item => item.route?.path === path)
  const handlers = layer.route.stack.map(item => item.handle)
  const req = { headers: auth ? { authorization: auth } : {}, body, params }
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

describe('verificación de proveedores del superadmin', () => {
  it('protege TODOS sus endpoints exclusivamente con autenticación admin', async () => {
    // Tres desde el 2026-08-22: los dos de siempre y el del número del
    // marketplace. El conteo es a propósito — si mañana se añade un cuarto
    // sin `authAdmin`, esta cuenta falla y obliga a mirarlo.
    expect(providersRouter.stack).toHaveLength(3)
    expect(providersRouter.stack.every(layer => layer.route.stack.length === 2)).toBe(true)
    for (const ruta of [
      '/api/admin/verify-provider',
      '/api/admin/verify-platform-channel',
    ]) {
      expect((await dispatch(ruta)).status, `${ruta} sin token`).toBe(401)
      expect((await dispatch(ruta, { auth: authorization('client') })).status,
        `${ruta} con token de cliente`).toBe(403)
    }
  })

  it('valida campos requeridos sin realizar llamadas externas', async () => {
    delete process.env.YCLOUD_API_KEY
    const get = vi.spyOn(axios, 'get')

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: { provider: 'ycloud' },
    })

    expect(response.body).toEqual({ ok: false, info: 'Falta YCloud API Key' })
    expect(get).not.toHaveBeenCalled()
  })

  it('confirma que el número YCloud pertenece a la cuenta verificada', async () => {
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        items: [{
          phoneNumber: '+593999000001',
          displayName: 'Negocio Demo',
        }],
      },
    })

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: {
        provider: 'ycloud',
        ycloud_api_key: 'ycloud-test-secret',
        ycloud_number: '593 999 000 001',
        ycloud_webhook_secret: 'whsec_de_prueba',
        ycloud_webhook_endpoint_id: '6a41a4f44de0392666e757f4',
      },
    })

    expect(response.body).toEqual({
      ok: true,
      info: '✅ Conectado: +593999000001 — Negocio Demo',
    })
    expect(get).toHaveBeenCalledWith(
      'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'ycloud-test-secret' }),
        timeout: 10000,
      }),
    )
  })

  it('avisa que faltan las credenciales del webhook aunque la API Key funcione', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { items: [{ phoneNumber: '+593999000001', displayName: 'Negocio Demo' }] },
    })

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: {
        provider: 'ycloud',
        ycloud_api_key: 'ycloud-test-secret',
        ycloud_number: '593 999 000 001',
      },
    })

    // Sin Signing Secret el webhook se rechaza en producción (503): la
    // verificación no puede dar "todo bien" solo porque la API Key sirve
    expect(response.body.ok).toBe(false)
    expect(response.body.info).toContain('Conectado: +593999000001')
    expect(response.body.info).toContain('Signing Secret')
    expect(response.body.info).toContain('Endpoint ID')
    expect(response.body.info).toContain('no recibirá mensajes')
  })

  it('no valida un número local solo porque comparte los últimos nueve dígitos', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: { items: [{ phoneNumber: '+593999000001' }] },
    })

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: {
        provider: 'ycloud',
        ycloud_api_key: 'ycloud-test-secret',
        ycloud_number: '0999000001',
      },
    })

    expect(response.body.ok).toBe(false)
    expect(response.body.info).toContain('formato internacional E.164')
  })

  it('verifica credenciales guardadas únicamente desde el negocio solicitado', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      whatsapp_provider: 'meta',
      meta_token: 'meta-test-secret',
      meta_phone_id: 'phone-a',
    })
    vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        verified_name: 'Empresa A',
        display_phone_number: '+593200000001',
        code_verification_status: 'VERIFIED',
      },
    })

    const response = await dispatch('/api/admin/clients/:id/verify', {
      auth: authorization(),
      params: { id: 'business-a' },
    })

    expect(db.getBusinessById).toHaveBeenCalledWith('business-a')
    expect(response.body).toEqual({
      ok: true,
      info: 'Empresa A — +593200000001 (VERIFIED)',
    })
    expect(JSON.stringify(response.body)).not.toContain('meta-test-secret')
  })

  it('verifica el proveedor prospectivo de una edición y no el proveedor guardado', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      whatsapp_provider: 'meta',
      meta_token: 'meta-stored-secret',
      meta_phone_id: 'phone-meta',
      ycloud_api_key: 'ycloud-stored-secret',
      ycloud_number: '+593999000001',
      ycloud_webhook_secret: 'whsec_guardado',
      ycloud_webhook_endpoint_id: '6a41a4f44de0392666e757f4',
    })
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        items: [{ phoneNumber: '+593999000002', displayName: 'Nueva línea' }],
      },
    })

    const response = await dispatch('/api/admin/clients/:id/verify', {
      auth: authorization(),
      params: { id: 'business-a' },
      body: {
        provider: 'ycloud',
        ycloud_number: '+593999000002',
      },
    })

    expect(response.body).toEqual({
      ok: true,
      info: '✅ Conectado: +593999000002 — Nueva línea',
    })
    expect(get).toHaveBeenCalledWith(
      'https://api.ycloud.com/v2/whatsapp/phoneNumbers',
      expect.objectContaining({
        headers: expect.objectContaining({ 'X-API-Key': 'ycloud-stored-secret' }),
      }),
    )
    expect(get.mock.calls.some(([url]) => String(url).includes('graph.facebook.com'))).toBe(false)
    expect(JSON.stringify(response.body)).not.toContain('ycloud-stored-secret')
    expect(JSON.stringify(response.body)).not.toContain('meta-stored-secret')
  })

  it('combina un identificador prospectivo con el token Meta guardado', async () => {
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'ycloud-stored-secret',
      meta_token: 'meta-stored-secret',
      meta_phone_id: 'phone-old',
    })
    const get = vi.spyOn(axios, 'get').mockResolvedValue({
      data: {
        verified_name: 'Empresa Nueva',
        display_phone_number: '+593200000002',
        code_verification_status: 'VERIFIED',
      },
    })

    const response = await dispatch('/api/admin/clients/:id/verify', {
      auth: authorization(),
      params: { id: 'business-a' },
      body: { provider: 'meta', meta_phone_id: 'phone-new' },
    })

    expect(response.body.ok).toBe(true)
    expect(get).toHaveBeenCalledWith(
      'https://graph.facebook.com/v25.0/phone-new',
      expect.objectContaining({
        params: expect.objectContaining({ access_token: 'meta-stored-secret' }),
      }),
    )
    expect(JSON.stringify(response.body)).not.toContain('meta-stored-secret')
  })

  it('elimina secretos de los errores devueltos por proveedores', async () => {
    const secret = 'meta-super-secret'
    const error = new Error('Request failed')
    error.isAxiosError = true
    error.response = {
      status: 401,
      data: { message: `Credencial ${secret} inválida` },
    }
    vi.spyOn(axios, 'get').mockRejectedValue(error)

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: { provider: 'meta', meta_token: secret, meta_phone_id: 'phone-a' },
    })

    expect(response.body.ok).toBe(false)
    expect(response.body.info).toContain('[HTTP 401]')
    expect(response.body.info).toContain('API Key inválida o sin permisos')
    expect(response.body.info).not.toContain(secret)
  })

  it('elimina también secretos globales de los errores del proveedor', async () => {
    const secret = 'ycloud-environment-super-secret'
    process.env.YCLOUD_API_KEY = secret
    const error = new Error('Request failed')
    error.isAxiosError = true
    error.response = {
      status: 401,
      data: { message: `Credencial ${secret} inválida` },
    }
    vi.spyOn(axios, 'get').mockRejectedValue(error)

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: { provider: 'ycloud', ycloud_number: '+593999000001' },
    })

    expect(response.body.ok).toBe(false)
    expect(response.body.info).not.toContain(secret)
    expect(response.body.info).toContain('••••••')
  })

  it('no refleja valores arbitrarios enviados como proveedor', async () => {
    const unknownProvider = 'credential-looking-provider-value'

    const response = await dispatch('/api/admin/verify-provider', {
      auth: authorization(),
      body: { provider: unknownProvider },
    })

    expect(response.body).toEqual({ ok: false, info: 'Proveedor no reconocido' })
    expect(JSON.stringify(response.body)).not.toContain(unknownProvider)
  })
})
