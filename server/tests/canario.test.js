import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { crearCanario } = require('../dist/services/canario')
const serverDir = fileURLToPath(new URL('..', import.meta.url))
const leer = ruta => readFileSync(`${serverDir}/${ruta}`, 'utf8')

// ═══════════════════════════════════════════════════════════════════════════
// EL CANARIO DEL CAMINO DEL CLIENTE
// ═══════════════════════════════════════════════════════════════════════════
//
// Nace del 2026-09-13: tres fallos rojos encontrados probando a mano, ninguno
// cazado por el CI. El peor dejó a los dos locales SIN PODER VENDER durante
// cuatro días, con 2.727 pruebas en verde.
//
// ⚠️ Estas pruebas vigilan al vigilante, y lo que más importa de ellas es lo
// que NO es obvio: que no escriba nada y que alguien lo llame.

const NEGOCIO = { id: 'b1', name: 'La Abuelita', type: 'almuerzos', active: true, storefront_enabled: true }

function armar({ respuestas, escrituras = [], productos = [{ id: 'p1', name: 'Almuerzo del día', price: 3.5, active: true }] }) {
  const database = {
    // ⚠️ El canario recorre el marketplace COMO EL CLIENTE: las categorías que
    // ve y, dentro de cada una, los locales que la base dice que tiene. No
    // parte de `getAllBusinesses` a propósito — un local que no aparezca en
    // ninguna categoría es invisible para quien compra, y eso es un fallo.
    getMarketplaceCategories: async () => ([{ city_id: 'ciudad-chone', city_name: 'Chone', code: 'almuerzos', label: 'Almuerzos' }]),
    getMarketplaceBusinesses: async () => ([NEGOCIO]),
    // Desde el 2026-09-15 todo local pide por su mini app, así que lo que se
    // vigila es el CATÁLOGO que lee la tienda.
    getStorefrontProducts: async () => productos,
    getBusinessPricingRule: async () => null,
    // Cualquier escritura que se cuele queda anotada y hace fallar la prueba.
    resolveMarketplaceCustomer: async () => { escrituras.push('crear cliente'); return { id: 'x' } },
    advanceConversation: async () => { escrituras.push('escribir conversación'); return {} },
    claimMarketplaceReply: async () => { escrituras.push('gastar del techo'); return {} },
    // ⚠️ Se colaba hasta el 2026-09-27: el canario no lo sustituía, y en cada
    // vuelta intentaba guardar pasos del menú con el cliente 'canario'. Fallaba
    // (no es un uuid) y solo ensuciaba el log — pero si llegara a funcionar,
    // inflaría los reportes de «Uso de Umbani» con visitas que no existen.
    logMarketplaceEvent: async () => { escrituras.push('registrar paso del menú') },
    // Y el bloqueo de plataforma y los insultos (2026-09-27): los dos ESCRIBEN.
    claimPlatformBlockState: async () => { escrituras.push('reclamar el aviso de desbloqueo'); return { bloqueado: false } },
    registerInsult: async () => { escrituras.push('registrar un insulto'); return { accion: 'advertido' } },
  }
  const errores = []
  const canario = crearCanario({
    database,
    handleMarketplaceMessage: async (entrada, deps) => {
      // Un doble del camino: devuelve lo que se le diga para cada mensaje, y
      // de paso EJERCITA las dependencias que el canario sustituye.
      await deps.database.resolveMarketplaceCustomer(entrada.from)
      await deps.database.advanceConversation('x', { flowState: {} }, 1)
      await deps.database.claimMarketplaceReply('x')
      // Como hace la entrada de verdad: sin la función, no registra.
      if (deps.database.logMarketplaceEvent) {
        await deps.database.logMarketplaceEvent({ customerId: 'x', tipo: 'menu' })
      }
      await deps.database.claimPlatformBlockState?.('x')
      await deps.database.registerInsult?.('x')
      const texto = respuestas[entrada.text]
      if (texto === undefined) return
      await deps.send(texto.reply, texto.options || [])
    },
    registrarError: input => { errores.push(input) },
  })
  return { canario, errores, escrituras }
}

const CAMINO_BUENO = {
  hola: { reply: '👋 ¡Hola! Bienvenido a *Umbani*.' },
  Almuerzos: { reply: '🍽️ Almuerzos\n\nElige un local 👇\nLa Abuelita' },
  'La Abuelita': { reply: '¡Hola! 👋 Gracias por escribir' },
}

