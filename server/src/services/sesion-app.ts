import { randomInt } from 'node:crypto'
import jwt from 'jsonwebtoken'
import type { Request, RequestHandler } from 'express'

// ═══════════════════════════════════════════════════════════════════════════
// LA SESIÓN DEL CLIENTE EN LA APP (Flutter)
// ═══════════════════════════════════════════════════════════════════════════
//
// El teléfono lo prueba WhatsApp (ver `migration-2026-09-28-login-con-
// whatsapp.sql`); aquí solo se generan los códigos y se firma la sesión.
//
// ⚠️ `role: 'cliente_app'` y audiencia `umbani-app`: `authAdmin` exige
// `admin` y `authClient` exige `client` con negocio, así que este token no
// abre NINGÚN panel. Solo sirve para las rutas `/api/v1/*` de la app.

/** Sin 0/O ni 1/I: el cliente no los tiene que distinguir, pero se leen en voz alta. */
const ALFABETO = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const CODIGO_VALIDO = /^[A-HJ-NP-Z2-9]{6}$/
export const VIGENCIA_DEL_CODIGO_MS = 10 * 60 * 1000
const AUDIENCIA = 'umbani-app'
const DURACION = '30d'

export function generarCodigo(): string {
  let codigo = ''
  for (let i = 0; i < 6; i++) codigo += ALFABETO[randomInt(ALFABETO.length)]
  return codigo
}

/** El mensaje que la app deja escrito en WhatsApp. El bot lo reconoce igual. */
export const mensajeDelCodigo = (codigo: string) => `Mi código de Umbani: ${codigo}`

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

/** El teléfono de la sesión, o null si el token no es de la app o no vale. */
export function leerSesionApp(token: string): string | null {
  try {
    const datos = jwt.verify(token, secreto(), { audience: AUDIENCIA }) as { role?: string; phone?: string }
    return datos?.role === 'cliente_app' && typeof datos.phone === 'string' ? datos.phone : null
  } catch {
    return null
  }
}

/** El teléfono de la sesión de la app, o 401. Lo usan la app del cliente y la del motorizado. */
export const authApp: RequestHandler = (req, res, next) => {
  const cabecera = String(req.headers.authorization || '')
  const telefono = cabecera.startsWith('Bearer ') ? leerSesionApp(cabecera.slice(7).trim()) : null
  if (!telefono) return res.status(401).json({ error: 'Inicia sesión otra vez' })
  ;(req as Request & { telefonoApp?: string }).telefonoApp = telefono
  return next()
}

export const telefonoDe = (req: Request): string => String((req as Request & { telefonoApp?: string }).telefonoApp || '')
