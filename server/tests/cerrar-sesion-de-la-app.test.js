import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import jwt from 'jsonwebtoken'

// ═══════════════════════════════════════════════════════════════════════════
// «CERRAR SESIÓN» DESDE WHATSAPP (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// El login de la app lo prueba WhatsApp, y eso deja abierta la estafa de «te
// llegó un código, mándamelo»: quien lo consigue abre la app con el número de
// otro, 30 días. Ahora el mensaje de «iniciaste sesión» dice cómo cortarlo, y
// cortarlo funciona al instante.

const require = createRequire(import.meta.url)
const db = require('../dist/db')
const cliente = require('../dist/db/client')
const sesion = require('../dist/services/sesion-app')
const {
  handleMarketplaceMessage, esCerrarSesion, SESION_DE_APP_INICIADA, SESIONES_DE_APP_CERRADAS,
} = require('../dist/services/marketplace-entry')

const SECRETO = 'cerrar-sesion-test'
const original = process.env.JWT_SECRET

afterEach(() => {
  vi.restoreAllMocks()
  if (original === undefined) delete process.env.JWT_SECRET
  else process.env.JWT_SECRET = original
})

describe('qué cuenta como «cerrar sesión»', () => {
  it.each([
    'CERRAR SESIÓN', 'cerrar sesion', 'Cerrar sesión.', '*CERRAR SESIÓN*', 'cierra mis sesiones',
    'cerrar la sesión de la app', 'Cierren todas las sesiones!', 'cerrar mi sesion',
  ])('«%s» sí', (texto) => expect(esCerrarSesion(texto)).toBe(true))

  it.each([
    'cerrar', 'sesión', 'quiero cerrar mi pedido', 'cerrar sesión y pedir pizza', 'MENÚ', '',
  ])('«%s» no', (texto) => expect(esCerrarSesion(texto)).toBe(false))

  it('el mensaje de «iniciaste sesión» dice cómo cortarlo, con la palabra exacta', () => {
    expect(SESION_DE_APP_INICIADA).toContain('*CERRAR SESIÓN*')
    expect(SESION_DE_APP_INICIADA).toMatch(/alguien te pidió que le enviaras este código/)
    expect(esCerrarSesion('CERRAR SESIÓN')).toBe(true)
  })
})

describe('cuándo una sesión de la app está cerrada', () => {
  const corte = '2026-09-29T05:00:00.500Z'
  it('sin corte, valen todas, como hasta hoy', () => {
    expect(sesion.sesionCerrada(Date.parse('2026-01-01T00:00:00Z'), null)).toBe(false)
  })
  it('emitida antes del corte: cerrada; después: abierta', () => {
    expect(sesion.sesionCerrada(Date.parse('2026-09-29T04:59:00Z'), corte)).toBe(true)
    expect(sesion.sesionCerrada(Date.parse('2026-09-29T05:00:01Z'), corte)).toBe(false)
  })
  it('emitida en el mismo segundo del corte: cerrada (lo peor es pedir otro código)', () => {
    expect(sesion.sesionCerrada(Date.parse('2026-09-29T05:00:00Z'), corte)).toBe(true)
  })
  it('una fecha de corte ilegible no cierra nada', () => {
    expect(sesion.sesionCerrada(Date.now(), 'no es una fecha')).toBe(false)
  })
})

describe('`authApp` respeta el corte', () => {
  const pasar = async (token) => {
    const r = { status: 200, body: null, siguio: false, telefono: null }
    const req = { headers: { authorization: `Bearer ${token}` } }
    const res = { status(c) { r.status = c; return this }, json(b) { r.body = b; return this } }
    await sesion.authApp(req, res, () => { r.siguio = true; r.telefono = sesion.telefonoDe(req) })
    return r
  }
  const token = (emitida) => jwt.sign(
    { role: 'cliente_app', phone: '593990000926', iat: Math.floor(emitida / 1000) },
    SECRETO, { audience: 'umbani-app', expiresIn: '30d' },
  )

  it('nunca cerrada: entra', async () => {
    process.env.JWT_SECRET = SECRETO
    vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(null)
    expect(await pasar(token(Date.now()))).toMatchObject({ siguio: true, telefono: '593990000926' })
  })

  it('cerrada desde WhatsApp después de emitirla: 401, y dice por qué', async () => {
    process.env.JWT_SECRET = SECRETO
    vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(new Date().toISOString())
    const r = await pasar(token(Date.now() - 60_000))
    expect(r.siguio).toBe(false)
    expect(r.status).toBe(401)
    expect(r.body.error).toMatch(/se cerró desde WhatsApp/)
  })

  it('la sesión NUEVA, sacada después del corte, sí entra', async () => {
    process.env.JWT_SECRET = SECRETO
    vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockResolvedValue(new Date(Date.now() - 60_000).toISOString())
    expect((await pasar(token(Date.now()))).siguio).toBe(true)
  })

  it('falla CERRADO: sin base no se entra', async () => {
    process.env.JWT_SECRET = SECRETO
    vi.spyOn(db, 'sesionesDeLaAppValidasDesde').mockRejectedValue(new Error('base caída'))
    const r = await pasar(token(Date.now()))
    expect(r).toMatchObject({ siguio: false, status: 503 })
  })

  it('un token que no es de la app ni pregunta a la base', async () => {
    process.env.JWT_SECRET = SECRETO
    const leer = vi.spyOn(db, 'sesionesDeLaAppValidasDesde')
    const r = await pasar(jwt.sign({ role: 'admin', mfa: true }, SECRETO))
    expect(r.status).toBe(401)
    expect(leer).not.toHaveBeenCalled()
  })
})

