import type { RequestHandler } from 'express'
import { leerConfiguracionTurnstile } from '../config/turnstile'

// El captcha al pedir el código (`config/turnstile.ts`): su guion y su marco
// vienen de Cloudflare. Se abren SOLO cuando está encendido y SOLO en las dos
// apps que piden el código (`/u` clientes, `/r` repartidores): los paneles y
// la tienda siguen sin poder cargar un guion de fuera.
const TURNSTILE = 'https://challenges.cloudflare.com'
const PAGINAS_QUE_PIDEN_EL_CODIGO = /^\/(u|r)(\/|$)/

function politica(conTurnstile: boolean): string {
  return [
    "default-src 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    conTurnstile ? `script-src 'self' ${TURNSTILE}` : "script-src 'self'",
    ...(conTurnstile ? [`frame-src ${TURNSTILE}`] : []),
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: https:",
    // blob: solo en media: el panel genera el WAV de la alarma en memoria
    // (apps/client/src/lib/alarm.ts); sin blob: el navegador lo bloquea con
    // NotSupportedError y la alarma de pendientes queda muda.
    "media-src 'self' data: https: blob:",
    "connect-src 'self'",
  ].join('; ')
}

export const securityHeaders: RequestHandler = (req, res, next) => {
  const conTurnstile = Boolean(leerConfiguracionTurnstile()) && PAGINAS_QUE_PIDEN_EL_CODIGO.test(req.path ?? '')
  res.setHeader('Content-Security-Policy', politica(conTurnstile))
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  // ⚠️ `geolocation=(self)`, no `geolocation=()`.
  //
  // Con la lista VACÍA la ubicación queda prohibida en la página para todo el
  // mundo, y el navegador la deniega sin preguntar nada. Eso convirtió el pin
  // de la mini app en algo imposible de arreglar desde el teléfono: el cliente
  // tenía el permiso concedido en Android, en Chrome y en el sitio, y seguía
  // fallando — porque la propia página lo había prohibido. Costó dos rondas de
  // diagnóstico y un mensaje de error que mandaba al candado del navegador a
  // arreglar algo que el candado no controla.
  //
  // `(self)` lo permite SOLO en nuestro propio origen: un iframe de otro sitio
  // sigue sin poder pedirla, que es lo que esta cabecera protege de verdad.
  //
  // La cámara y el micrófono se quedan cerrados: el comprobante se sube con un
  // `<input type="file">`, que abre la galería del sistema y no necesita
  // permiso de cámara.
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(self), microphone=()')
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  next()
}
