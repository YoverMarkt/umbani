import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// TOCAR OPCIONES VIEJAS TIENE CONSECUENCIA (2026-09-28)
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño, probando el número de Umbani: escribió «Menu», tocó «Hamburguesas»
// en una lista vieja, recibió el aviso, y tocó «Hamburguesas» en OTRA lista
// vieja. El anti-eco calló el segundo aviso —idéntico al de hacía segundos— y
// el «escribiendo…» se quedó colgado sin respuesta. Parecía roto.
//
// Su decisión: la regla de Luka se queda SIEMPRE. La primera vez, advertencia;
// la segunda, 5 minutos sin menú con un solo aviso, MENÚ no la levanta, y el
// comprobante de un pedido ya hecho pasa igual.

const require = createRequire(import.meta.url)
const {
  menuEnPausa, queHacerConElToqueViejo,
  PAUSA_POR_OPCIONES_VIEJAS_MS, VIGENCIA_DE_LA_ADVERTENCIA_MS,
} = require('../dist/services/marketplace-envio')
const {
  ADVERTENCIA_OPCION_VIEJA, avisoDePausaPorOpcionesViejas,
} = require('../dist/services/marketplace-menu')

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('la regla, sin base de por medio', () => {
  const ahora = Date.parse('2026-09-28T15:45:00Z')
  const hace = ms => new Date(ahora - ms).toISOString()

  it('sin advertencia previa, el toque viejo se advierte', () => {
    expect(queHacerConElToqueViejo(null, ahora)).toBe('advertir')
    expect(queHacerConElToqueViejo(undefined, ahora)).toBe('advertir')
  })

  it('con la advertencia vigente, se pausa', () => {
    expect(queHacerConElToqueViejo(hace(5_000), ahora)).toBe('pausar')
    expect(queHacerConElToqueViejo(hace(VIGENCIA_DE_LA_ADVERTENCIA_MS - 1), ahora)).toBe('pausar')
  })

  it('la advertencia caduca: un despiste de la noche no paga el de mediodía', () => {
    expect(queHacerConElToqueViejo(hace(VIGENCIA_DE_LA_ADVERTENCIA_MS), ahora)).toBe('advertir')
  })

  it('una fecha ilegible no pausa a nadie', () => {
    expect(queHacerConElToqueViejo('no es una fecha', ahora)).toBe('advertir')
    expect(menuEnPausa('no es una fecha', ahora)).toBe(false)
  })

  it('la pausa dura hasta su hora y ni un segundo más', () => {
    const hasta = new Date(ahora + PAUSA_POR_OPCIONES_VIEJAS_MS).toISOString()
    expect(menuEnPausa(hasta, ahora)).toBe(true)
    expect(menuEnPausa(hasta, ahora + PAUSA_POR_OPCIONES_VIEJAS_MS)).toBe(false)
    expect(menuEnPausa(null, ahora)).toBe(false)
  })

  it('son 5 minutos, como dice el texto', () => {
    expect(PAUSA_POR_OPCIONES_VIEJAS_MS).toBe(5 * 60_000)
    expect(ADVERTENCIA_OPCION_VIEJA).toContain('5 minutos')
  })

  it('el aviso de pausa dice la hora de vuelta en hora de Ecuador', () => {
    const texto = avisoDePausaPorOpcionesViejas('2026-09-28T15:52:00Z')
    expect(texto).toContain('desde las 10:52 AM')
    expect(texto).toContain('comprobante')
  })
})

// ── Con la función REAL del marketplace ────────────────────────────────────

const CATEGORIAS = [
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'hamburguesas', label: 'Hamburguesas', emoji: '🍔', locales: 1 },
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
]
const LOCALES = {
  hamburguesas: [{ id: 'biz-brava', slug: 'burger-brava', name: 'Burger Brava', type: 'hamburguesería', prep_min: 20 }],
  pizzerias: [{ id: 'biz-pizza', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 }],
}

