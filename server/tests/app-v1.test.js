import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import jwt from 'jsonwebtoken'
import fs from 'node:fs'

const require = createRequire(import.meta.url)
const client = require('../dist/db/client')
const db = require('../dist/db')
const auth = require('../dist/middleware/auth')
const sesion = require('../dist/services/sesion-app')
const router = require('../dist/routes/app-v1.routes')
const pagos = require('../dist/routes/pagos.routes')
const { handleMarketplaceMessage } = require('../dist/services/marketplace-entry')

// ═══════════════════════════════════════════════════════════════════════════
// LA API DE LA APP (v1): iniciar sesión con WhatsApp, el marketplace y la
// sesión de tienda. Lo que defienden estas pruebas, por orden de lo que
// costaría fallar:
//   1. El token de la app NO abre ningún panel (ni el del local ni el tuyo).
//   2. El código lo verifica el REMITENTE de WhatsApp, una vez y en plazo.
//   3. La página intermedia solo lleva a PayPhone (sin redirección abierta).
//   4. El código en el chat no mueve la conversación ni el menú.
// ═══════════════════════════════════════════════════════════════════════════

const SECRET = 'app-v1-test'
let anterior
beforeEach(() => { anterior = process.env.JWT_SECRET; process.env.JWT_SECRET = SECRET })
afterEach(() => {
  vi.restoreAllMocks()
  if (anterior === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = anterior
})

async function correr(r, method, path, { headers = {}, body = {}, params = {}, query = {} } = {}) {
  const layer = r.stack.find(l => l.route?.path === path && l.route?.methods?.[method])
  const handlers = layer.route.stack.map(l => l.handle).slice(1) // sin el limitador
  const req = { headers, body, params, query, ip: '1.1.1.1' }
  const out = { status: 200, body: undefined, html: null }
  const res = {
    status(c) { out.status = c; return this }, json(v) { out.body = v; return this },
    setHeader() {}, type() { return this }, send(h) { out.html = h; return this },
  }
  for (const h of handlers) {
    let sigue = false
    await h(req, res, (e) => { if (e) throw e; sigue = true })
    if (!sigue) break
  }
  return out
}

describe('la sesión de la app', () => {
  it('los códigos son de 6, sin letras que se confunden', () => {
    for (let i = 0; i < 50; i++) expect(sesion.generarCodigo()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
  })

  it('el bot reconoce el mensaje aunque venga escrito a mano', () => {
    expect(sesion.codigoEnElMensaje('Mi código de Umbani: K7P2QX')).toBe('K7P2QX')
    expect(sesion.codigoEnElMensaje('mi codigo de umbani k7p2qx')).toBe('K7P2QX')
    expect(sesion.codigoEnElMensaje('hola, quiero una pizza')).toBeNull()
    expect(sesion.codigoEnElMensaje('Mi código de Umbani: K0P2QX')).toBeNull()
  })

  it('⚠️ el token de la app NO abre el panel del local ni el del superadmin', async () => {
    const token = sesion.firmarSesionApp('593999111222')
    expect(sesion.leerSesionApp(token)).toBe('593999111222')
    for (const guardia of [auth.authAdmin, auth.authClient]) {
      const out = { status: 200 }
      const res = { status(c) { out.status = c; return this }, json() { return this } }
      let paso = false
      await guardia({ headers: { authorization: `Bearer ${token}` } }, res, () => { paso = true })
      expect(paso).toBe(false)
      expect(out.status).toBeGreaterThanOrEqual(401)
    }
    // Y al revés: un token de panel no es una sesión de la app.
    expect(sesion.leerSesionApp(jwt.sign({ role: 'client', businessId: 'b' }, SECRET))).toBeNull()
    expect(sesion.leerSesionApp('basura')).toBeNull()
  })
})

describe('iniciar sesión con WhatsApp', () => {
  it('da un código y el enlace de WhatsApp con el mensaje escrito', async () => {
    vi.spyOn(db, 'createAppLoginCode').mockResolvedValue(true)
    const plataforma = require('../dist/services/platform-channel')
    vi.spyOn(plataforma, 'getPlatformPhone').mockResolvedValue('+593 99 171 6574')
    const r = await correr(router, 'post', '/api/v1/auth/whatsapp')
    expect(r.status).toBe(201)
    expect(r.body.enlace).toBe(`https://wa.me/593991716574?text=${encodeURIComponent(`Mi código de Umbani: ${r.body.codigo}`)}`)
  })

  it('canjear: pendiente mientras no llega el mensaje, token al llegar, 410 si no vale', async () => {
    const canje = vi.spyOn(db, 'consumeAppLoginCode')
    canje.mockResolvedValueOnce({ estado: 'pendiente' })
    expect((await correr(router, 'post', '/api/v1/auth/whatsapp/verificar', { body: { codigo: 'k7p2qx' } })).status).toBe(202)
    expect(canje).toHaveBeenLastCalledWith('K7P2QX')
    canje.mockResolvedValueOnce({ estado: 'ok', phone: '593999111222' })
    const ok = await correr(router, 'post', '/api/v1/auth/whatsapp/verificar', { body: { codigo: 'K7P2QX' } })
    expect(sesion.leerSesionApp(ok.body.token)).toBe('593999111222')
    canje.mockResolvedValueOnce({ estado: 'invalido' })
    expect((await correr(router, 'post', '/api/v1/auth/whatsapp/verificar', { body: { codigo: 'K7P2QX' } })).status).toBe(410)
    expect((await correr(router, 'post', '/api/v1/auth/whatsapp/verificar', { body: { codigo: "x' or 1" } })).status).toBe(400)
  })
})

describe('las rutas con sesión', () => {
  const conSesion = () => ({ authorization: `Bearer ${sesion.firmarSesionApp('593999111222')}` })

  it('sin sesión: 401', async () => {
    expect((await correr(router, 'get', '/api/v1/yo')).status).toBe(401)
    expect((await correr(router, 'post', '/api/v1/locales/:slug/sesion', { params: { slug: 'x' } })).status).toBe(401)
  })

  it('la sesión de tienda exige el dispositivo, el local y que el local venda', async () => {
    const ruta = '/api/v1/locales/:slug/sesion'
    expect((await correr(router, 'post', ruta, { headers: conSesion(), params: { slug: 'x' } })).status).toBe(400)
    const headers = { ...conSesion(), 'x-storefront-device': 'dispositivo-1234', 'user-agent': 'UmbaniApp/1.0' }
    vi.spyOn(db, 'getBusinessBySlug').mockResolvedValue(null)
    expect((await correr(router, 'post', ruta, { headers, params: { slug: 'x' } })).status).toBe(404)
  })

  it('el marketplace sale con sus categorías y locales', async () => {
    vi.spyOn(db, 'getMarketplaceCategories').mockResolvedValue([{ code: 'pizzas', label: 'Pizzerías', emoji: '🍕', locales: 1 }])
    vi.spyOn(db, 'getMarketplaceBusinesses').mockResolvedValue([{ id: 'b', slug: 'burger-brava', name: 'Burger Brava', type: 'x', prep_min: 20 }])
    const r = await correr(router, 'get', '/api/v1/marketplace')
    expect(r.body.categorias[0]).toMatchObject({ codigo: 'pizzas', locales: [{ slug: 'burger-brava', abierto: null }] })
  })
})

describe('el salto a PayPhone desde la app', () => {
  it('⚠️ solo lleva a PayPhone, y con el origen', async () => {
    expect((await correr(pagos, 'get', '/pagos/payphone/ir', { query: { destino: 'https://phishing.example/x' } })).status).toBe(404)
    const bien = await correr(pagos, 'get', '/pagos/payphone/ir', {
      query: { destino: 'https://pay.payphonetodoesposible.com/Anonymous/Index?paymentId=A&b="><script>' },
    })
    expect(bien.status).toBe(200)
    expect(bien.html).toMatch(/referrerpolicy="origin"/)
    expect(bien.html).not.toMatch(/"><script>/)
  })

  it('la respuesta de pagar con tarjeta trae la URL para la app', () => {
    const tienda = fs.readFileSync('src/routes/storefront.routes.ts', 'utf8')
    expect(tienda).toMatch(/urlApp: base \? `\$\{base\}\/pagos\/payphone\/ir\?destino=/)
  })
})

describe('el código llega por el chat de Umbani', () => {
  const deps = (verificar) => {
    const enviados = []
    const database = {
      resolveMarketplaceCustomer: vi.fn(async () => ({ id: 'c1', name: null })),
      claimPlatformBlockState: vi.fn(async () => ({ bloqueado: false, avisarDesbloqueo: false })),
      claimMarketplaceReply: vi.fn(async () => ({ permitido: true, respuestas: 1, aviso: false, hasta: null })),
      getConversation: vi.fn(async () => null),
      getMarketplaceCategories: vi.fn(async () => []),
      verifyAppLoginCode: verificar,
    }
    return { enviados, database, deps: { database, issueLink: vi.fn(), send: vi.fn(async (t) => { enviados.push(t) }), logger: { log() {} } } }
  }

  it('lo verifica con el REMITENTE y no toca la conversación', async () => {
    const verificar = vi.fn(async () => true)
    const { deps: d, database, enviados } = deps(verificar)
    await handleMarketplaceMessage({ from: '593999111222', text: 'Mi código de Umbani: K7P2QX' }, d)
    expect(verificar).toHaveBeenCalledWith('K7P2QX', '593999111222')
    expect(enviados[0]).toMatch(/iniciaste sesión/)
    expect(database.getConversation).not.toHaveBeenCalled()
  })

  it('un bloqueado no inicia sesión', async () => {
    const verificar = vi.fn(async () => true)
    const { deps: d, database } = deps(verificar)
    database.claimPlatformBlockState.mockResolvedValue({ bloqueado: true, avisarDesbloqueo: false })
    await handleMarketplaceMessage({ from: '593999111222', text: 'Mi código de Umbani: K7P2QX' }, d)
    expect(verificar).not.toHaveBeenCalled()
  })

  it('un código vencido se dice, sin menú', async () => {
    const { deps: d, enviados, database } = deps(vi.fn(async () => false))
    await handleMarketplaceMessage({ from: '593999111222', text: 'Mi código de Umbani: K7P2QX' }, d)
    expect(enviados[0]).toMatch(/ya no es válido/)
    expect(database.getMarketplaceCategories).not.toHaveBeenCalled()
  })
})

describe('el repositorio de los códigos', () => {
  const consulta = (resultado) => {
    const q = {}
    for (const m of ['insert', 'update', 'select', 'eq', 'is', 'not', 'gt']) q[m] = vi.fn(() => q)
    q.maybeSingle = vi.fn(async () => resultado)
    q.then = (ok, mal) => Promise.resolve(resultado).then(ok, mal)
    return q
  }

  it('guardar, verificar y canjear son sentencias condicionales', async () => {
    const from = vi.spyOn(client, 'from')
    from.mockReturnValue(consulta({ error: null }))
    expect(await db.createAppLoginCode('K7P2QX', new Date())).toBe(true)
    from.mockReturnValue(consulta({ error: { code: '23505', message: 'dup' } }))
    expect(await db.createAppLoginCode('K7P2QX', new Date())).toBe(false)
    const v = consulta({ data: [{ id: 'x' }], error: null })
    from.mockReturnValue(v)
    expect(await db.verifyAppLoginCode('K7P2QX', '593')).toBe(true)
    expect(v.is).toHaveBeenCalledWith('verified_at', null)
    from.mockReturnValue(consulta({ data: [{ phone: '593' }], error: null }))
    expect(await db.consumeAppLoginCode('K7P2QX')).toEqual({ estado: 'ok', phone: '593' })
    from.mockReturnValueOnce(consulta({ data: [], error: null })).mockReturnValueOnce(consulta({ data: { id: 'x' } }))
    expect(await db.consumeAppLoginCode('K7P2QX')).toEqual({ estado: 'pendiente' })
    from.mockReturnValueOnce(consulta({ data: [], error: null })).mockReturnValueOnce(consulta({ data: null }))
    expect(await db.consumeAppLoginCode('K7P2QX')).toEqual({ estado: 'invalido' })
  })
})
