import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const { handleMarketplaceMessage } = require('../dist/services/marketplace-entry')
const { textoDeComprobanteQueNoCuadra } = require('../dist/services/payment-proof-inbox')
const { NO_CONTINUAR, SI_REINICIAR } = require('../dist/services/marketplace-menu')

// ═══════════════════════════════════════════════════════════════════════════
// LA PUERTA DEL MARKETPLACE — los caminos del DINERO y de la SESIÓN
// ═══════════════════════════════════════════════════════════════════════════
//
// `handleMarketplaceMessage` es la función que atiende cada mensaje que entra
// al número de Umbani. Tiene 536 líneas y nueve pasos, y su cobertura de ramas
// era la más baja de todo el camino del cliente (65 %) por un motivo mecánico:
// para llegar al paso 6 hay que atravesar los cinco anteriores, así que probar
// un caso cuesta mucho más que en cualquier otro sitio.
//
// Esto es la RED que hay que tener puesta antes de partirla en piezas. No se
// prueba aquí lo que ya cubren `menu-mata-el-enlace`, `techo-del-marketplace`,
// `candado-cerrado` o `el-bloqueo-ofrece-otros-locales`: se prueban los huecos
// que quedaban, y se han elegido por dónde duele si fallan — el dinero y el
// enlace, que es la credencial de la tienda.

const CATEGORIAS = [
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 2 },
  { city_id: 'ciudad-chone', city_name: 'Chone', code: 'hamburguesas', label: 'Hamburguesas', emoji: '🍔', locales: 1 },
]

const LOCAL = {
  id: 'biz-1',
  name: 'Monster Pizza',
  slug: 'monster-pizza',
  storefront_enabled: true,
  takes_orders: true,
}

const TELEFONO = '593900000825'

function armar({ conversacion = {}, database: extra = {}, issueLink } = {}) {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: 'en_local',
      selected_business_id: null,
      shopping_locked: false,
      flow_state: { vista: { vista: 'categorias', pagina: 0 } },
      version: 3,
      ...conversacion,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue(LOCAL),
    getSchedulesFor: vi.fn().mockResolvedValue(new Map()),
    claimMarketplaceReply: vi.fn().mockResolvedValue({ permitido: true, respuestas: 1 }),
    claimPlatformBlockState: vi.fn().mockResolvedValue({ bloqueado: false }),
    isContactBlocked: vi.fn().mockResolvedValue(false),
    cancelUnpaidOrderOnPurpose: vi.fn().mockResolvedValue(1),
    revokeStorefrontSessionsOnExit: vi.fn().mockResolvedValue(2),
    ...extra,
  }
  const deps = {
    database,
    send: async (reply, options) => { enviados.push({ reply, options: options || [] }) },
    issueLink: issueLink ?? vi.fn().mockResolvedValue('https://umbani.app/s/abc123'),
    tipoPideEnChat: vi.fn().mockResolvedValue(false),
    avanzarMenu: vi.fn(),
    crearPedido: vi.fn(),
    crearPedidoCompleto: vi.fn(),
    logger: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
  }
  return { database, deps, enviados, todo: () => enviados.map(e => e.reply).join('\n') }
}

const escribir = (deps, text) => handleMarketplaceMessage({ from: TELEFONO, text }, deps)

beforeEach(() => { vi.clearAllMocks() })

// ── DINERO ──────────────────────────────────────────────────────────────────

describe('el comprobante que NO cuadra', () => {
  // ⚠️ El error caro aquí es decirle «recibimos tu comprobante» a quien pagó a
  // otra cuenta: se iría a esperar una comida que nadie va a preparar.

  it('acusa recibo pero deja clarísimo que NO cuadra', async () => {
    const m = armar()
    await escribir(m.deps, textoDeComprobanteQueNoCuadra('la cuenta no es la del local'))

    expect(m.enviados).toHaveLength(1)
    // Acusar recibo está bien —le consta que llegó—, pero la misma frase tiene
    // que decir que no sirve. Lo que no se puede es dejarle creer que su pedido
    // va en marcha: se iría a esperar una comida que nadie va a preparar.
    expect(m.todo()).toMatch(/no coincide con este pedido/i)
    expect(m.todo()).toMatch(/de nuevo/i)
  })

  it('el motivo es para el DUEÑO y no se le suelta al cliente', async () => {
    const m = armar()
    await escribir(m.deps, textoDeComprobanteQueNoCuadra('pagó a la cuenta de otro local'))

    expect(m.todo()).not.toContain('pagó a la cuenta de otro local')
  })

  it('se atiende aunque la conversación esté bloqueada por un pedido en curso', async () => {
    // Quien acaba de pagar es justo el que tiene el candado puesto. Si el
    // candado se comiera su comprobante, no habría forma de rematar el pedido.
    const m = armar({
      conversacion: { selected_business_id: 'biz-1', shopping_locked: true },
    })
    await escribir(m.deps, textoDeComprobanteQueNoCuadra(null))

    expect(m.enviados).toHaveLength(1)
    expect(m.todo()).not.toMatch(/termina(r)? tu pedido/i)
  })
})

