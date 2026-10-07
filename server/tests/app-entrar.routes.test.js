import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const sesion = require('../dist/services/sesion-app')
const entrar = require('../dist/routes/app-entrar.routes')
const appV1 = require('../dist/routes/app-v1.routes')
const motorizado = require('../dist/routes/app-motorizado.routes')

// ═══════════════════════════════════════════════════════════════════════════
// ENTRAR A LAS APPS CON CORREO: LAS RUTAS (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que se defiende, por lo que costaría fallar:
//   1. Una cuenta de correo SIN teléfono no ve pedidos de nadie ni abre una
//      tienda: el teléfono es la frontera de sus pedidos.
//   2. El teléfono se reclama en exclusiva, y el mismo texto sea de quien sea.
//   3. El código solo vuelve en la respuesta en STAGING.
//   4. El repartidor entra por el correo con el que lo registraron.

const SECRET = 'app-entrar-test'
const CORREO = 'ana@correo.com'
let entorno
beforeEach(() => {
  entorno = { JWT_SECRET: process.env.JWT_SECRET, UMBANI_ENTORNO: process.env.UMBANI_ENTORNO, RESEND_API_KEY: process.env.RESEND_API_KEY, CORREO_REMITENTE: process.env.CORREO_REMITENTE }
  process.env.JWT_SECRET = SECRET
  delete process.env.UMBANI_ENTORNO
  delete process.env.RESEND_API_KEY
  delete process.env.CORREO_REMITENTE
  vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(null)
  vi.spyOn(db, 'sesionesDeLaAppValidasDesdeCorreo').mockResolvedValue(null)
})
afterEach(() => {
  vi.restoreAllMocks()
  for (const [clave, valor] of Object.entries(entorno)) {
    if (valor === undefined) delete process.env[clave]
    else process.env[clave] = valor
  }
})

async function correr(r, method, path, { headers = {}, body = {}, params = {}, query = {} } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle).slice(1) // sin el limitador
  const req = { headers, body, params, query, ip: '1.1.1.1' }
  const out = { status: 200, body: undefined }
  const res = { status(c) { out.status = c; return this }, json(v) { out.body = v; return this }, setHeader() {} }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}

const conCorreo = (correo = CORREO) => ({ authorization: `Bearer ${sesion.firmarSesionDeCorreo(correo)}` })
const conTelefono = (telefono = '593999111222') => ({ authorization: `Bearer ${sesion.firmarSesionApp(telefono)}` })

describe('la sesión de correo', () => {
  it('prueba un correo y solo un correo', () => {
    const leida = sesion.leerSesionAppConFecha(sesion.firmarSesionDeCorreo(CORREO))
    expect(leida).toMatchObject({ correo: CORREO, telefono: null })
    // La de WhatsApp sigue igual.
    expect(sesion.leerSesionApp(sesion.firmarSesionApp('593999111222'))).toBe('593999111222')
  })

  it('una que dijera las dos cosas, o ninguna, no vale', () => {
    const firmar = datos => jwt.sign({ role: 'cliente_app', ...datos }, SECRET, { audience: 'umbani-app' })
    expect(sesion.leerSesionAppConFecha(firmar({ phone: '593999111222', email: CORREO }))).toBeNull()
    expect(sesion.leerSesionAppConFecha(firmar({}))).toBeNull()
  })

  it('cerrada después de emitirse ya no entra, y lo dice sin hablar de WhatsApp', async () => {
    db.sesionesDeLaAppValidasDesdeCorreo.mockResolvedValue(new Date(Date.now() + 60_000).toISOString())
    const r = await correr(appV1, 'get', '/api/v1/yo', { headers: conCorreo() })
    expect(r).toMatchObject({ status: 401, body: { error: 'Tu sesión se cerró. Inicia sesión otra vez.' } })
  })
})

