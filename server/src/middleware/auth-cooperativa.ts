import type { Request, RequestHandler } from 'express'
import jwt from 'jsonwebtoken'
import { conActor } from '../lib/actor-de-la-peticion'
import { JWT } from './auth'

// ═══════════════════════════════════════════════════════════════════════════
// LA SESIÓN DEL PANEL DE UNA COOPERATIVA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Como la del local (`createActiveClientGuard`): el token dice quién es, y
// cada 15 s como mucho se vuelve a mirar en la base que el usuario y SU
// cooperativa sigan activos. Desactivar una cooperativa le corta el panel al
// momento, sin esperar a que venzan los 7 días del token.
//
// ⚠️ El id de la cooperativa sale SIEMPRE de aquí (`cooperativaDe`), nunca de
// la petición. Con un rol propio (`cooperativa`): ni el panel del local ni el
// superadmin ni la app aceptan este token, y este no acepta los suyos.

export interface SesionDeCooperativa {
  cooperativeId: string
  userId: string
  email: string
}

interface BaseDeLaSesion {
  getCooperativeUserById(cooperativeId: string, userId: string): Promise<{ active?: boolean | null; cooperative_id?: string } | null>
  getCooperative(id: string): Promise<{ active?: boolean | null } | null>
}

type ConCooperativa = Request & { cooperativa?: SesionDeCooperativa }

/** La cooperativa de la sesión. Solo detrás de la guardia. */
export const cooperativaDe = (req: Request): SesionDeCooperativa => (req as ConCooperativa).cooperativa!

/** Cómo se nombra a quien actúa, en el registro de dinero. */
const actor = (sesion: SesionDeCooperativa) => `cooperativa:${sesion.email || sesion.userId}`

export function firmarSesionDeCooperativa(sesion: SesionDeCooperativa): string {
  return jwt.sign({ role: 'cooperativa', ...sesion }, JWT(), { expiresIn: '7d' })
}

export function createCooperativeGuard(dependencias: {
  database: BaseDeLaSesion
  now?: () => number
  cacheTtlMs?: number
}): RequestHandler {
  const now = dependencias.now || Date.now
  const ttl = dependencias.cacheTtlMs ?? 15_000
  const cache = new Map<string, { hasta: number; sesion: SesionDeCooperativa }>()

  return async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1]
    if (!token) return res.status(401).json({ error: 'No autorizado' })

    let datos: jwt.JwtPayload | string
    try {
      datos = jwt.verify(token, JWT())
    } catch {
      return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo.' })
    }
    if (typeof datos === 'string' || datos.role !== 'cooperativa'
      || typeof datos.cooperativeId !== 'string' || typeof datos.userId !== 'string') {
      return res.status(401).json({ error: 'Tu sesión venció. Entra de nuevo.' })
    }

    const clave = `${datos.cooperativeId}:${datos.userId}`
    const guardada = cache.get(clave)
    if (guardada && guardada.hasta > now()) {
      ;(req as ConCooperativa).cooperativa = guardada.sesion
      return conActor(actor(guardada.sesion), next)
    }

    try {
      const [usuario, cooperativa] = await Promise.all([
        dependencias.database.getCooperativeUserById(datos.cooperativeId, datos.userId),
        dependencias.database.getCooperative(datos.cooperativeId),
      ])
      if (!usuario?.active || usuario.cooperative_id !== datos.cooperativeId || !cooperativa?.active) {
        cache.delete(clave)
        return res.status(401).json({ error: 'Tu acceso ya no está activo. Habla con Umbani.' })
      }
      const sesion: SesionDeCooperativa = {
        cooperativeId: datos.cooperativeId,
        userId: datos.userId,
        email: typeof datos.email === 'string' ? datos.email : '',
      }
      cache.set(clave, { hasta: now() + ttl, sesion })
      ;(req as ConCooperativa).cooperativa = sesion
      return conActor(actor(sesion), next)
    } catch (error) {
      // Falla CERRADO: una sesión que no se pudo comprobar no pasa.
      console.error('❌ Sesión de cooperativa:', (error as Error).message)
      return res.status(503).json({ error: 'No se pudo comprobar tu sesión. Inténtalo en un momento.' })
    }
  }
}

const database: BaseDeLaSesion = require('../db') as typeof import('../db')
export const cooperativaGuard = createCooperativeGuard({ database })
