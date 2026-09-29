import { describe, it, expect } from 'vitest'
import jwt from 'jsonwebtoken'
import secrets from '../dist/services/secrets.js'
import auth from '../dist/middleware/auth.js'
import asyncTools from '../dist/middleware/async.js'

describe('credenciales de negocios', () => {
  it('no expone secretos completos al panel admin', () => {
    const business = {
      id: 'biz-1',
      name: 'Demo',
      ycloud_api_key: 'ycloud-secret',
      ycloud_webhook_secret: 'ycloud-signing-secret',
      meta_token: 'meta-secret',
      telegram_bot_token: null,
    }
    const safe = secrets.sanitizeBusinessForAdmin(business)

    expect(safe.id).toBe('biz-1')
    for (const field of secrets.BUSINESS_SECRET_FIELDS) {
      expect(safe).not.toHaveProperty(field)
    }
    expect(safe.credential_status.ycloud_api_key).toBe(true)
    expect(safe.credential_status.ycloud_webhook_secret).toBe(true)
    expect(safe.credential_status.meta_token).toBe(true)
    expect(safe.credential_status.telegram_bot_token).toBe(false)
    expect(business.ycloud_api_key).toBe('ycloud-secret')
    expect(business.telegram_bot_token).toBeNull()
  })

  it('conserva campos públicos y marca credenciales vacías como no configuradas', () => {
    const safe = secrets.sanitizeBusinessForAdmin({
      id: 'biz-2',
      name: 'Negocio público',
      ycloud_api_key: '',
    })

    expect(safe.name).toBe('Negocio público')
    expect(safe.credential_status.ycloud_api_key).toBe(false)
    expect(Object.keys(safe.credential_status)).toEqual(secrets.BUSINESS_SECRET_FIELDS)
  })

  it('respeta valores nulos usados por rutas sin negocio', () => {
    expect(secrets.sanitizeBusinessForAdmin(null)).toBeNull()
    expect(secrets.sanitizeBusinessForAdmin(undefined)).toBeUndefined()
  })
})

describe('middleware de cliente', () => {
  const originalSecret = process.env.JWT_SECRET

  const run = token => {
    let status = 200
    let body = null
    let nextCalled = false
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = {
      status(code) { status = code; return this },
      json(data) { body = data; return this },
    }
    auth.authClient(req, res, () => { nextCalled = true })
    return { status, body, nextCalled, req }
  }

  it('acepta solo un token cliente con businessId', () => {
    process.env.JWT_SECRET = 'test-secret'
    const token = jwt.sign({ role: 'client', businessId: 'biz-1' }, process.env.JWT_SECRET)
    const result = run(token)
    expect(result.nextCalled).toBe(true)
    expect(result.req.user.businessId).toBe('biz-1')
    process.env.JWT_SECRET = originalSecret
  })

  it('rechaza un token de administrador en rutas cliente', () => {
    process.env.JWT_SECRET = 'test-secret'
    const token = jwt.sign({ role: 'admin', mfa: true }, process.env.JWT_SECRET)
    const result = run(token)
    expect(result.nextCalled).toBe(false)
    expect(result.status).toBe(403)
    process.env.JWT_SECRET = originalSecret
  })
})

describe('errores asíncronos de Express', () => {
  it('propaga un rechazo al middleware de error', async () => {
    const expected = new Error('fallo controlado')
    let received = null
    const handler = asyncTools.asyncHandler(async () => { throw expected })
    await handler({}, {}, error => { received = error })
    expect(received).toBe(expected)
  })

  it('propaga también errores síncronos', async () => {
    const expected = new Error('fallo síncrono')
    let received = null
    const handler = asyncTools.asyncHandler(() => { throw expected })
    await handler({}, {}, error => { received = error })
    expect(received).toBe(expected)
  })
})
