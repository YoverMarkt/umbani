import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ═══════════════════════════════════════════════════════════════════════════
// EL CANAL DE LA PLATAFORMA
//
// Un solo número para todo el marketplace. Lo que se fija aquí es lo que hace
// que un mensaje SIN local llegue, se ordene y se conteste — y que al abrir
// ese camino no se haya debilitado el que ya existía.
// ═══════════════════════════════════════════════════════════════════════════

const leer = ruta => readFileSync(
  fileURLToPath(new URL(ruta, import.meta.url)),
  'utf8',
)

describe('reconocer el número de la plataforma', () => {
  it('el mismo número casa con y sin el «+»', async () => {
    const { esNumeroDePlataforma } = await import('../dist/services/platform-channel.js')
    const direccion = identifier => ([{
      provider: 'ycloud', identifierType: 'phone', identifier,
    }])

    // El mismo teléfono llega como `+593…` desde un proveedor y como `593…`
    // desde otro. Comparar en crudo daría «no» a dos escrituras del mismo
    // número, y el mensaje se descartaría en silencio.
    expect(esNumeroDePlataforma(direccion('+593990978367'), '593990978367')).toBe(true)
    expect(esNumeroDePlataforma(direccion('593990978367'), '593990978367')).toBe(true)
    expect(esNumeroDePlataforma(direccion('+593 99 097 8367'), '593990978367')).toBe(true)
    expect(esNumeroDePlataforma(direccion('593990978368'), '593990978367')).toBe(false)
  })

  it('un account_id de Meta nunca se confunde con un número', async () => {
    const { esNumeroDePlataforma } = await import('../dist/services/platform-channel.js')
    // Comparar un identificador de cuenta con un teléfono daría siempre falso,
    // pero por accidente. Se excluye explícitamente.
    expect(esNumeroDePlataforma([{
      provider: 'meta', identifierType: 'account_id', identifier: '593990978367',
    }], '593990978367')).toBe(false)
  })
})

describe('el payload durable sin local', () => {
  const base = {
    version: 1,
    provider: 'ycloud',
    from: '593990978367',
    inboundId: 'wamid.abc',
    channelAddress: {
      provider: 'ycloud', identifierType: 'phone', identifier: '593911111111',
    },
    content: { kind: 'text', text: 'hola' },
  }

  it('acepta que no haya negocio: el cliente aún no eligió local', async () => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    expect(parseInboundWebhookPayload({ ...base, businessId: null }).businessId).toBe(null)
    // Ausente y nulo son lo mismo: un payload viejo no llevaba el campo.
    expect(parseInboundWebhookPayload({ ...base }).businessId).toBe(null)
  })

  it('pero un negocio ILEGIBLE sigue siendo un error', async () => {
    const { parseInboundWebhookPayload } = await import('../dist/services/inbound-webhook.js')
    // ⚠️ Esto es lo que separa «mensaje de marketplace» de «payload corrupto».
    // Tratarlos igual escondería el corrupto detrás del camino nuevo.
    for (const roto of ['', '   ', 'x'.repeat(200), 42]) {
      expect(() => parseInboundWebhookPayload({ ...base, businessId: roto }))
        .toThrow(/Contexto durable/)
    }
  })

  it('la clave de conversación dice «plataforma», no «null»', async () => {
    const { inboundConversationKey } = await import('../dist/services/inbound-webhook.js')
    const clave = inboundConversationKey({ ...base, businessId: null })
    expect(clave).toBe('ycloud:plataforma:593990978367')
    // Un `null` interpolado ahí parece un dato que se perdió al leer un log.
    expect(clave).not.toContain('null')
  })
})

