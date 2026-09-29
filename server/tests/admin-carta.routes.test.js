import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import express from 'express'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const cartaRouter = require('../dist/routes/admin-carta.routes.js')
const carta = require('../dist/services/carta-del-local.js')
const errorLog = require('../dist/services/error-log.js')

// ═══════════════════════════════════════════════════════════════════════════
// LEER LA CARTA: SOLO EL SUPERADMIN, SOLO FOTOS, Y NO GUARDA NADA
// ═══════════════════════════════════════════════════════════════════════════
//
// Se prueba con un servidor de verdad y un envío multipart real: la subida la
// procesa multer, y un simulacro del `req` se saltaría justo esa mitad.

const JWT_SECRET = 'carta-test-secret'
let servidor
let base
let secretoAnterior

beforeAll(async () => {
  secretoAnterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = JWT_SECRET
  const app = express()
  app.use(cartaRouter)
  await new Promise((resolve) => { servidor = app.listen(0, resolve) })
  base = `http://127.0.0.1:${servidor.address().port}`
})

afterAll(async () => {
  await new Promise(resolve => servidor.close(resolve))
  if (secretoAnterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = secretoAnterior
})

afterEach(() => { vi.restoreAllMocks() })

const token = (role = 'admin') => `Bearer ${jwt.sign({ role, mfa: true, businessId: 'b' }, JWT_SECRET)}`

const enviar = (fotos, auth = token()) => {
  const formulario = new FormData()
  for (const [nombre, tipo, bytes = 'imagen'] of fotos) {
    formulario.append('fotos', new Blob([bytes], { type: tipo }), nombre)
  }
  return fetch(`${base}/api/admin/carta/leer`, {
    method: 'POST',
    headers: auth ? { authorization: auth } : {},
    body: formulario,
  })
}

describe('POST /api/admin/carta/leer', () => {
  it('está colgada del router del superadmin', () => {
    // Se LEE el archivo en vez de cargar el router: cargarlo arrastra todas las
    // rutas del superadmin a este proceso, y la cobertura de sus propias
    // pruebas dejaba de contarse (medido: −160 sentencias). Que responde de
    // verdad se comprueba contra staging y producción al desplegar.
    const montaje = readFileSync(new URL('../src/routes/admin.routes.ts', import.meta.url), 'utf8')
    expect(montaje).toMatch(/import cartaRouter = require\('\.\/admin-carta\.routes'\)/)
    expect(montaje).toMatch(/router\.use\(cartaRouter\)/)
  })

  it('exige superadmin: sin sesión 401, con sesión de un local 403', async () => {
    const leer = vi.spyOn(carta, 'leerCarta')
    expect((await enviar([['carta.jpg', 'image/jpeg']], null)).status).toBe(401)
    expect((await enviar([['carta.jpg', 'image/jpeg']], token('client'))).status).toBe(403)
    expect(leer).not.toHaveBeenCalled()
  })

  it('devuelve la propuesta de la IA con las fotos que se subieron', async () => {
    const propuesta = { categorias: [{ nombre: 'Almuerzos', productos: [] }], otrosPrecios: [] }
    const leer = vi.spyOn(carta, 'leerCarta').mockResolvedValue({ ok: true, propuesta })

    const respuesta = await enviar([['p1.jpg', 'image/jpeg', 'uno'], ['p2.png', 'image/png', 'dos']])
    expect(respuesta.status).toBe(200)
    expect(await respuesta.json()).toEqual({ propuesta })
    const fotos = leer.mock.calls[0][0]
    expect(fotos.map(f => [f.mimetype, f.buffer.toString()])).toEqual([
      ['image/jpeg', 'uno'], ['image/png', 'dos'],
    ])
  })

  it('sin fotos, con más de cuatro o con un formato que la IA no lee, no llama a nadie', async () => {
    const leer = vi.spyOn(carta, 'leerCarta')
    const vacio = await fetch(`${base}/api/admin/carta/leer`, {
      method: 'POST', headers: { authorization: token() }, body: new FormData(),
    })
    expect(vacio.status).toBe(400)

    const cinco = Array.from({ length: 5 }, (_, i) => [`p${i}.jpg`, 'image/jpeg'])
    expect((await enviar(cinco)).status).toBe(400)

    const heic = await enviar([['IMG_0001.heic', 'image/heic']])
    expect(heic.status).toBe(400)
    expect((await heic.json()).error).toMatch(/HEIC/)
    expect(leer).not.toHaveBeenCalled()
  })

  it('cada motivo de la IA se traduce a algo que el superadmin entiende', async () => {
    const registrar = vi.spyOn(errorLog, 'recordError').mockResolvedValue(undefined)
    const leer = vi.spyOn(carta, 'leerCarta')

    leer.mockResolvedValueOnce({ ok: false, motivo: 'sin_credencial' })
    const sinClave = await enviar([['c.jpg', 'image/jpeg']])
    expect(sinClave.status).toBe(503)
    expect((await sinClave.json()).error).toMatch(/clave de OpenAI/)

    leer.mockResolvedValueOnce({ ok: false, motivo: 'sin_productos' })
    expect((await enviar([['c.jpg', 'image/jpeg']])).status).toBe(422)
    // Una foto sin productos es cosa de la foto: no es un error de la plataforma.
    expect(registrar).not.toHaveBeenCalled()

    leer.mockResolvedValueOnce({ ok: false, motivo: 'fallo_del_modelo' })
    expect((await enviar([['c.jpg', 'image/jpeg']])).status).toBe(502)
    expect(registrar).toHaveBeenCalledWith(expect.objectContaining({
      category: 'ia', code: 'carta_ilegible',
    }))
  })
})
