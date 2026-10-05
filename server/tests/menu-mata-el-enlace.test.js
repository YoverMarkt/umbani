import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// MENÚ MATA EL ENLACE ANTERIOR
//
// El dueño lo probó (2026-09-03): escribió MENÚ, recibió las categorías… y el
// botón «Ver la carta» de unos mensajes más arriba SEGUÍA abriendo el local
// anterior. Sus palabras: «todo lo de la palabra menú hacia arriba debería
// morirse».
//
// Y no era estético: MENÚ suelta el candado de «un pedido a la vez», así que
// por ese enlace vivo se podía armar un pedido en un local mientras se
// navegaba otro — justo lo que el candado existe para impedir.
//
// ⚠️ CON UNA EXCEPCIÓN que marcó él mismo: quien debe un comprobante o lo
// tiene en revisión CONSERVA su enlace. Ahí la mini app es por donde manda su
// captura; revocárselo le deja un pedido pagado sin forma de rematarlo.
// ═══════════════════════════════════════════════════════════════════════════

const CATEGORIAS = [{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]

const armar = ({ estado = 'en_local', bloqueado = true } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: estado,
      selected_business_id: 'biz-1',
      shopping_locked: bloqueado,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 3,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
      storefront_enabled: true, takes_orders: true,
    }),
    getSchedulesFor: vi.fn().mockResolvedValue(new Map()),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
    isContactBlocked: vi.fn().mockResolvedValue(false),
    cancelUnpaidOrderOnPurpose: vi.fn().mockResolvedValue(1),
    revokeStorefrontSessionsOnExit: vi.fn().mockResolvedValue(2),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      issueLink: vi.fn(), tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(), crearPedido: vi.fn(), crearPedidoCompleto: vi.fn(),
    },
  }
}

const escribir = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000825', text: texto }, deps)
}

describe('MENÚ revoca el enlace anterior', () => {
  it('con un local elegido, mata los enlaces vivos', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
  })

  it('y también «Empezar de nuevo» ESCRITO, que entra por el otro camino', async () => {
    // ⚠️ Su texto normaliza a un COMANDO_MENU, así que llega por la rama de la
    // pregunta de reinicio. Conectar solo una dejaría la mitad sin revocar.
    // ⚠️ Esto cubre a quien lo ESCRIBE. El BOTÓN llega como número: ver la
    // prueba de «1» más abajo, que es la que faltaba.
    const m = armar({ estado: 'en_local' })
    m.database.getConversation.mockResolvedValue({
      current_state: 'en_local', selected_business_id: 'biz-1', shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } }, version: 3,
    })
    await escribir(m.deps, '✅ Empezar de nuevo')
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
  })

  it('el botón como llega DE VERDAD: con YCloud es su NÚMERO, «1», no su título', async () => {
    // ⚠️ Caso real (2026-09-17). La prueba de arriba mandaba el título, y
    // producción nunca lo manda: `ycloudContent` entrega el id del botón, que
    // es el número de la opción. «1» no es un comando de MENÚ, así que entraba
    // por la rama de la pregunta de reinicio, que cancelaba el pedido pero NO
    // revocaba el enlace. El dueño tocó «✅ Empezar de nuevo» y el enlace de
    // arriba seguía abriendo la carta.
    const m = armar({ estado: 'confirmando_reinicio' })
    m.database.getConversation.mockResolvedValue({
      current_state: 'confirmando_reinicio', selected_business_id: 'biz-1', shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } }, version: 3,
    })
    await escribir(m.deps, '1')
    expect(m.database.cancelUnpaidOrderOnPurpose).toHaveBeenCalled()
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
  })

  it('«2» —Seguir mi pedido— NO los revoca todos: devuelve el enlace', async () => {
    const m = armar({ estado: 'confirmando_reinicio' })
    m.database.getConversation.mockResolvedValue({
      current_state: 'confirmando_reinicio', selected_business_id: 'biz-1', shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } }, version: 3,
    })
    await escribir(m.deps, '2')
    expect(m.database.revokeStorefrontSessionsOnExit).not.toHaveBeenCalled()
  })

  // ⚠️ LA EXCEPCIÓN —quien debe un comprobante o lo tiene en revisión conserva
  // su enlace— ya NO se decide aquí con el estado del chat, sino en la base con
  // los pedidos (`revoke_storefront_sessions_on_exit`, probada en
  // `verificar-esquema.sql`). Hasta el 2026-09-27 esta prueba exigía «NO lo
  // revoca a quien debe un comprobante»… con la cancelación devolviendo 1: es
  // decir, daba por bueno cancelar el pedido y dejarle el enlace vivo. Le pasó
  // al amigo del dueño con el #25 de La Abuelita.
  it('a quien debe un comprobante: PRIMERO se cancela, DESPUÉS se deciden los enlaces', async () => {
    const m = armar({ estado: 'esperando_comprobante' })
    await escribir(m.deps, 'menu')
    expect(m.database.cancelUnpaidOrderOnPurpose).toHaveBeenCalled()
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
    expect(m.database.cancelUnpaidOrderOnPurpose.mock.invocationCallOrder[0])
      .toBeLessThan(m.database.revokeStorefrontSessionsOnExit.mock.invocationCallOrder[0])
  })

  it('a quien lo tiene en revisión también se le pregunta a la base, que es quien sabe', async () => {
    const m = armar({ estado: 'pago_en_revision' })
    await escribir(m.deps, 'menu')
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
  })

  it('el estado del chat ya no decide nada: no se le pasa', async () => {
    const fuente = readFileSync(new URL('../src/services/marketplace-entry.ts', import.meta.url), 'utf8')
    expect(fuente).not.toMatch(/matarEnlaceAnterior\([^)]*estadoDeLaConversacion/)
    expect(fuente).not.toMatch(/necesitaSuEnlace/)
  })

  // ─────────────────────────────────────────────────────────────────────
  // LO QUE MENÚ SEGUÍA HACIENDO, Y NO PUEDE DEJAR DE HACER
  //
  // La revocación se AÑADE a ese camino. Estas pruebas existen porque un
  // efecto que se pierde de paso no rompe nada visible: la lección del
  // 2026-08-03, cuando un atajo se llevó el marcar-como-leído sin que
  // ninguna prueba lo notara.
  // ─────────────────────────────────────────────────────────────────────
  it('sigue cancelando el pedido sin pagar', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    expect(m.database.cancelUnpaidOrderOnPurpose).toHaveBeenCalled()
  })

  it('sigue soltando el local y guardando la vista', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    const patch = m.database.advanceConversation.mock.calls.at(-1)?.[1]
    expect(patch.businessId ?? null).toBe(null)
    expect(patch.state).toBe('navegando')
  })

  it('sigue respondiendo con las categorías y la bienvenida de vuelta', async () => {
    const m = armar({ estado: 'en_local' })
    await escribir(m.deps, 'menu')
    const texto = m.enviados.map(e => e.reply).join('')
    expect(texto).toContain('vuelta')
    expect(m.enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
  })

  // ⚠️ Falla en SILENCIO: es una limpieza, no una defensa. La defensa es el
  // 403 de `readStorefrontSession`.
  it('si la revocación revienta, MENÚ funciona igual', async () => {
    const m = armar({ estado: 'en_local' })
    m.database.revokeStorefrontSessionsOnExit.mockRejectedValue(new Error('base caída'))
    await escribir(m.deps, 'menu')
    expect(m.enviados.flatMap(e => e.options)).toContain('🍕 Pizzerías')
  })
})