describe('la migración no revierte lo que ya existía', () => {
  const sql = leer('../migration-2026-08-21-canal-de-plataforma.sql')

  it('conserva el agrupado de textos rápidos', () => {
    // ⚠️ El riesgo real: `enqueue_webhook_event` creció con el debounce
    // durable (migration-agrupado-webhooks.sql). Recrearla desde la versión
    // vieja de migration-inbox-webhooks.sql lo habría borrado en silencio, y
    // cada palabra suelta del cliente pasaría a ser una respuesta pagada.
    expect(sql).toContain('v_quiet_until')
    expect(sql).toContain("interval '3 seconds'")
    expect(sql).toContain('_inboxBatch')
    expect(sql).toMatch(/boundary/)
  })

  it('conserva los lotes del lease', () => {
    expect(sql).toMatch(/v_batch_ids|v_combined_text/)
  })

  it('compara los negocios con «is not distinct from», nunca con «=»', () => {
    // En SQL `null = null` es NULL, no cierto. Con `=`, el FIFO por
    // conversación desaparecía para los mensajes sin local y dos mensajes
    // seguidos del mismo cliente se contestaban al revés.
    //
    // Se mira solo el CÓDIGO: los comentarios de la migración citan el `=`
    // viejo para explicar de qué fallo viene, y eso no es una comparación.
    const codigo = sql.split('\n')
      .filter(linea => !linea.trimStart().startsWith('--'))
      .join('\n')
    expect(codigo).not.toMatch(/business_id\s*=\s*/)
    expect(codigo).toContain('is not distinct from')
  })

  it('el advisory lock no se calcula sobre NULL', () => {
    // `null || ':'` es NULL: sin el coalesce, el lock que serializa los
    // enqueue del mismo stream se pediría sobre nada.
    expect(sql).toContain("coalesce(p_business_id::text, 'plataforma')")
  })

  it('deduplica los mensajes sin local con índices parciales', () => {
    // Los únicos que empiezan por business_id no deduplican con NULL, así que
    // sin estos el mismo mensaje reentregado se contestaría dos veces.
    expect(sql).toContain('uq_webhook_events_plataforma_hash')
    expect(sql).toContain('uq_webhook_inbox_plataforma_stream')
    expect(sql).toMatch(/where business_id is null/)
  })

  it('no toca las funciones del dinero ni el reclamo por negocio', () => {
    expect(sql).not.toContain('create_storefront_order')
    expect(sql).not.toContain('set_order_status')
    // `claim_webhook_event` sigue exigiendo negocio: solo lo usan los canales
    // con número propio, donde el negocio siempre existe.
    expect(sql).not.toContain('claim_webhook_event')
  })
})

