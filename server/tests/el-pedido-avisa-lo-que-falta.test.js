import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const {
  NO_CONTINUAR, SI_REINICIAR, resolverReinicio,
} = require('../dist/services/marketplace-menu')

// ═══════════════════════════════════════════════════════════════════════════
// EL BOT DICE LO QUE DE VERDAD FALTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo vivió el dueño el 2026-09-04: pidió por la mini app, escribió «hola» en
// vez de subir el comprobante, y el bot le contestó «Termínalo, o empieza de
// nuevo». Pulsó «Seguir mi pedido» y recibió «Termina tu pedido cuando
// quieras» con el enlace de la carta.
//
// El pedido estaba TERMINADO. Lo que faltaba era la foto.
//
// La causa estaba en la base: el checkout del chat marcaba
// `esperando_comprobante` y el de la mini app no tocaba la conversación. Eso
// lo arregla un disparador (se ejecuta contra PostgreSQL real en
// `verificar-esquema.sql`); aquí se prueba lo que el cliente LEE.

describe('«Seguir mi pedido» dice lo que falta', () => {
  const local = { name: 'Monster Pizza', slug: 'monster-pizza' }

  it('a quien ya pidió le pide la FOTO, no que termine', async () => {
    const r = resolverReinicio(NO_CONTINUAR, {
      negocio: local, bloqueado: true, esperandoComprobante: true,
    }, [])
    expect(r.continua).toBe(true)
    expect(r.respuesta.reply).toMatch(/esperando tu comprobante/i)
    expect(r.respuesta.reply).toMatch(/foto de tu transferencia/i)
    expect(r.respuesta.reply).not.toMatch(/Termina tu pedido/i)
  })

  it('y le dice que puede irse escribiendo MENÚ', () => {
    // ⚠️ Se le nombra la salida a propósito: irse avisando CANCELA el pedido y
    // no le cuesta una falta. Callarlo empuja al abandono silencioso, que es
    // justo lo que se quiere evitar.
    const r = resolverReinicio(NO_CONTINUAR, {
      negocio: local, bloqueado: true, esperandoComprobante: true,
    }, [])
    expect(r.respuesta.reply).toMatch(/MENÚ/)
  })

  it('a quien está a medio armar el carrito se le sigue diciendo que termine', () => {
    // El mensaje viejo no estaba mal: estaba en el sitio equivocado.
    const r = resolverReinicio(NO_CONTINUAR, {
      negocio: local, bloqueado: true, esperandoComprobante: false,
    }, [])
    expect(r.respuesta.reply).toMatch(/Termina tu pedido/i)
    expect(r.respuesta.reply).not.toMatch(/comprobante/i)
  })

  it('sin local no se inventa nada', () => {
    const r = resolverReinicio(NO_CONTINUAR, { negocio: null, bloqueado: false }, [])
    expect(r.respuesta.reply).toBe('Perfecto 👍')
  })
})

const CATEGORIAS = [{ code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]

const armar = (estado) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: estado,
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { vista: { vista: 'confirmando_reinicio', pagina: 0 } },
      version: 5,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza', type: 'pizzeria',
      storefront_enabled: true, takes_orders: true,
    }),
    getProducts: vi.fn().mockResolvedValue([]),
    cancelUnpaidOrderOnPurpose: vi.fn().mockResolvedValue(1),
  }
  return {
    database,
    enviados,
    deps: {
      database,
      issueLink: vi.fn().mockResolvedValue('https://umbani.app/s/tok3n'),
      send: async (reply, options) => { enviados.push({ reply, options }) },
      sendLink: vi.fn().mockResolvedValue(true),
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

describe('irse AVISANDO cancela el pedido', () => {
  it('«Empezar de nuevo» cancela el pedido sin pagar', async () => {
    // Avisar y desaparecer no pueden costar lo mismo: quien desaparece deja el
    // pedido caducar y suma una falta; quien avisa, no.
    const { deps, database } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: SI_REINICIAR }, deps)
    expect(database.cancelUnpaidOrderOnPurpose).toHaveBeenCalledWith('biz-1', 'cli-1')
  })

  it('«Seguir mi pedido» NO lo cancela', async () => {
    const { deps, database } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: NO_CONTINUAR }, deps)
    expect(database.cancelUnpaidOrderOnPurpose).not.toHaveBeenCalled()
  })

  it('si cancelar falla, el reinicio sigue adelante', async () => {
    // El pedido caduca solo a los 15 minutos. Un fallo aquí no puede dejar al
    // cliente atrapado en un local que ya dijo que abandonaba.
    const { deps, database, enviados } = armar('esperando_comprobante')
    database.cancelUnpaidOrderOnPurpose.mockRejectedValue(new Error('sin conexión'))
    await handle({ from: '593999111222', text: SI_REINICIAR }, deps)
    expect(enviados.at(-1).options).toContain('🍕 Pizzerías')
  })

  it('el estado del comprobante NO se pisa al responder', async () => {
    // `guardar` escribía 'navegando' encima y el «Seguir mi pedido» siguiente
    // volvía a decir «termínalo».
    const { deps, database } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: 'hola' }, deps)
    // Cae en el recordatorio del paso 5, que conserva el estado.
    const patch = database.advanceConversation.mock.calls[0][1]
    expect(patch.state).toBeUndefined()
  })
})

