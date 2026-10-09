import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { fuenteDeLaEntradaDelMarketplace } from './fuente-de-rutas.mjs'

// ═══════════════════════════════════════════════════════════════════════════
// TODO LOCAL PIDE POR LA MINI APP
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-09-14), después de probar el chat: «un pedido
// familiar cuesta ~14 mensajes de ida y vuelta, y cada saliente se paga».
// Además los títulos de lista se cortan a 24 caracteres y los grupos por
// casillas no se pueden expresar en WhatsApp. Eran DOS motores para lo mismo,
// y eso ya costó un fallo de cuatro días que dejó al chat sin poder vender.
//
// Lo que SIGUE por WhatsApp: bienvenida, categorías, elegir local, el enlace,
// los comprobantes, los avisos de estado, la ubicación y MENÚ. Lo único que
// desaparece es ARMAR EL CARRITO por chat.

const CATEGORIAS = [{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️', locales: 1 }]
const LOCAL = {
  id: 'biz-1', slug: 'la-abuelita', name: 'La Abuelita',
  type: 'almuerzos', prep_min: 20,
}
const TELEFONO = '593999111222'

const armar = () => {
  const enviados = []
  const botones = []
  const guardados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue(null),
    advanceConversation: vi.fn(async (_id, patch) => { guardados.push(patch); return { conflicto: false } }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([LOCAL]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'La Abuelita', slug: 'la-abuelita',
      type: 'almuerzos', storefront_enabled: true, takes_orders: true,
    }),
  }
  return {
    database,
    enviados,
    botones,
    guardados,
    deps: {
      database,
      issueLink: vi.fn().mockResolvedValue('https://umbani.app/s/tok3n'),
      send: async (reply, options) => { enviados.push({ reply, options }) },
      sendLink: async (mensaje) => { botones.push(mensaje); return true },
      logger: { log: () => {} },
    },
  }
}

let handle
beforeEach(async () => {
  ({ handleMarketplaceMessage: handle } = await import('../dist/services/marketplace-entry.js'))
})

describe('un local de almuerzos ya no arma el carrito en el chat', () => {
  it('elegirlo devuelve su ENLACE, no un menú de listas', async () => {
    const ctx = armar()
    await handle({ from: TELEFONO, text: 'hola' }, ctx.deps)
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'navegando',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'almuerzos', pagina: 0 } },
      version: 1,
    })
    await handle({ from: TELEFONO, text: 'La Abuelita' }, ctx.deps)

    expect(ctx.deps.issueLink).toHaveBeenCalled()
    expect(ctx.botones.at(-1)?.url).toBe('https://umbani.app/s/tok3n')
    expect(ctx.botones.at(-1)?.label).toBe('Ver la carta')
  })

  // ⚠️ Lo que el camino viejo hacía DE PASO y no se puede perder: el candado de
  // «un pedido a la vez» se pone al ELEGIR local, no al crear el pedido.
  it('conserva el candado y el local elegido', async () => {
    const ctx = armar()
    await handle({ from: TELEFONO, text: 'hola' }, ctx.deps)
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'almuerzos', pagina: 0 } }, version: 1,
    })
    await handle({ from: TELEFONO, text: 'La Abuelita' }, ctx.deps)

    const alElegir = ctx.guardados.find(patch => patch.businessId === 'biz-1')
    expect(alElegir).toMatchObject({ businessId: 'biz-1', shoppingLocked: true, state: 'en_local' })
  })
})

describe('quien quedó a medio pedir por chat no se queda atrapado', () => {
  // Al desplegar esto había UNA conversación en `pidiendo`. Sin esta rama, su
  // siguiente mensaje caía en un motor que ya no existe.
  const aMedias = estado => ({
    current_state: estado,
    selected_business_id: 'biz-1',
    shopping_locked: true,
    flow_state: { menu: { view: { kind: 'cart' } }, checkout: { items: [{ name: 'Almuerzo', qty: 1 }] } },
    version: 3,
  })

  it.each(['pidiendo', 'esperando_entrega', 'esperando_ubicacion', 'esperando_metodo_pago'])(
    'desde «%s» se le recuerda dónde está, sin motor de chat',
    async (estado) => {
      const ctx = armar()
      ctx.database.getConversation.mockResolvedValue(aMedias(estado))
      await handle({ from: TELEFONO, text: 'quiero pollo' }, ctx.deps)

      const dicho = ctx.enviados.map(e => e.reply).join(' ')
      expect(dicho).toMatch(/La Abuelita/)
      expect(dicho).not.toMatch(/Tu pedido|carrito/i)
    },
  )

  it('MENÚ lo devuelve a las categorías y suelta el local', async () => {
    const ctx = armar()
    ctx.database.getConversation.mockResolvedValue(aMedias('pidiendo'))
    await handle({ from: TELEFONO, text: 'MENÚ' }, ctx.deps)

    expect(ctx.enviados.at(-1)?.options.join(' ')).toMatch(/Almuerzos/)
    expect(ctx.guardados.at(-1)).toMatchObject({ clearBusiness: true })
  })
})

describe('el motor del chat ya no cuelga del marketplace', () => {
  const leer = ruta => readFileSync(fileURLToPath(new URL(ruta, import.meta.url)), 'utf8')

  it('la entrada del marketplace no importa el menú ni su checkout', () => {
    // Entera: desde el 2026-10-07 la entrada son cinco archivos.
    const fuente = fuenteDeLaEntradaDelMarketplace()
    expect(fuente).not.toMatch(/bot-menu-flow|marketplace-checkout/)
  })

  it('el checkout del chat se retiró del repositorio', () => {
    expect(existsSync(fileURLToPath(new URL('../src/services/marketplace-checkout.ts', import.meta.url)))).toBe(false)
  })

  it('el webhook ya no arma el motor de menú para el número de la plataforma', () => {
    const fuente = leer('../src/services/inbound-webhook.ts')
    const marketplace = fuente.slice(fuente.indexOf('atenderMarketplace'))
    expect(marketplace).not.toMatch(/avanzarMenu|crearPedidoCompleto|tipoPideEnChat/)
  })
})