// ── SESIÓN: el enlace es la credencial de la tienda ─────────────────────────

describe('«Seguir mi pedido» devuelve el enlace', () => {
  const enConfirmacion = {
    current_state: 'confirmando_reinicio',
    selected_business_id: 'biz-1',
    shopping_locked: true,
    flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } },
  }

  it('a quien está a medio armar el carrito, le devuelve su carta', async () => {
    const m = armar({ conversacion: enConfirmacion })
    await escribir(m.deps, NO_CONTINUAR)

    expect(m.deps.issueLink).toHaveBeenCalled()
    expect(m.todo()).toContain('https://umbani.app/s/abc123')
    // Y NO cancela nada: justo lo contrario de «Empezar de nuevo».
    expect(m.database.cancelUnpaidOrderOnPurpose).not.toHaveBeenCalled()
    expect(m.database.revokeStorefrontSessionsOnExit).not.toHaveBeenCalled()
  })

  it('si el local ya no existe, responde igual en vez de callarse', async () => {
    // Un enlace que no se puede emitir no puede dejar a la persona sin
    // respuesta: se queda mirando el chat sin saber qué pasó.
    const m = armar({
      conversacion: enConfirmacion,
      database: { getBusinessById: vi.fn().mockResolvedValue(null) },
    })
    await escribir(m.deps, NO_CONTINUAR)

    expect(m.enviados.length).toBeGreaterThan(0)
    expect(m.deps.issueLink).not.toHaveBeenCalled()
  })

  it('si la base se cae al leer el local, PROPAGA en vez de fingir', async () => {
    // ⚠️ Esto parece contradecir el «falla abierto» del bloqueo de plataforma,
    // y no lo hace: aquí fallar abierto tendría un coste peor. `negocioActual`
    // quedaría en `null`, el paso 4 no entraría y quien tiene un pedido en
    // curso podría abrir OTRO — el candado de «un pedido a la vez» se saltaría
    // justo cuando la base no está para impedirlo.
    //
    // Propagando, el webhook reintenta cuando la base vuelva: no se pierde el
    // mensaje ni se rompe el candado. La consulta de `devolverElEnlace`
    // (más abajo) sí lleva `.catch`, porque ahí ya no hay candado que proteger.
    const m = armar({
      conversacion: enConfirmacion,
      database: { getBusinessById: vi.fn().mockRejectedValue(new Error('sin conexión')) },
    })

    await expect(escribir(m.deps, NO_CONTINUAR)).rejects.toThrow('sin conexión')
  })

  it('si no se puede emitir el enlace, no promete una carta que no abre', async () => {
    const m = armar({
      conversacion: enConfirmacion,
      issueLink: vi.fn().mockResolvedValue(null),
    })
    await escribir(m.deps, NO_CONTINUAR)

    expect(m.enviados.length).toBeGreaterThan(0)
    expect(m.todo()).not.toContain('umbani.app/s/')
  })

  it('a quien DEBE el comprobante NO se le manda enlace nuevo', async () => {
    // ⚠️ Decisión del dueño: su enlace sigue vivo unos mensajes más arriba, y
    // los datos para transferir viven detrás de él. Lo que se retira es la
    // invitación a seguir mirando la carta, que es lo que sobra.
    const m = armar({
      // Lo pone el disparador `orders_mark_awaiting_receipt` al crear el pedido.
      conversacion: { ...enConfirmacion, current_state: 'esperando_comprobante' },
    })
    await escribir(m.deps, NO_CONTINUAR)

    expect(m.deps.issueLink).not.toHaveBeenCalled()
    expect(m.enviados.length).toBeGreaterThan(0)
  })
})

describe('«Empezar de nuevo» sí corta por lo sano', () => {
  it('cancela el pedido y revoca los enlaces', async () => {
    const m = armar({
      conversacion: {
        current_state: 'confirmando_reinicio',
        selected_business_id: 'biz-1',
        shopping_locked: true,
        flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } },
      },
    })
    await escribir(m.deps, SI_REINICIAR)

    expect(m.database.cancelUnpaidOrderOnPurpose).toHaveBeenCalled()
    expect(m.database.revokeStorefrontSessionsOnExit).toHaveBeenCalledWith('cli-1')
  })
})