/** Una base de mentira que RECUERDA la conversación entre turnos, como la real. */
const armarMarketplace = (conversacion, { sinPausa = false } = {}) => {
  const memoria = { valor: conversacion }
  const enviados = []
  const guardar = cambios => { if (memoria.valor) memoria.valor = { ...memoria.valor, ...cambios } }
  const database = {
    resolveMarketplaceCustomer: vi.fn(async () => ({ id: 'cli-1', name: null })),
    claimPlatformBlockState: vi.fn(async () => ({ bloqueado: false })),
    claimMarketplaceReply: vi.fn(async () => ({ permitido: true, respuestas: 1 })),
    getConversation: vi.fn(async () => memoria.valor && { ...memoria.valor }),
    advanceConversation: vi.fn(async (_id, patch) => {
      memoria.valor = {
        ...(memoria.valor || {}),
        current_state: patch.state || memoria.valor?.current_state || 'navegando',
        selected_business_id: patch.clearBusiness ? null : (patch.businessId ?? memoria.valor?.selected_business_id ?? null),
        shopping_locked: Boolean(patch.shoppingLocked ?? memoria.valor?.shopping_locked),
        flow_state: patch.flowState ?? memoria.valor?.flow_state ?? null,
        version: (memoria.valor?.version || 0) + 1,
      }
      return { conflicto: false }
    }),
    marcarUltimaLista: vi.fn(async (_id, marca) => { guardar({ menu_mark: marca }); return Boolean(memoria.valor) }),
    anotarUltimaRespuesta: vi.fn(async (_id, huella) => guardar({ last_reply_hash: huella, last_reply_at: new Date().toISOString() })),
    anotarAvisoDeOpcionVieja: vi.fn(async () => guardar({ stale_tap_warned_at: new Date().toISOString() })),
    pausarElMenu: vi.fn(async (_id, hasta) => { guardar({ menu_paused_until: hasta, stale_tap_warned_at: null }); return true }),
    getMarketplaceCategories: vi.fn(async () => CATEGORIAS),
    getMarketplaceBusinesses: vi.fn(async code => LOCALES[code] || []),
    getBusinessById: vi.fn(async id => ({ id, name: 'Burger Brava', slug: 'burger-brava', storefront_enabled: true, takes_orders: true })),
    searchMarketplaceBusinesses: vi.fn(async () => []),
    marketplaceKnownTerm: vi.fn(async () => null),
    cancelUnpaidOrderOnPurpose: vi.fn(async () => 0),
    revokeStorefrontSessionsOnExit: vi.fn(async () => 0),
  }
  if (sinPausa) delete database.pausarElMenu
  const deps = {
    database,
    send: vi.fn(async (reply, options, marca) => { enviados.push({ reply, options, marca }) }),
    issueLink: vi.fn(async () => 'https://umbani.app/s/enlace'),
    sendLink: vi.fn(async () => true),
    logger: { log: vi.fn() },
  }
  return { database, deps, enviados, memoria }
}

const atender = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593990978367', text: texto }, deps)
}

/** La portada, recién pintada tras «Menu»: su marca es la vigente. */
const enLaPortada = {
  current_state: 'navegando', selected_business_id: null, shopping_locked: false,
  flow_state: { vista: { vista: 'categorias', pagina: 0 } },
  version: 3, menu_mark: 'aaaaa',
}

