import jwt from 'jsonwebtoken'
import type { Request, RequestHandler } from 'express'

// ═══════════════════════════════════════════════════════════════════════════
// LA SESIÓN DEL CLIENTE EN LA APP (Flutter)
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde el 2026-10-09 las apps entran SOLO con el correo
// (`entrar-con-correo.ts`): la entrada por WhatsApp se retiró. Aquí se firma
// la sesión. Las sesiones por TELÉFONO que ya se emitieron siguen valiendo
// hasta caducar, y el bot —WhatsApp en espera— sigue sabiendo leer un código.
//
// ⚠️ `role: 'cliente_app'` y audiencia `umbani-app`: `authAdmin` exige
// `admin` y `authClient` exige `client` con negocio, así que este token no
// abre NINGÚN panel. Solo sirve para las rutas `/api/v1/*` de la app.

/** Los códigos de la entrada por WhatsApp: sin 0/O ni 1/I. */
export const CODIGO_VALIDO = /^[A-HJ-NP-Z2-9]{6}$/
const AUDIENCIA = 'umbani-app'
const DURACION = '30d'

/** Lee el código de un mensaje de WhatsApp, o null si no es uno. */
export function codigoEnElMensaje(texto: string): string | null {
  const encontrado = /c[oó]digo\s+de\s+umbani\W*([A-Za-z0-9]{6})\b/i.exec(String(texto || ''))
  const codigo = encontrado?.[1]?.toUpperCase() || null
  return codigo && CODIGO_VALIDO.test(codigo) ? codigo : null
}

const secreto = (): string => {
  const valor = process.env.JWT_SECRET
  if (!valor) throw new Error('Falta JWT_SECRET')
  return valor
}

export function firmarSesionApp(telefono: string): string {
  return jwt.sign({ role: 'cliente_app', phone: telefono }, secreto(), { audience: AUDIENCIA, expiresIn: DURACION })
}

/** La sesión de quien probó su CORREO (2026-10-06): la puerta de las apps desde que no entran por WhatsApp. */
export function firmarSesionDeCorreo(correo: string): string {
  return jwt.sign({ role: 'cliente_app', email: correo }, secreto(), { audience: AUDIENCIA, expiresIn: DURACION })
}

/**
 * Lo que prueba una sesión: un teléfono (WhatsApp) O un correo, nunca los dos
 * ni ninguno, y cuándo se emitió. `null` si el token no es de la app o no vale.
 */
export interface SesionDeLaApp {
  telefono: string | null
  correo: string | null
  emitidaMs: number
}

export function leerSesionAppConFecha(token: string): SesionDeLaApp | null {
  try {
    const datos = jwt.verify(token, secreto(), { audience: AUDIENCIA }) as { role?: string; phone?: unknown; email?: unknown; iat?: number }
    if (datos?.role !== 'cliente_app') return null
    const telefono = typeof datos.phone === 'string' && datos.phone ? datos.phone : null
    const correo = typeof datos.email === 'string' && datos.email ? datos.email : null
    if (Boolean(telefono) === Boolean(correo)) return null
    return { telefono, correo, emitidaMs: Number(datos.iat) * 1000 }
  } catch {
    return null
  }
}

/** El teléfono de la sesión, o null si el token no es de la app o no vale. */
export function leerSesionApp(token: string): string | null {
  return leerSesionAppConFecha(token)?.telefono ?? null
}

/**
 * ¿Se cerró esta sesión desde WhatsApp? (2026-09-29)
 *
 * Un token emitido ANTES del último «CERRAR SESIÓN» de ese teléfono ya no vale.
 * `iat` va en segundos: uno emitido en el mismo segundo del corte cuenta como
 * anterior, y lo peor que pasa es pedir un código más.
 */
export const sesionCerrada = (emitidaMs: number, validasDesde: string | null): boolean => {
  if (!validasDesde) return false
  const corte = Date.parse(validasDesde)
  return Number.isFinite(corte) && !(emitidaMs > corte)
}

/**
 * El teléfono de la sesión de la app, o 401. Lo usan la app del cliente y la del motorizado.
 *
 * ⚠️ Desde el 2026-09-29 pregunta a la base si la sesión se CERRÓ desde
 * WhatsApp, y falla CERRADO (503) si la base no responde: una sesión cerrada
 * que vuelve a abrir cuando la base va lenta no está cerrada.
 */
export const authApp: RequestHandler = async (req, res, next) => {
  const cabecera = String(req.headers.authorization || '')
  const sesion = cabecera.startsWith('Bearer ') ? leerSesionAppConFecha(cabecera.slice(7).trim()) : null
  if (!sesion) return res.status(401).json({ error: 'Inicia sesión otra vez' })

  // Diferido: este módulo lo importa el menú del marketplace al arrancar.
  const db = require('../db') as typeof import('../db')
  let validasDesde: string | null
  try {
    validasDesde = sesion.telefono
      ? await db.sesionesDeLaAppValidasDesde(sesion.telefono)
      : await db.sesionesDeLaAppValidasDesdeCorreo(sesion.correo || '')
  } catch {
    return res.status(503).json({ error: 'No se pudo comprobar tu sesión. Inténtalo en un momento.' })
  }
  if (sesionCerrada(sesion.emitidaMs, validasDesde)) {
    return res.status(401).json({ error: sesion.telefono
      ? 'Tu sesión se cerró desde WhatsApp. Inicia sesión otra vez.'
      : 'Tu sesión se cerró. Inicia sesión otra vez.' })
  }
  ;(req as ConSesionDeLaApp).telefonoApp = sesion.telefono || ''
  ;(req as ConSesionDeLaApp).correoApp = sesion.correo || ''
  return next()
}

type ConSesionDeLaApp = Request & { telefonoApp?: string; correoApp?: string }

/** El teléfono que probó la sesión (la puerta de WhatsApp), o '' si entró con correo. */
export const telefonoDe = (req: Request): string => String((req as ConSesionDeLaApp).telefonoApp || '')
/** El correo que probó la sesión, o '' si entró por WhatsApp. */
export const correoDe = (req: Request): string => String((req as ConSesionDeLaApp).correoApp || '')