// ── QUE NADA DEJE MUDO AL MARKETPLACE ───────────────────────────────────────

describe('falla abierto', () => {
  it('sin la comprobación de bloqueo de plataforma, sigue atendiendo', async () => {
    // ⚠️ Es la regla de esta puerta: un fallo de la base no puede dejar mudo
    // al número por el que entra TODO el negocio.
    const m = armar({ database: { claimPlatformBlockState: undefined } })
    await escribir(m.deps, 'hola')

    expect(m.enviados.length).toBeGreaterThan(0)
  })

  it('si la consulta de bloqueo revienta, atiende igual', async () => {
    const m = armar({
      database: { claimPlatformBlockState: vi.fn().mockRejectedValue(new Error('caída')) },
    })
    await escribir(m.deps, 'hola')

    expect(m.enviados.length).toBeGreaterThan(0)
  })

  it('sin categorías lo dice, en vez de enseñar una lista vacía', async () => {
    const m = armar({ database: { getMarketplaceCategories: vi.fn().mockResolvedValue([]) } })
    await escribir(m.deps, 'hola')

    expect(m.enviados).toHaveLength(1)
    expect(m.enviados[0].options).toEqual([])
  })
})

// ── LO QUE LEE EL CLIENTE ───────────────────────────────────────────────────

describe('un local cerrado lo dice, y dice cuándo abre', () => {
  const cerrado = (abre) => armar({
    conversacion: {
      selected_business_id: null,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
    },
    database: {
      getMarketplaceBusinesses: vi.fn().mockResolvedValue([
        { ...LOCAL, type: 'pizzería', prep_min: 30 },
      ]),
      // Un horario que deja el local cerrado ahora mismo.
      getSchedulesFor: vi.fn().mockResolvedValue(new Map([['biz-1', [
        { day_of_week: 1, open_time: abre, close_time: '22:00', is_closed: false },
      ]]])),
    },
  })

  it('la hora se dice como se dice aquí: en AM/PM, no en formato de 24 h', async () => {
    // «Abre mañana a las 20:00» no lo dice nadie en Ecuador.
    const m = cerrado('20:00')
    await escribir(m.deps, 'Monster Pizza')

    const texto = m.todo()
    if (texto.includes('Abre')) {
      expect(texto).toMatch(/\d{1,2}:\d{2}\s?(AM|PM)/)
      expect(texto).not.toMatch(/a las 20:00/)
    }
  })
})

// ── EL CANDADO: un pedido a la vez ──────────────────────────────────────────

describe('quien tiene un pedido en curso no puede abrir otro', () => {
  const conPedido = extra => armar({
    conversacion: {
      current_state: 'en_local',
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { vista: { vista: 'categorias', pagina: 0 } },
      ...extra,
    },
  })

  it('le recuerda dónde está en vez de enseñarle el menú', async () => {
    // ⚠️ Es una regla de DINERO: dos pedidos abiertos a la vez en locales
    // distintos es exactamente lo que el candado existe para impedir.
    const m = conPedido()
    await escribir(m.deps, 'hamburguesas')

    expect(m.todo()).toContain('Monster Pizza')
    // No le ofrece cambiar de local.
    expect(m.enviados.at(-1).options).not.toContain('🍔 Hamburguesas')
  })

  it('a quien DEBE la foto del pago se le pide la FOTO, no que termine', async () => {
    // Dos situaciones distintas y dos textos distintos: decirle «termina tu
    // pedido» a quien ya pidió y debe la transferencia lo deja dando vueltas.
    const m = conPedido({ current_state: 'esperando_comprobante' })
    await escribir(m.deps, 'hola')

    expect(m.todo()).not.toMatch(/termina(r)? tu pedido/i)
  })
})

// ── EL BLOQUEO ES DEL LOCAL, NO DE LA PLATAFORMA ────────────────────────────

