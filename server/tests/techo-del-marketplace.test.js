import { describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL TECHO DE GASTO Y EL BLOQUEO, DENTRO DEL MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════
//
// Las dos defensas existían… para el canal PROPIO. Se llaman desde
// `bot-conversation.ts`, y el marketplace no pasa por ahí: hasta el 2026-08-24
// el número compartido respondía SIN LÍMITE —cada respuesta se paga desde el 1
// de octubre— y entregaba el enlace de un local a quien ese local había
// bloqueado, que descubría el rechazo al confirmar el carrito.
//
// Estas pruebas ejercen la función REAL (`handleMarketplaceMessage`), no leen
// el archivo: lo que importa es qué pasa cuando llega el mensaje.

const CATEGORIAS = [{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]
const LOCAL = { id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 }

const armar = ({ permitido = true, bloqueado = false, avisaDelBloqueo = false } = {}) => {
  const conversacion = { valor: null }
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
    getConversation: vi.fn(async () => conversacion.valor),
    advanceConversation: vi.fn(async (_id, patch) => {
      conversacion.valor = {
        current_state: patch.state || 'navegando',
        selected_business_id: patch.clearBusiness ? null : (patch.businessId ?? null),
        shopping_locked: Boolean(patch.shoppingLocked),
        flow_state: patch.flowState ?? null,
        version: (conversacion.valor?.version || 0) + 1,
      }
      return { conflicto: false }
    }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([LOCAL]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
      storefront_enabled: true, takes_orders: true,
    }),
    getPolicies: vi.fn().mockResolvedValue({ welcome_message: null }),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido, respuestas: permitido ? 3 : 26 }),
    isContactBlocked: vi.fn().mockResolvedValue(bloqueado),
    claimBlockedNotice: vi.fn().mockResolvedValue(avisaDelBloqueo),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      send: async (reply, options) => { enviados.push({ reply, options }) },
      issueLink: vi.fn().mockResolvedValue('https://umbani.test/s/token'),
      tipoPideEnChat: vi.fn().mockResolvedValue(false),
      avanzarMenu: vi.fn(),
      crearPedido: vi.fn(),
      crearPedidoCompleto: vi.fn(),
    },
  }
}

const atender = async (deps, texto, extra = {}) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000824', text: texto, ...extra }, deps)
}

describe('el techo de gasto del marketplace', () => {
  it('por debajo del tope contesta como siempre', async () => {
    const { deps, enviados, database } = armar()
    await atender(deps, 'hola')
    expect(database.claimMarketplaceReply).toHaveBeenCalledWith('cli-1', null)
    expect(enviados).toHaveLength(1)
  })

  // Ni una palabra: avisar al silenciado cuesta justo el mensaje que se está
  // ahorrando, y le da la reacción que busca.
  it('pasado el tope no se manda NADA', async () => {
    const { deps, enviados, database } = armar({ permitido: false })
    await atender(deps, 'hola')
    expect(enviados).toEqual([])
    // Y no se gasta ni una consulta más: se corta antes de leer la conversación.
    expect(database.getConversation).not.toHaveBeenCalled()
    expect(database.getMarketplaceCategories).not.toHaveBeenCalled()
  })

  // ⚠️ Si el techo fuera DESPUÉS de MENÚ, bastaría con escribir «MENÚ» sin
  // parar para tener respuestas gratis para siempre.
  it('MENÚ tampoco se escapa del techo', async () => {
    const { deps, enviados } = armar({ permitido: false })
    await atender(deps, 'MENÚ')
    expect(enviados).toEqual([])
  })

  // Quien acaba de pagar no es quien molesta, y dejarlo sin respuesta con el
  // dinero ya transferido es el peor momento posible para callarse.
  it('el comprobante SÍ se contesta aunque esté silenciado', async () => {
    const { deps, enviados, database } = armar({ permitido: false })
    await atender(deps, '[el cliente envió su comprobante de pago del pedido #12]')
    expect(database.claimMarketplaceReply).not.toHaveBeenCalled()
    expect(enviados).toHaveLength(1)
  })

  // ⚠️ La entrada es *at-least-once*: sin el id, cinco reintentos del worker
  // acercaban al silencio a un cliente legítimo.
  it('el id del mensaje entrante llega hasta el reclamo', async () => {
    const { deps, database } = armar()
    await atender(deps, 'hola', { inboundId: 'wamid.ABC' })
    expect(database.claimMarketplaceReply).toHaveBeenCalledWith('cli-1', 'wamid.ABC')
  })

  // Quedarse mudo por un problema nuestro deja sin servicio a alguien de
  // verdad; equivocarse al revés cuesta un mensaje.
  it('si el reclamo revienta, se atiende igual', async () => {
    const { deps, enviados, database } = armar()
    database.claimMarketplaceReply.mockRejectedValue(new Error('base caída'))
    await atender(deps, 'hola')
    expect(enviados).toHaveLength(1)
  })

  // Sin la función se atiende: quien construya estas dependencias sin ella
  // —el simulador, una prueba— no puede quedarse sin marketplace.
  it('sin la función configurada, se atiende', async () => {
    const { deps, enviados, database } = armar()
    delete database.claimMarketplaceReply
    await atender(deps, 'hola')
    expect(enviados).toHaveLength(1)
  })
})