describe('los repositorios', () => {
  it('cerrar pone la fecha de corte en el cliente', async () => {
    const eq = vi.fn(async () => ({ error: null }))
    const update = vi.fn(() => ({ eq }))
    vi.spyOn(cliente, 'from').mockReturnValue({ update })
    await db.cerrarSesionesDeLaApp('cli-1')
    expect(update.mock.calls[0][0].app_sessions_valid_after).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(eq).toHaveBeenCalledWith('id', 'cli-1')
  })

  it('la consulta busca por los DÍGITOS del teléfono, como se guarda el cliente', async () => {
    const maybeSingle = vi.fn(async () => ({ data: { app_sessions_valid_after: '2026-09-29T05:00:00Z' }, error: null }))
    const eq = vi.fn(() => ({ maybeSingle }))
    vi.spyOn(cliente, 'from').mockReturnValue({ select: () => ({ eq }) })
    expect(await db.sesionesDeLaAppValidasDesde('+593 99 000 0926')).toBe('2026-09-29T05:00:00Z')
    expect(eq).toHaveBeenCalledWith('phone', '593990000926')
    maybeSingle.mockResolvedValueOnce({ data: null, error: { message: 'caída' } })
    await expect(db.sesionesDeLaAppValidasDesde('593990000926')).rejects.toThrow('caída')
  })
})

// ── Por WhatsApp, con la función REAL del marketplace ──────────────────────

const armar = (conversacion = {}, { falla = false } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn(async () => ({ id: 'cli-1', name: null })),
    claimPlatformBlockState: vi.fn(async () => ({ bloqueado: false })),
    claimMarketplaceReply: vi.fn(async () => ({ permitido: true, respuestas: 1 })),
    getConversation: vi.fn(async () => ({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'categorias', pagina: 0 } }, version: 1, ...conversacion,
    })),
    advanceConversation: vi.fn(async () => ({ conflicto: false })),
    getMarketplaceCategories: vi.fn(async () => [{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]),
    getMarketplaceBusinesses: vi.fn(async () => []),
    verifyAppLoginCode: vi.fn(async () => true),
    cerrarSesionesDeLaApp: vi.fn(async () => { if (falla) throw new Error('base caída') }),
    revokeStorefrontSessionsOnExit: vi.fn(async () => 2),
  }
  const deps = {
    database,
    send: vi.fn(async (reply) => { enviados.push(reply) }),
    issueLink: vi.fn(async () => null),
    sendLink: vi.fn(async () => true),
  }
  return { database, deps, enviados }
}

describe('por WhatsApp', () => {
  it('«CERRAR SESIÓN» cierra la app y los enlaces, y lo dice', async () => {
    const m = armar()
    await handleMarketplaceMessage({ from: '593990000926', text: 'CERRAR SESIÓN' }, m.deps)
    expect(m.database.cerrarSesionesDeLaApp).toHaveBeenCalledWith('cli-1')
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
    expect(m.enviados).toEqual([SESIONES_DE_APP_CERRADAS])
    // No mueve el menú: es para la app, no para el chat.
    expect(m.database.advanceConversation).not.toHaveBeenCalled()
  })

  it('si la base no pudo cerrarlas, NO dice «listo»', async () => {
    const m = armar({}, { falla: true })
    await handleMarketplaceMessage({ from: '593990000926', text: 'cerrar sesion' }, m.deps)
    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0]).toMatch(/No pudimos cerrar/)
    expect(m.enviados[0]).not.toContain('Listo')
    expect(m.database.revokeStorefrontSessionsOnExit).not.toHaveBeenCalled()
  })

  it('funciona también con el menú en PAUSA por opciones viejas: un robo no espera 5 minutos', async () => {
    const m = armar({ menu_paused_until: new Date(Date.now() + 4 * 60_000).toISOString() })
    await handleMarketplaceMessage({ from: '593990000926', text: 'CERRAR SESIÓN' }, m.deps)
    expect(m.database.cerrarSesionesDeLaApp).toHaveBeenCalled()
    expect(m.enviados).toEqual([SESIONES_DE_APP_CERRADAS])
  })

  it('el código de la app, verificado, avisa de la salida', async () => {
    const m = armar()
    await handleMarketplaceMessage({ from: '593990000926', text: 'Mi código de Umbani: ABC234' }, m.deps)
    expect(m.enviados).toEqual([SESION_DE_APP_INICIADA])
  })

  it('el canario y el simulador no cierran sesiones de verdad', () => {
    for (const archivo of ['../src/services/canario.ts', '../src/routes/admin-simulator.routes.ts']) {
      const fuente = readFileSync(new URL(archivo, import.meta.url), 'utf8')
      expect(fuente, archivo).toContain('cerrarSesionesDeLaApp: async () => undefined')
    }
  })
})
