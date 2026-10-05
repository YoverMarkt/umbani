import { describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// CÓMO USA LA GENTE EL MENÚ DE UMBANI (2026-09-18)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño: «qué cajones se tocan, cuáles se abandonan y qué escribe
// la gente en la búsqueda». Nada de eso se podía saber: la conversación guarda
// DÓNDE está cada cliente ahora, en una fila que se pisa a sí misma.
//
// ⚠️ Es un registro de PRODUCTO, no de dinero: si falla, el chat tiene que
// responder exactamente igual. Por eso la última prueba es la que importa.

const CATEGORIAS = [
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️', locales: 1 },
]
const LOCAL = {
  id: 'biz-1', slug: 'pizza-uno', name: 'Pizza Uno', type: 'pizzería',
  prep_min: 20, storefront_enabled: true, takes_orders: true,
}

const armar = ({ vista = null, estado = 'navegando' } = {}) => {
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue(vista ? {
      current_state: estado, selected_business_id: null, shopping_locked: false,
      flow_state: { vista }, version: 3,
    } : null),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([LOCAL]),
    searchMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue(LOCAL),
    getSchedulesFor: vi.fn().mockResolvedValue(new Map()),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
    isContactBlocked: vi.fn().mockResolvedValue(false),
    cancelUnpaidOrderOnPurpose: vi.fn().mockResolvedValue(0),
    revokeStorefrontSessionsOnExit: vi.fn().mockResolvedValue(0),
    logMarketplaceEvent: vi.fn().mockResolvedValue(undefined),
  }
  const enviados = []
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      issueLink: vi.fn().mockResolvedValue({ url: 'https://u/s/abc' }),
      tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(), crearPedido: vi.fn(), crearPedidoCompleto: vi.fn(),
    },
  }
}

const escribir = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000825', text: texto }, deps)
}

/** Los eventos registrados, en orden. */
const eventos = (m) => m.database.logMarketplaceEvent.mock.calls.map(([evento]) => evento)

describe('el menú de Umbani deja rastro', () => {
  it('quien escribe y recibe las categorías cuenta como «vio el menú»', async () => {
    const m = armar()
    await escribir(m.deps, 'hola')
    expect(eventos(m)).toContainEqual(expect.objectContaining({ customerId: 'cli-1', tipo: 'menu' }))
  })

  it('entrar a un cajón queda con SU código, que es el dato del reporte', async () => {
    const m = armar({ vista: { vista: 'categorias', pagina: 0 } })
    await escribir(m.deps, '1')
    expect(eventos(m)).toContainEqual(expect.objectContaining({
      tipo: 'cajon', categoryCode: 'pizzerias',
    }))
  })

  it('una búsqueda guarda lo que escribió y CUÁNTOS salieron', async () => {
    // ⚠️ El cero es el dato valioso: cada búsqueda sin resultado es una palabra
    // que el menú no entiende, y de ahí salen los alias y los nombres nuevos.
    //
    // Con el menú ya visto: en el PRIMER mensaje el chat saluda y enseña los
    // cajones, no busca — «un saludo no dispara la búsqueda».
    const m = armar({ vista: { vista: 'categorias', pagina: 0 } })
    await escribir(m.deps, 'quiero seco de chivo')
    expect(eventos(m)).toContainEqual(expect.objectContaining({
      tipo: 'busqueda', resultados: 0,
    }))
    const busqueda = eventos(m).find(e => e.tipo === 'busqueda')
    expect(busqueda.consulta).toContain('seco de chivo')
  })

  it('elegir un local queda con el local elegido', async () => {
    const m = armar({ vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } })
    await escribir(m.deps, '1')
    expect(eventos(m)).toContainEqual(expect.objectContaining({
      tipo: 'local', businessId: 'biz-1',
    }))
  })

  it('si el registro revienta, el cliente recibe su respuesta igual', async () => {
    // Es un registro de producto: no puede costar una venta.
    const m = armar()
    m.database.logMarketplaceEvent.mockRejectedValue(new Error('base caída'))
    await escribir(m.deps, 'hola')
    expect(m.enviados[0]?.reply).toBeTruthy()
  })

  it('sin la función de registro el chat funciona igual que antes', async () => {
    const m = armar()
    delete m.database.logMarketplaceEvent
    await escribir(m.deps, 'hola')
    expect(m.enviados[0]?.reply).toBeTruthy()
  })
})