describe('la secuencia exacta del dueño', () => {
  it('toque viejo → advertencia; otro toque viejo → pausa, NUNCA el silencio colgado', async () => {
    const m = armarMarketplace(enLaPortada)

    // Tocó «Hamburguesas» en una lista de antes de «Menu».
    await atender(m.deps, 'zzzzz.1')
    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0].reply).toContain(ADVERTENCIA_OPCION_VIEJA)
    // Con las opciones de AHORA y su marca nueva: esa es la que vale.
    expect(m.enviados[0].options.length).toBeGreaterThan(0)
    const marcaDeLaAdvertencia = m.memoria.valor.menu_mark
    expect(marcaDeLaAdvertencia).not.toBe('aaaaa')
    expect(m.memoria.valor.stale_tap_warned_at).toBeTruthy()
    expect(m.database.searchMarketplaceBusinesses).not.toHaveBeenCalled()

    // Tocó «Hamburguesas» en la lista de «¡Qué bueno tenerte de vuelta!», que
    // la advertencia acaba de dejar vieja. Antes: silencio y «escribiendo…».
    await atender(m.deps, 'aaaaa.1')
    expect(m.enviados).toHaveLength(2)
    expect(m.enviados[1].reply).toMatch(/pausamos tu pedido por el chat durante 5 minutos/)
    expect(m.enviados[1].reply).toMatch(/Podrás pedir de nuevo desde las \d{1,2}:\d{2} (AM|PM)/)
    expect(m.enviados[1].options).toEqual([])
    expect(m.database.pausarElMenu).toHaveBeenCalledTimes(1)
    expect(m.deps.issueLink).not.toHaveBeenCalled()
    // La pausa olvida la advertencia: al volver, el siguiente toque viejo
    // vuelve a ser solo una advertencia.
    expect(m.memoria.valor.stale_tap_warned_at).toBeNull()
  })

  it('durante la pausa: silencio, también para MENÚ y para lo escrito', async () => {
    const m = armarMarketplace({
      ...enLaPortada,
      menu_paused_until: new Date(Date.now() + 4 * 60_000).toISOString(),
    })
    for (const texto of ['MENÚ', 'Menu', 'quiero hamburguesas', 'aaaaa.1', 'zzzzz.2', '[foto]']) {
      await atender(m.deps, texto)
    }
    expect(m.enviados).toHaveLength(0)
    expect(m.deps.issueLink).not.toHaveBeenCalled()
    expect(m.database.advanceConversation).not.toHaveBeenCalled()
  })

  it('durante la pausa, el COMPROBANTE de un pedido ya hecho se atiende igual', async () => {
    const m = armarMarketplace({
      ...enLaPortada,
      current_state: 'pago_en_revision',
      selected_business_id: 'biz-brava',
      shopping_locked: true,
      menu_paused_until: new Date(Date.now() + 4 * 60_000).toISOString(),
    })
    await atender(m.deps, '[el cliente envió su comprobante de pago del pedido #12]')
    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0].reply).toMatch(/comprobante/i)
  })

  it('pasada la pausa, todo vuelve: MENÚ contesta', async () => {
    const m = armarMarketplace({
      ...enLaPortada,
      menu_paused_until: new Date(Date.now() - 1_000).toISOString(),
    })
    await atender(m.deps, 'MENÚ')
    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0].options.length).toBeGreaterThan(0)
  })

  it('la advertencia caducada no pausa: vuelve a advertir', async () => {
    const m = armarMarketplace({
      ...enLaPortada,
      stale_tap_warned_at: new Date(Date.now() - VIGENCIA_DE_LA_ADVERTENCIA_MS - 1_000).toISOString(),
    })
    await atender(m.deps, 'zzzzz.1')
    expect(m.database.pausarElMenu).not.toHaveBeenCalled()
    expect(m.enviados[0].reply).toContain(ADVERTENCIA_OPCION_VIEJA)
  })

  it('el toque en la ÚLTIMA lista funciona como siempre, sin advertencia', async () => {
    const m = armarMarketplace({ ...enLaPortada, stale_tap_warned_at: new Date().toISOString() })
    await atender(m.deps, 'aaaaa.1')
    expect(m.database.pausarElMenu).not.toHaveBeenCalled()
    expect(m.enviados[0].reply).not.toContain(ADVERTENCIA_OPCION_VIEJA)
    expect(m.enviados[0].options).toContain('Burger Brava')
  })
})

describe('el orden: primero se manda, después se anota', () => {
  it('si la advertencia no sale, no se anota: el reintento no pausa a quien no la leyó', async () => {
    const m = armarMarketplace(enLaPortada)
    m.deps.send.mockRejectedValueOnce(new Error('YCloud caído'))
    await expect(atender(m.deps, 'zzzzz.1')).rejects.toThrow('YCloud caído')
    expect(m.database.anotarAvisoDeOpcionVieja).not.toHaveBeenCalled()

    // El reintento del webhook: vuelve a ser la advertencia, no la pausa.
    await atender(m.deps, 'zzzzz.1')
    expect(m.database.pausarElMenu).not.toHaveBeenCalled()
    expect(m.enviados[0].reply).toContain(ADVERTENCIA_OPCION_VIEJA)
  })

  it('si el aviso de pausa no sale, no se pausa: nadie queda mudo sin saber por qué', async () => {
    const m = armarMarketplace({ ...enLaPortada, stale_tap_warned_at: new Date().toISOString() })
    m.deps.send.mockRejectedValueOnce(new Error('YCloud caído'))
    await expect(atender(m.deps, 'zzzzz.1')).rejects.toThrow('YCloud caído')
    expect(m.database.pausarElMenu).not.toHaveBeenCalled()
  })

  it('sin `pausarElMenu` (canario, simulador) nunca se pausa: se advierte', async () => {
    const m = armarMarketplace({ ...enLaPortada, stale_tap_warned_at: new Date().toISOString() }, { sinPausa: true })
    await atender(m.deps, 'zzzzz.1')
    expect(m.enviados[0].reply).toContain(ADVERTENCIA_OPCION_VIEJA)
  })
})

