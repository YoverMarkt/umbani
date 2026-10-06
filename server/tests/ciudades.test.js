import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { handleMarketplaceMessage } = require('../dist/services/marketplace-entry')
const { textoDeComprobanteQueNoCuadra } = require('../dist/services/payment-proof-inbox')
const { verCategorias } = require('../dist/services/marketplace-menu')
const ciudad = require('../dist/services/marketplace-ciudad')

// ═══════════════════════════════════════════════════════════════════════════
// LAS CIUDADES (2026-10-05)
// ═══════════════════════════════════════════════════════════════════════════
//
// Umbani se lanza en Chone y ya atiende en Portoviejo. Lo que defienden, por
// orden de lo que costaría fallar:
//   1. Un cliente de Chone NO ve los locales de Portoviejo.
//   2. Quien está a mitad de un pedido —o acaba de pagar— no se queda sin
//      respuesta por una pregunta de ciudad.
//   3. Con una sola ciudad con locales no se le pregunta nada a nadie.

const CHONE = 'ciudad-chone'
const PORTOVIEJO = 'ciudad-portoviejo'
const FILAS = [
  { city_id: CHONE, city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 2 },
  { city_id: CHONE, city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos', emoji: '🍱', locales: 1 },
  { city_id: PORTOVIEJO, city_name: 'Portoviejo', code: 'almuerzos', label: 'Almuerzos', emoji: '🍱', locales: 1 },
  { city_id: PORTOVIEJO, city_name: 'Portoviejo', code: 'mariscos', label: 'Mariscos', emoji: '🦐', locales: 1 },
]
const SOLO_CHONE = FILAS.filter(f => f.city_id === CHONE)

describe('la regla de qué ciudad se le enseña', () => {
  const ciudades = ciudad.ciudadesDe(FILAS)

  it('las ciudades con locales, una vez cada una y en el orden de la base', () => {
    expect(ciudades).toEqual([{ id: CHONE, nombre: 'Chone' }, { id: PORTOVIEJO, nombre: 'Portoviejo' }])
  })

  it('primero la que ÉL eligió; si ya no tiene locales, la de su local; con una sola, esa; si no, preguntar', () => {
    expect(ciudad.ciudadEfectiva(ciudades, PORTOVIEJO, CHONE)?.id).toBe(PORTOVIEJO)
    expect(ciudad.ciudadEfectiva(ciudades, 'una-que-cerro', CHONE)?.id).toBe(CHONE)
    expect(ciudad.ciudadEfectiva(ciudades, null, null)).toBeNull()
    expect(ciudad.ciudadEfectiva(ciudad.ciudadesDe(SOLO_CHONE), null, null)?.id).toBe(CHONE)
    expect(ciudad.ciudadEfectiva([], CHONE, CHONE)).toBeNull()
  })

  it('las categorías son SOLO las de su ciudad, y llevan el nombre para el pie', () => {
    const deChone = ciudad.categoriasDe(FILAS, { id: CHONE, nombre: 'Chone' }, true)
    expect(deChone.map(c => c.code)).toEqual(['pizzerias', 'almuerzos'])
    expect(deChone[0]).toMatchObject({ ciudad: 'Chone', otrasCiudades: true })
    expect(ciudad.categoriasDe(FILAS, null, true)).toEqual([])
  })

  it('el menú dice dónde está y cómo cambiar SOLO si hay más de una ciudad', () => {
    const conOtras = verCategorias(ciudad.categoriasDe(FILAS, { id: CHONE, nombre: 'Chone' }, true), 0, true)
    const sola = verCategorias(ciudad.categoriasDe(SOLO_CHONE, { id: CHONE, nombre: 'Chone' }, false), 0, true)
    expect(conOtras.reply).toMatch(/Estás en \*Chone\*.*escribe \*CIUDAD\*/s)
    expect(sola.reply).not.toMatch(/CIUDAD/)
  })

  it('CIUDAD y sus formas; y el nombre exacto de una ciudad, no un trozo', () => {
    for (const t of ['CIUDAD', 'ciudad', 'Cambiar de ciudad', 'otra ciudad']) expect(ciudad.esComandoCiudad(t)).toBe(true)
    expect(ciudad.esComandoCiudad('pizza')).toBe(false)
    expect(ciudad.ciudadEscrita('chone', ciudades)?.id).toBe(CHONE)
    expect(ciudad.ciudadEscrita('PORTOVIEJO', ciudades)?.id).toBe(PORTOVIEJO)
    expect(ciudad.ciudadEscrita('2', ciudades)?.id).toBe(PORTOVIEJO)
    // «quiero algo en chone» es una búsqueda, no un cambio de ciudad.
    expect(ciudad.ciudadEscrita('quiero algo en chone', ciudades)).toBeNull()
  })

  it('atar la ciudad: todo lo que viene después pide los locales de ESA ciudad', async () => {
    const base = { getMarketplaceBusinesses: vi.fn(async () => []), searchMarketplaceBusinesses: vi.fn(async () => []) }
    const atado = ciudad.conLaCiudad({ database: base }, { id: CHONE, nombre: 'Chone' })
    await atado.database.getMarketplaceBusinesses('pizzerias')
    await atado.database.searchMarketplaceBusinesses('ceviche', 9)
    expect(base.getMarketplaceBusinesses).toHaveBeenCalledWith('pizzerias', CHONE)
    expect(base.searchMarketplaceBusinesses).toHaveBeenCalledWith('ceviche', 9, CHONE)
    // Sin ciudad viaja `null`: la base no devuelve nada (falla cerrado).
    const sinCiudad = ciudad.conLaCiudad({ database: base }, null)
    await sinCiudad.database.getMarketplaceBusinesses('pizzerias')
    expect(base.getMarketplaceBusinesses).toHaveBeenLastCalledWith('pizzerias', null)
  })
})

// ── El chat, de punta a punta ────────────────────────────────────────────────

const LOCAL_PORTOVIEJO = { id: 'biz-po', name: 'La Abuelita', slug: 'la-abuelita', storefront_enabled: true, takes_orders: true, city_id: PORTOVIEJO }

function armar({ filas = FILAS, cliente = {}, conversacion = {}, local = LOCAL_PORTOVIEJO } = {}) {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana', city_id: null, ...cliente }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: 'navegando',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'categorias', pagina: 0 } },
      version: 3,
      ...conversacion,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(filas),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([{ id: 'biz-pz', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 }]),
    getBusinessById: vi.fn().mockResolvedValue(local),
    getSchedulesFor: vi.fn().mockResolvedValue(new Map()),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
    setCustomerCity: vi.fn().mockResolvedValue(),
  }
  const deps = {
    database,
    send: async (reply, options) => { enviados.push({ reply, options: options || [] }) },
    issueLink: vi.fn().mockResolvedValue('https://umbani.app/s/abc123'),
    tipoPideEnChat: vi.fn().mockResolvedValue(false),
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }
  return { database, deps, enviados, ultimo: () => enviados[enviados.length - 1] }
}

