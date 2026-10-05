import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createStorefrontLinkService } = require('../dist/services/storefront-link')
const {
  NO_CONTINUAR, SI_REINICIAR, resolverReinicio,
} = require('../dist/services/marketplace-menu')

// ═══════════════════════════════════════════════════════════════════════════
// EL ENLACE ES DE UN SOLO USO: UNO VIVO A LA VEZ
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-08-31): «quiero que sea estricto con bloqueos de
// enlace, porque si estás pidiendo en ese momento termina el proceso, o
// escribes MENÚ y listo».
//
// El agujero no estaba en el chat —ahí `shopping_locked` ya impedía ir hacia
// atrás desde el 2026-08-30— sino en los ENLACES: `issueLink` emitía uno nuevo
// en cada elección y no revocaba ninguno. `revoked_at` existía, lo miraba
// `checkSession`, lo traducía `rejectionMessage`… y nadie lo escribía jamás.
// Quien había pedido en cinco locales tenía cinco enlaces vivos en su chat.
//
// Aquí se prueba el lado de TypeScript. Las dos excepciones —el local vigente
// y el que debe dinero— las decide la RPC, y se ejecutan contra PostgreSQL de
// verdad en `tests/sql/verificar-esquema.sql`.

const negocio = {
  id: 'biz-1',
  name: 'Monster Pizza',
  slug: 'monster-pizza',
  storefront_enabled: true,
  takes_orders: true,
}

const armarBase = (extra = {}) => ({
  resolveCustomer: vi.fn().mockResolvedValue({ id: 'cli-1' }),
  createStorefrontSession: vi.fn().mockResolvedValue({ id: 'sesion-nueva' }),
  revokeOtherStorefrontSessions: vi.fn().mockResolvedValue(2),
  ...extra,
})

const servicio = database => createStorefrontLinkService({
  database,
  baseUrl: () => 'https://umbani.app',
})