describe('el bloqueo dentro del marketplace', () => {
  /** Deja la conversación mirando los locales de la categoría. */
  const enLaCategoria = (harness) => {
    harness.database.getConversation.mockResolvedValue({
      current_state: 'navegando',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 1,
    })
  }

  it('sin bloqueo, el local entrega su enlace', async () => {
    const h = armar()
    enLaCategoria(h)
    await atender(h.deps, 'Monster Pizza')
    expect(h.database.isContactBlocked).toHaveBeenCalledWith('biz-1', '593900000824')
    expect(h.deps.issueLink).toHaveBeenCalled()
    expect(h.enviados.at(-1).reply).toContain('https://umbani.test/s/token')
  })

  // El enlace abriría una tienda que va a rechazar el pedido al confirmar: el
  // cliente armaría el carrito entero para nada.
  it('un bloqueado no recibe el enlace de ese local', async () => {
    const h = armar({ bloqueado: true })
    enLaCategoria(h)
    await atender(h.deps, 'Monster Pizza')
    expect(h.deps.issueLink).not.toHaveBeenCalled()
    expect(h.enviados.at(-1).reply).toContain('Monster Pizza')
  })

  // Busca una reacción, y avisarle cuesta el mensaje que se está ahorrando.
  it('nunca se le dice que está bloqueado', async () => {
    const h = armar({ bloqueado: true })
    enLaCategoria(h)
    await atender(h.deps, 'Monster Pizza')
    expect(h.enviados.at(-1).reply).not.toMatch(/bloquead/i)
  })

  // Dejar fuera a un cliente legítimo por un fallo nuestro es peor que dejar
  // entrar a un bloqueado, que además no va a poder cerrar el pedido.
  it('si la consulta del bloqueo revienta, se atiende', async () => {
    const h = armar()
    h.database.isContactBlocked.mockRejectedValue(new Error('base caída'))
    enLaCategoria(h)
    await atender(h.deps, 'Monster Pizza')
    expect(h.deps.issueLink).toHaveBeenCalled()
  })
})

