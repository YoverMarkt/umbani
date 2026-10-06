import { describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL CHAT NO ENCADENA LO QUE PUEDE PEDIR A LA VEZ (2026-09-25)
// ═══════════════════════════════════════════════════════════════════════════
//
// Cada ida a la base se paga entera: con el servidor en EE. UU. y la base en
// São Paulo, ~140 ms cada una. Conversación, categorías y el local elegido se
// pedían una detrás de otra en CADA mensaje del marketplace, sin que ninguna
// necesitara a las demás — salvo el local, que sale de la conversación.
//
// Estas pruebas ejercen la función REAL: lo que importa es que, mientras la
// conversación todavía no ha contestado, las categorías YA se estén pidiendo.

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

const armar = () => {
  const conversacion = deferred()
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    getConversation: vi.fn(() => conversacion.promise),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue([
      { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
    ]),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
      storefront_enabled: true, takes_orders: true,
    }),
  }
  const deps = {
    database,
    send: async (reply, options) => { enviados.push({ reply, options }) },
    issueLink: vi.fn().mockResolvedValue('https://umbani.test/s/token'),
  }
  return { database, deps, conversacion, enviados }
}

const atender = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  return handleMarketplaceMessage({ from: '593900000925', text: texto }, deps)
}

describe('el chat pide a la vez lo que no depende de lo otro', () => {
  it('las categorías se piden sin esperar a la conversación', async () => {
    const { database, deps, conversacion, enviados } = armar()
    const atendiendo = atender(deps, 'hola')

    await vi.waitFor(() => expect(database.getConversation).toHaveBeenCalledOnce())
    // La conversación sigue sin contestar y las categorías ya van en camino.
    expect(database.getMarketplaceCategories).toHaveBeenCalledOnce()

    conversacion.resolve(null)
    await atendiendo
    expect(enviados).toHaveLength(1)
  })

  it('el local elegido sale de la conversación, en cuanto llega', async () => {
    const { database, deps, conversacion } = armar()
    const atendiendo = atender(deps, 'hola')

    await vi.waitFor(() => expect(database.getConversation).toHaveBeenCalledOnce())
    expect(database.getBusinessById).not.toHaveBeenCalled()

    conversacion.resolve({
      current_state: 'en_local', selected_business_id: 'biz-1',
      shopping_locked: false, flow_state: null, version: 3,
    })
    await atendiendo
    expect(database.getBusinessById).toHaveBeenCalledWith('biz-1')
  })

  it('si la base falla leyendo el local, el mensaje se reintenta: el candado no se salta', async () => {
    // Fallar «abierto» aquí dejaría abrir un segundo pedido con uno en curso.
    const { database, deps, conversacion, enviados } = armar()
    database.getBusinessById.mockRejectedValue(new Error('base caída'))
    conversacion.resolve({
      current_state: 'en_local', selected_business_id: 'biz-1',
      shopping_locked: true, flow_state: null, version: 3,
    })

    await expect(atender(deps, 'hola')).rejects.toThrow('base caída')
    expect(enviados).toEqual([])
  })
})
