import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import security from '../dist/middleware/security-headers.js'

const originalNodeEnv = process.env.NODE_ENV

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV
  else process.env.NODE_ENV = originalNodeEnv
})

function run(req = {}) {
  const headers = new Map()
  const response = { setHeader: (name, value) => headers.set(name, value) }
  let nextCalled = false
  security.securityHeaders(req, response, () => { nextCalled = true })
  return { headers, nextCalled }
}

describe('cabeceras HTTP de seguridad', () => {
  it('bloquea framing, sniffing y fuentes no permitidas', () => {
    const result = run()
    expect(result.nextCalled).toBe(true)
    expect(result.headers.get('X-Frame-Options')).toBe('DENY')
    expect(result.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(result.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  })

  it('permite blob: solo en media (el WAV de la alarma) sin abrirlo en el resto', () => {
    const csp = run().headers.get('Content-Security-Policy')
    expect(csp).toContain("media-src 'self' data: https: blob:")
    // El resto de directivas siguen cerradas a blob:
    expect(csp.replace("media-src 'self' data: https: blob:", '')).not.toContain('blob:')
  })

  // ⚠️ Con la lista VACÍA —`geolocation=()`— la ubicación queda prohibida en la
  // página para todo el mundo y el navegador la deniega sin preguntar. Eso
  // rompió el pin de la mini app de una forma imposible de diagnosticar desde
  // el teléfono: el cliente tenía el permiso concedido en Android, en Chrome y
  // en el sitio, y seguía fallando porque la propia página lo prohibía.
  it('permite la ubicación en nuestro origen, y solo ahí', () => {
    const politica = run().headers.get('Permissions-Policy')
    expect(politica).toContain('geolocation=(self)')
    // La lista vacía es justo lo que no puede volver: no se distingue de un
    // permiso denegado por el usuario, y nadie lo arregla desde su teléfono.
    expect(politica).not.toContain('geolocation=()')
  })

  // El comprobante se sube con un `<input type="file">`, que abre la galería
  // del sistema: no hace falta cámara ni micrófono, así que siguen cerrados.
  it('la cámara y el micrófono siguen prohibidos', () => {
    const politica = run().headers.get('Permissions-Policy')
    expect(politica).toContain('camera=()')
    expect(politica).toContain('microphone=()')
  })

  it('activa HSTS únicamente en producción', () => {
    process.env.NODE_ENV = 'production'
    expect(run().headers.get('Strict-Transport-Security')).toContain('max-age=31536000')
    process.env.NODE_ENV = 'development'
    expect(run().headers.has('Strict-Transport-Security')).toBe(false)
  })

  // El captcha al pedir el código (2026-10-09): su guion y su marco vienen de
  // Cloudflare. Se abren solo con él encendido y solo en /u y /r.
  describe('el captcha (Turnstile)', () => {
    const CLAVES = { TURNSTILE_SITE_KEY: '0x4AAAAAAAsitio', TURNSTILE_SECRET_KEY: '0x4AAAAAAAsecreto' }
    const antes = {}
    beforeEach(() => {
      for (const clave of Object.keys(CLAVES)) antes[clave] = process.env[clave]
    })
    afterEach(() => {
      for (const [clave, valor] of Object.entries(antes)) {
        if (valor === undefined) delete process.env[clave]
        else process.env[clave] = valor
      }
    })
    const cloudflare = 'https://challenges.cloudflare.com'

    it('apagado, ninguna página puede cargar nada de Cloudflare', () => {
      for (const clave of Object.keys(CLAVES)) delete process.env[clave]
      for (const path of ['/u', '/r', '/app']) {
        expect(run({ path }).headers.get('Content-Security-Policy'), path).not.toContain(cloudflare)
      }
    })

    it('encendido, solo las apps que piden el código abren su guion y su marco', () => {
      Object.assign(process.env, CLAVES)
      for (const path of ['/u', '/u/', '/r', '/r/pedidos']) {
        const csp = run({ path }).headers.get('Content-Security-Policy')
        expect(csp, path).toContain(`script-src 'self' ${cloudflare}`)
        expect(csp, path).toContain(`frame-src ${cloudflare}`)
      }
      // Los paneles, la tienda y la API siguen cerrados a guiones de fuera.
      for (const path of ['/app', '/app-admin', '/cooperativa', '/t/la-abuelita', '/api/v1/auth/correo', '/umbani']) {
        expect(run({ path }).headers.get('Content-Security-Policy'), path).not.toContain(cloudflare)
      }
    })
  })
})