describe('pedir el código por correo', () => {
  it('un correo que no lo parece es 400 y no toca la base', async () => {
    const contar = vi.spyOn(db, 'contarCodigosDeCorreo')
    const r = await correr(entrar, 'post', '/api/v1/auth/correo', { body: { correo: 'ana' } })
    expect(r.status).toBe(400)
    expect(contar).not.toHaveBeenCalled()
  })

  it('en PRODUCCIÓN sin proveedor: 503, sin guardar ningún código', async () => {
    const guardar = vi.spyOn(db, 'guardarCodigoDeCorreo')
    const r = await correr(entrar, 'post', '/api/v1/auth/correo', { body: { correo: CORREO } })
    expect(r).toMatchObject({ status: 503, body: { error: 'Entrar con correo todavía no está disponible' } })
    expect(guardar).not.toHaveBeenCalled()
  })

  it('en STAGING sin proveedor: el código vuelve en la respuesta, y es el que se guardó', async () => {
    process.env.UMBANI_ENTORNO = 'staging'
    vi.spyOn(db, 'contarCodigosDeCorreo').mockResolvedValue(0)
    const guardar = vi.spyOn(db, 'guardarCodigoDeCorreo').mockResolvedValue()
    const r = await correr(entrar, 'post', '/api/v1/auth/correo', { body: { correo: ' Ana@Correo.com ' } })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ enviado: false, codigoDePruebas: expect.stringMatching(/^\d{6}$/) })
    // Se guarda con el correo normalizado: la misma persona escriba como escriba.
    expect(guardar.mock.calls[0][0]).toBe(CORREO)
  })

  it('el tope por correo responde 429', async () => {
    process.env.UMBANI_ENTORNO = 'staging'
    vi.spyOn(db, 'contarCodigosDeCorreo').mockResolvedValue(5)
    const r = await correr(entrar, 'post', '/api/v1/auth/correo', { body: { correo: CORREO } })
    expect(r.status).toBe(429)
  })
})

describe('canjear el código', () => {
  it('el bueno da una sesión de ESE correo', async () => {
    process.env.UMBANI_ENTORNO = 'staging'
    vi.spyOn(db, 'contarCodigosDeCorreo').mockResolvedValue(0)
    let guardado
    vi.spyOn(db, 'guardarCodigoDeCorreo').mockImplementation(async (_c, huella) => { guardado = huella })
    const pedido = await correr(entrar, 'post', '/api/v1/auth/correo', { body: { correo: CORREO } })
    vi.spyOn(db, 'codigoDeCorreoVigente').mockResolvedValue({ id: 'c1', code_hash: guardado, attempts: 0 })
    vi.spyOn(db, 'gastarIntentoDeCodigoDeCorreo').mockResolvedValue(true)
    vi.spyOn(db, 'marcarCodigoDeCorreoUsado').mockResolvedValue(true)
    const r = await correr(entrar, 'post', '/api/v1/auth/correo/verificar', { body: { correo: CORREO, codigo: pedido.body.codigoDePruebas } })
    expect(r.status).toBe(200)
    expect(sesion.leerSesionAppConFecha(r.body.token)).toMatchObject({ correo: CORREO, telefono: null })
  })

  it('el malo es 401; sin código vivo, 410', async () => {
    vi.spyOn(db, 'codigoDeCorreoVigente').mockResolvedValue({ id: 'c1', code_hash: 'f'.repeat(64), attempts: 0 })
    vi.spyOn(db, 'gastarIntentoDeCodigoDeCorreo').mockResolvedValue(true)
    expect((await correr(entrar, 'post', '/api/v1/auth/correo/verificar', { body: { correo: CORREO, codigo: '123456' } })).status).toBe(401)
    db.codigoDeCorreoVigente.mockResolvedValue(null)
    expect((await correr(entrar, 'post', '/api/v1/auth/correo/verificar', { body: { correo: CORREO, codigo: '123456' } })).status).toBe(410)
  })
})