describe('el menú del marketplace, de punta a punta', () => {
  const CATEGORIAS = [
    { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
    { city_id: 'ciudad-chone', city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos', emoji: '🍽️', locales: 2 },
  ]
  const MONSTER = {
    id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza',
    type: 'pizzería', prep_min: 25,
  }

  const armar = (overrides = {}) => {
    const conversacion = { valor: null }
    const database = {
      resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: null }),
      getConversation: vi.fn(async () => conversacion.valor),
      advanceConversation: vi.fn(async (_id, patch) => {
        conversacion.valor = {
          current_state: patch.state || 'navegando',
          selected_business_id: patch.clearBusiness
            ? null
            : (patch.businessId ?? conversacion.valor?.selected_business_id ?? null),
          shopping_locked: patch.shoppingLocked ?? conversacion.valor?.shopping_locked ?? false,
          flow_state: patch.flowState ?? conversacion.valor?.flow_state ?? null,
          version: (conversacion.valor?.version || 0) + 1,
        }
        return { conflicto: false }
      }),
      getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
      getMarketplaceBusinesses: vi.fn().mockResolvedValue([MONSTER]),
      getBusinessById: vi.fn().mockResolvedValue({
        id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
        storefront_enabled: true, takes_orders: true,
      }),
      // Catálogo grande: estos casos cubren el camino del ENLACE. La regla
      // de los 20 y el pedido dentro del chat viven en su propio archivo.
      getProducts: vi.fn().mockResolvedValue([]),
      getMenuModifiers: vi.fn().mockResolvedValue([]),
      getLastOrderForContact: vi.fn().mockResolvedValue(null),
      getPolicies: vi.fn().mockResolvedValue(null),
      ...overrides.database,
    }
    const enviados = []
    return {
      conversacion,
      database,
      enviados,
      deps: {
        database,
        issueLink: overrides.issueLink
          || vi.fn().mockResolvedValue('https://umbani.app/t/monster-pizza?k=abc'),
        send: async (reply, options) => { enviados.push({ reply, options }) },
        tipoPideEnChat: async () => false,
        avanzarMenu: vi.fn(() => ({
          resultado: { reply: '', options: [] },
          estado: null,
        })),
        crearPedido: vi.fn().mockResolvedValue(true),
        logger: { log: () => {} },
      },
    }
  }

  let handle
  let SI_REINICIAR
  beforeEach(async () => {
    ({ handleMarketplaceMessage: handle } = await import('../dist/services/marketplace-entry.js'))
    // La etiqueta REAL del botón, no una copia: si cambia, estas pruebas
    // siguen midiendo lo que el cliente toca de verdad.
    ;({ SI_REINICIAR } = await import('../dist/services/marketplace-menu.js'))
  })

  it('el primer mensaje ofrece las categorías', async () => {
    const ctx = armar()
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    expect(ctx.enviados).toHaveLength(1)
    expect(ctx.enviados[0].options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
  })

  it('elegir categoría lleva a los locales SIN pedir otro mensaje', async () => {
    const ctx = armar()
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Pizzerías' }, ctx.deps)
    // ⚠️ Las dos fases de `paso` (elegir categoría → consultar locales) se
    // resuelven dentro de la MISMA llamada. Si no, el cliente tendría que
    // escribir dos veces para ver una lista, y cada mensaje se paga.
    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.options).toContain('Monster Pizza')
    // Con la ciudad del cliente (2026-10-05): la que tiene locales, Chone.
    expect(ctx.database.getMarketplaceBusinesses).toHaveBeenCalledWith('pizzerias', 'ciudad-chone')
  })

  it('elegir local manda su enlace y deja la conversación en ese local', async () => {
    const ctx = armar()
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Pizzerías' }, ctx.deps)
    await handle({ from: '593990978367', text: 'Monster Pizza' }, ctx.deps)

    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toContain('Monster Pizza')
    expect(ultimo.reply).toContain('https://umbani.app/t/monster-pizza?k=abc')
    expect(ctx.conversacion.valor.selected_business_id).toBe('biz-1')
  })

  it('el local se guarda ANTES de mandar el enlace', async () => {
    // Si se guardara después y el envío fallara, el cliente tendría la tienda
    // abierta y la plataforma lo creería en la portada.
    const orden = []
    const ctx = armar({
      issueLink: vi.fn(async () => { orden.push('enlace'); return 'https://x/y' }),
    })
    ctx.database.advanceConversation.mockImplementation(async (_i, patch) => {
      if (patch.businessId) orden.push('guardar')
      return { conflicto: false }
    })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 1,
    })
    await handle({ from: '593990978367', text: 'Monster Pizza' }, ctx.deps)
    expect(orden).toEqual(['guardar', 'enlace'])
  })

  it('sin enlace se dice, y se ofrece la salida', async () => {
    const ctx = armar({ issueLink: vi.fn().mockResolvedValue(null) })
    ctx.database.getConversation.mockResolvedValue({
      current_state: 'navegando', selected_business_id: null, shopping_locked: false,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 1,
    })
    await handle({ from: '593990978367', text: 'Monster Pizza' }, ctx.deps)
    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toMatch(/MENÚ/)
    // Nunca se deja al cliente sin respuesta y sin salida.
    expect(ultimo.reply).not.toBe('')
  })

  it('sin locales disponibles se dice, en vez de una lista vacía', async () => {
    const ctx = armar()
    ctx.database.getMarketplaceCategories.mockResolvedValue([])
    await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
    expect(ctx.enviados[0].reply).toMatch(/no hay locales/i)
    expect(ctx.enviados[0].options).toEqual([])
  })

  describe('un pedido a la vez', () => {
    const conPedidoAbierto = ctx => {
      ctx.database.getConversation.mockResolvedValue({
        current_state: 'en_local',
        selected_business_id: 'biz-1',
        shopping_locked: true,
        flow_state: { vista: { vista: 'negocios', pagina: 0 } },
        version: 3,
      })
    }

    it('con un pedido abierto no se cambia de local en silencio', async () => {
      const ctx = armar()
      conPedidoAbierto(ctx)
      await handle({ from: '593990978367', text: 'ahora quiero pizza' }, ctx.deps)
      const ultimo = ctx.enviados.at(-1)
      expect(ultimo.reply).toContain('Monster Pizza')
      // El bloqueo NO es un muro: dice qué tiene abierto Y cómo salir, en el
      // mismo mensaje. Cada respuesta se paga desde el 1 de octubre.
      //
      // ⚠️ CAMBIADO EL 2026-08-23, misma intención: antes mandaba «escribe
      // *MENÚ*», y MENÚ llevaba a una pregunta que MENÚ no podía responder.
      // El dueño se quedó en bucle. Ahora la salida son las dos opciones.
      expect(ultimo.options).toHaveLength(2)
      expect(ultimo.options.join(' ')).toMatch(/Empezar de nuevo/)
    })

    // ── El bug del 2026-08-24: hacían falta DOS toques ──
    //
    // Esta rama era la única que respondía sin guardar su vista. Como el botón
    // que ofrece —«✅ Empezar de nuevo»— normaliza a uno de los COMANDOS_MENU,
    // tocarlo se leía como MENÚ con la vista anterior y volvía a preguntar.
    it('recordar el pedido abierto DEJA GUARDADA la vista de confirmación', async () => {
      const ctx = armar()
      ctx.conversacion.valor = {
        current_state: 'en_local',
        selected_business_id: 'biz-1',
        shopping_locked: true,
        flow_state: { vista: { vista: 'negocios', pagina: 0 } },
        version: 3,
      }
      await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
      // Sin esto, el toque siguiente no tiene forma de saber que se le
      // preguntó nada.
      expect(ctx.database.advanceConversation).toHaveBeenCalled()
      expect(ctx.conversacion.valor.current_state).toBe('confirmando_reinicio')
      // Y NO suelta el local: aquí solo se está preguntando.
      expect(ctx.conversacion.valor.selected_business_id).toBe('biz-1')
    })

    it('tocar «Empezar de nuevo» reinicia en UN solo toque', async () => {
      const ctx = armar()
      ctx.conversacion.valor = {
        current_state: 'en_local',
        selected_business_id: 'biz-1',
        shopping_locked: true,
        flow_state: { vista: { vista: 'negocios', pagina: 0 } },
        version: 3,
      }
      await handle({ from: '593990978367', text: 'hola' }, ctx.deps)
      await handle({ from: '593990978367', text: SI_REINICIAR }, ctx.deps)

      const ultimo = ctx.enviados.at(-1)
      // Las categorías, no la pregunta otra vez.
      expect(ultimo.options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
      expect(ultimo.reply).not.toMatch(/pedido en proceso/i)
      // Y AHORA sí se suelta el local: el cliente confirmó.
      expect(ctx.conversacion.valor.selected_business_id).toBeNull()
    })

    it('MENÚ con un pedido abierto va DIRECTO a las categorías', async () => {
    // ⚠️ ESTA AFIRMACIÓN SE INVIRTIÓ EL 2026-09-05, y queda escrito por qué.
    // Hasta esa fecha MENÚ preguntaba «¿empezar de nuevo o seguir?» en cuanto
    // había un local elegido. El dueño lo probó y tenía razón dos veces:
    //
    //  · «MENÚ mata todo proceso, es la palabra clave y más fuerte», y el
    //    propio mensaje del enlace dice «para volver al inicio, escribe MENÚ»;
    //  · y la pregunta era FALSA en el caso más común — el candado se pone al
    //    ELEGIR el local, así que a quien acababa de recibir el enlace se le
    //    decía «tienes un pedido en proceso» sin tener ninguno (comprobado
    //    contra producción: 0 pedidos abiertos).
    //
    // La pregunta NO desapareció: sale ante cualquier OTRA cosa —otro texto,
    // una foto—, que es cuando de verdad hace falta avisar.
      const ctx = armar()
      conPedidoAbierto(ctx)
      await handle({ from: '593990978367', text: 'menú' }, ctx.deps)
      const ultimo = ctx.enviados.at(-1)
      expect(ultimo.options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
      // Y suelta el local: MENÚ es salir, no preguntar si se quiere salir.
      const patches = ctx.database.advanceConversation.mock.calls.map(c => c[1])
      expect(patches.some(p => p.clearBusiness)).toBe(true)
    })

    it('MENÚ sin pedido abierto vuelve a la portada directo', async () => {
      const ctx = armar()
      ctx.database.getConversation.mockResolvedValue({
        current_state: 'navegando', selected_business_id: null, shopping_locked: false,
        flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
        version: 2,
      })
      await handle({ from: '593990978367', text: 'MENÚ' }, ctx.deps)
      expect(ctx.enviados.at(-1).options).toEqual(['🍕 Pizzerías', '🍽️ Almuerzos'])
    })
  })
})