describe('el bloqueo de PLATAFORMA', () => {
  // Es distinto del bloqueo del local, y los dos hacen falta: aquel lo pone un
  // dueño y solo cierra SU local; este lo pone el superadmin y significa que
  // Umbani entero deja de atender a esa persona.
  it('no se le responde absolutamente nada', async () => {
    const h = armar()
    h.database.claimPlatformBlockState.mockResolvedValue({ bloqueado: true })
    await atender(h.deps, 'hola')
    expect(h.enviados).toEqual([])
  })

  // Va antes que el techo porque es más fuerte y más barato: ni se cuenta.
  it('ni se gasta el techo ni se lee la conversación', async () => {
    const h = armar()
    h.database.claimPlatformBlockState.mockResolvedValue({ bloqueado: true })
    await atender(h.deps, 'hola')
    expect(h.database.claimMarketplaceReply).not.toHaveBeenCalled()
    expect(h.database.getConversation).not.toHaveBeenCalled()
  })

  // ⚠️ Al bloqueado de plataforma NI SIQUIERA se le contesta el comprobante:
  // no tiene ningún pedido válido esperando, y responder es la reacción que
  // busca. Es la diferencia con el techo, donde el comprobante sí pasa.
  it('tampoco se le contesta el comprobante', async () => {
    const h = armar()
    h.database.claimPlatformBlockState.mockResolvedValue({ bloqueado: true })
    await atender(h.deps, '[el cliente envió su comprobante de pago del pedido #12]')
    expect(h.enviados).toEqual([])
  })

  it('falla ABIERTO: un fallo de la base no deja mudo al marketplace', async () => {
    const h = armar()
    h.database.claimPlatformBlockState.mockRejectedValue(new Error('base caída'))
    await atender(h.deps, 'hola')
    expect(h.enviados).toHaveLength(1)
  })

  it('sin la función configurada, se atiende', async () => {
    const h = armar()
    delete h.database.claimPlatformBlockState
    await atender(h.deps, 'hola')
    expect(h.enviados).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// AL BLOQUEADO SE LE EXPLICA UNA VEZ (2026-08-25)
//
// Hasta esta fecha no se le decía NUNCA. El dueño decidió lo contrario: quien
// fue bloqueado por dejar pedidos sin recoger no se enteraba de qué hizo mal,
// y el bloqueado por error tampoco. Pero avisar en CADA intento haría que el
// bloqueado costara más mensajes que un cliente normal — quien molesta insiste.
// ═══════════════════════════════════════════════════════════════════════════

describe('el aviso al bloqueado', () => {
  const elegirLocal = async (opciones) => {
    const m = armar(opciones)
    await atender(m.deps, 'hola')            // portada
    await atender(m.deps, '🍕 Pizzerías')    // locales
    m.enviados.length = 0
    await atender(m.deps, 'Monster Pizza')   // elige local
    return m
  }

  it('la primera vez le explica por qué, y le da salida', async () => {
    const { enviados, database } = await elegirLocal({ bloqueado: true, avisaDelBloqueo: true })
    expect(database.claimBlockedNotice).toHaveBeenCalledWith('biz-1', 'cli-1')
    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).toMatch(/pausó tus pedidos/i)
    expect(texto).toMatch(/otros locales/i)
    // El bloqueo es de UN local: nunca se le echa de Umbani entero.
    //
    // ⚠️ Antes se comprobaba que el texto dijera «MENÚ». Desde el 2026-09-02
    // la salida no se teclea: se le dan las CATEGORÍAS en el mismo mensaje,
    // que es lo que el dueño pidió tras probarlo —«que me salgan las demás
    // categorías, porque sí puedo pedir en otros locales»—. Lo que se vigila
    // sigue siendo lo mismo: que la salida EXISTA y sea tomable.
    const conOpciones = enviados.filter(e => e.options?.length)
    expect(conOpciones.length, 'el bloqueado se quedó sin ninguna salida').toBeGreaterThan(0)
  })

  it('a partir de la segunda vuelve el mensaje neutro', async () => {
    const { enviados } = await elegirLocal({ bloqueado: true, avisaDelBloqueo: false })
    const texto = enviados.map(e => e.reply).join('\n')
    expect(texto).toMatch(/no está recibiendo pedidos tuyos/i)
    expect(texto).not.toMatch(/pausó tus pedidos/i)
  })

  // Falla hacia el silencio: es la conducta anterior a esto, y la barata.
  it('si el reclamo revienta, se manda el mensaje neutro', async () => {
    const m = armar({ bloqueado: true })
    m.database.claimBlockedNotice = vi.fn().mockRejectedValue(new Error('base caída'))
    await atender(m.deps, 'hola')
    await atender(m.deps, '🍕 Pizzerías')
    m.enviados.length = 0
    await atender(m.deps, 'Monster Pizza')
    const texto = m.enviados.map(e => e.reply).join('\n')
    expect(texto).toMatch(/no está recibiendo pedidos tuyos/i)
  })

  // Al bloqueado JAMÁS se le manda el enlace de la tienda: armaría el carrito
  // entero para que se lo rechacen al confirmar.
  it('bloqueado o no, nunca recibe el enlace', async () => {
    const { enviados, deps } = await elegirLocal({ bloqueado: true, avisaDelBloqueo: true })
    expect(deps.issueLink).not.toHaveBeenCalled()
    expect(enviados.map(e => e.reply).join('')).not.toContain('umbani.test/s/')
  })
})
