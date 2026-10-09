import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import authRouter from '../dist/routes/auth.routes.js'

const require = createRequire(import.meta.url)
const bcrypt = require('bcryptjs')
const db = require('../dist/db')

const originalEnvironment = {
  JWT_SECRET: process.env.JWT_SECRET,
  ADMIN_EMAIL: process.env.ADMIN_EMAIL,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
}

beforeEach(() => {
  process.env.JWT_SECRET = 'auth-routes-test-secret'
  process.env.ADMIN_EMAIL = 'admin@example.com'
  process.env.ADMIN_PASSWORD = 'admin-password'
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

async function dispatch(path, body) {
  const routeLayer = authRouter.stack.find(layer => (
    layer.route?.path === path && layer.route?.methods?.post
  ))
  const finalHandler = routeLayer.route.stack.at(-1).handle
  const req = { body, headers: {} }
  const result = { status: 200, body: undefined, nextError: null }
  const res = {
    status(code) { result.status = code; return this },
    json(responseBody) { result.body = responseBody; return this },
  }

  await finalHandler(req, res, error => { result.nextError = error })
  if (result.nextError) throw result.nextError
  return result
}

describe('protección anti fuerza bruta', () => {
  it('conserva el mismo limiter en los dos logins', () => {
    expect(authRouter.loginRateLimitOptions).toEqual({
      windowMs: 15 * 60 * 1000,
      max: 20,
      skipSuccessfulRequests: true,
      standardHeaders: true,
      legacyHeaders: false,
      message: { error: 'Demasiados intentos fallidos. Espera 15 minutos.' },
    })

    for (const path of ['/api/admin/login', '/api/admin/login/configurar', '/api/admin/login/codigo', '/api/client/login']) {
      const route = authRouter.stack.find(layer => layer.route?.path === path)
      expect(route.route.stack).toHaveLength(2)
    }
  })
})

describe('POST /api/admin/login', () => {
  it('falla cerrado cuando las credenciales administrativas no están configuradas', async () => {
    delete process.env.ADMIN_EMAIL
    delete process.env.ADMIN_PASSWORD

    const response = await dispatch('/api/admin/login', {})

    expect(response).toMatchObject({
      status: 401,
      body: { error: 'Credenciales incorrectas' },
    })
  })

  it('rechaza credenciales incorrectas', async () => {
    const response = await dispatch('/api/admin/login', {
      email: 'admin@example.com',
      password: 'incorrecta',
    })

    expect(response).toMatchObject({
      status: 401,
      body: { error: 'Credenciales incorrectas' },
    })
  })

  it('la contraseña sola NO da la sesión: da un pase de 10 minutos para el código', async () => {
    // Hasta el 2026-09-29 daba aquí una sesión de 7 días. Ahora hace falta el
    // segundo paso: ver `superadmin-dos-pasos.test.js`.
    vi.spyOn(db, 'leerSegundoPasoDelAdmin')
      .mockResolvedValue({ clave: 'JBSWY3DPEHPK3PXP', pendiente: null, pendienteDesde: null, ultimoPaso: -1 })
    const response = await dispatch('/api/admin/login', {
      email: 'admin@example.com',
      password: 'admin-password',
    })
    const decoded = jwt.verify(response.body.pase, process.env.JWT_SECRET)

    expect(response.status).toBe(200)
    expect(response.body.token).toBeUndefined()
    expect(response.body.paso).toBe('codigo')
    expect(decoded).toMatchObject({ role: 'admin_2fa', email: 'admin@example.com', paso: 'codigo' })
    expect(decoded.exp - decoded.iat).toBe(10 * 60)
  })
})

describe('POST /api/client/login', () => {
  it('no revela si el usuario existe o la contraseña es incorrecta', async () => {
    const getClientByEmail = vi.spyOn(db, 'getClientByEmail')
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'user-a',
        business_id: 'business-a',
        password_hash: 'stored-hash',
      })
    const compare = vi.spyOn(bcrypt, 'compare').mockResolvedValue(false)

    const missing = await dispatch('/api/client/login', {
      email: 'missing@example.com', password: 'password',
    })
    const incorrect = await dispatch('/api/client/login', {
      email: 'user@example.com', password: 'incorrect',
    })

    expect(missing.status).toBe(401)
    expect(missing.body.error).toBe('Credenciales incorrectas')
    expect(incorrect.status).toBe(401)
    expect(incorrect.body.error).toBe('Credenciales incorrectas')
    expect(getClientByEmail).toHaveBeenCalledTimes(2)
    // Y TARDAN lo mismo: sin cuenta también se paga el bcrypt (2026-10-08).
    // Si no, cronometrando se sabría qué correos tienen cuenta.
    expect(compare).toHaveBeenCalledTimes(2)
  })

  it('una cuenta creada sin clave es un 401, no un 500', async () => {
    // `bcrypt.compare(clave, null)` lanza: antes eso acababa en «Error interno».
    vi.spyOn(db, 'getClientByEmail').mockResolvedValue({
      id: 'user-a', business_id: 'business-a', password_hash: null,
    })
    const response = await dispatch('/api/client/login', {
      email: 'user@example.com', password: 'una-clave-cualquiera',
    })
    expect(response.status).toBe(401)
    expect(response.body.error).toBe('Credenciales incorrectas')
  })

  it('rechaza negocios inactivos', async () => {
    vi.spyOn(db, 'getClientByEmail').mockResolvedValue({
      id: 'user-a', business_id: 'business-a', password_hash: 'stored-hash',
    })
    vi.spyOn(bcrypt, 'compare').mockResolvedValue(true)
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a', name: 'Demo', type: 'tienda', active: false,
    })

    const response = await dispatch('/api/client/login', {
      email: 'user@example.com', password: 'password',
    })

    expect(response.status).toBe(403)
    expect(response.body.error).toBe('Tu cuenta no está activa. Contacta al administrador.')
  })

  it('verifica bcrypt y devuelve un JWT cliente sin contraseña', async () => {
    const compare = vi.spyOn(bcrypt, 'compare').mockResolvedValue(true)
    vi.spyOn(db, 'getClientByEmail').mockResolvedValue({
      id: 'user-a',
      business_id: 'business-a',
      password_hash: 'stored-hash',
      name: 'Ana',
      role: 'employee',
      permissions: ['horarios', 'ventas'],
    })
    vi.spyOn(db, 'getBusinessById').mockResolvedValue({
      id: 'business-a',
      name: 'Demo',
      type: 'servicios',
      active: true,
      suspended: false,
      bot_active: true,
    })

    const response = await dispatch('/api/client/login', {
      email: 'ana@example.com', password: 'plain-password',
    })
    const decoded = jwt.verify(response.body.token, process.env.JWT_SECRET)

    expect(response.status).toBe(200)
    expect(compare).toHaveBeenCalledWith('plain-password', 'stored-hash')
    expect(decoded).toMatchObject({
      userId: 'user-a',
      businessId: 'business-a',
      role: 'client',
      urole: 'employee',
      perms: ['horarios', 'ventas'],
      email: 'ana@example.com',
    })
    expect(response.body).not.toHaveProperty('password_hash')
    expect(response.body.user).toEqual({
      name: 'Ana', role: 'employee', permissions: ['horarios', 'ventas'],
    })
    // El panel pinta la franja de demostración solo si el local lo es (2026-09-30).
    expect(response.body.business.demo).toBe(false)
  })

  it('convierte fallos internos en respuesta 500 controlada', async () => {
    vi.spyOn(db, 'getClientByEmail').mockRejectedValue(new Error('fallo controlado'))

    const response = await dispatch('/api/client/login', {
      email: 'user@example.com', password: 'password',
    })

    expect(response).toMatchObject({
      status: 500,
      body: { error: 'No se pudo iniciar sesión' },
    })
  })
})