describe('a quien debe el comprobante NO se le manda la carta', () => {
  // El dueño lo dijo probándolo el 2026-09-04: «no debería darme la opción de
  // ver la carta porque tengo que completar el pedido para hacer otro».
  //
  // El botón dice «Ver la carta» y esa es la invitación equivocada: esa
  // persona no puede pedir nada más hasta cerrar lo que ya pidió. Su enlace
  // sigue vivo unos mensajes más arriba, así que no se queda sin los datos
  // para transferir — lo único que se retira es la invitación a seguir mirando.

  it('«Seguir mi pedido» responde SIN enlace cuando debe la foto', async () => {
    const { deps, enviados } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: NO_CONTINUAR }, deps)

    expect(deps.sendLink).not.toHaveBeenCalled()
    expect(deps.issueLink).not.toHaveBeenCalled()
    const ultimo = enviados.at(-1)
    expect(ultimo.reply).toMatch(/esperando tu comprobante/i)
    expect(ultimo.reply).not.toMatch(/http/)
  })

  it('pero a quien está a medio armar el carrito SÍ se le manda', async () => {
    // Ahí volver a la carta es justo lo que necesita: el pedido no existe
    // todavía.
    const { deps } = armar('en_local')
    await handle({ from: '593999111222', text: NO_CONTINUAR }, deps)
    expect(deps.sendLink).toHaveBeenCalled()
  })
})

describe('el texto no promete lo que el sistema no hace', () => {
  // El dueño escribió MENÚ esperando salir —porque el mensaje se lo decía— y
  // recibió una pregunta. MENÚ con un pedido en marcha SIEMPRE pregunta antes
  // de tirarlo, y desde el 2026-09-04 «Empezar de nuevo» lo cancela de verdad.
  //
  // Se arregla el texto y no la conducta: hay un caso que no se puede
  // distinguir —quien ya transfirió y no mandó la foto se ve igual que quien
  // no pagó nada— y un MENÚ directo le cancelaría el pedido con el dinero
  // enviado.
  //
  // ⚠️ Y SE VOLVIÓ A ARREGLAR EL TEXTO el 2026-09-27, en sentido contrario:
  // desde el 2026-09-05 MENÚ va DIRECTO y cancela (decisión del dueño), así
  // que «te pregunto antes de soltarlo» volvió a ser una promesa falsa.
  it('no promete una pregunta que MENÚ ya no hace', () => {
    const r = resolverReinicio(NO_CONTINUAR, {
      negocio: { name: 'Monster Pizza', slug: 'monster-pizza' },
      bloqueado: true,
      esperandoComprobante: true,
    }, [])
    expect(r.respuesta.reply).toMatch(/MENÚ/)
    expect(r.respuesta.reply).not.toMatch(/pregunto antes/i)
  })
})

describe('MENÚ mata todo proceso', () => {
  // Decisión del dueño (2026-09-05), tras probarlo: «se supone que MENÚ mata
  // todo proceso, es la palabra clave y más fuerte». Y tenía razón dos veces:
  // el mensaje del enlace dice «para volver al inicio, escribe MENÚ», y la
  // pregunta que salía era además FALSA — el candado se pone al ELEGIR el
  // local, así que decía «tienes un pedido en proceso» a quien acababa de
  // recibir la carta y no tenía ninguno.

  it('con el local elegido va DIRECTO a las categorías', async () => {
    const { deps, enviados } = armar('en_local')
    await handle({ from: '593999111222', text: 'menu' }, deps)

    const ultimo = enviados.at(-1)
    expect(ultimo.options).toContain('🍕 Pizzerías')
    expect(ultimo.reply).not.toMatch(/pedido en proceso/i)
    expect(ultimo.reply).not.toMatch(/¿Qué prefieres\?/i)
  })

  it('y suelta el local: MENÚ es salir, no preguntar si se quiere salir', async () => {
    const { deps, database } = armar('en_local')
    await handle({ from: '593999111222', text: 'menu' }, deps)
    const patches = database.advanceConversation.mock.calls.map(c => c[1])
    expect(patches.some(p => p.clearBusiness)).toBe(true)
  })

  it('cancela el pedido sin pagar: avisar no puede costar una falta', async () => {
    // Si solo soltara el local, ese pedido caducaría a los 15 minutos y le
    // sumaría una falta de «pedido sin pagar» — la misma que suma quien nunca
    // volvió a contestar. Escribir MENÚ es avisar.
    const { deps, database } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: 'menu' }, deps)
    expect(database.cancelUnpaidOrderOnPurpose).toHaveBeenCalledWith('biz-1', 'cli-1')
  })

  it('pero CUALQUIER OTRA COSA sí recuerda lo que hay abierto', async () => {
    // La pregunta no desapareció: sale ante otro texto o una foto, que es
    // cuando de verdad hace falta avisar de que hay algo a medias.
    const { deps, enviados, database } = armar('en_local')
    // ⚠️ Con la vista normal, no la de confirmación: el montaje de este
    // archivo deja `confirmando_reinicio` para probar los botones, y con esa
    // vista cualquier texto cae en el paso 2 en vez de en el recordatorio.
    database.getConversation.mockResolvedValue({
      current_state: 'en_local',
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 } },
      version: 5,
    })
    await handle({ from: '593999111222', text: 'quiero pizza' }, deps)
    expect(enviados.at(-1).reply).toMatch(/Estás pidiendo en/i)
    expect(enviados.at(-1).options.join(' ')).toMatch(/Empezar de nuevo/)
  })
})
