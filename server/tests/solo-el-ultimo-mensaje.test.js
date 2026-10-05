import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

// ═══════════════════════════════════════════════════════════════════════════
// SOLO VALE EL ÚLTIMO MENSAJE, Y NO SE REPITE LA MISMA RESPUESTA (2026-09-26)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo encontró el dueño en producción, probando el número de Umbani:
//   · estando en «Panaderías» tocó «Minimarkets» en una lista VIEJA y el bot
//     buscó «3»; después «Jugos y batidos», también vieja, le entregó la carta
//     de Monster Pizza;
//   · tres fotos seguidas, tres respuestas iguales.
// La referencia fue el chat de Luka: solo vale el último mensaje.

const require = createRequire(import.meta.url)
const {
  enviosDelTurno, huellaDeRespuesta, leerToque, nuevaMarca, VENTANA_ANTI_ECO_MS,
} = require('../dist/services/marketplace-envio')
const { OPCION_ANTERIOR, verResultados } = require('../dist/services/marketplace-menu')
const { idsDeFila } = require('../dist/services/platform-channel')

describe('qué quiso decir el cliente al tocar', () => {
  it('con la marca de la última lista, el número de su fila', () => {
    expect(leerToque('ab12c.3', 'ab12c')).toEqual({ texto: '3', vieja: false })
  })

  it('con la marca de OTRA lista, un aviso: no se ejecuta nada', () => {
    expect(leerToque('ab12c.3', 'ff00e')).toEqual({ texto: OPCION_ANTERIOR, vieja: true })
  })

  it('sin marca guardada se acepta, como hasta hoy: falla abierto', () => {
    expect(leerToque('ab12c.3', null)).toEqual({ texto: '3', vieja: false })
  })

  it('lo escrito, y las opciones sin marca, pasan tal cual', () => {
    expect(leerToque('quiero pizza', 'ab12c')).toEqual({ texto: 'quiero pizza', vieja: false })
    expect(leerToque('2', 'ab12c')).toEqual({ texto: '2', vieja: false })
  })

  it('la marca cabe en la regla de la columna', () => {
    for (let i = 0; i < 50; i += 1) expect(nuevaMarca()).toMatch(/^[a-z0-9]{4,10}$/)
  })
})

describe('las filas llevan la marca de su lista', () => {
  it('«k3f9a.1», no «1»', () => {
    expect(idsDeFila(['🥖 Panaderías', '⬅️ Volver'], 'k3f9a').map(f => f.id))
      .toEqual(['k3f9a.1', 'k3f9a.2'])
  })

  it('sin marca, el número de siempre', () => {
    expect(idsDeFila(['A', 'B']).map(f => f.id)).toEqual(['1', '2'])
  })

  it('una lista de números sigue con `opt_N`: el título ya es el número', () => {
    expect(idsDeFila(['0', '1', '2'], 'k3f9a').map(f => f.id)).toEqual(['opt_0', 'opt_1', 'opt_2'])
  })
})

// ── Los envíos del turno ───────────────────────────────────────────────────

const armarEnvios = ({ ultima = {}, ahora = 1_000_000, marcaGuardada = true } = {}) => {
  const enviados = []
  const deps = {
    send: vi.fn(async (reply, options, marca) => { enviados.push({ reply, options, marca }) }),
    sendLink: vi.fn(async () => true),
    database: {
      marcarUltimaLista: vi.fn(async () => marcaGuardada),
      anotarUltimaRespuesta: vi.fn(async () => undefined),
    },
  }
  const reloj = { t: ahora }
  const envios = enviosDelTurno(deps, 'cli-1', ultima, () => reloj.t)
  return { deps, enviados, envios, reloj }
}

