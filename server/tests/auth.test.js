import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import jwt from 'jsonwebtoken'
import auth from '../dist/middleware/auth.js'

const JWT_SECRET = 'auth-middleware-test-secret'
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

function run(middleware, token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} }
  const result = { status: 200, body: null, nextCalled: false, req }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  middleware(req, res, () => { result.nextCalled = true })
  return result
}

function sign(claims, options) {
  return jwt.sign(claims, JWT_SECRET, options)
}

async function runAsync(middleware, token) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {} }
  const result = { status: 200, body: null, nextCalled: false, req }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  await middleware(req, res, () => { result.nextCalled = true })
  return result
}

describe('autenticación administrativa', () => {
  it('no permite firmar ni verificar tokens sin JWT_SECRET', () => {
    delete process.env.JWT_SECRET
    expect(() => auth.JWT()).toThrow('JWT_SECRET no está configurado')
  })

  it('rechaza solicitudes sin token', () => {
    expect(run(auth.authAdmin).status).toBe(401)
  })

  it('acepta únicamente un JWT administrativo válido', () => {
    const valid = run(auth.authAdmin, sign({ role: 'admin', mfa: true, email: 'admin@example.com' }))
    const client = run(auth.authAdmin, sign({ role: 'client', businessId: 'business-a' }))

    expect(valid.nextCalled).toBe(true)
    expect(valid.req.user.email).toBe('admin@example.com')
    expect(client.status).toBe(403)
    expect(client.nextCalled).toBe(false)
  })

  it('rechaza tokens manipulados o vencidos', () => {
    const manipulated = `${sign({ role: 'admin' })}x`
    const expired = sign({ role: 'admin' }, { expiresIn: -1 })

    expect(run(auth.authAdmin, manipulated).status).toBe(401)
    expect(run(auth.authAdmin, expired).status).toBe(401)
  })
})

describe('autenticación de clientes', () => {
  it('requiere rol cliente y businessId', () => {
    const valid = run(auth.authClient, sign({ role: 'client', businessId: 'business-a' }))
    const missingBusiness = run(auth.authClient, sign({ role: 'client' }))
    const admin = run(auth.authClient, sign({ role: 'admin' }))

    expect(valid.nextCalled).toBe(true)
    expect(valid.req.user.businessId).toBe('business-a')
    expect(missingBusiness.status).toBe(403)
    expect(admin.status).toBe(403)
  })

  it('rechaza solicitudes sin token o con firma incorrecta', () => {
    const wrongSecret = jwt.sign({ role: 'client', businessId: 'business-a' }, 'otro-secreto')

    expect(run(auth.authClient).status).toBe(401)
    expect(run(auth.authClient, wrongSecret).status).toBe(401)
  })
})

describe('autorización por rol y permisos', () => {
  it('permite al dueño cualquier sección', () => {
    const middleware = auth.requirePermission('ventas')
    const owner = { role: 'client', businessId: 'business-a', urole: 'owner' }

    const authorized = runWithUser(middleware, owner)
    expect(authorized.nextCalled).toBe(true)
  })

  it('permite al empleado solo sus secciones y deniega por defecto', () => {
    const user = {
      role: 'client',
      businessId: 'business-a',
      urole: 'employee',
      perms: ['horarios'],
    }

    expect(runWithUser(auth.requirePermission('horarios'), user).nextCalled).toBe(true)
    expect(runWithUser(auth.requirePermission('ventas'), user).status).toBe(403)
    expect(runWithUser(auth.requirePermission('ventas'), { ...user, perms: null }).status).toBe(403)
  })

  it('requireOwner rechaza empleados y acepta al dueño', () => {
    const base = { role: 'client', businessId: 'business-a' }

    expect(runWithUser(auth.requireOwner, { ...base, urole: 'employee' }).status).toBe(403)
    expect(runWithUser(auth.requireOwner, { ...base, urole: 'owner' }).nextCalled).toBe(true)
  })
})

describe('vigencia de la sesión cliente', () => {
  it('revalida usuario, negocio y permisos actuales', async () => {
    const database = {
      getClientUserById: vi.fn().mockResolvedValue({
        id: 'user-a', business_id: 'business-a', role: 'employee', permissions: ['horarios'],
      }),
      getBusinessById: vi.fn().mockResolvedValue({
        active: true, suspended: false,
      }),
    }
    const guard = auth.createActiveClientGuard({ database })
    const token = sign({
      role: 'client', businessId: 'business-a', userId: 'user-a',
      urole: 'owner', perms: ['ventas'],
    })

    const result = await runAsync(guard, token)

    expect(result.nextCalled).toBe(true)
    expect(result.req.user).toMatchObject({
      businessId: 'business-a', userId: 'user-a', urole: 'employee',
      perms: ['horarios'],
    })
    expect(database.getClientUserById).toHaveBeenCalledWith('business-a', 'user-a')
  })

  it('rechaza usuarios eliminados, negocios suspendidos y tokens antiguos', async () => {
    const token = sign({ role: 'client', businessId: 'business-a', userId: 'user-a' })
    const deleted = auth.createActiveClientGuard({
      database: {
        getClientUserById: vi.fn().mockResolvedValue(null),
        getBusinessById: vi.fn().mockResolvedValue({ active: true }),
      },
    })
    const suspended = auth.createActiveClientGuard({
      database: {
        getClientUserById: vi.fn().mockResolvedValue({
          business_id: 'business-a', role: 'owner', permissions: [],
        }),
        getBusinessById: vi.fn().mockResolvedValue({ active: true, suspended: true }),
      },
    })

    expect((await runAsync(deleted, token)).status).toBe(401)
    expect((await runAsync(suspended, token)).status).toBe(401)
    expect((await runAsync(
      deleted,
      sign({ role: 'client', businessId: 'business-a' }),
    )).status).toBe(401)
  })

  it('falla cerrado si la base no puede validar la sesión', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const guard = auth.createActiveClientGuard({
      database: {
        getClientUserById: vi.fn().mockRejectedValue(new Error('base caída')),
        getBusinessById: vi.fn().mockResolvedValue({ active: true }),
      },
    })
    const token = sign({ role: 'client', businessId: 'business-a', userId: 'user-a' })

    expect(await runAsync(guard, token)).toMatchObject({
      status: 503,
      body: { error: 'No se pudo validar la sesión' },
      nextCalled: false,
    })
  })
})

function runWithUser(middleware, user) {
  const req = { headers: {}, user }
  const result = { status: 200, body: null, nextCalled: false, req }
  const res = {
    status(code) { result.status = code; return this },
    json(body) { result.body = body; return this },
  }
  middleware(req, res, () => { result.nextCalled = true })
  return result
}
