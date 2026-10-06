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
beforeEach(() => {
  anterior = process.env.JWT_SECRET
  process.env.JWT_SECRET = SECRET
  // `authApp` pregunta si la sesión se cerró desde WhatsApp (2026-09-29): aquí
  // nunca se cerró. Lo de cerrarla se prueba en `cerrar-sesion-de-la-app.test.js`.
  vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(null)
})
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

  // ── Las ciudades (2026-10-05) ──────────────────────────────────────────
  const CHONE = '11111111-2222-4333-8444-555555555555'
  const PORTOVIEJO = '22222222-3333-4444-8555-666666666666'
  const FILAS = [
    { city_id: CHONE, city_name: 'Chone', code: 'pizzas', label: 'Pizzerías', emoji: '🍕', locales: 1 },
    { city_id: PORTOVIEJO, city_name: 'Portoviejo', code: 'almuerzos', label: 'Almuerzos', emoji: '🍱', locales: 1 },
  ]

  it('las ciudades: solo las que tienen locales, una vez cada una', async () => {
    vi.spyOn(db, 'getMarketplaceCategories').mockResolvedValue([...FILAS, { ...FILAS[0], code: 'cafes' }])
    const r = await correr(router, 'get', '/api/v1/ciudades')
    expect(r.body.ciudades).toEqual([{ id: CHONE, nombre: 'Chone' }, { id: PORTOVIEJO, nombre: 'Portoviejo' }])
  })

  it('el marketplace es de UNA ciudad, y sin ella no se enseña nada', async () => {
    vi.spyOn(db, 'getMarketplaceCategories').mockResolvedValue(FILAS)
    const locales = vi.spyOn(db, 'getMarketplaceBusinesses').mockResolvedValue([{ id: 'b', slug: 'burger-brava', name: 'Burger Brava', type: 'x', prep_min: 20 }])
    expect((await correr(router, 'get', '/api/v1/marketplace')).status).toBe(400)
    const r = await correr(router, 'get', '/api/v1/marketplace', { query: { ciudad: CHONE } })
    expect(r.body.categorias).toHaveLength(1)
    expect(r.body.categorias[0]).toMatchObject({ codigo: 'pizzas', locales: [{ slug: 'burger-brava', abierto: null }] })
    expect(locales).toHaveBeenCalledWith('pizzas', CHONE)
  })

  // ── La ciudad por el GPS (2026-10-05) ──────────────────────────────────
  it('¿en qué ciudad estoy?: dentro, la ciudad y si ya tiene locales', async () => {
    vi.spyOn(db, 'cityAt').mockResolvedValue({ id: CHONE, name: 'Chone', km: 0.2, dentro: true })
    vi.spyOn(db, 'getMarketplaceCategories').mockResolvedValue(FILAS)
    const anotar = vi.spyOn(db, 'recordCoverageRequest').mockResolvedValue()
    const r = await correr(router, 'get', '/api/v1/ciudades/aqui', { query: { lat: '-0.6995', lng: '-80.093' } })
    expect(r.body).toEqual({ ciudad: { id: CHONE, nombre: 'Chone' }, conLocales: true })
    expect(db.cityAt).toHaveBeenCalledWith(-0.6995, -80.093)
    expect(anotar).not.toHaveBeenCalled()
  })

  it('fuera de toda ciudad: la más cercana, y queda anotado con el dispositivo RESUMIDO', async () => {
    vi.spyOn(db, 'cityAt').mockResolvedValue({ id: CHONE, name: 'Chone', km: 172.4, dentro: false })
    const anotar = vi.spyOn(db, 'recordCoverageRequest').mockResolvedValue()
    const r = await correr(router, 'get', '/api/v1/ciudades/aqui', {
      query: { lat: '-0.1807', lng: '-78.4678' }, headers: { 'x-umbani-dispositivo': 'mi-telefono-123' },
    })
    expect(r.body).toEqual({ ciudad: null, cercana: { nombre: 'Chone', km: 172.4 } })
    const [lat, lng, huella] = anotar.mock.calls[0]
    expect([lat, lng]).toEqual([-0.1807, -78.4678])
    // Nunca el identificador tal cual: una huella corta.
    expect(huella).toMatch(/^[0-9a-f]{16}$/)
    expect(huella).not.toContain('mi-telefono')
  })

  it('una ubicación que no lo es no llega a la base', async () => {
    const buscar = vi.spyOn(db, 'cityAt')
    for (const query of [{}, { lat: 'x', lng: '1' }, { lat: '91', lng: '0' }, { lat: '0', lng: '181' }, { lat: '-0.69' }]) {
      expect((await correr(router, 'get', '/api/v1/ciudades/aqui', { query })).status).toBe(400)
    }
    expect(buscar).not.toHaveBeenCalled()
  })

  it('la ciudad del cliente la guarda SU teléfono, y es la misma que usa el chat', async () => {
    vi.spyOn(db, 'resolveMarketplaceCustomer').mockResolvedValue({ id: 'cli-1', phone: '593999111222', name: null, city_id: null })
    const getCity = vi.spyOn(db, 'getCity').mockResolvedValue(null)
    const guardar = vi.spyOn(db, 'setCustomerCity').mockResolvedValue()
    const ruta = '/api/v1/yo/ciudad'
    expect((await correr(router, 'put', ruta, { body: { ciudadId: CHONE } })).status).toBe(401)
    expect((await correr(router, 'put', ruta, { headers: conSesion(), body: { ciudadId: 'x' } })).status).toBe(400)
    expect((await correr(router, 'put', ruta, { headers: conSesion(), body: { ciudadId: CHONE } })).status).toBe(404)
    getCity.mockResolvedValue({ id: CHONE, name: 'Chone', active: true })
    const r = await correr(router, 'put', ruta, { headers: conSesion(), body: { ciudadId: CHONE } })
    expect(r.body).toEqual({ ciudadId: CHONE, nombre: 'Chone' })
    expect(guardar).toHaveBeenCalledWith('cli-1', CHONE)
    expect(db.resolveMarketplaceCustomer).toHaveBeenCalledWith('593999111222')
  })
})

