import { beforeEach, describe, expect, it, vi } from 'vitest'

// ═══════════════════════════════════════════════════════════════════════════
// UMBANI CERRADO: MANDAR EL COMPROBANTE NO TE SUELTA
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño (2026-08-30), después de probarlo él mismo con el pedido
// #75: mandó su comprobante, luego una foto cualquiera, y el bot le contestó
// «🙏 No te entendí. ¿Qué deseas pedir?» con la lista de categorías — lo estaba
// invitando a pedir en otro local con su pago en revisión.
//
// La causa era el candado, que se soltaba al pasar a `pago_en_revision`. Eso
// dejaba al cliente SIN LOCAL, así que cualquier mensaje suyo caía en el menú.
//
// ⚠️ El disparador de la base es quien retiene ahora (se ejecuta contra
// PostgreSQL real en `tests/sql/verificar-esquema.sql`). Aquí se prueba lo que
// el cliente LEE, que es la otra mitad del arreglo: tres situaciones y tres
// mensajes, porque decirle «mándanos la foto» a quien acaba de mandarla suena
// exactamente igual de roto que no contestarle.

const CATEGORIAS = [{ code: 'pizzerias', label: 'Pizzerías', emoji: '🍕', locales: 1 }]

const armar = (estado) => {
  const enviados = []
  const database = {
    resolveMarketplaceCustomer: vi.fn().mockResolvedValue({ id: 'cli-1', name: 'Ana' }),
    getConversation: vi.fn().mockResolvedValue({
      current_state: estado,
      selected_business_id: 'biz-1',
      shopping_locked: true,
      flow_state: { vista: { vista: 'negocios', pagina: 0 } },
      version: 4,
    }),
    advanceConversation: vi.fn().mockResolvedValue({ conflicto: false }),
    getMarketplaceCategories: vi.fn().mockResolvedValue(CATEGORIAS),
    getMarketplaceBusinesses: vi.fn().mockResolvedValue([]),
    getBusinessById: vi.fn().mockResolvedValue({
      id: 'biz-1', name: 'Monster Pizza', slug: 'monster-pizza', type: 'pizzeria',
      storefront_enabled: true, takes_orders: true,
    }),
    getProducts: vi.fn().mockResolvedValue([]),
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

describe('con el comprobante EN REVISIÓN', () => {
  it('una foto cualquiera ya no lo manda a pedir a otro local', async () => {
    // El fallo exacto que vivió el dueño: `[foto]` caía en el menú.
    const { deps, enviados } = armar('pago_en_revision')
    await handle({ from: '593999111222', text: '[foto]' }, deps)

    const ultimo = enviados.at(-1)
    expect(ultimo.reply).toContain('Monster Pizza')
    expect(ultimo.reply).toMatch(/en revisión/i)
    expect(ultimo.reply).not.toMatch(/no te entend/i)
    // Y NO la lista de categorías, que era la invitación a irse.
    expect(ultimo.options).toEqual([])
  })

  it('cualquier texto recibe lo mismo', async () => {
    const { deps, enviados } = armar('pago_en_revision')
    await handle({ from: '593999111222', text: 'hola, ya pagué' }, deps)
    expect(enviados.at(-1).reply).toMatch(/en revisión/i)
  })

  it('NO le pide una foto que acaba de mandar', async () => {
    // `recordarComprobantePendiente` dice «mándanos aquí la foto». A quien ya
    // la mandó eso le suena a que el bot no se enteró.
    const { deps, enviados } = armar('pago_en_revision')
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(enviados.at(-1).reply).not.toMatch(/foto de tu transferencia/i)
    expect(enviados.at(-1).reply).not.toMatch(/Termínalo/i)
  })

  it('NO ofrece «Empezar de nuevo» a un toque: ya hay dinero puesto', async () => {
    // Los otros dos recordatorios sí lo ofrecen. Aquí abandonar significa
    // dejar tirado un pedido PAGADO, y eso no puede estar a un toque de
    // distancia. Quien quiera salir escribe MENÚ, que le pregunta antes.
    const { deps, enviados } = armar('pago_en_revision')
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(enviados.at(-1).options.join(' ')).not.toMatch(/Empezar de nuevo/)
  })

  it('el estado del pago NO se pisa al responder', async () => {
    // `guardar` escribe 'navegando' salvo en la confirmación de reinicio, y
    // eso borraría el `pago_en_revision` que puso el disparador. Con él
    // perdido, el mensaje siguiente volvería a decir «termínalo» a quien pagó.
    const { deps, database } = armar('pago_en_revision')
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(database.advanceConversation).toHaveBeenCalled()
    expect(database.advanceConversation.mock.calls[0][1].state).toBeUndefined()
  })
})

describe('los otros dos recordatorios siguen igual', () => {
  it('a quien DEBE la foto se le sigue pidiendo la foto', async () => {
    const { deps, enviados } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(enviados.at(-1).reply).toMatch(/comprobante/i)
  })

  it('a quien está a medio armar su pedido se le dice que lo termine', async () => {
    // ⚠️ «Estás pidiendo en X», no «tienes un pedido en proceso» (2026-09-05).
    // El estado `en_local` significa que el enlace ya salió y todavía NO hay
    // pedido: el candado se pone al ELEGIR el local. Decirle a esa persona que
    // tiene un pedido en proceso era sencillamente falso, y el dueño lo cazó
    // probándolo con 0 pedidos abiertos en la base.
    const { deps, enviados } = armar('en_local')
    await handle({ from: '593999111222', text: 'hola' }, deps)
    expect(enviados.at(-1).reply).toMatch(/Estás pidiendo en/i)
    expect(enviados.at(-1).reply).toMatch(/Termínalo/i)
    expect(enviados.at(-1).options.join(' ')).toMatch(/Empezar de nuevo/)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// «TE ENVÍO EL COMPROBANTE» YA NO LLEVA «EMPEZAR DE NUEVO» (2026-09-27)
// ═══════════════════════════════════════════════════════════════════════════
//
// El texto que precarga la mini app —«Hola, te envío el comprobante de mi
// pedido #N 🙂»— recibía la petición de la foto con «✅ Empezar de nuevo» como
// PRIMER botón, y un toque por error cancelaba el pedido. Lo aprobó el dueño.
// Quien transfirió y aún no mandó la foto se ve igual que quien no pagó nada,
// así que el botón sale de TODO recordatorio del comprobante, no solo de este
// texto: la gente lo edita, y el riesgo es el mismo.
describe('quien debe la foto no tiene «Empezar de nuevo» a un toque', () => {
  const TEXTO = 'Hola, te envío el comprobante de mi pedido #25 🙂'

  it('el texto de la mini app recibe la petición de la foto, sin botones', async () => {
    const { deps, enviados } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: TEXTO }, deps)
    expect(enviados.at(-1).reply).toMatch(/foto de tu transferencia/i)
    expect(enviados.at(-1).options).toEqual([])
  })

  it('y la salida sigue nombrada: MENÚ', async () => {
    const { deps, enviados } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: TEXTO }, deps)
    expect(enviados.at(-1).reply).toMatch(/MENÚ/)
  })

  it('no deja pendiente una pregunta que un «1» respondería', async () => {
    const { deps, database } = armar('esperando_comprobante')
    await handle({ from: '593999111222', text: TEXTO }, deps)
    const guardado = database.advanceConversation.mock.calls.at(-1)[1]
    expect(guardado.flowState.vista.vista).not.toBe('confirmando_reinicio')
    // Y el estado del pago no se pisa: sin él, el siguiente mensaje volvería a
    // decir «termínalo» a quien ya pidió.
    expect(guardado.state).toBeUndefined()
  })

  it('un «1» después no cancela nada', async () => {
    const { deps, database, enviados } = armar('esperando_comprobante')
    database.cancelUnpaidOrderOnPurpose = vi.fn().mockResolvedValue(1)
    await handle({ from: '593999111222', text: '1' }, deps)
    expect(database.cancelUnpaidOrderOnPurpose).not.toHaveBeenCalled()
    expect(enviados.at(-1).reply).toMatch(/foto de tu transferencia/i)
  })
})
