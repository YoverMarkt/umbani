import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const menu = require('../dist/services/marketplace-menu')
const { handleMarketplaceMessage: handle } = require('../dist/services/marketplace-entry')

// ═══════════════════════════════════════════════════════════════════════════
// «¿HAY LOCALES ABIERTOS?» Y EL AVISO DEL TECHO (2026-09-27)
// ═══════════════════════════════════════════════════════════════════════════
//
// Las dos las vivió el dueño con su teléfono la misma madrugada:
//   · «Locales abiertos en está hora?» (00:16) → «🙏 Con eso no te puedo
//     ayudar por aquí», con la búsqueda anterior repintada;
//   · a las 00:42 cruzó el techo de 25 respuestas por hora y sus «Menu» no
//     recibieron NADA: lo leyó como que el chat se colgó.

// Ecuador es UTC−5 todo el año.
const ecuador = (hhmm, dia = '2026-09-27') => new Date(`${dia}T${hhmm}:00-05:00`)

const CATEGORIAS = [
  { code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
  { code: 'cafeterias', label: 'Cafeterías', emoji: '☕', locales: 2 },
  { code: 'asados', label: 'Asados', emoji: '🔥', locales: 1 },
]
const local = (id, extra = {}) => ({ id, slug: id, name: id, type: 'x', prep_min: null, ...extra })

describe('¿pregunta qué hay abierto?', () => {
  it.each([
    'Locales abiertos en está hora?',
    '¿hay algo abierto?',
    'que esta abierto ahora',
    'quién atiende a esta hora',
    'que abren ahora',
  ])('«%s» sí', (texto) => {
    expect(menu.esPreguntaPorAbiertos(texto)).toBe(true)
  })

  it.each([
    'atienden a domicilio?', // «atiende» sin tiempo: no pregunta por la hora
    'pizza',
    'hola',
    'Parilladas',
  ])('«%s» no', (texto) => {
    expect(menu.esPreguntaPorAbiertos(texto)).toBe(false)
  })
})

describe('se saluda según la hora de Ecuador', () => {
  it.each([
    ['00:16', 'madrugada'],
    ['07:30', 'desayuno'],
    ['12:30', 'almuerzo'],
    ['16:00', 'tarde'],
    ['21:00', 'cena'],
  ])('a las %s, %s', (hhmm, palabra) => {
    expect(menu.momentoDelDia(ecuador(hhmm))).toContain(palabra)
  })
})

describe('la respuesta a «¿hay locales abiertos?»', () => {
  it('primero pregunta qué quiere comer, con SOLO las categorías que tienen algo abierto', () => {
    const porCategoria = new Map([
      ['pizzerias', [local('monster', { abierto: false, abre: { open: '12:00', inDays: 0, dayName: 'Domingo' } })]],
      ['cafeterias', [local('grano', { abierto: true }), local('tostado', { abierto: false })]],
      // Abierto pero sin carta a esta hora: para el cliente es lo mismo que cerrado.
      ['asados', [local('brasas', { abierto: true, con_carta: false, carta_desde: '12:00' })]],
    ])
    const r = menu.verAbiertos(CATEGORIAS, porCategoria, ecuador('08:00'))
    expect(r.reply).toMatch(/desayuno/)
    expect(r.reply).toMatch(/¿Qué te gustaría comer\?/)
    expect(r.options).toEqual(['☕ Cafeterías', menu.VOLVER])
    expect(r.vista).toEqual({ vista: 'abiertos', codigos: ['cafeterias'], pagina: 0 })
  })

  it('sin saber el horario, el local cuenta como abierto (lo que ya hace la lista)', () => {
    const r = menu.verAbiertos(CATEGORIAS.slice(0, 1), new Map([['pizzerias', [local('monster')]]]))
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('si NO hay nada abierto, lo dice y enseña los que abren antes, de cualquier categoría', () => {
    const porCategoria = new Map([
      ['pizzerias', [local('Monster Pizza', { abierto: false, abre: { open: '12:00', inDays: 0, dayName: 'Domingo' } })]],
      ['cafeterias', [
        local('Café Grano Fino', { abierto: false, abre: { open: '07:00', inDays: 0, dayName: 'Domingo' } }),
        local('Tostado', { abierto: false, abre: { open: '09:00', inDays: 1, dayName: 'Lunes' } }),
      ]],
      ['asados', [local('Brasas del Puerto', { abierto: false, abre: { open: '12:00', inDays: 0, dayName: 'Domingo' } })]],
    ])
    const r = menu.verAbiertos(CATEGORIAS, porCategoria, ecuador('00:16'))
    expect(r.reply).toMatch(/no tenemos locales abiertos/)
    // El primero en abrir va primero, sin importar su categoría; el de mañana, al final.
    const orden = ['Café Grano Fino', 'Monster Pizza', 'Brasas del Puerto', 'Tostado']
      .map(nombre => r.reply.indexOf(nombre))
    expect(orden.every(i => i > 0)).toBe(true)
    expect(orden).toEqual([...orden].sort((a, b) => a - b))
    expect(r.reply).toMatch(/Café Grano Fino · abre hoy 7:00 AM/)
    // Los botones son la portada: puede mirar cartas para luego.
    expect(r.vista.vista).toBe('categorias')
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('un «1» elige la primera de la lista QUE SE LE ENSEÑÓ, no la de la portada', () => {
    const r = menu.paso({
      mensaje: '1',
      vista: { vista: 'abiertos', codigos: ['asados', 'cafeterias'], pagina: 0 },
      categorias: CATEGORIAS,
      negocios: [],
    })
    expect(r.vista).toEqual({ vista: 'negocios', categoria: 'asados', pagina: 0 })
  })

  it('«Volver» lleva a la portada entera', () => {
    const r = menu.paso({
      mensaje: menu.VOLVER,
      vista: { vista: 'abiertos', codigos: ['cafeterias'], pagina: 0 },
      categorias: CATEGORIAS,
      negocios: [],
    })
    expect(r.vista).toEqual({ vista: 'categorias', pagina: 0 })
  })
})

describe('el aviso al que cruza el techo', () => {
  it('dice hasta cuándo, en hora de Ecuador', () => {
    // 00:42 + 12 h = 12:42 del mismo día.
    const texto = menu.avisoDeSilencio(ecuador('12:42').toISOString(), ecuador('00:42'))
    expect(texto).toMatch(/hoy a las 12:42 PM/)
    expect(texto).toMatch(/comprobante/)
  })

  it('si acaba al día siguiente, dice «mañana»', () => {
    const texto = menu.avisoDeSilencio(ecuador('05:10', '2026-09-28').toISOString(), ecuador('17:10'))
    expect(texto).toMatch(/mañana a las 5:10 AM/)
  })
})

// ── Por el camino REAL de la entrada ─────────────────────────────────────
const armar = ({ reclamo = { permitido: true, respuestas: 1 }, negocios = {}, horarios = null } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    claimMarketplaceReply: vi.fn().mockResolvedValue(reclamo),
    getConversation: vi.fn().mockResolvedValue({
      current_state: 'navegando',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'busqueda', consulta: 'Parilladas', pagina: 0 } },
      version: 4,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn(async code => negocios[code] || []),
    searchMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue(null),
    ...(horarios ? { getSchedulesFor: vi.fn(async () => horarios) } : {}),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      logger: { log: () => {} },
    },
  }
}

describe('por la entrada del marketplace', () => {
  afterEach(() => vi.useRealTimers())

  it('la pregunta de las 00:16 ya no recibe «no te puedo ayudar»', async () => {
    vi.useFakeTimers({ now: ecuador('00:16'), toFake: ['Date'] })
    // Todo cerrado a esa hora: abren de 07:00 a 22:00.
    const cerrado = [0, 1, 2, 3, 4, 5, 6].map(d => ({ day_of_week: d, open_time: '07:00', close_time: '22:00', is_active: true }))
    const { deps, enviados, database } = armar({
      negocios: { cafeterias: [local('Café Grano Fino')], pizzerias: [local('Monster Pizza')] },
      horarios: new Map([['Café Grano Fino', cerrado], ['Monster Pizza', cerrado]]),
    })
    await handle({ from: '593999111222', text: 'Locales abiertos en está hora?' }, deps)

    const ultimo = enviados.at(-1)
    expect(ultimo.reply).not.toMatch(/no te puedo ayudar/i)
    expect(ultimo.reply).toMatch(/no tenemos locales abiertos/)
    expect(ultimo.reply).toMatch(/abre hoy 7:00 AM/)
    // No se buscó «Locales abiertos…» como si fuera comida.
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
  })

  it('con locales abiertos, ofrece solo sus categorías y guarda cuáles', async () => {
    const { deps, enviados, database } = armar({
      negocios: { cafeterias: [local('Café Grano Fino')] },
    })
    await handle({ from: '593999111222', text: '¿hay algo abierto?' }, deps)
    expect(enviados.at(-1).options).toEqual(['☕ Cafeterías', menu.VOLVER])
    const guardado = database.advanceConversation.mock.calls.at(-1)[1]
    expect(guardado.flowState.vista).toMatchObject({ vista: 'abiertos', codigos: ['cafeterias'] })
  })

  it('el mensaje que cruza el techo recibe UN aviso con la hora de vuelta', async () => {
    const { deps, enviados } = armar({
      reclamo: { permitido: false, respuestas: 26, aviso: true, hasta: new Date(Date.now() + 12 * 3600_000).toISOString() },
    })
    await handle({ from: '593999111222', text: 'Menu' }, deps)
    expect(enviados).toHaveLength(1)
    expect(enviados[0].reply).toMatch(/pausamos las respuestas/)
    expect(enviados[0].options).toEqual([])
  })

  it('los intentos siguientes del silenciado siguen sin respuesta', async () => {
    const { deps, enviados } = armar({
      reclamo: { permitido: false, respuestas: 26, hasta: new Date(Date.now() + 3600_000).toISOString() },
    })
    await handle({ from: '593999111222', text: 'Menu' }, deps)
    expect(enviados).toHaveLength(0)
  })
})