describe('emitir un enlace revoca los demás', () => {
  it('revoca a nombre de la PERSONA, conservando la sesión recién creada', async () => {
    const database = armarBase()
    const url = await servicio(database).issueLink({ business: negocio, phone: '593999111222' })

    expect(url).toContain('https://umbani.app/s/')
    expect(database.revokeOtherStorefrontSessions).toHaveBeenCalledWith('cli-1', 'sesion-nueva')
  })

  it('revoca DESPUÉS de crear la nueva, nunca antes', async () => {
    // Si se revocara primero, la persona quedaría un instante sin ningún
    // enlace vivo — y si la creación fallara, sin ninguno en absoluto.
    const orden = []
    const database = armarBase({
      createStorefrontSession: vi.fn(async () => {
        orden.push('crear')
        return { id: 'sesion-nueva' }
      }),
      revokeOtherStorefrontSessions: vi.fn(async () => {
        orden.push('revocar')
        return 1
      }),
    })
    await servicio(database).issueLink({ business: negocio, phone: '593999111222' })
    expect(orden).toEqual(['crear', 'revocar'])
  })

  it('un fallo revocando NO deja al cliente sin enlace', async () => {
    // El enlace es lo que le permite comprar; la limpieza de los viejos es una
    // mejora. Que la mejora tumbe la venta sería el peor cambio posible.
    const database = armarBase({
      revokeOtherStorefrontSessions: vi.fn().mockRejectedValue(new Error('sin conexión')),
    })
    const url = await servicio(database).issueLink({ business: negocio, phone: '593999111222' })
    expect(url).toContain('https://umbani.app/s/')
  })

  it('sin id de sesión no se revoca nada: no se sabe cuál conservar', async () => {
    const database = armarBase({
      createStorefrontSession: vi.fn().mockResolvedValue(null),
    })
    const url = await servicio(database).issueLink({ business: negocio, phone: '593999111222' })
    expect(url).toContain('https://umbani.app/s/')
    expect(database.revokeOtherStorefrontSessions).not.toHaveBeenCalled()
  })

  it('una base sin la función sigue emitiendo enlaces', async () => {
    const database = armarBase()
    delete database.revokeOtherStorefrontSessions
    const url = await servicio(database).issueLink({ business: negocio, phone: '593999111222' })
    expect(url).toContain('https://umbani.app/s/')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LA SALIDA: «MENÚ» Y «SEGUIR MI PEDIDO»
// ═══════════════════════════════════════════════════════════════════════════
//
// El enlace estricto solo deja de ser una trampa si hay una forma de recuperar
// la entrada. La del dueño es escribir MENÚ.

// ═══════════════════════════════════════════════════════════════════════════
// «SEGUIR MI PEDIDO» DEJA VIVO SOLO EL ENLACE NUEVO (2026-09-16)
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño: «si se estaba haciendo el pedido pero el cliente lo dejó y
// selecciona continuar con un pedido, que pase igual: todo lo de atrás no
// funcione». La revocación de siempre perdona las sesiones del MISMO local, así
// que tras «seguir» el enlace viejo de ese local seguía abriendo la tienda.

describe('la revocación estricta, solo cuando se pide', () => {
  it('con `soloEste` revoca con la estricta, y no con la de siempre', async () => {
    const database = armarBase({
      revokeStorefrontSessionsExcept: vi.fn().mockResolvedValue(3),
    })
    await servicio(database).issueLink({
      business: negocio, phone: '593999111222', soloEste: true,
    })
    expect(database.revokeStorefrontSessionsExcept).toHaveBeenCalledWith('cli-1', 'sesion-nueva')
    expect(database.revokeOtherStorefrontSessions).not.toHaveBeenCalled()
  })

  it('sin `soloEste` sigue la de siempre: elegir un local no cambia', async () => {
    // ⚠️ El pedido del dueño es sobre «seguir mi pedido», no sobre elegir local.
    // Ahí la de siempre conserva el carrito del local vigente, y no se toca.
    const database = armarBase({
      revokeStorefrontSessionsExcept: vi.fn().mockResolvedValue(3),
    })
    await servicio(database).issueLink({ business: negocio, phone: '593999111222' })
    expect(database.revokeOtherStorefrontSessions).toHaveBeenCalledWith('cli-1', 'sesion-nueva')
    expect(database.revokeStorefrontSessionsExcept).not.toHaveBeenCalled()
  })

  it('con `soloEste` pero sin la estricta, cae a la de siempre y no a nada', async () => {
    // Un enlace viejo del mismo local vivo es un fallo menor; los de OTROS
    // locales vivos reabrirían el agujero que se cerró el 2026-09-03.
    const database = armarBase()
    await servicio(database).issueLink({
      business: negocio, phone: '593999111222', soloEste: true,
    })
    expect(database.revokeOtherStorefrontSessions).toHaveBeenCalledWith('cli-1', 'sesion-nueva')
  })

  it('un fallo en la estricta NO deja al cliente sin su enlace nuevo', async () => {
    const database = armarBase({
      revokeStorefrontSessionsExcept: vi.fn().mockRejectedValue(new Error('sin conexión')),
    })
    const url = await servicio(database).issueLink({
      business: negocio, phone: '593999111222', soloEste: true,
    })
    expect(url).toContain('https://umbani.app/s/')
  })
})

describe('resolverReinicio distingue las TRES respuestas', () => {
  const estado = { negocio: { name: 'Monster Pizza', slug: 'monster-pizza' }, bloqueado: true }

  it('«empezar de nuevo» reinicia y no continúa', () => {
    const r = resolverReinicio(SI_REINICIAR, estado, [])
    expect(r.reinicia).toBe(true)
    expect(r.continua).toBe(false)
  })

  it('«seguir mi pedido» continúa y no reinicia', () => {
    const r = resolverReinicio(NO_CONTINUAR, estado, [])
    expect(r.reinicia).toBe(false)
    expect(r.continua).toBe(true)
  })

  it('cualquier otra cosa no es ninguna de las dos: se vuelve a preguntar', () => {
    // ⚠️ `continua` NO es lo contrario de `reinicia`. Tirar un carrito por un
    // «ok» ambiguo es lo único que no tiene vuelta atrás, y devolverle el
    // enlace a quien no dijo nada claro sería decidir por él.
    const r = resolverReinicio('ok', estado, [])
    expect(r.reinicia).toBe(false)
    expect(r.continua).toBe(false)
    expect(r.respuesta.options).toEqual([SI_REINICIAR, NO_CONTINUAR])
  })
})

const CATEGORIAS = [{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]

const armarEntrada = ({ enChat = false, url = 'https://umbani.app/s/tok3n' } = {}) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    // Está en «¿empezar de nuevo o seguir?» con su local elegido y bloqueada.
    getConversation: vi.fn().mockResolvedValue({
      current_state: 'confirmando_reinicio',
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } },
      version: 3,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue({
      ...negocio, type: enChat ? 'almuerzos' : 'pizzeria',
    }),
    getProducts: vi.fn().mockResolvedValue([]),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      issueLink: vi.fn().mockResolvedValue(url),
      send: async (reply, options) => { enviados.push({ reply, options }) },
      tipoPideEnChat: vi.fn().mockResolvedValue(enChat),
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

describe('«Seguir mi pedido» devuelve el enlace', () => {
  it('quien dice que sigue recibe su enlace, no solo un «👍»', async () => {
    // ⚠️ Este es el caso que hacía del enlace estricto una trampa: la persona
    // escribe MENÚ porque NO encuentra su enlace, y hasta ahora sus dos
    // salidas eran tirar el pedido o seguir sin poder entrar.
    const { deps, enviados } = armarEntrada()
    await handle({ from: '593999111222', text: NO_CONTINUAR }, deps)

    expect(deps.issueLink).toHaveBeenCalledTimes(1)
    // Con `force`: lo acaba de pedir con todas las letras, el cooldown estorba.
    expect(deps.issueLink.mock.calls[0][0].force).toBe(true)
    // Y con `soloEste` (2026-09-16): tras continuar, «todo lo de atrás no
    // funcione» — el enlace viejo de este mismo local tiene que caer.
    expect(deps.issueLink.mock.calls[0][0].soloEste).toBe(true)
    expect(enviados).toHaveLength(1)
    expect(enviados[0].reply).toContain('Monster Pizza')
    expect(enviados[0].reply).toContain('https://umbani.app/s/tok3n')
  })

  // ⚠️ Antes había aquí lo contrario: en un local que se pedía POR CHAT no se
  // daba enlace, porque el pedido se armaba en la conversación. Desde el
  // 2026-09-15 todo local pide por su mini app, así que TODOS reciben el suyo.
  it('también en un local de almuerzos, que antes pedía por chat', async () => {
    const { deps } = armarEntrada({ enChat: true })
    await handle({ from: '593999111222', text: NO_CONTINUAR }, deps)

    expect(deps.issueLink).toHaveBeenCalled()
  })

  it('sin enlace disponible responde igual: quedarse mudo sería peor', async () => {
    const { deps, enviados } = armarEntrada({ url: null })
    await handle({ from: '593999111222', text: NO_CONTINUAR }, deps)

    expect(enviados).toHaveLength(1)
    expect(enviados[0].reply).toContain('Monster Pizza')
    expect(enviados[0].reply).not.toContain('http')
  })

  it('«empezar de nuevo» NO recibe enlace: acaba de soltar ese local', async () => {
    const { deps, database, enviados } = armarEntrada()
    await handle({ from: '593999111222', text: SI_REINICIAR }, deps)

    expect(deps.issueLink).not.toHaveBeenCalled()
    expect(database.advanceConversation.mock.calls[0][1].clearBusiness).toBe(true)
    expect(enviados[0].options).toContain('🍕 Pizzerías')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// «UNA VEZ QUE ELIGES UN LOCAL YA NO PUEDES PEDIR PARA ATRÁS»
// ═══════════════════════════════════════════════════════════════════════════
//
// La otra mitad de la decisión del dueño. El chat ya lo impedía —`shopping_locked`
// gana antes de que el menú vea el mensaje— pero no había ninguna prueba que lo
// fijara para el botón «⬅️ Volver», que es justo por donde se temía la fuga.
//
// ⚠️ «Volver» NO es un comando de menú: normaliza a `volver`, y `COMANDOS_MENU`
// solo tiene `volver al menu`. Si alguien lo añadiera a esa lista, tocar el
// botón dentro de un local pasaría a soltar el local sin preguntar y el
// carrito se iría sin aviso. Esta prueba es lo que lo caza.

const enUnLocal = (vista) => ({
  current_state: 'en_local',
  selected_business_id: 'biz-1',
  shopping_locked: true,
  flow_state: { vista },
  version: 3,
})

describe('con un local elegido no se vuelve atrás', () => {
  const casos = [
    ['⬅️ Volver desde la lista de locales', { vista: 'negocios', categoria: 'pizzerias', pagina: 0 }],
    ['⬅️ Volver desde una búsqueda', { vista: 'busqueda', consulta: 'ceviche', pagina: 0 }],
  ]

  it.each(casos)('%s no cambia de local: recuerda el pedido abierto', async (_titulo, vista) => {
    const { deps, database, enviados } = armarEntrada()
    database.getConversation.mockResolvedValue(enUnLocal(vista))

    await handle({ from: '593999111222', text: '⬅️ Volver' }, deps)

    const ultimo = enviados.at(-1)
    // ⚠️ «Estás pidiendo en X» desde el 2026-09-05: con el estado `en_local`
    // el enlace ya salió pero NO hay pedido, y el texto anterior lo afirmaba.
    // Lo que esta prueba vigila sigue siendo lo mismo: que «Volver» no cambie
    // de local.
    expect(ultimo.reply).toMatch(/Estás pidiendo en|pedido en proceso/i)
    expect(ultimo.reply).toContain('Monster Pizza')
    // Y NO la lista de categorías, que es a donde lleva «Volver» sin candado.
    expect(ultimo.options).toEqual([SI_REINICIAR, NO_CONTINUAR])
    // El local sigue elegido: aquí solo se pregunta.
    expect(database.advanceConversation.mock.calls[0][1].clearBusiness).toBeUndefined()
  })
})