describe('nadie llega a la pausa sin haber leído la advertencia (camino real)', () => {
  // Cada estado responde al toque viejo por un camino distinto del código: el
  // menú, la confirmación de reinicio, el candado del local. Los tres tienen
  // que llevar la advertencia, o el siguiente toque pausa sin aviso previo.
  const estados = {
    'la portada': enLaPortada,
    'la lista de locales': { ...enLaPortada, flow_state: { vista: { vista: 'negocios', categoria: 'hamburguesas', pagina: 0 } } },
    'una búsqueda': { ...enLaPortada, flow_state: { vista: { vista: 'busqueda', consulta: 'pizza', pagina: 0 } } },
    'la confirmación de reinicio': {
      ...enLaPortada, current_state: 'confirmando_reinicio', selected_business_id: 'biz-brava', shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } },
    },
    'dentro de un local': { ...enLaPortada, current_state: 'en_local', selected_business_id: 'biz-brava', shopping_locked: true },
    'debiendo el comprobante': { ...enLaPortada, current_state: 'esperando_comprobante', selected_business_id: 'biz-brava', shopping_locked: true },
    'con el pago en revisión': { ...enLaPortada, current_state: 'pago_en_revision', selected_business_id: 'biz-brava', shopping_locked: true },
  }

  for (const [nombre, conversacion] of Object.entries(estados)) {
    it(`en ${nombre}`, async () => {
      const m = armarMarketplace(conversacion)
      await atender(m.deps, 'zzzzz.1')
      expect(m.enviados).toHaveLength(1)
      expect(m.enviados[0].reply).toContain(ADVERTENCIA_OPCION_VIEJA)
      expect(m.database.anotarAvisoDeOpcionVieja).toHaveBeenCalledTimes(1)
      expect(m.database.cancelUnpaidOrderOnPurpose).not.toHaveBeenCalled()
    })
  }
})

describe('el canario y el simulador no escriben advertencias ni pausas', () => {
  it('el canario las sustituye', () => {
    const fuente = readFileSync(new URL('../src/services/canario.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('anotarAvisoDeOpcionVieja: async () => undefined')
    expect(fuente).toContain('pausarElMenu: async () => false')
  })

  it('el simulador también: al superadmin se le advierte y nunca se le pausa', () => {
    const fuente = readFileSync(new URL('../src/routes/admin-simulator.routes.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('anotarAvisoDeOpcionVieja: async () => undefined')
    expect(fuente).toContain('pausarElMenu: async () => false')
  })
})

describe('el número de Umbani marca leído SIN «escribiendo…»', () => {
  it('el visto azul llega, el indicador no', async () => {
    const whatsapp = require('../dist/integrations/whatsapp')
    const platform = require('../dist/services/platform-channel')
    const visto = vi.spyOn(whatsapp, 'sendReadReceipt').mockResolvedValue(undefined)
    const escribiendo = vi.spyOn(whatsapp, 'sendTyping').mockResolvedValue(undefined)
    await platform.marcarLeidoPorLaPlataforma('inbound-1')
    expect(visto).toHaveBeenCalledWith(expect.anything(), 'inbound-1')
    expect(escribiendo).not.toHaveBeenCalled()
  })

  it('`sendReadReceipt` marca leído y nunca pinta «escribiendo…»', async () => {
    const ycloud = require('../dist/integrations/ycloud')
    const whatsapp = require('../dist/integrations/whatsapp')
    const markAsRead = vi.spyOn(ycloud, 'markAsRead').mockResolvedValue(undefined)
    const showTyping = vi.spyOn(ycloud, 'showTyping').mockResolvedValue(undefined)
    await whatsapp.sendReadReceipt({
      whatsapp_provider: 'ycloud', ycloud_api_key: 'ycloud-key', ycloud_number: '+593990000010',
    }, 'inbound-1')
    expect(markAsRead).toHaveBeenCalledWith('ycloud-key', 'inbound-1')
    expect(showTyping).not.toHaveBeenCalled()
  })

  it('si YCloud falla, no lanza: el visto nunca cuesta la respuesta', async () => {
    const ycloud = require('../dist/integrations/ycloud')
    const whatsapp = require('../dist/integrations/whatsapp')
    vi.spyOn(ycloud, 'markAsRead').mockRejectedValue(new Error('timeout'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(whatsapp.sendReadReceipt({
      whatsapp_provider: 'ycloud', ycloud_api_key: 'ycloud-key', ycloud_number: '+593990000010',
    }, 'inbound-1')).resolves.toBeUndefined()
  })

  it('los locales con canal propio conservan el «escribiendo…»: allí piensa la IA', () => {
    const fuente = readFileSync(new URL('../src/services/bot-entry.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('whatsapp.sendTyping(business, options.inboundId)')
  })
})