describe('el teléfono de la cuenta', () => {
  const cuenta = { id: 'cu1', phone: null, email: CORREO, city_id: null }

  it('se reclama con el número como lo verá cualquiera: dígitos y código del país', async () => {
    vi.spyOn(db, 'cuentaPorCorreo').mockResolvedValue(cuenta)
    const reclamar = vi.spyOn(db, 'reclamarTelefono').mockResolvedValue('ok')
    const r = await correr(entrar, 'put', '/api/v1/yo/telefono', { headers: conCorreo(), body: { telefono: '099 123 4567' } })
    expect(r).toMatchObject({ status: 200, body: { telefono: '593991234567' } })
    expect(reclamar).toHaveBeenCalledWith('cu1', '593991234567')
  })

  it('el de otra persona no se da, y el texto no dice de quién es', async () => {
    vi.spyOn(db, 'cuentaPorCorreo').mockResolvedValue(cuenta)
    vi.spyOn(db, 'reclamarTelefono').mockResolvedValue('ocupado')
    const r = await correr(entrar, 'put', '/api/v1/yo/telefono', { headers: conCorreo(), body: { telefono: '0991234567' } })
    expect(r).toMatchObject({ status: 409, body: { error: 'Ese número ya está en otra cuenta de Umbani. Si es tuyo, escríbenos.' } })
  })

  it('un número que no lo es: 400; quien entró por WhatsApp ya tiene el suyo: 409', async () => {
    expect((await correr(entrar, 'put', '/api/v1/yo/telefono', { headers: conCorreo(), body: { telefono: '12' } })).status).toBe(400)
    expect((await correr(entrar, 'put', '/api/v1/yo/telefono', { headers: conTelefono(), body: { telefono: '0991234567' } })).status).toBe(409)
  })
})

describe('una cuenta de correo SIN teléfono no ve nada de nadie', () => {
  beforeEach(() => {
    vi.spyOn(db, 'cuentaPorCorreo').mockResolvedValue({ id: 'cu1', phone: null, email: CORREO, city_id: null })
  })

  it('«/yo» dice quién es y que aún no tiene número', async () => {
    const r = await correr(appV1, 'get', '/api/v1/yo', { headers: conCorreo() })
    expect(r.body).toEqual({ telefono: null, correo: CORREO, ciudadId: null })
  })

  it('no abre la tienda de un local hasta poner su número', async () => {
    const negocio = vi.spyOn(db, 'getBusinessBySlug')
    const r = await correr(appV1, 'post', '/api/v1/locales/:slug/sesion', {
      headers: { ...conCorreo(), 'x-storefront-device': 'dispositivo-1234' }, params: { slug: 'monster' },
    })
    expect(r).toMatchObject({ status: 409, body: { falta: 'telefono' } })
    expect(negocio).not.toHaveBeenCalled()
  })

  it('«Mis pedidos» sale vacío: no se busca con un número que no tiene', async () => {
    const pedidos = vi.spyOn(db, 'getAppOrders').mockResolvedValue({ data: [], error: null })
    const r = await correr(appV1, 'get', '/api/v1/pedidos', { headers: conCorreo() })
    expect(r.body).toEqual({ pedidos: [] })
    expect(pedidos).toHaveBeenCalledWith('')
  })

  it('con su número ya reclamado, sus pedidos se buscan por ESE número', async () => {
    db.cuentaPorCorreo.mockResolvedValue({ id: 'cu1', phone: '593991234567', email: CORREO, city_id: null })
    const pedidos = vi.spyOn(db, 'getAppOrders').mockResolvedValue({ data: [], error: null })
    await correr(appV1, 'get', '/api/v1/pedidos', { headers: conCorreo() })
    expect(pedidos).toHaveBeenCalledWith('593991234567')
  })
})

describe('el repartidor entra con su correo', () => {
  it('se le busca por el correo de la sesión, no por un teléfono', async () => {
    const porCorreo = vi.spyOn(db, 'getActiveCourierByEmail').mockResolvedValue(null)
    const porTelefono = vi.spyOn(db, 'getActiveCourierByPhone')
    const r = await correr(motorizado, 'get', '/api/v1/motorizado/yo', { headers: conCorreo('luis@correo.com') })
    expect(r).toMatchObject({ status: 403, body: { error: 'Este correo no es de un repartidor activo de Umbani' } })
    expect(porCorreo).toHaveBeenCalledWith('luis@correo.com')
    expect(porTelefono).not.toHaveBeenCalled()
  })
})
