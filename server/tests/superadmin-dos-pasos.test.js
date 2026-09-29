import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'
import authRouter from '../dist/routes/auth.routes.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL SUPERADMIN ENTRA EN DOS PASOS (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta hoy bastaban correo y contraseña, con una sesión de 7 días sin forma
// de cortarla, en la cuenta que ve el dinero de todos. El dueño eligió una app
// de códigos: gratis, sin datos en el móvil y sin depender del saldo de YCloud.

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const auth = require('../dist/middleware/auth')
const {
  base32, desdeBase32, codigoDelPaso, verificarCodigo, pasoDe, enlaceDeConfiguracion, nuevaClave,
} = require('../dist/lib/codigos-de-un-solo-uso')

const SECRETO = 'dos-pasos-test-secret'
const entorno = { JWT_SECRET: process.env.JWT_SECRET, ADMIN_EMAIL: process.env.ADMIN_EMAIL, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD }

beforeEach(() => {
  process.env.JWT_SECRET = SECRETO
  process.env.ADMIN_EMAIL = 'dueno@umbani.test'
  process.env.ADMIN_PASSWORD = 'una-contrasena-larga'
  authRouter.olvidarFallosDelSegundoPaso()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  for (const [k, v] of Object.entries(entorno)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// ── El generador, contra los vectores OFICIALES del RFC 6238 ───────────────

describe('los códigos, contra el estándar', () => {
  // RFC 6238, apéndice B: clave ASCII «12345678901234567890», SHA-1. El RFC da
  // 8 dígitos; los 6 de las apps son los 6 últimos.
  const claveDelRfc = Buffer.from('12345678901234567890')
  const vectores = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130'],
  ]
  for (const [segundos, esperado] of vectores) {
    it(`T=${segundos} → ${esperado}`, () => {
      expect(codigoDelPaso(claveDelRfc, Math.floor(segundos / 30))).toBe(esperado)
    })
  }

  it('base32 va y vuelve, y admite la clave copiada a mano (espacios, minúsculas)', () => {
    const bytes = Buffer.from('12345678901234567890')
    const clave = base32(bytes)
    expect(clave).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    expect(desdeBase32(clave).equals(bytes)).toBe(true)
    expect(desdeBase32('gezd gnbv gy3t qojq gezd gnbv gy3t qojq').equals(bytes)).toBe(true)
  })

  it('una clave nueva son 160 bits en base32', () => {
    const clave = nuevaClave()
    expect(clave).toMatch(/^[A-Z2-7]{32}$/)
    expect(desdeBase32(clave)).toHaveLength(20)
    expect(nuevaClave()).not.toBe(clave)
  })

  it('el enlace lo entienden las apps de códigos', () => {
    const enlace = enlaceDeConfiguracion('GEZDGNBV', 'dueno@umbani.test')
    expect(enlace).toMatch(/^otpauth:\/\/totp\/Umbani%3Adueno%40umbani\.test\?/)
    expect(enlace).toContain('secret=GEZDGNBV')
    expect(enlace).toContain('issuer=Umbani')
    expect(enlace).toContain('digits=6')
    expect(enlace).toContain('period=30')
  })
})

describe('qué código vale', () => {
  const clave = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  const ahora = 1_727_600_000_000
  const codigoEn = paso => codigoDelPaso(desdeBase32(clave), paso)

  it('el de ahora, y el de 30 s antes o después: los relojes nunca están clavados', () => {
    const paso = pasoDe(ahora)
    expect(verificarCodigo(clave, codigoEn(paso), ahora)).toBe(paso)
    expect(verificarCodigo(clave, codigoEn(paso - 1), ahora)).toBe(paso - 1)
    expect(verificarCodigo(clave, codigoEn(paso + 1), ahora)).toBe(paso + 1)
  })

  it('uno de hace dos minutos, no', () => {
    expect(verificarCodigo(clave, codigoEn(pasoDe(ahora) - 4), ahora)).toBeNull()
  })

  it('un código YA USADO no vuelve a abrir, aunque siga en su minuto y medio', () => {
    const paso = pasoDe(ahora)
    expect(verificarCodigo(clave, codigoEn(paso), ahora, paso)).toBeNull()
    expect(verificarCodigo(clave, codigoEn(paso - 1), ahora, paso - 1)).toBeNull()
  })

  it('lo que no son seis dígitos no se compara siquiera', () => {
    for (const malo of ['', '12345', '1234567', 'abcdef', null, undefined]) {
      expect(verificarCodigo(clave, malo, ahora)).toBeNull()
    }
  })

  it('una clave rota no revienta: simplemente no abre', () => {
    expect(verificarCodigo('esto no es base32!', '123456', ahora)).toBeNull()
  })
})

// ── El login, con la ruta REAL ─────────────────────────────────────────────

async function despachar(ruta, body) {
  const capa = authRouter.stack.find(c => c.route?.path === ruta && c.route?.methods?.post)
  const final = capa.route.stack.at(-1).handle
  const resultado = { status: 200, body: undefined }
  const res = {
    status(codigo) { resultado.status = codigo; return this },
    json(cuerpo) { resultado.body = cuerpo; return this },
  }
  let error = null
  await final({ body, headers: {} }, res, e => { error = e })
  if (error) throw error
  return resultado
}

const CLAVE = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const codigoDeAhora = () => codigoDelPaso(desdeBase32(CLAVE), pasoDe(Date.now()))

/** Una base de mentira que RECUERDA, como la real. */
const baseDelSegundoPaso = (inicial = {}) => {
  const estado = { clave: null, pendiente: null, pendienteDesde: null, ultimoPaso: -1, ...inicial }
  vi.spyOn(db, 'leerSegundoPasoDelAdmin').mockImplementation(async () => ({ ...estado }))
  vi.spyOn(db, 'guardarClavePendiente').mockImplementation(async (clave) => {
    estado.pendiente = clave
    estado.pendienteDesde = new Date().toISOString()
  })
  vi.spyOn(db, 'activarClave').mockImplementation(async (clave, paso) => {
    estado.clave = clave
    estado.pendiente = null
    estado.ultimoPaso = paso
  })
  vi.spyOn(db, 'anotarPasoUsado').mockImplementation(async (paso) => { estado.ultimoPaso = paso })
  return estado
}

const entrarConContrasena = () => despachar('/api/admin/login', {
  email: 'dueno@umbani.test', password: 'una-contrasena-larga',
})

/** Pasar la sesión por `authAdmin`, que es lo que de verdad decide. */
const porElMiddleware = (token) => {
  const r = { status: 200, siguio: false }
  auth.authAdmin(
    { headers: { authorization: `Bearer ${token}` } },
    { status(c) { r.status = c; return this }, json() { return this } },
    () => { r.siguio = true },
  )
  return r
}

describe('entrar con el segundo paso ya configurado', () => {
  it('contraseña → pase → código → sesión de 12 horas con `mfa`', async () => {
    baseDelSegundoPaso({ clave: CLAVE })
    const primero = await entrarConContrasena()
    expect(primero.body.paso).toBe('codigo')
    expect(primero.body.token).toBeUndefined()

    const segundo = await despachar('/api/admin/login/codigo', { pase: primero.body.pase, codigo: codigoDeAhora() })
    expect(segundo.status).toBe(200)
    const sesion = jwt.verify(segundo.body.token, SECRETO)
    expect(sesion).toMatchObject({ role: 'admin', email: 'dueno@umbani.test', mfa: true })
    expect(sesion.exp - sesion.iat).toBe(12 * 60 * 60)
    expect(porElMiddleware(segundo.body.token).siguio).toBe(true)
  })

  it('el PASE no sirve como sesión: `authAdmin` lo rechaza', async () => {
    baseDelSegundoPaso({ clave: CLAVE })
    const { body } = await entrarConContrasena()
    const r = porElMiddleware(body.pase)
    expect(r.siguio).toBe(false)
    expect(r.status).toBe(403)
  })

  it('las sesiones de antes —sin segundo paso— dejan de valer al desplegar', () => {
    const vieja = jwt.sign({ role: 'admin', email: 'dueno@umbani.test' }, SECRETO, { expiresIn: '7d' })
    const r = porElMiddleware(vieja)
    expect(r.siguio).toBe(false)
    // 401: el panel lo lee como «sesión vencida» y vuelve al login.
    expect(r.status).toBe(401)
  })

  it('un código incorrecto no entra', async () => {
    baseDelSegundoPaso({ clave: CLAVE })
    const { body } = await entrarConContrasena()
    const r = await despachar('/api/admin/login/codigo', { pase: body.pase, codigo: '000000' === codigoDeAhora() ? '111111' : '000000' })
    expect(r.status).toBe(401)
    expect(r.body.token).toBeUndefined()
  })

  it('el mismo código no sirve dos veces', async () => {
    baseDelSegundoPaso({ clave: CLAVE })
    const { body } = await entrarConContrasena()
    const codigo = codigoDeAhora()
    expect((await despachar('/api/admin/login/codigo', { pase: body.pase, codigo })).status).toBe(200)
    expect((await despachar('/api/admin/login/codigo', { pase: body.pase, codigo })).status).toBe(401)
  })

  it('sin pase, o con uno inventado, no se llega ni a mirar el código', async () => {
    const estado = baseDelSegundoPaso({ clave: CLAVE })
    const falso = jwt.sign({ role: 'admin_2fa', email: 'x', paso: 'codigo' }, 'otro-secreto')
    for (const pase of [undefined, '', 'basura', falso]) {
      const r = await despachar('/api/admin/login/codigo', { pase, codigo: codigoDeAhora() })
      expect(r.status).toBe(401)
    }
    expect(estado.ultimoPaso).toBe(-1)
  })

  it('diez códigos malos cierran el segundo paso a TODOS: repartir IP no sirve', async () => {
    baseDelSegundoPaso({ clave: CLAVE })
    const { body } = await entrarConContrasena()
    const malo = codigoDeAhora() === '000000' ? '111111' : '000000'
    for (let i = 0; i < 10; i += 1) {
      expect((await despachar('/api/admin/login/codigo', { pase: body.pase, codigo: malo })).status).toBe(401)
    }
    const bueno = await despachar('/api/admin/login/codigo', { pase: body.pase, codigo: codigoDeAhora() })
    expect(bueno.status).toBe(429)
  })

  it('falla CERRADO: si la base no responde, no se entra', async () => {
    vi.spyOn(db, 'leerSegundoPasoDelAdmin').mockRejectedValue(new Error('base caída'))
    expect((await entrarConContrasena()).status).toBe(503)
    const pase = jwt.sign({ role: 'admin_2fa', email: 'dueno@umbani.test', paso: 'codigo' }, SECRETO)
    const r = await despachar('/api/admin/login/codigo', { pase, codigo: '123456' })
    expect(r.status).toBe(503)
    expect(r.body.token).toBeUndefined()
  })

  it('la contraseña se sigue exigiendo, y mal escrita no dice nada del segundo paso', async () => {
    const leer = vi.spyOn(db, 'leerSegundoPasoDelAdmin')
    const r = await despachar('/api/admin/login', { email: 'dueno@umbani.test', password: 'otra' })
    expect(r.status).toBe(401)
    expect(r.body).toEqual({ error: 'Credenciales incorrectas' })
    expect(leer).not.toHaveBeenCalled()
  })
})

describe('la primera vez: configurar la app', () => {
  it('contraseña → clave nueva → primer código → queda activa y se entra', async () => {
    const estado = baseDelSegundoPaso()
    const primero = await entrarConContrasena()
    expect(primero.body.paso).toBe('configurar')

    const config = await despachar('/api/admin/login/configurar', { pase: primero.body.pase })
    expect(config.body.clave).toMatch(/^[A-Z2-7]{32}$/)
    expect(config.body.enlace).toContain(`secret=${config.body.clave}`)
    expect(estado.clave).toBeNull()

    const codigo = codigoDelPaso(desdeBase32(config.body.clave), pasoDe(Date.now()))
    const fin = await despachar('/api/admin/login/codigo', { pase: primero.body.pase, codigo })
    expect(fin.status).toBe(200)
    expect(jwt.verify(fin.body.token, SECRETO).mfa).toBe(true)
    expect(estado.clave).toBe(config.body.clave)
    expect(estado.pendiente).toBeNull()
  })

  it('una clave a medio configurar caduca a los 15 minutos', async () => {
    const estado = baseDelSegundoPaso()
    const { body } = await entrarConContrasena()
    const config = await despachar('/api/admin/login/configurar', { pase: body.pase })
    estado.pendienteDesde = new Date(Date.now() - 16 * 60_000).toISOString()
    const codigo = codigoDelPaso(desdeBase32(config.body.clave), pasoDe(Date.now()))
    const r = await despachar('/api/admin/login/codigo', { pase: body.pase, codigo })
    expect(r.status).toBe(401)
    expect(estado.clave).toBeNull()
  })

  it('ya configurado, nadie puede pedir una clave nueva con la sola contraseña', async () => {
    // Si pudiera, quien robara la contraseña sustituiría la app del dueño.
    const estado = baseDelSegundoPaso({ clave: CLAVE })
    const { body } = await entrarConContrasena()
    expect((await despachar('/api/admin/login/configurar', { pase: body.pase })).status).toBe(409)
    // Ni con un pase de «configurar» sacado antes de que se configurara.
    const viejo = jwt.sign({ role: 'admin_2fa', email: 'dueno@umbani.test', paso: 'configurar' }, SECRETO)
    expect((await despachar('/api/admin/login/configurar', { pase: viejo })).status).toBe(409)
    expect(estado.clave).toBe(CLAVE)
  })
})

describe('la clave nunca sale por la pantalla de Ajustes', () => {
  it('no está entre los ajustes que el panel lee y escribe', () => {
    const { ALLOWED_KEYS } = require('../dist/services/settings')
    expect(ALLOWED_KEYS.filter(k => k.startsWith('admin_'))).toEqual([])
  })

  it('el login compara la contraseña sin dejar adivinar letra a letra', () => {
    const fuente = readFileSync(new URL('../src/routes/auth.routes.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('crypto.timingSafeEqual')
    expect(fuente).not.toMatch(/password !== adminPassword/)
  })
})