describe('cada lista sale con su marca, guardada ANTES de mandarla', () => {
  it('la marca que se guarda es la que viaja', async () => {
    const { deps, enviados, envios } = armarEnvios()
    await envios.send('Elige', ['A', 'B'])
    const marca = deps.database.marcarUltimaLista.mock.calls[0][1]
    expect(enviados[0].marca).toBe(marca)
    expect(deps.database.marcarUltimaLista.mock.invocationCallOrder[0])
      .toBeLessThan(deps.send.mock.invocationCallOrder[0])
  })

  it('si no se pudo guardar, sale SIN marca: el toque se aceptará como hoy', async () => {
    const { enviados, envios } = armarEnvios({ marcaGuardada: false })
    await envios.send('Elige', ['A', 'B'])
    expect(enviados[0].marca).toBeNull()
  })

  it('un mensaje sin opciones no toca la marca', async () => {
    const { deps, envios } = armarEnvios()
    await envios.send('Listo', [])
    expect(deps.database.marcarUltimaLista).not.toHaveBeenCalled()
  })
})

describe('la misma respuesta no sale dos veces seguidas', () => {
  it('tres fotos seguidas en el mismo turno: una respuesta', async () => {
    const { enviados, envios } = armarEnvios()
    for (let i = 0; i < 3; i += 1) await envios.send('📷 Recibí tu foto…', ['A'])
    expect(enviados).toHaveLength(1)
  })

  it('entre turnos: lo que anotó el anterior hace menos de 60 s la calla', async () => {
    const huella = huellaDeRespuesta('📷 Recibí tu foto…', ['A'])
    const ahora = 5_000_000
    const reciente = armarEnvios({ ahora, ultima: { huella, at: new Date(ahora - 30_000).toISOString() } })
    await reciente.envios.send('📷 Recibí tu foto…', ['A'])
    expect(reciente.enviados).toHaveLength(0)

    const vieja = armarEnvios({ ahora, ultima: { huella, at: new Date(ahora - VENTANA_ANTI_ECO_MS - 1).toISOString() } })
    await vieja.envios.send('📷 Recibí tu foto…', ['A'])
    expect(vieja.enviados).toHaveLength(1)
  })

  it('otra respuesta sí sale', async () => {
    const { enviados, envios } = armarEnvios()
    await envios.send('Elige una categoría', ['A'])
    await envios.send('Elige un local', ['B'])
    expect(enviados).toHaveLength(2)
  })

  it('la huella no depende de la marca: dos listas iguales son la misma respuesta', () => {
    expect(huellaDeRespuesta('Elige', ['A'])).toBe(huellaDeRespuesta('Elige', ['A']))
    expect(huellaDeRespuesta('Elige', ['A'])).not.toBe(huellaDeRespuesta('Elige', ['B']))
  })

  it('se anota DESPUÉS de mandar: un envío que falla no calla el reintento', async () => {
    const { deps, envios } = armarEnvios()
    deps.send.mockRejectedValueOnce(new Error('YCloud caído'))
    await expect(envios.send('Elige', ['A'])).rejects.toThrow('YCloud caído')
    expect(deps.database.anotarUltimaRespuesta).not.toHaveBeenCalled()
  })

  it('el enlace repetido tampoco, y NO cae al texto', async () => {
    const { deps, envios } = armarEnvios()
    const mensaje = { body: 'Monster Pizza', url: 'https://umbani.app/s/x', label: 'Ver la carta' }
    await expect(envios.sendLink(mensaje)).resolves.toBe(true)
    await expect(envios.sendLink(mensaje)).resolves.toBe(true)
    expect(deps.sendLink).toHaveBeenCalledTimes(1)
  })
})

// ── Con la función REAL del marketplace ────────────────────────────────────

const CATEGORIAS = [
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 },
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'panaderias', label: 'Panaderías', emoji: '🥖', locales: 1 },
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'minimarkets', label: 'Minimarkets', emoji: '🛒', locales: 1 },
]
const LOCALES = {
  pizzerias: [{ id: 'biz-pizza', slug: 'monster-pizza', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 }],
  panaderias: [{ id: 'biz-trigal', slug: 'el-trigal', name: 'Panadería El Trigal', type: 'panadería', prep_min: 20 }],
  minimarkets: [{ id: 'biz-beto', slug: 'don-beto', name: 'Mini Súper Don Beto', type: 'tienda', prep_min: 20 }],
}