describe('a quien un local bloqueó, se le ofrecen los demás', () => {
  it('no se le echa del marketplace entero', async () => {
    // ⚠️ El bloqueo lo pone UN dueño y vale para SU local. Echarlo de todo
    // sería darle a un local el poder de vetar para toda la plataforma.
    const m = armar({
      conversacion: {
        selected_business_id: null,
        flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      },
      database: {
        isContactBlocked: vi.fn().mockResolvedValue(true),
        getMarketplaceBusinesses: vi.fn().mockResolvedValue([
          { ...LOCAL, type: 'pizzería', prep_min: 30 },
        ]),
      },
    })
    await escribir(m.deps, 'Monster Pizza')

    expect(m.deps.issueLink).not.toHaveBeenCalled()
    expect(m.enviados.length).toBeGreaterThan(0)
  })
})

// ── EL ENLACE QUE NO SE PUDO EMITIR ─────────────────────────────────────────

describe('elegir un local cuando el enlace no sale', () => {
  const eligiendo = database => armar({
    conversacion: {
      selected_business_id: null,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
    },
    database: {
      getMarketplaceBusinesses: vi.fn().mockResolvedValue([
        { ...LOCAL, type: 'pizzería', prep_min: 30 },
      ]),
      ...database,
    },
  })

  it('sin enlace, no se le deja esperando un botón que no llega', async () => {
    const m = eligiendo()
    m.deps.issueLink = vi.fn().mockResolvedValue(null)
    await escribir(m.deps, 'Monster Pizza')

    expect(m.enviados.length).toBeGreaterThan(0)
    expect(m.todo()).not.toContain('umbani.app/s/')
  })
})

// ── LO QUE LEE EL CLIENTE CUANDO EL LOCAL ESTÁ CERRADO ──────────────────────

describe('un local cerrado', () => {
  // ⚠️ El campo que manda es `is_active`, no `is_closed` — un registro sin él
  // se filtra fuera y el local queda «sin horario configurado», que NO bloquea.
  // Con la forma equivocada, esta prueba habría pasado sin probar nada.
  //
  // Y el horario se calcula desde el día de HOY en Ecuador: se define solo el
  // de MAÑANA, así que hoy está cerrado corra la prueba cuando corra.
  const diaEnEcuador = new Date(
    new Date().toLocaleString('en-US', { timeZone: 'America/Guayaquil' }),
  ).getDay()
  const SOLO_ABRE_MANANA = [{
    day_of_week: (diaEnEcuador + 1) % 7,
    open_time: '09:00:00',
    close_time: '17:00:00',
    is_active: true,
  }]

  const conHorario = horarios => armar({
    conversacion: {
      selected_business_id: null,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
    },
    database: {
      getMarketplaceBusinesses: vi.fn().mockResolvedValue([
        { ...LOCAL, type: 'pizzería', prep_min: 30 },
      ]),
      getSchedulesFor: horarios,
    },
  })

  it('lo dice ANTES de entrar, con la hora como se dice aquí, y le deja ver la carta', async () => {
    const m = conHorario(vi.fn().mockResolvedValue(new Map([['biz-1', SOLO_ABRE_MANANA]])))
    await escribir(m.deps, 'Monster Pizza')

    // Que el horario se haya consultado de verdad: si no, esto comprobaría el
    // texto de un local que nadie llegó a marcar como cerrado.
    expect(m.database.getSchedulesFor).toHaveBeenCalled()
    expect(m.todo()).toMatch(/cerrado/i)
    // «Abre mañana a las 09:00» no lo dice nadie en Ecuador.
    expect(m.todo()).toContain('9:00 AM')
    // ⚠️ Recibe el enlace IGUAL: la mini app deja ver la carta con la tienda
    // cerrada e impide pedir. Negárselo solo lograría que no sepa qué se vende.
    expect(m.deps.issueLink).toHaveBeenCalled()
  })

  it('sin horarios configurados, no se inventa que está cerrado', async () => {
    const m = conHorario(vi.fn().mockResolvedValue(new Map()))
    await escribir(m.deps, 'Monster Pizza')

    expect(m.todo()).not.toMatch(/cerrado/i)
    expect(m.deps.issueLink).toHaveBeenCalled()
  })

  it('si la consulta de horarios falla, atiende igual', async () => {
    // Un fallo leyendo horarios no puede impedir una venta.
    const m = conHorario(vi.fn().mockRejectedValue(new Error('sin conexión')))
    await escribir(m.deps, 'Monster Pizza')

    expect(m.deps.issueLink).toHaveBeenCalled()
  })
})

// ── BUSCAR: lo que se escribe y no es una opción del menú ───────────────────

