import type { RequestHandler } from 'express'
import jwt, { type JwtPayload } from 'jsonwebtoken'

interface ActiveClientUser {
  id?: string
  business_id?: string
  role?: string | null
  permissions?: unknown
}

interface ActiveBusiness {
  active?: boolean | null
  suspended?: boolean | null
}

interface SessionDatabase {
  getClientUserById(businessId: string, userId: string): Promise<ActiveClientUser | null>
  getBusinessById(businessId: string): Promise<ActiveBusiness | null>
}

interface ClientSessionDependencies {
  database: SessionDatabase
  now?: () => number
  cacheTtlMs?: number
}

interface CachedClientSession {
  expiresAt: number
  user: Express.ClientUserClaims
}

export function JWT(): string {
  const secret = process.env.JWT_SECRET?.trim()
  if (!secret) throw new Error('JWT_SECRET no está configurado')
  return secret
}

function decodedPayload(token: string): JwtPayload | null {
  const decoded = jwt.verify(token, JWT())
  return typeof decoded === 'string' ? null : decoded
}

export const authAdmin: RequestHandler = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })

  try {
    const decoded = decodedPayload(token)
    if (!decoded || decoded.role !== 'admin') {
      return res.status(403).json({ error: 'Solo admins' })
    }
    // ⚠️ Solo la sesión que pasó el SEGUNDO PASO (2026-09-29). Las de antes
    // —7 días, solo contraseña— dejan de valer al desplegar, y es a propósito.
    // 401 y no 403: el panel lo lee como «sesión vencida» y vuelve al login.
    if (decoded.mfa !== true) {
      return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo con tu código.' })
    }
    req.user = decoded as Express.AdminUserClaims
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

export const authClient: RequestHandler = (req, res, next) => {
  if (req.user?.role === 'client') return next()
  const token = req.headers.authorization?.split(' ')[1]
  if (!token) return res.status(401).json({ error: 'No autorizado' })

  try {
    const decoded = decodedPayload(token)
    if (!decoded || decoded.role !== 'client' || !decoded.businessId) {
      return res.status(403).json({ error: 'Solo clientes' })
    }
    req.user = decoded as Express.ClientUserClaims
    next()
  } catch {
    res.status(401).json({ error: 'Token inválido' })
  }
}

export function createActiveClientGuard(
  dependencies: ClientSessionDependencies,
): RequestHandler {
  const now = dependencies.now || Date.now
  const cacheTtlMs = dependencies.cacheTtlMs ?? 15_000
  const cache = new Map<string, CachedClientSession>()

  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No autorizado' })

    let decoded: JwtPayload | null
    try {
      decoded = decodedPayload(token)
    } catch {
      return res.status(401).json({ error: 'Token inválido' })
    }
    if (!decoded || decoded.role !== 'client'
      || typeof decoded.businessId !== 'string'
      || typeof decoded.userId !== 'string') {
      return res.status(401).json({ error: 'Sesión desactualizada. Inicia sesión nuevamente.' })
    }

    const cacheKey = `${decoded.businessId}:${decoded.userId}`
    const cached = cache.get(cacheKey)
    if (cached && cached.expiresAt > now()) {
      req.user = cached.user
      return next()
    }

    try {
      const [user, business] = await Promise.all([
        dependencies.database.getClientUserById(decoded.businessId, decoded.userId),
        dependencies.database.getBusinessById(decoded.businessId),
      ])
      if (!user || user.business_id !== decoded.businessId
        || !business?.active || business.suspended) {
        cache.delete(cacheKey)
        return res.status(401).json({ error: 'La sesión ya no está activa' })
      }

      const current: Express.ClientUserClaims = {
        role: 'client',
        businessId: decoded.businessId,
        userId: decoded.userId,
        email: typeof decoded.email === 'string' ? decoded.email : undefined,
        urole: user.role === 'owner' ? 'owner' : 'employee',
        perms: Array.isArray(user.permissions)
          ? user.permissions.filter((value): value is string => typeof value === 'string')
          : [],
      }
      cache.set(cacheKey, { user: current, expiresAt: now() + cacheTtlMs })
      req.user = current
      return next()
    } catch (error) {
      console.error('❌ Validación de sesión cliente:', (error as Error).message)
      return res.status(503).json({ error: 'No se pudo validar la sesión' })
    }
  }
}

const database: SessionDatabase = require('../db') as typeof import('../db')
export const activeClientGuard = createActiveClientGuard({ database })

export function requirePermission(section: string): RequestHandler {
  return (req, res, next) => {
    const user = req.user as Express.ClientUserClaims | undefined
    if (user?.urole === 'owner') return next()

    const permissions = Array.isArray(user?.perms) ? user.perms : []
    if (permissions.includes(section)) return next()
    return res.status(403).json({ error: 'No tienes permiso para esta sección' })
  }
}

export const requireOwner: RequestHandler = (req, res, next) => {
  const user = req.user as Express.ClientUserClaims | undefined
  if (user?.urole === 'owner') return next()
  return res.status(403).json({ error: 'Solo el dueño puede hacer esto' })
}