/** Una base de mentira que RECUERDA la conversación entre turnos, como la real. */
const armarMarketplace = (conversacion) => {
  const memoria = { valor: conversacion }
  const enviados = []
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
    marcarUltimaLista: vi.fn(async (_id, marca) => {
      if (!memoria.valor) return false
      memoria.valor = { ...memoria.valor, menu_mark: marca }
      return true
    }),
    anotarUltimaRespuesta: vi.fn(async (_id, huella) => {
      if (memoria.valor) memoria.valor = { ...memoria.valor, last_reply_hash: huella, last_reply_at: new Date().toISOString() }
    }),
    // La advertencia y la pausa por opciones viejas (2026-09-28).
    anotarAvisoDeOpcionVieja: vi.fn(async () => {
      if (memoria.valor) memoria.valor = { ...memoria.valor, stale_tap_warned_at: new Date().toISOString() }
    }),
    pausarElMenu: vi.fn(async (_id, hasta) => {
      if (memoria.valor) memoria.valor = { ...memoria.valor, menu_paused_until: hasta, stale_tap_warned_at: null }
      return Boolean(memoria.valor)
    }),
    getMarketplaceCategories: vi.fn(async () => CATEGORIAS),
    getMarketplaceBusinesses: vi.fn(async code => LOCALES[code] || []),
    getBusinessById: vi.fn(async id => ({ id, name: id, slug: id, storefront_enabled: true, takes_orders: true })),
    searchMarketplaceBusinesses: vi.fn(async () => [LOCALES.pizzerias[0]]),
    marketplaceKnownTerm: vi.fn(async () => null),
    cancelUnpaidOrderOnPurpose: vi.fn(async () => 0),
    revokeStorefrontSessionsOnExit: vi.fn(async () => 0),
  }
  const deps = {
    database,
    send: vi.fn(async (reply, options, marca) => { enviados.push({ reply, options, marca }) }),
    issueLink: vi.fn(async () => 'https://umbani.app/s/enlace'),
    sendLink: vi.fn(async () => true),
  }
  return { database, deps, enviados, memoria }
}

const atender = async (deps, texto) => {
  const { handleMarketplaceMessage } = await import('../dist/services/marketplace-entry.js')
  await handleMarketplaceMessage({ from: '593900000926', text: texto }, deps)
}

