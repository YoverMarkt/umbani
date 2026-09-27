import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// EL ENLACE DEL MARKETPLACE SALE COMO BOTÓN, Y EL VISTO AZUL SE MARCA
// ═══════════════════════════════════════════════════════════════════════════
//
// Dos cosas que el dueño pidió el 2026-08-29, y las dos estaban CONSTRUIDAS y
// desconectadas:
//
//   · `sendLinkButton` + `storefrontInviteButton` existían desde el
//     2026-08-12 para el canal propio. El marketplace —donde están hoy TODOS
//     los clientes— seguía mandando la URL pelada, que ocupa tres líneas, se
//     parte en pantallas estrechas y se lee como publicidad.
//   · `sendTyping`, que marca leído Y pone «escribiendo…», solo lo llamaba
//     `bot-entry`. Quien escribía a Umbani veía un solo tic hasta la
//     respuesta, que en un chat de venta se lee como «no me están leyendo».

const CATEGORIAS = [{ code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]
const LOCAL = {
  id: 'biz-1', slug: 'monster-pizza', name: 'Monster Pizza',
  type: 'pizzeria', prep_min: 30,
}

const armar = ({ botonSale = true } = {}) => {
  const enviados = []
  const botones = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue(null),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([LOCAL]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza',
      type: 'pizzeria', storefront_enabled: true, takes_orders: true,
    }),
    getProducts: vi.fn().mockResolvedValue([]),
  }
  return {
    database,
    enviados,
    botones,
    deps: {
      database,
      issueLink: vi.fn().mockResolvedValue('https://umbani.app/s/tok3n'),
      send: async (reply, options) => { enviados.push({ reply, options }) },
      sendLink: async (mensaje) => { botones.push(mensaje); return botonSale },
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

/** Lleva la conversación hasta elegir el local. */
const elegirLocal = async (ctx) => {
  await handle({ from: '593999111222', text: 'hola' }, ctx.deps)
  ctx.database.getConversation.mockResolvedValue({
    current_state: 'navegando',
    selected_business_id: null,
    shopping_locked: false,
    flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
    version: 1,
  })
  await handle({ from: '593999111222', text: 'Monster Pizza' }, ctx.deps)
}

describe('el enlace sale como botón «Ver la carta»', () => {
  it('se manda como botón y NO como URL suelta', async () => {
    const ctx = armar()
    await elegirLocal(ctx)

    expect(ctx.botones).toHaveLength(1)
    const boton = ctx.botones[0]
    expect(boton.url).toBe('https://umbani.app/s/tok3n')
    expect(boton.label).toBe('Ver la carta')
    expect(boton.body).toContain('Monster Pizza')
    // Y no se manda además el texto con la URL dentro: sería el mismo enlace
    // dos veces y un mensaje pagado de más.
    expect(ctx.enviados.some(m => String(m.reply).includes('https://'))).toBe(false)
  })

  it('la etiqueta cabe en los 20 BYTES que admite WhatsApp', () => {
    // ⚠️ BYTES, no caracteres: un emoji gasta cuatro de golpe. Por eso el
    // adorno se queda en el cuerpo, que admite 1024.
    expect(Buffer.byteLength('Ver la carta', 'utf8')).toBeLessThanOrEqual(20)
  })

  it('la salida por MENÚ sigue estando a la vista, en el pie', async () => {
    const ctx = armar()
    await elegirLocal(ctx)
    expect(ctx.botones[0].footer).toMatch(/MEN/i)
  })

  it('si el botón NO sale, se manda el texto de siempre con la URL', async () => {
    // Un botón que no sale no puede costar el enlace: sin enlace no hay pedido.
    const ctx = armar({ botonSale: false })
    await elegirLocal(ctx)

    expect(ctx.botones).toHaveLength(1)
    const ultimo = ctx.enviados.at(-1)
    expect(ultimo.reply).toContain('https://umbani.app/s/tok3n')
    expect(ultimo.reply).toContain('Monster Pizza')
  })

  it('sin la dependencia del botón, el marketplace sigue mandando el enlace', async () => {
    // `sendLink` es opcional a propósito: una instalación que no lo tenga
    // conectado no puede quedarse sin poder entregar locales.
    const ctx = armar()
    delete ctx.deps.sendLink
    await elegirLocal(ctx)
    expect(ctx.enviados.at(-1).reply).toContain('https://umbani.app/s/tok3n')
  })
})

describe('el visto azul del número de Umbani', () => {
  it('el marketplace marca leído ANTES de contestar', async () => {
    // Guardián sobre el compilado: la conexión vive en la raíz de composición
    // (`inbound-webhook`), que no se puede ejercitar sin media docena de
    // dobles. Lo que importa es que la llamada EXISTA y vaya antes — un visto
    // que llega después de la respuesta no sirve de nada.
    const fs = await import('node:fs')
    const fuente = fs.readFileSync('dist/services/inbound-webhook.js', 'utf8')
    const bloque = fuente.slice(fuente.indexOf('atenderMarketplace: async'))
    const marcar = bloque.indexOf('marcarLeidoPorLaPlataforma')
    const atender = bloque.indexOf('handleMarketplaceMessage')
    expect(marcar, 'el marketplace no marca leído').toBeGreaterThan(-1)
    expect(marcar, 'marca leído DESPUÉS de contestar').toBeLessThan(atender)
  })

  it('y CADA envío espera al visto, aunque pensar y marcar corran a la vez', async () => {
    // 2026-09-25: el visto dejó de esperarse ANTES de leer la base —la ida a
    // YCloud se sumaba entera a cada respuesta— y pasó a lanzarse a la vez.
    // Que la llamada esté escrita antes ya no basta: lo que garantiza que el
    // visto aterrice primero es que cada envío vaya encadenado a él.
    const fs = await import('node:fs')
    const fuente = fs.readFileSync('dist/services/inbound-webhook.js', 'utf8')
    const bloque = fuente.slice(fuente.indexOf('atenderMarketplace: async'))
    expect(bloque).toMatch(/const trasElVisto = \(enviar\) => visto\.then\(enviar\)/)
    // Y con la marca de su lista hasta el final (2026-09-26): sin ella, los
    // toques en listas viejas vuelven a aplicarse a la pantalla de ahora.
    expect(bloque, 'el texto sale sin esperar al visto, o sin su marca')
      .toMatch(/send: \(reply, options, marca\) => trasElVisto\(\(\) => platform\.enviarPorLaPlataforma\(from, reply, options, marca\)/)
    expect(bloque, 'el enlace sale sin esperar al visto')
      .toMatch(/sendLink: mensaje => trasElVisto\(\(\) => platform\.enviarEnlacePorLaPlataforma\(/)
    // Y el evento no se da por terminado con el visto todavía en vuelo.
    expect(bloque).toMatch(/finally \{[^}]*await visto;/)
  })

  it('marcar leído nunca puede impedir la respuesta', async () => {
    const platform = await import('../dist/services/platform-channel.js')
    // Sin id de mensaje no hay nada que marcar, y no se rompe.
    await expect(platform.marcarLeidoPorLaPlataforma(null)).resolves.toBeUndefined()
    await expect(platform.marcarLeidoPorLaPlataforma(undefined)).resolves.toBeUndefined()
  })

  it('el enlace como botón existe de verdad en el canal de la plataforma', async () => {
    // Camino real: que la función esté EXPORTADA y sea llamable, no solo
    // escrita. Es el fallo que este PR corrige — `sendLinkButton` llevaba
    // desde el 2026-08-12 sin que el marketplace lo llamara.
    const platform = await import('../dist/services/platform-channel.js')
    expect(typeof platform.enviarEnlacePorLaPlataforma).toBe('function')
    expect(typeof platform.marcarLeidoPorLaPlataforma).toBe('function')
  })
})