const escribir = (deps, text) => handleMarketplaceMessage({ from: '593900000777', text }, deps)
const vistaGuardada = database => database.advanceConversation.mock.calls.at(-1)?.[1]?.flowState?.vista?.vista

beforeEach(() => { vi.clearAllMocks() })

describe('el chat con dos ciudades', () => {
  it('quien no eligió ciudad recibe «¿En qué ciudad estás?», no el menú de todas', async () => {
    const m = armar()
    await escribir(m.deps, 'hola')
    expect(m.ultimo().reply).toMatch(/En qué ciudad estás/)
    expect(m.ultimo().options).toEqual(['Chone', 'Portoviejo'])
    expect(vistaGuardada(m.database)).toBe('ciudades')
    expect(m.database.getMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  it('al elegir Portoviejo se anota y ve SOLO las categorías de Portoviejo', async () => {
    const m = armar({ conversacion: { flow_state: { vista: { vista: 'ciudades', pagina: 0 } } } })
    await escribir(m.deps, 'Portoviejo')
    expect(m.database.setCustomerCity).toHaveBeenCalledWith('cli-1', PORTOVIEJO)
    const { reply, options } = m.ultimo()
    expect(options.join(' ')).toMatch(/Mariscos/)
    expect(options.join(' ')).not.toMatch(/Pizzerías/)
    expect(reply).toMatch(/Estás en \*Portoviejo\*/)
    expect(vistaGuardada(m.database)).toBe('categorias')
  })

  it('quien ya eligió Chone ve su menú sin que se le pregunte, y los locales se piden en Chone', async () => {
    const m = armar({ cliente: { city_id: CHONE } })
    await escribir(m.deps, 'hola')
    expect(m.ultimo().reply).not.toMatch(/En qué ciudad estás/)
    expect(m.ultimo().options.join(' ')).toMatch(/Pizzerías/)
    expect(m.ultimo().options.join(' ')).not.toMatch(/Mariscos/)
    await escribir(m.deps, 'Pizzerías')
    expect(m.database.getMarketplaceBusinesses).toHaveBeenCalledWith('pizzerias', CHONE)
    expect(m.database.setCustomerCity).not.toHaveBeenCalled()
  })

  it('CIUDAD le enseña la lista otra vez', async () => {
    const m = armar({ cliente: { city_id: CHONE } })
    await escribir(m.deps, 'CIUDAD')
    expect(m.ultimo().reply).toMatch(/En qué ciudad estás/)
  })

  it('con un local elegido, CIUDAD no le cambia el menú por debajo del pedido', async () => {
    const m = armar({ cliente: { city_id: CHONE }, conversacion: { selected_business_id: 'biz-po' } })
    await escribir(m.deps, 'CIUDAD')
    expect(m.ultimo().reply).toMatch(/Estás en el pedido de \*La Abuelita\*.*MENÚ.*CIUDAD/s)
    expect(m.database.setCustomerCity).not.toHaveBeenCalled()
  })

  it('a mitad de un pedido no se le pregunta: su ciudad es la de su local', async () => {
    const m = armar({ conversacion: { selected_business_id: 'biz-po', current_state: 'en_local' } })
    await escribir(m.deps, 'hola')
    expect(m.enviados.map(e => e.reply).join('\n')).not.toMatch(/En qué ciudad estás/)
  })

  it('un COMPROBANTE nunca se intercepta, aunque no tenga ciudad', async () => {
    const m = armar()
    await escribir(m.deps, textoDeComprobanteQueNoCuadra('la cuenta no es la del local'))
    expect(m.enviados.map(e => e.reply).join('\n')).not.toMatch(/En qué ciudad estás/)
    expect(m.enviados.length).toBeGreaterThan(0)
  })

  it('si no se puede anotar la ciudad, se le enseña igual (falla hacia preguntar de más)', async () => {
    const m = armar({ conversacion: { flow_state: { vista: { vista: 'ciudades', pagina: 0 } } } })
    m.database.setCustomerCity.mockRejectedValue(new Error('base caída'))
    await escribir(m.deps, 'Chone')
    expect(m.ultimo().options.join(' ')).toMatch(/Pizzerías/)
  })
})

describe('con una sola ciudad con locales', () => {
  it('no se le pregunta a nadie ni se le anota: el día que abra otra, se le pregunta', async () => {
    const m = armar({ filas: SOLO_CHONE })
    await escribir(m.deps, 'hola')
    expect(m.ultimo().reply).not.toMatch(/En qué ciudad estás|CIUDAD/)
    expect(m.ultimo().options.join(' ')).toMatch(/Pizzerías/)
    expect(m.database.setCustomerCity).not.toHaveBeenCalled()
  })

  it('sin ningún local en ninguna ciudad, se dice', async () => {
    const m = armar({ filas: [] })
    await escribir(m.deps, 'hola')
    expect(m.ultimo().reply).toMatch(/no hay locales disponibles/)
  })
})