describe('«Mis pedidos» de la app: los de este teléfono en todos los locales', () => {
  const conSesion = () => ({ authorization: `Bearer ${sesion.firmarSesionApp('593999111222')}` })
  beforeEach(() => {
    vi.spyOn(db, 'getBusinessPricingRule').mockResolvedValue({ strategy: 'percentage', percentage: 10, mode: 'on_top' })
  })

  it('el teléfono sale del TOKEN, nunca de la petición', async () => {
    const consulta = vi.spyOn(db, 'getAppOrders').mockResolvedValue({ data: [], error: null })
    const r = await correr(router, 'get', '/api/v1/pedidos', {
      headers: conSesion(), query: { telefono: '593000000000' }, body: { telefono: '593000000000' },
    })
    expect(r.status).toBe(200)
    expect(consulta).toHaveBeenCalledWith('593999111222')
  })

  it('cada pedido con su local, a precio del cliente y sin nada del local ni del margen', async () => {
    vi.spyOn(db, 'getAppOrders').mockResolvedValue({
      data: [{
        business_id: 'negocio-a', contact_phone: '593999111222',
        businesses: { name: 'Pizzería', slug: 'pizzeria' },
        id: 'o1', total: 2.43, shipping: 1.5, service_fee: 0.1,
        merchant_subtotal: 0.75, platform_markup: 0.18,
        order_items: [{ product_name: 'Agua', quantity: 1, line_total: 0.75 }],
      }],
      error: null,
    })
    const r = await correr(router, 'get', '/api/v1/pedidos', { headers: conSesion() })
    const [pedido] = r.body.pedidos
    expect(pedido.local).toEqual({ nombre: 'Pizzería', slug: 'pizzeria' })
    expect(pedido.order_items[0].line_total).toBe(0.83)
    for (const clave of ['merchant_subtotal', 'platform_markup', 'business_id', 'contact_phone']) {
      expect(pedido).not.toHaveProperty(clave)
    }
  })

  it('el pedido de OTRO teléfono responde lo mismo que uno que no existe', async () => {
    vi.spyOn(db, 'getAppOrderOwner').mockResolvedValue(null)
    const r = await correr(router, 'get', '/api/v1/pedidos/:id', {
      headers: conSesion(), params: { id: '11111111-2222-4333-8444-555555555555' },
    })
    expect(r.status).toBe(404)
    expect(r.body.error).toBe('No encontramos ese pedido')
  })

  it('el detalle se lee con el negocio y el teléfono DEL PEDIDO', async () => {
    vi.spyOn(db, 'getAppOrderOwner').mockResolvedValue({
      business_id: 'negocio-a', contact_phone: '+593999111222', businesses: { name: 'Pizzería', slug: 'pizzeria' },
    })
    const detalle = vi.spyOn(db, 'getStorefrontOrder').mockResolvedValue({
      data: { id: 'o1', total: 2.43, shipping: 1.5, service_fee: 0.1, order_items: [{ product_name: 'Agua', quantity: 1, line_total: 0.75 }] },
      error: null,
    })
    const id = '11111111-2222-4333-8444-555555555555'
    const r = await correr(router, 'get', '/api/v1/pedidos/:id', { headers: conSesion(), params: { id } })
    expect(r.status).toBe(200)
    expect(detalle).toHaveBeenCalledWith({ businessId: 'negocio-a', contactPhone: '+593999111222', orderId: id })
    expect(r.body.local.slug).toBe('pizzeria')
    expect(r.body.order_items[0].line_total).toBe(0.83)
  })

  it('sin sesión de la app, nada', async () => {
    const r = await correr(router, 'get', '/api/v1/pedidos', {})
    expect(r.status).toBe(401)
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
