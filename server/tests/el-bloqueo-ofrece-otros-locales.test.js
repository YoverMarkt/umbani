import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { textoDeFotoQueNoEsComprobante } = require('../dist/services/payment-proof-inbox')

// ═══════════════════════════════════════════════════════════════════════════
// UN BLOQUEO DE LOCAL NO ES UN BLOQUEO DE UMBANI
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño lo probó el 2026-09-02: mandó dos imágenes que no eran comprobantes,
// se bloqueó el local —bien— y el mensaje le decía «mientras tanto puedes pedir
// en los demás locales»… sin darle ninguno. Leía una salida que no podía tomar.
//
// «Que me salgan las demás categorías, porque sí puedo pedir en otros locales.»
//
// ⚠️ Esto solo se puede ofrecer AHORA porque al bloquear se expira su pedido.
// Antes de eso, tocar una categoría lo habría llevado contra el muro de
// «tienes un pedido en proceso» — la salida habría sido igual de falsa.

const CATEGORIAS = [
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️', locales: 2 },
]

const armar = ({ bloqueadoEnElLocal = false } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: 'esperando_comprobante',
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { vista: { vista: 'negocios', pagina: 0 } },
      version: 3,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([
      { id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzeria', prep_min: 30 },
    ]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza', type: 'pizzeria',
      storefront_enabled: true, takes_orders: true,
    }),
    getProducts: vi.fn().mockResolvedValue([]),
    isContactBlocked: vi.fn().mockResolvedValue(bloqueadoEnElLocal),
    claimBlockedNotice: vi.fn().mockResolvedValue(true),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      issueLink: vi.fn().mockResolvedValue('https://umbani.app/s/tok3n'),
      send: async (reply, options) => { enviados.push({ reply, options }) },
      sendLink: vi.fn().mockResolvedValue(true),
      tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(),
      crearPedido: vi.fn(),
      crearPedidoCompleto: vi.fn(),
      logger: { log: () => {} },
    },
  }
}

let handle
beforeEach(async () => {
  ({ handleMarketplaceMessage: handle } = await import('../dist/services/marketplace-entry.js'))
})

describe('al bloquear por imágenes que no son comprobantes', () => {
  const marcaBloqueo = textoDeFotoQueNoEsComprobante({
    strikes: 2, blocked: true, limit: 2, minutes: 30,
  })

  it('ofrece las DEMÁS categorías, no solo la promesa de que existen', async () => {
    const { deps, enviados } = armar()
    await handle({ from: '593999111222', text: marcaBloqueo }, deps)

    const ultimo = enviados.at(-1)
    expect(ultimo.reply).toMatch(/30 minutos/)
    expect(ultimo.options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
  })

  it('GUARDA la vista, o el toque siguiente no se entendería', async () => {
    // Es el fallo del 2026-08-24: una rama que responde con opciones sin
    // persistir su vista obliga a tocar el botón dos veces.
    const { deps, database } = armar()
    await handle({ from: '593999111222', text: marcaBloqueo }, deps)

    expect(database.advanceConversation).toHaveBeenCalled()
    const patch = database.advanceConversation.mock.calls[0][1]
    expect(patch.flowState.vista.vista).toBe('categorias')
    // Y suelta el local: su pedido ahí acaba de expirar.
    expect(patch.clearBusiness).toBe(true)
  })

  it('la PRIMERA imagen mala no ofrece nada: todavía no está bloqueado', async () => {
    // Ahí la salida no es irse a otro local, es mandar la captura buena.
    const aviso = textoDeFotoQueNoEsComprobante({ strikes: 1, blocked: false, limit: 2 })
    const { deps, enviados } = armar()
    await handle({ from: '593999111222', text: aviso }, deps)

    expect(enviados.at(-1).options).toEqual([])
    expect(enviados.at(-1).reply).toMatch(/comprobante/i)
  })
})

describe('al elegir un local que te tiene bloqueado', () => {
  it('da las categorías en vez de hacerte teclear MENÚ', async () => {
    const { deps, enviados, database } = armar({ bloqueadoEnElLocal: true })
    database.getConversation.mockResolvedValue({
      current_state: 'navegando',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 2,
    })
    await handle({ from: '593999111222', text: 'Monster Pizza' }, deps)

    const ultimo = enviados.at(-1)
    expect(ultimo.reply).toContain('Monster Pizza')
    expect(ultimo.options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
    // Y no se le manda el enlace de un local donde no puede pedir.
    expect(deps.issueLink).not.toHaveBeenCalled()
  })
})