describe('el envío por el número de la plataforma', () => {
  it('no le cobra el mensaje a ningún negocio', async () => {
    const fuente = leer('../src/services/platform-channel.ts')
    // Un mensaje de antes de elegir local es de la plataforma. Cargárselo a un
    // local elegido después sería inventarle gasto.
    expect(fuente).toMatch(/id:\s*null/)
  })

  it('cae a texto con las opciones si la lista interactiva falla', async () => {
    const fuente = leer('../src/services/platform-channel.ts')
    // Quedarse sin respuesta es peor que responder sin botones.
    expect(fuente).toContain('sendText')
    expect(fuente).toMatch(/\$\{i \+ 1\}/)
  })
})

describe('el negocio de marketplace ya puede enviar', () => {
  const fuente = leer('../src/integrations/whatsapp.ts')

  it('resuelve el canal antes de decidir el proveedor', () => {
    // Antes lanzaba «todavía no hay canal propio»: un aviso de pedido a un
    // local de marketplace no salía nunca.
    expect(fuente).toContain('conCanalDePlataforma')
    expect(fuente).not.toContain('todavía no hay canal propio')
  })

  it('las credenciales salen del canal resuelto, no del negocio', () => {
    // ⚠️ El fallo silencioso que esto evita: con `ycloudKeyFor(business)` un
    // local de marketplace no tiene key propia y caería a la variable de
    // entorno, mandando por la cuenta equivocada.
    expect(fuente).not.toContain('ycloudKeyFor(business)')
    expect(fuente).not.toContain('ycloudNumberFor(business)')
    expect(fuente).toContain('ycloudKeyFor(canal)')
  })

  it('pero el consumo se le sigue cargando al LOCAL, no a la plataforma', () => {
    // Quien envía es la plataforma; quien gasta es el local.
    expect(fuente).toMatch(/recordAcceptedMessage\(business,/)
    expect(fuente).toMatch(/recordSendFailure\(business,/)
  })

  it('el «escribiendo…» resuelve el canal DENTRO de su try', () => {
    // ⚠️ `sendTyping` es best-effort: nunca puede interrumpir la respuesta.
    // Resolver el canal consulta `server_settings` y puede lanzar, así que
    // fuera del try un negocio sin plataforma configurada tumbaría la
    // respuesta entera por no poder poner el indicador de escritura.
    const typing = fuente.slice(
      fuente.indexOf('async function sendTyping'),
      fuente.indexOf('async function sendText'),
    )
    const try_ = typing.indexOf('try {')
    const resolver = typing.indexOf('conCanalDePlataforma(business)')
    expect(try_).toBeGreaterThan(-1)
    expect(resolver).toBeGreaterThan(try_)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL COMPROBANTE QUE LLEGA AL NÚMERO DE LA PLATAFORMA
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ EL HUECO QUE ESTO CIERRA, y no era teórico: con un solo número, quien
// pide en el chat del marketplace y transfiere manda su captura a ESE número.
// El mensaje llega sin local —`businessId === null`, porque el número es de la
// plataforma y no de ningún negocio— y la foto se convertía en el texto
// «[foto]» sin descargarse nunca. El comprobante se perdía, el pedido se
// quedaba en `esperando_pago` para siempre y el cliente sin respuesta.
//
// Es el mismo patrón que ya cerró el atajo del modo mini app: se le pregunta
// a la BASE si ese teléfono tiene un pedido esperando comprobante ANTES de
// bajar un solo byte. Quien no lo tenga sigue por el camino de siempre.
const { createInboundWebhookProcessor } = await import('../dist/services/inbound-webhook.js')

describe('la foto de quien pidió por el marketplace', () => {
  const eventoConFoto = () => ({
    version: 1,
    provider: 'ycloud',
    businessId: null,
    from: '+593988000001',
    inboundId: 'wamid-foto-1',
    channelAddress: { provider: 'ycloud', identifierType: 'phone', identifier: '593991716574' },
    content: {
      kind: 'image',
      media: { url: 'https://api.ycloud.com/v2/whatsapp/media/download/abc123', mimeType: 'image/jpeg' },
    },
  })

  const montar = (overrides = {}) => {
    const atenderMarketplace = vi.fn().mockResolvedValue(undefined)
    const logger = { log: vi.fn() }
    const http = {
      get: vi.fn().mockResolvedValue({
        data: Buffer.from('la captura'), headers: { 'content-type': 'image/jpeg' },
      }),
    }
    const process = createInboundWebhookProcessor({
      database: { getBusinessByChannel: vi.fn() },
      bot: { handleMessage: vi.fn(), handleImage: vi.fn(), transcribeAudio: vi.fn() },
      http,
      logger,
      atenderMarketplace,
      // ⚠️ La key sale de `server_settings`, no del entorno: el número es de
      // la plataforma y no pertenece a ningún negocio.
      credencialDePlataforma: async () => 'ycloud-key-de-la-plataforma',
      ...overrides,
    })
    return { process, atenderMarketplace, http, logger }
  }

  it('sin pedido esperando pago NO se descarga nada (el ahorro se conserva)', async () => {
    const esperaComprobanteSinLocal = vi.fn().mockResolvedValue(false)
    const m = montar({ esperaComprobanteSinLocal, adjuntarComprobante: vi.fn() })
    await m.process(eventoConFoto())

    expect(m.http.get).not.toHaveBeenCalled()
    expect(m.atenderMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[foto]' }),
    )
  })

  it('CON un pedido esperando pago, la foto se descarga y se adjunta', async () => {
    const adjuntarComprobante = vi.fn().mockResolvedValue({ adjuntado: true, orderNumber: 45 })
    const m = montar({
      esperaComprobanteSinLocal: vi.fn().mockResolvedValue(true),
      adjuntarComprobante,
    })
    await m.process(eventoConFoto())

    // ⚠️ Se llama SIN local: el negocio sale del PEDIDO, nunca del número.
    expect(adjuntarComprobante).toHaveBeenCalledWith(
      null, '+593988000001', expect.any(Buffer), 'image/jpeg',
    )
    expect(m.atenderMarketplace).toHaveBeenCalledWith(expect.objectContaining({
      text: '[el cliente envió su comprobante de pago del pedido #45]',
    }))
  })

  it('con pagos pendientes en varios locales, se pregunta cuál', async () => {
    const m = montar({
      esperaComprobanteSinLocal: vi.fn().mockResolvedValue(true),
      adjuntarComprobante: vi.fn().mockResolvedValue({
        adjuntado: false,
        ambiguos: [
          { orderId: 'a', orderNumber: 1, businessName: 'El Puerto' },
          { orderId: 'b', orderNumber: 2, businessName: 'Monster Pizza' },
        ],
      }),
    })
    await m.process(eventoConFoto())
    expect(m.atenderMarketplace.mock.calls[0][0].text).toContain('El Puerto / Monster Pizza')
  })

  it('si la foto no era un comprobante, se le pide la correcta', async () => {
    const m = montar({
      esperaComprobanteSinLocal: vi.fn().mockResolvedValue(true),
      adjuntarComprobante: vi.fn().mockResolvedValue({
        adjuntado: false, noEsComprobante: true,
      }),
    })
    await m.process(eventoConFoto())
    expect(m.atenderMarketplace.mock.calls[0][0].text)
      .toContain('una imagen que no parece un pago')
  })

  it('sin la credencial de la plataforma, se falla abierto', async () => {
    // Es el caso del día que nadie haya pegado todavía la API Key en Ajustes.
    const m = montar({
      esperaComprobanteSinLocal: vi.fn().mockResolvedValue(true),
      adjuntarComprobante: vi.fn(),
      credencialDePlataforma: async () => null,
    })
    await m.process(eventoConFoto())
    expect(m.atenderMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[foto]' }),
    )
  })

  it('si la descarga falla, el mensaje llega igual como [foto]', async () => {
    // Falla ABIERTO: el cliente recibe respuesta aunque la media no baje.
    const m = montar({
      esperaComprobanteSinLocal: vi.fn().mockResolvedValue(true),
      adjuntarComprobante: vi.fn(),
      http: { get: vi.fn().mockRejectedValue(new Error('media caída')) },
    })
    await m.process(eventoConFoto())
    expect(m.atenderMarketplace).toHaveBeenCalledWith(
      expect.objectContaining({ text: '[foto]' }),
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// Y EL MARKETPLACE SABE QUÉ CONTESTAR
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Sin esto, el marcador que pone el webhook caería al menú y se trataría
// como una BÚSQUEDA: quien acaba de pagar recibiría «no encontramos locales
// para [el cliente envió su comprobante de pago del pedido #45]».
const entry = await import('../dist/services/marketplace-entry.js')
const inbox = await import('../dist/services/payment-proof-inbox.js')

describe('el marketplace contesta al comprobante', () => {
  const montar = () => {
    const enviados = []
    const advanceConversation = vi.fn()
    return {
      enviados,
      advanceConversation,
      deps: {
        database: {
          resolveMarketplaceCustomer: async () => ({ id: 'cust-1' }),
          getConversation: async () => ({
            version: 1, current_state: 'navegando', selected_business_id: null,
          }),
          getMarketplaceCategories: async () => ([{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizza', label: 'Pizzas' }]),
          getBusinessById: async () => null,
          advanceConversation,
        },
        send: async (reply) => { enviados.push(reply) },
      },
    }
  }

  it('al comprobante adjuntado le contesta que está en revisión', async () => {
    const m = montar()
    await entry.handleMarketplaceMessage(
      { from: '+593988000001', text: `[el cliente envió ${inbox.MARCA_COMPROBANTE} del pedido #45]` },
      m.deps,
    )
    expect(m.enviados[0]).toBe(inbox.RESPUESTA_COMPROBANTE)
    // ⚠️ Y NO toca la conversación: el carrito y el local siguen donde estaban.
    expect(m.advanceConversation).not.toHaveBeenCalled()
  })

  it('a la foto que no era un comprobante le pide la correcta', async () => {
    const m = montar()
    await entry.handleMarketplaceMessage(
      { from: '+593988000001', text: `[el cliente envió ${inbox.MARCA_NO_ES_COMPROBANTE}]` },
      m.deps,
    )
    expect(m.enviados[0]).toBe(inbox.RESPUESTA_NO_ES_COMPROBANTE)
  })

  it('con pagos en varios locales, pregunta cuál', async () => {
    const m = montar()
    await entry.handleMarketplaceMessage(
      {
        from: '+593988000001',
        text: `[el cliente envió ${inbox.MARCA_COMPROBANTE_AMBIGUO}: El Puerto / Monster Pizza]`,
      },
      m.deps,
    )
    expect(m.enviados[0]).toContain('El Puerto')
    expect(m.enviados[0]).toContain('Monster Pizza')
    expect(m.enviados[0]).toContain('más de un local')
  })

  it('un mensaje normal NO se confunde con un comprobante', async () => {
    const m = montar()
    await entry.handleMarketplaceMessage(
      { from: '+593988000001', text: 'quiero pizza' },
      m.deps,
    )
    expect(m.enviados[0]).not.toBe(inbox.RESPUESTA_COMPROBANTE)
    expect(m.enviados[0]).not.toBe(inbox.RESPUESTA_NO_ES_COMPROBANTE)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA DE ENTRADA DEL MARKETPLACE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Este módulo decide si un mensaje al número de Umbani se reconoce o se
// descarta, y estaba al 37 % de cobertura — siendo la puerta por la que entra
// TODO el marketplace. Lo que se fija aquí es que media configuración nunca se
// dé por buena, y que un fallo leyendo los ajustes no tumbe el webhook.
// ⚠️ `createRequire` y no `await import`: el import ESM devuelve un
// ENVOLTORIO del módulo CommonJS, así que espiarlo no cambia lo que ve
// `platform-channel`, que hizo su propio `require`. La prueba se colgaba
// cinco segundos llamando a Supabase de verdad.
const requerir = createRequire(import.meta.url)
const ajustes = requerir('../dist/services/settings')
const { getPlatformChannel } = requerir('../dist/services/platform-channel')

describe('las credenciales del número de la plataforma', () => {
  const con = (valores) => {
    vi.spyOn(ajustes, 'get').mockImplementation(async clave => (
      typeof valores === 'function' ? valores(clave) : (valores[clave] ?? null)
    ))
  }
  const completo = {
    platform_ycloud_api_key: ' key-de-la-plataforma ',
    platform_ycloud_number: '+593 99 171 6574',
    platform_webhook_secret: ' whsec_abc ',
    platform_webhook_endpoint_id: ' endpoint-1 ',
  }
  beforeEach(() => { vi.restoreAllMocks() })

  it('con todo puesto, devuelve el canal con el número normalizado', async () => {
    con(completo)
    expect(await getPlatformChannel()).toEqual({
      apiKey: 'key-de-la-plataforma',
      number: '593991716574',
      webhookSecret: 'whsec_abc',
      endpointId: 'endpoint-1',
    })
  })

  // ⚠️ Media configuración que parece válida es PEOR que ninguna: fallaría más
  // tarde y más lejos, con el número ya recibiendo mensajes de clientes.
  it('sin API key no hay canal, aunque haya número', async () => {
    con({ ...completo, platform_ycloud_api_key: null })
    expect(await getPlatformChannel()).toBeNull()
    con({ ...completo, platform_ycloud_api_key: '   ' })
    expect(await getPlatformChannel()).toBeNull()
  })

  it('sin un número válido no hay canal, aunque haya API key', async () => {
    con({ ...completo, platform_ycloud_number: null })
    expect(await getPlatformChannel()).toBeNull()
    con({ ...completo, platform_ycloud_number: 'no-es-un-numero' })
    expect(await getPlatformChannel()).toBeNull()
  })

  // El webhook puede funcionar sin secreto (en desarrollo). Lo que NO puede es
  // que faltar un opcional impida reconocer el número.
  it('el secreto y el endpoint son opcionales', async () => {
    con({
      platform_ycloud_api_key: 'k', platform_ycloud_number: '593991716574',
      platform_webhook_secret: null, platform_webhook_endpoint_id: '',
    })
    const canal = await getPlatformChannel()
    expect(canal.webhookSecret).toBeNull()
    expect(canal.endpointId).toBeNull()
  })

  // ⚠️ ESTE ES EL IMPORTANTE. Dejar que lance tumbaría el webhook ENTERO,
  // incluidos los negocios con número propio que no tienen nada que ver con
  // el marketplace. Es el fallo que dejó el canal mudo cinco días en julio.
  it('si `server_settings` falla, dice «no configurado» en vez de lanzar', async () => {
    con(() => { throw new Error('base caída') })
    await expect(getPlatformChannel()).resolves.toBeNull()
  })
})
