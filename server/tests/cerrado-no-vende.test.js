import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { handleMarketplaceMessage } = require('../dist/services/marketplace-entry')

// ═══════════════════════════════════════════════════════════════════════════
// UN LOCAL CERRADO SE VE, PERO NO VENDE
// ═══════════════════════════════════════════════════════════════════════════
//
// Encontrado auditando la app como cliente (2026-09-13): con La Abuelita
// CERRADA, el chat decía «está cerrado ahora mismo» y acto seguido dejaba armar
// el carrito y recibir los datos bancarios. A las 00:30, para una cocina
// cerrada.
//
// ⚠️ Desde el 2026-09-15 el pedido por chat ya no existe: todo local pide por su
// mini app, que YA impedía pedir con la tienda cerrada (`canOrder: false`, y el
// 409 de `/orders`). Lo que se vigila aquí es lo que el cliente LEE al elegir un
// local cerrado: que se entera ANTES de entrar, y que recibe su enlace igual.
//
// ⚠️ Lo que NO cambia: el local cerrado SIGUE saliendo en la lista, marcado y
// con su hora de apertura, y sigue dejando ver la carta. Esconderlo dejaría el
// marketplace vacío de noche —con dos locales, literalmente vacío— y el cliente
// concluiría que no hay nada. Ver «abre a las 9:00 AM» es lo que le hace volver.

const LUNES_13H = new Date('2026-07-13T18:00:00Z')   // lunes 13:00 en Ecuador

const HORARIO_ABIERTO = [
  { day_of_week: 1, open_time: '09:00:00', close_time: '17:00:00', is_active: true },
]
const HORARIO_CERRADO = [
  { day_of_week: 1, open_time: '09:00:00', close_time: '12:00:00', is_active: true },
  { day_of_week: 2, open_time: '09:00:00', close_time: '17:00:00', is_active: true },
]

const NEGOCIO = {
  id: 'b1', name: 'La Abuelita', type: 'almuerzos', slug: 'la-abuelita',
  takes_orders: true, storefront_enabled: true, active: true,
}

function armar({ horario } = {}) {
  const enviados = []
  const botones = []
  const database = {
    resolveMarketplaceCustomer: async () => ({ id: 'c1', name: 'Ana' }),
    getConversation: async () => ({
      current_state: 'navegando',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'almuerzos', pagina: 0 } },
      version: 1,
    }),
    advanceConversation: async () => ({ conflicto: false }),
    getBusinessById: async () => NEGOCIO,
    getMarketplaceCategories: async () => ([{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos', emoji: '🍱' }]),
    getMarketplaceBusinesses: async () => ([
      { id: 'b1', slug: 'la-abuelita', name: 'La Abuelita', type: 'almuerzos' },
    ]),
    claimMarketplaceReply: async () => ({ permitido: true, respuestas: 1 }),
    claimPlatformBlockState: async () => ({ bloqueado: false }),
    isContactBlocked: async () => false,
  }
  if (horario !== undefined) {
    database.getSchedulesFor = vi.fn().mockResolvedValue(new Map([['b1', horario]]))
  }
  const deps = {
    database,
    send: (reply, options) => { enviados.push({ reply, options }) },
    sendLink: async (mensaje) => { botones.push(mensaje); return true },
    issueLink: async () => 'https://umbani.app/s/tok3n',
  }
  const escribir = texto => handleMarketplaceMessage(
    { from: '593900000913', text: texto, inboundId: null }, deps,
  )
  return { escribir, enviados, botones, deps }
}

afterEach(() => { vi.useRealTimers() })

describe('elegir un local cerrado', () => {
  it('avisa ANTES de entrar, y manda el enlace igual', async () => {
    // La carta se puede mirar con el local cerrado, y saber qué hay es justo lo
    // que le hace volver a la hora de apertura. Lo que cambia es que se entera
    // antes, no después de armar el carrito.
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const { escribir, botones } = armar({ horario: HORARIO_CERRADO })

    await escribir('La Abuelita')

    expect(botones).toHaveLength(1)
    expect(botones[0].body).toContain('cerrado ahora mismo')
    expect(botones[0].body).toContain('mañana a las 9:00 AM')
    expect(botones[0].url).toBe('https://umbani.app/s/tok3n')
  })

  it('con el local ABIERTO invita a pedir', async () => {
    vi.useFakeTimers(); vi.setSystemTime(LUNES_13H)
    const { escribir, botones } = armar({ horario: HORARIO_ABIERTO })

    await escribir('La Abuelita')

    expect(botones[0].body).toContain('Arma tu pedido')
    expect(botones[0].body).not.toContain('cerrado')
  })

  it('FALLA ABIERTO: sin horario configurado se puede pedir', async () => {
    // Llamar «cerrado» a un local que está abierto le cuesta ventas de verdad;
    // lo contrario solo cuesta que un pedido llegue fuera de hora.
    const { escribir, botones } = armar({ horario: [] })

    await escribir('La Abuelita')

    expect(botones[0].body).not.toContain('cerrado')
  })
})