describe('el caso del dueño, con la función real', () => {
  const enPanaderias = {
    current_state: 'navegando', selected_business_id: null, shopping_locked: false,
    flow_state: { vista: { vista: 'negocios', categoria: 'panaderias', pagina: 0 } },
    version: 5, menu_mark: 'aaaaa',
  }

  it('un toque en una lista VIEJA no busca «3»: avisa y repinta lo de ahora', async () => {
    const m = armarMarketplace(enPanaderias)
    await atender(m.deps, 'bbbbb.3')

    expect(m.database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
    expect(m.deps.issueLink).not.toHaveBeenCalled()
    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0].reply).toContain('mensaje anterior')
    expect(m.enviados[0].reply).not.toMatch(/encontré/i)
    // Las opciones de AHORA, con su marca nueva.
    expect(m.enviados[0].options).toContain('Panadería El Trigal')
    expect(m.enviados[0].marca).toBe(m.memoria.valor.menu_mark)
  })

  it('el toque en la ÚLTIMA lista funciona como siempre', async () => {
    const m = armarMarketplace(enPanaderias)
    await atender(m.deps, 'aaaaa.1')
    expect(m.deps.issueLink).toHaveBeenCalledTimes(1)
    expect(m.deps.issueLink.mock.calls[0][0].business.id).toBe('biz-trigal')
  })

  it('una opción vieja nunca entrega la carta de OTRO local', async () => {
    // «Jugos y batidos» cayó en Monster Pizza: su número se aplicó a los
    // resultados de búsqueda que había en pantalla.
    const m = armarMarketplace({
      ...enPanaderias,
      flow_state: { vista: { vista: 'busqueda', consulta: 'pizza', pagina: 0 } },
    })
    await atender(m.deps, 'bbbbb.1')
    expect(m.deps.issueLink).not.toHaveBeenCalled()
  })

  it('una opción vieja tampoco dispara «Empezar de nuevo» en la confirmación', async () => {
    // Antes un «1» de cualquier lista vieja se leía como la primera opción de
    // la confirmación —«✅ Empezar de nuevo»— y cancelaba el pedido.
    const m = armarMarketplace({
      ...enPanaderias,
      current_state: 'confirmando_reinicio',
      selected_business_id: 'biz-trigal',
      shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } },
    })
    await atender(m.deps, 'bbbbb.1')
    expect(m.database.cancelUnpaidOrderOnPurpose).not.toHaveBeenCalled()
    expect(m.database.revokeStorefrontSessionsOnExit).not.toHaveBeenCalled()
  })

  it('un número escrito que no es opción no se busca como si fuera comida', async () => {
    const m = armarMarketplace(enPanaderias)
    await atender(m.deps, '3')
    expect(m.database.searchMarketplaceBusinesses).not.toHaveBeenCalled()
    expect(m.enviados[0].reply).not.toMatch(/encontré/i)
  })

  it('tres fotos seguidas: una sola respuesta', async () => {
    const m = armarMarketplace({ ...enPanaderias, flow_state: { vista: { vista: 'categorias', pagina: 0 } } })
    for (let i = 0; i < 3; i += 1) await atender(m.deps, '[foto]')
    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0].reply).toContain('foto')
  })

  it('veinte toques viejos seguidos: una advertencia, un aviso de pausa y silencio', async () => {
    // Hasta el 2026-09-28 era «un solo aviso» y los otros diecinueve callaban
    // con el «escribiendo…» colgado. Ahora el segundo toque pausa el menú 5
    // minutos y lo dice. Ver `opciones-viejas-pausa.test.js`.
    const m = armarMarketplace(enPanaderias)
    for (let i = 0; i < 20; i += 1) await atender(m.deps, 'bbbbb.3')
    expect(m.enviados).toHaveLength(2)
    expect(m.enviados[0].reply).toContain('mensaje anterior')
    expect(m.enviados[1].reply).toContain('5 minutos')
  })
})

describe('los resultados de una búsqueda nombran TODOS los locales', () => {
  it('no solo los cerrados: el dueño vio tres en la lista y dos en el texto', () => {
    const r = verResultados('helado', [
      { id: 'a', slug: 'a', name: 'Monster Pizza', type: 'pizzería', prep_min: 30 },
      { id: 'b', slug: 'b', name: 'Helados Nevado', type: 'heladería', prep_min: 10, abierto: false, abre: { open: '10:00', inDays: 0, dayName: 'Sábado' } },
    ])
    expect(r.reply).toContain('Monster Pizza')
    expect(r.reply).toContain('Helados Nevado · abre hoy 10:00 AM')
  })
})

describe('el canario sigue sin escribir nada', () => {
  it('sustituye también la marca y la huella', () => {
    const fuente = readFileSync(new URL('../src/services/canario.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('marcarUltimaLista: async () => false')
    expect(fuente).toContain('anotarUltimaRespuesta: async () => undefined')
  })
})

describe('el simulador del superadmin contesta siempre', () => {
  it('sin anti-eco: «hola» dos veces no puede devolver una pantalla vacía', () => {
    // Allí no se paga ningún mensaje, que es para lo que existe el anti-eco.
    const fuente = readFileSync(new URL('../src/routes/admin-simulator.routes.ts', import.meta.url), 'utf8')
    expect(fuente).toContain('anotarUltimaRespuesta: async () => undefined')
  })
})
