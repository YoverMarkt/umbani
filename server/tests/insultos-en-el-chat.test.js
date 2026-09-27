import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const menu = require('../dist/services/marketplace-menu')
const { handleMarketplaceMessage: handle } = require('../dist/services/marketplace-entry')

// ═══════════════════════════════════════════════════════════════════════════
// INSULTOS EN EL CHAT DE UMBANI (2026-09-27)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo probó el dueño con su teléfono: «Putas», «Verga», «Mierda» se contestaban
// como cualquier otra cosa. Decidió: la primera vez, advertencia; la segunda,
// 15 días fuera de toda la app, que caducan solos; y al volver, «te hemos
// desbloqueado». La regla vive en la base (`register_insult`,
// `claim_platform_block_state`) y se prueba contra PostgreSQL real en
// `verificar-esquema.sql`; aquí, lo que el cliente LEE.

const CATEGORIAS = [{ code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]

const armar = ({ falta = { accion: 'advertido' }, estado = { bloqueado: false } } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    claimPlatformBlockState: vi.fn().mockResolvedValue(estado),
    registerInsult: vi.fn().mockResolvedValue(falta),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'categorias', pagina: 0 } }, version: 1,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    searchMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue(null),
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

describe('un insulto en el chat', () => {
  it('la primera vez: advertencia, y el mensaje NO se atiende', async () => {
    const { deps, enviados, database } = armar()
    await handle({ from: '593999111222', text: 'Putas' }, deps)
    expect(database.registerInsult).toHaveBeenCalledWith('cli-1')
    expect(enviados).toHaveLength(1)
    expect(enviados[0].reply).toMatch(/mantén el respeto/)
    expect(enviados[0].reply).toMatch(/15 días/)
    // Ni menú ni búsqueda: solo la respuesta a lo que dijo.
    expect(database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
    expect(database.advanceConversation).not.toHaveBeenCalled()
  })

  it('la segunda: 15 días fuera, y se le dice hasta cuándo', async () => {
    const hasta = '2026-10-12T15:00:00Z'
    const { deps, enviados } = armar({ falta: { accion: 'bloqueado', hasta } })
    await handle({ from: '593999111222', text: 'Verga' }, deps)
    expect(enviados).toHaveLength(1)
    expect(enviados[0].reply).toMatch(/bloqueado por 15 días/)
    expect(enviados[0].reply).toMatch(/12 de octubre/)
  })

  it('«menú, hijueputa» sigue siendo un insulto: va antes que MENÚ', async () => {
    const { deps, enviados } = armar()
    await handle({ from: '593999111222', text: 'menu hijueputa' }, deps)
    expect(enviados[0].reply).toMatch(/mantén el respeto/)
  })

  it('la comida NO es un insulto: «ceviche de concha» se atiende normal', async () => {
    const { deps, database } = armar()
    await handle({ from: '593999111222', text: 'ceviche de concha' }, deps)
    expect(database.registerInsult).not.toHaveBeenCalled()
  })

  it('si la base no contesta, se atiende como antes (bloquear por un fallo nuestro no tiene vuelta atrás)', async () => {
    const { deps, enviados, database } = armar()
    database.registerInsult.mockRejectedValue(new Error('base caída'))
    await handle({ from: '593999111222', text: 'Mierda' }, deps)
    expect(enviados.length).toBeGreaterThan(0)
    expect(enviados.at(-1).reply).not.toMatch(/mantén el respeto|bloqueado/)
  })
})

describe('el bloqueado y el que vuelve', () => {
  it('mientras dura el bloqueo, no se le responde nada', async () => {
    const { deps, enviados, database } = armar({ estado: { bloqueado: true } })
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(enviados).toHaveLength(0)
    expect(database.registerInsult).not.toHaveBeenCalled()
  })

  it('al volver, en su primer mensaje: «te hemos desbloqueado», y su mensaje se atiende', async () => {
    const { deps, enviados } = armar({ estado: { bloqueado: false, avisarDesbloqueo: true } })
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(enviados[0].reply).toMatch(/Te hemos desbloqueado/)
    expect(enviados[0].reply).toMatch(/mejores tu conducta/)
    // Y después, lo de siempre.
    expect(enviados.length).toBeGreaterThan(1)
    expect(enviados.at(-1).options).toContain('🍕 Pizzerías')
  })
})

describe('los textos', () => {
  it('la advertencia avisa del bloqueo automático de 15 días', () => {
    expect(menu.ADVERTENCIA_POR_INSULTOS).toMatch(/bloqueará\s+automáticamente/)
    expect(menu.ADVERTENCIA_POR_INSULTOS).toMatch(/15 días/)
  })
})

describe('está CONECTADO', () => {
  // Construido y desconectado es el fallo que más se repite aquí: la entrada
  // de producción recibe el módulo `db` entero, así que las dos funciones
  // tienen que salir de él.
  it('el módulo de la base exporta las dos funciones que usa la entrada', () => {
    const db = require('../dist/db')
    expect(typeof db.claimPlatformBlockState).toBe('function')
    expect(typeof db.registerInsult).toBe('function')
  })
})