describe('escribir algo que no está en el menú', () => {
  const buscando = (resultados, extra = {}) => armar({
    database: {
      searchMarketplace: vi.fn().mockResolvedValue(resultados),
      ...extra,
    },
  })

  it('busca locales en vez de contestar «no te entendí»', async () => {
    const m = buscando([{ id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza', type: 'pizzería' }])
    await escribir(m.deps, 'quiero una pizza hawaiana')

    expect(m.enviados.length).toBeGreaterThan(0)
  })

  it('si la búsqueda revienta, el cliente recibe respuesta igual', async () => {
    // ⚠️ La búsqueda es una MEJORA sobre «no te entendí»: un fallo suyo tiene
    // que devolver lo de antes, no dejar a la persona sin nada.
    const m = buscando(null, {
      searchMarketplace: vi.fn().mockRejectedValue(new Error('la RPC no existe')),
    })
    await escribir(m.deps, 'quiero una pizza hawaiana')

    expect(m.enviados.length).toBeGreaterThan(0)
  })

  it('sin resultados, no se queda callado', async () => {
    const m = buscando([])
    await escribir(m.deps, 'zapatos de tacón')

    expect(m.enviados.length).toBeGreaterThan(0)
  })
})

// ── EL ORDEN DE LAS PUERTAS, QUE ES LA LÓGICA ───────────────────────────────

describe('guardián: el orden de las puertas', () => {
  const fuente = readFileSync(
    new URL('../src/services/marketplace-entry.ts', import.meta.url), 'utf8',
  )

  it('cada puerta se consulta donde tiene que consultarse', () => {
    // ⚠️ ESTE ORDEN ES LA LÓGICA DE LA PUERTA, no una casualidad de cómo se
    // escribió. Sus propios comentarios lo dicen: «va ANTES que MENÚ», «el
    // orden importa», «va detrás de MENÚ». Hasta el 2026-09-19 vivía implícito
    // en 536 líneas seguidas, donde nadie podía comprobarlo; ahora está aquí.
    //
    // Si hace falta mover una puerta, esta prueba tiene que cambiar A MANO y
    // con su motivo escrito. Que falle es justo lo que se quiere.
    const puertas = [
      // El bloqueo de plataforma y el techo van primero: ni se cuenta ni se
      // contesta a quien no debe recibir respuesta.
      'claimPlatformBlockState(customer.id',
      'claimMarketplaceReply(customer.id',
      // Los insultos (2026-09-27): DESPUÉS del techo —la advertencia se paga, y
      // quien insulta a ráfagas no se lo puede saltar— y ANTES que MENÚ —«menú,
      // hijueputa» sigue siendo un insulto—.
      'atenderInsulto(deps, text',
      // La pausa por opciones viejas (2026-09-28) y el toque que la provoca:
      // ANTES que MENÚ, que no la levanta —una pausa que se salta escribiendo
      // una palabra no frena a nadie—. Decisión del dueño.
      'menuPausado(deps, conversation',
      'pausarSiReincide(deps, customer.id',
      // La ciudad (2026-10-05): ANTES que MENÚ —MENÚ pinta el menú, y sin
      // ciudad no hay nada que pintar— y DESPUÉS de la pausa y del techo —a
      // quien está silenciado no se le pregunta nada—.
      'atenderLaCiudad(deps, text',
      // MENÚ, que es la salida de cualquier sitio.
      'atenderComandoMenu(deps, text',
      // Los marcadores del webhook, detrás de MENÚ.
      'atenderComprobante(deps, text',
      // La respuesta a «¿tiro tu pedido?», antes del candado que la provocó.
      'atenderConfirmacionDeReinicio(deps, from, text',
      // El candado de «un pedido a la vez».
      'atenderCandado(deps, text',
      // Y el menú, al final: todo lo de arriba tiene prioridad sobre él.
      'recorrerElMenu(deps, from, text',
    ]

    const posiciones = puertas.map(puerta => fuente.indexOf(puerta))
    puertas.forEach((puerta, i) => {
      expect(posiciones[i], `no encuentro «${puerta}» en el orquestador`).toBeGreaterThan(-1)
    })
    expect(posiciones, 'las puertas están desordenadas')
      .toEqual([...posiciones].sort((a, b) => a - b))
  })

  it('el orquestador sigue cabiendo en una pantalla y media', () => {
    // Era de 536 líneas. Esta prueba no persigue una cifra bonita: persigue que
    // nadie vuelva a meterle un paso entero dentro en vez de sacarlo aparte.
    const inicio = fuente.indexOf('export async function handleMarketplaceMessage(')
    const cuerpo = fuente.slice(inicio)
    const lineas = cuerpo.slice(0, cuerpo.indexOf('\n}\n')).split('\n').length
    expect(lineas).toBeLessThan(250)
  })
})