describe('el canario del camino del cliente', () => {
  it('con todo bien, no anota nada', async () => {
    const { canario, errores } = armar({ respuestas: CAMINO_BUENO })
    await canario.vigilar()
    expect(errores, JSON.stringify(errores)).toEqual([])
  })

  it('caza el fallo del #343: la carta sin una sola cifra', async () => {
    // El síntoma real, ahora en la mini app: productos sin precio utilizable.
    const { canario, errores } = armar({
      respuestas: CAMINO_BUENO,
      productos: [{ id: 'p1', name: 'Almuerzo del día', price: null, active: true }],
    })
    await canario.vigilar()
    expect(errores).toHaveLength(1)
    expect(errores[0].code).toBe('canario_precio')
    expect(errores[0].businessId).toBe('b1')
  })

  it('caza el precio en cero, que en la tienda no se puede pedir', async () => {
    const { canario, errores } = armar({
      respuestas: CAMINO_BUENO,
      productos: [{ id: 'p1', name: 'Agua', price: 0, active: true }],
    })
    await canario.vigilar()
    expect(errores.map(e => e.code)).toContain('canario_precio')
  })

  it('caza la tienda VACÍA: un local que no puede vender nada', async () => {
    const { canario, errores } = armar({ respuestas: CAMINO_BUENO, productos: [] })
    await canario.vigilar()
    expect(errores.map(e => e.code)).toContain('canario_catalogo')
  })

  it('un local CERRADO no es un fallo', async () => {
    // Es la respuesta correcta fuera de horario. Anotarlo cada noche llenaría
    // el registro de ruido y acabaría con el dueño ignorándolo.
    const { canario, errores } = armar({
      respuestas: {
        ...CAMINO_BUENO,
        'La Abuelita': { reply: '🌙 *La Abuelita* está cerrado ahora mismo. Abre mañana a las 9:00 AM.' },
      },
    })
    await canario.vigilar()
    expect(errores).toEqual([])
  })

  it('caza el local INVISIBLE: existe pero no sale en su categoría', async () => {
    // Un local activo que no aparece en ninguna lista no existe para quien
    // compra. Es el fallo más silencioso de todos: nada falla, simplemente
    // nadie lo encuentra.
    const { canario, errores } = armar({
      respuestas: {
        ...CAMINO_BUENO,
        Almuerzos: { reply: '🍽️ Almuerzos\n\nElige un local 👇\nOtro Local' },
      },
    })
    await canario.vigilar()
    expect(errores.map(e => e.code)).toContain('canario_categoria')
  })

  it('NO ESCRIBE NADA: ni cliente, ni conversación, ni techo, ni pasos del menú', async () => {
    // ⚠️ Lo más importante de este archivo. Un vigilante que ensucia la base
    // se acaba apagando, y entonces no vigila. Las tres funciones que
    // escribirían están sustituidas por memoria.
    const escrituras = []
    const { canario } = armar({ respuestas: CAMINO_BUENO, escrituras })
    await canario.vigilar()
    expect(escrituras, JSON.stringify(escrituras)).toEqual([])
  })

  it('si el canario revienta, lo anota en vez de callar', async () => {
    const errores = []
    const canario = crearCanario({
      database: {
        getMarketplaceCategories: async () => { throw new Error('la base no responde') },
      },
      avanzarMenu: () => ({}),
      handleMarketplaceMessage: async () => {},
      registrarError: input => { errores.push(input) },
    })
    await canario.vigilar()
    expect(errores[0].code).toBe('canario_caido')
  })
})

describe('el canario está CONECTADO', () => {
  // ⚠️ La prueba que más falta hacía. Este módulo existe para cazar código
  // construido y desconectado: que él mismo se quedara sin llamador sería la
  // broma más cara del proyecto. Se lee el FUENTE porque lo que falla aquí no
  // es la lógica, es que nadie la llame.
  it('el arranque lo programa', () => {
    const fuente = leer('src/index.ts')
    // ⚠️ Se comprueba el NOMBRE, no la forma exacta de la línea de import: el
    // primer intento exigía `import { vigilarElCaminoDelCliente }` y se rompió
    // en cuanto entró un segundo nombre en la misma línea. Un guardián que
    // falla por reordenar un import enseña a ignorarlo.
    expect(fuente).toMatch(/import \{[^}]*vigilarElCaminoDelCliente[^}]*\} from '\.\/services\/canario'/)
    expect(fuente).toMatch(/setTimeout\(\(\) => \{ void vigilarElCaminoDelCliente\(\) \}/)
    expect(fuente).toMatch(/setInterval\(\(\) => \{ void vigilarElCaminoDelCliente\(\) \}/)
  })

  it('su última vuelta se ve en /api/health', () => {
    // ⚠️ Un vigilante SILENCIOSO no se distingue de uno MUERTO. El canario
    // calla cuando todo va bien, así que «sin entradas en el registro»
    // significaba a la vez «se puede comprar» y «nunca corrió». Se descubrió
    // al desplegarlo: no había forma de comprobar que se había ejecutado.
    const fuente = leer('src/index.ts')
    expect(fuente).toMatch(/canario: ultimaVueltaDelCanario\(\)/)
  })

  it('usa el camino REAL del cliente, no un doble', () => {
    // Un canario que vigila a un doble no vigila nada.
    const fuente = leer('src/services/canario.ts')
    expect(fuente).toMatch(/handleMarketplaceMessage/)
    expect(fuente).toMatch(/getStorefrontProducts/)
  })
})
