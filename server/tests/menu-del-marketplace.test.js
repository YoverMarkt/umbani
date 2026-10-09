import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fuenteDeLaEntradaDelMarketplace } from './fuente-de-rutas.mjs'
import { fileURLToPath } from 'node:url'
import {
  PAGINA, VER_MAS, VOLVER, elegir, esConversacion, esSaludo, paso, verCategorias, verNegocios,
} from '../dist/services/marketplace-menu.js'

// ═══════════════════════════════════════════════════════════════════════════
// EL MENÚ DEL MARKETPLACE
//
// Lo que ve quien escribe al número de Umbani. Se prueba entero sin base
// porque es una función pura, y eso es justo lo que permite cubrir los casos
// que en producción costarían un mensaje cada uno.
// ═══════════════════════════════════════════════════════════════════════════

const cat = (code, label, emoji = null, locales = 1) => ({ code, label, emoji, locales })
const neg = (slug, name, type = 'pizzería') => ({
  id: `id-${slug}`, slug, name, type, prep_min: 30,
})

const CATEGORIAS = [
  cat('pizzerias', 'Pizzerías', '🍕', 2),
  cat('hamburguesas', 'Hamburguesas', '🍔', 2),
  cat('mariscos', 'Mariscos y ceviches', '🐟', 1),
]

describe('la portada', () => {
  it('saluda una sola vez y ofrece las categorías', () => {
    const r = verCategorias(CATEGORIAS, 0, true)
    expect(r.reply).toContain('Umbani')
    expect(r.reply).toContain('¿Qué deseas pedir?')
    expect(r.options).toEqual(['🍕 Pizzerías', '🍔 Hamburguesas', '🐟 Mariscos y ceviches'])
    // Al volver al menú no se vuelve a saludar: sería un mensaje que se paga.
    expect(verCategorias(CATEGORIAS, 0, false).reply).not.toContain('Umbani')
  })

  it('sin locales lo dice, en vez de enseñar una lista vacía', () => {
    const r = verCategorias([], 0, true)
    expect(r.options).toEqual([])
    expect(r.reply).toMatch(/no tenemos locales/i)
  })

  it('pagina de nueve en nueve, porque la décima fila es «Ver más»', () => {
    // ⚠️ Una lista de WhatsApp admite DIEZ filas. Con diez categorías más el
    // botón, la última se perdería sin que nada avisara.
    const muchas = Array.from({ length: 14 }, (_, i) => cat(`c${i}`, `Categoría ${i}`))
    const primera = verCategorias(muchas, 0)
    expect(primera.options).toHaveLength(PAGINA + 1)
    expect(primera.options).toHaveLength(10)
    expect(primera.options.at(-1)).toBe(VER_MAS)

    const segunda = verCategorias(muchas, 1)
    expect(segunda.options).toHaveLength(5)
    expect(segunda.options).not.toContain(VER_MAS)
  })
})

describe('elegir una opción', () => {
  const opciones = ['🍕 Pizzerías', '🍔 Hamburguesas', VER_MAS]

  it('acepta el texto exacto que devuelve WhatsApp', () => {
    expect(elegir('🍕 Pizzerías', opciones)).toBe('🍕 Pizzerías')
  })

  it('acepta el número de la fila, que es como responde mucha gente', () => {
    expect(elegir('2', opciones)).toBe('🍔 Hamburguesas')
    expect(elegir('9', opciones)).toBeNull()
    expect(elegir('0', opciones)).toBeNull()
  })

  it('acepta el nombre sin emoji, sin tildes y sin mayúsculas', () => {
    expect(elegir('pizzerias', opciones)).toBe('🍕 Pizzerías')
    expect(elegir('PIZZERÍAS', opciones)).toBe('🍕 Pizzerías')
    expect(elegir('  hamburguesas ', opciones)).toBe('🍔 Hamburguesas')
  })

  it('no adivina cuando no hay nada parecido', () => {
    expect(elegir('quiero una moto', opciones)).toBeNull()
    expect(elegir('', opciones)).toBeNull()
  })
})

describe('navegar', () => {
  const enPortada = { vista: 'categorias', pagina: 0 }

  it('elegir una categoría pide sus locales, sin inventárselos', () => {
    const r = paso({
      mensaje: 'pizzerias', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    // No responde todavía: dice al llamador qué consultar.
    expect(r.vista).toEqual({ vista: 'negocios', categoria: 'pizzerias', pagina: 0 })
    expect(r.negocioElegido).toBeUndefined()
  })

  it('elegir un local devuelve el local, y ahí termina el menú', () => {
    const negocios = [neg('pizza-uno', 'Pizza Uno'), neg('pizza-dos', 'Pizza Dos')]
    const r = paso({
      mensaje: 'Pizza Dos',
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 },
      categorias: CATEGORIAS, negocios,
    })
    expect(r.negocioElegido?.slug).toBe('pizza-dos')
  })

  it('«Volver» regresa a la portada, no a la página en la que estaba', () => {
    const r = paso({
      mensaje: VOLVER,
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 3 },
      categorias: CATEGORIAS, negocios: [neg('x', 'X')],
    })
    expect(r.vista).toEqual({ vista: 'categorias', pagina: 0 })
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('un mensaje que no casa repite la lista en vez de dejar al cliente colgado', () => {
    const r = paso({
      mensaje: 'aaaa', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toMatch(/no te puedo ayudar por aquí/)
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('si la categoría se queda sin locales mientras miraba, no deja una calle sin salida', () => {
    // El último local pudo cerrar entre el menú y esta respuesta.
    const r = verNegocios(CATEGORIAS[0], [], 0)
    expect(r.options).toEqual([VOLVER])
    expect(r.reply).toMatch(/no hay locales abiertos/i)
  })

  it('si la categoría desapareció del todo, vuelve a la portada', () => {
    const r = paso({
      mensaje: 'lo que sea',
      vista: { vista: 'negocios', categoria: 'ya-no-existe', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.vista.vista).toBe('categorias')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// UN MENSAJE VACÍO ES REPINTAR, NO EQUIVOCARSE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Fallo REAL del 2026-08-23, visto por el dueño en su teléfono: tocaba
// «🍕 Pizzerías» y el bot le contestaba «🙏 No te entendí» — con la lista de
// locales correcta debajo. La vista avanzaba bien; solo el texto mentía.
//
// El porqué: elegir una categoría devuelve una vista SIN texto para que el
// llamador consulte los locales y vuelva a llamar. En esa segunda llamada el
// mensaje ya se consumió y llega vacío, y `elegir('')` devuelve null — que se
// trataba como «no casó ninguna opción».
describe('repintar la vista tras elegir una categoría', () => {
  const negocios = [neg('pizza-uno', 'Pizza Uno')]
  const enNegocios = { vista: 'negocios', categoria: 'pizzerias', pagina: 0 }

  it('con el mensaje vacío pinta los locales SIN reprochar nada', () => {
    const r = paso({ mensaje: '', vista: enNegocios, categorias: CATEGORIAS, negocios })
    expect(r.reply).not.toContain('no te puedo ayudar por aquí')
    expect(r.reply).toContain('Elige un local')
    expect(r.options).toContain('Pizza Uno')
  })

  it('y en la portada, igual', () => {
    const r = paso({
      mensaje: '', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).not.toContain('no te puedo ayudar por aquí')
  })

  // ⚠️ Lo que NO puede perderse: quien de verdad escribe cualquier cosa
  // estando en el menú sí tiene que saber que no se le entendió.
  it('pero una respuesta que no casa SIGUE diciendo que no se entendió', () => {
    const r = paso({
      mensaje: 'quiero un helado de mora',
      vista: enNegocios, categorias: CATEGORIAS, negocios,
    })
    expect(r.reply).toContain('no te puedo ayudar por aquí')
    expect(r.options).toContain('Pizza Uno')
  })

  it('el recorrido entero: categoría → repintado → local', () => {
    // Es el camino que el dueño no podía completar.
    const elegida = paso({
      mensaje: '🍕 Pizzerías', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(elegida.vista.categoria).toBe('pizzerias')

    const pintada = paso({
      mensaje: '', vista: elegida.vista, categorias: CATEGORIAS, negocios,
    })
    expect(pintada.reply).not.toContain('no te puedo ayudar por aquí')

    const local = paso({
      mensaje: 'Pizza Uno', vista: pintada.vista, categorias: CATEGORIAS, negocios,
    })
    expect(local.negocioElegido?.slug).toBe('pizza-uno')
  })
})

// ⚠️ `saludar` existía en `verCategorias` desde el principio y NADIE lo ponía
// en `true`: el saludo de bienvenida estaba construido y desconectado, así que
// el primerísimo mensaje de alguien que nunca había escrito recibía «🙏 No te
// entendí» como bienvenida a Umbani. Mismo patrón que `shopping_locked`.
describe('el primer mensaje de alguien que nunca ha escrito', () => {
  it('recibe la bienvenida, no un reproche', () => {
    const r = paso({
      mensaje: 'Hola buenas noches',
      vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
      primerContacto: true,
    })
    expect(r.reply).not.toContain('no te puedo ayudar por aquí')
    expect(r.reply).toContain('Bienvenido')
    expect(r.options.length).toBeGreaterThan(0)
  })

  // ⚠️ Esta prueba fijaba lo CONTRARIO hasta el 2026-08-25: quien ya había
  // escrito recibía «No te entendí» al saludar. Se reescribió, no se borró.
  // El fallo lo vio el dueño en su teléfono: la conversación no vence ni la
  // borra nadie, así que el cliente que VUELVE —el que más vale— recibía el
  // reproche cada vez que decía «Hola», para siempre.
  it('y quien YA había escrito recibe la bienvenida igual, no un reproche', () => {
    const r = paso({
      mensaje: 'Hola buenas noches',
      vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
      primerContacto: false,
    })
    expect(r.reply).not.toContain('no te puedo ayudar por aquí')
    expect(r.reply).toContain('Bienvenido')
    expect(r.options.length).toBeGreaterThan(0)
  })

  it('pero una BÚSQUEDA con saludo delante sigue siendo una búsqueda', () => {
    // «hola quiero pizza» no puede devolver la portada: el cliente pidió algo
    // concreto, y contestarle con el menú entero es no haberle escuchado.
    const r = paso({
      mensaje: 'hola quiero pizza',
      vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
      primerContacto: false,
    })
    expect(r.reply).toContain('no te puedo ayudar por aquí')
  })
})

describe('qué cuenta como saludo', () => {
  it('reconoce cómo saluda la gente de verdad', () => {
    for (const saludo of [
      'Hola', 'hola', 'HOLA', 'holaaa', 'ola', 'Buenas', 'buenass',
      'buenos días', 'buenas tardes', 'Buenas noches', 'hola buenas',
      'hola buenas noches', 'hey', 'Saludos', 'qué tal', 'como estas',
    ]) {
      expect(esSaludo(saludo), `«${saludo}» debería ser saludo`).toBe(true)
    }
  })

  it('y NO se traga lo que el cliente sí quiere pedir', () => {
    for (const texto of [
      'hola quiero pizza', 'pizza', 'buenas quiero un ceviche', 'menu',
      'hola, me traes dos hamburguesas y una cola por favor', '', '   ',
      'quiero saber que tal esta la pizza de esta pizzeria hoy',
    ]) {
      expect(esSaludo(texto), `«${texto}» NO debería ser saludo`).toBe(false)
    }
  })
})

describe('el reparto de tipos en categorías', () => {
  const sql = readFileSync(
    fileURLToPath(new URL('../migration-2026-08-21-categorias-del-marketplace.sql', import.meta.url)),
    'utf8',
  )
  const panel = readFileSync(
    fileURLToPath(new URL('../../apps/admin/src/features/clients/business-types.ts', import.meta.url)),
    'utf8',
  )

  const tiposDelPanel = () => [...panel.matchAll(/\{\s*value:\s*'([^']+)'/g)].map(([, v]) => v)
  const tiposRepartidos = () => [...sql.matchAll(/\('([^']+)','[a-z_]+'\)/g)].map(([, t]) => t)

  it('encuentra ambas listas (si no, todo lo demás pasaría en falso)', () => {
    expect(tiposDelPanel().length).toBeGreaterThanOrEqual(31)
    expect(tiposRepartidos().length).toBeGreaterThanOrEqual(31)
  })

  it('cada tipo del desplegable cae en una categoría', () => {
    // Un tipo sin categoría deja a sus locales invisibles en el menú, y nada
    // falla: simplemente nadie los encuentra nunca.
    const repartidos = new Set(tiposRepartidos())
    const huerfanos = tiposDelPanel().filter(tipo => !repartidos.has(tipo))
    expect(
      huerfanos,
      huerfanos.length
        ? 'Estos tipos no están en ninguna categoría del marketplace, así que sus\n'
          + `locales no saldrán nunca en el menú:\n${huerfanos.map(t => `  · ${t}`).join('\n')}`
        : '',
    ).toEqual([])
  })

  it('ningún tipo cae en dos categorías', () => {
    // Si pudiera, el mismo local saldría dos veces y el cliente no sabría si
    // son dos sitios distintos. Lo impide la clave primaria; esto lo vigila
    // también en el texto, que es donde se escribe el error.
    const repartidos = tiposRepartidos()
    const repetidos = repartidos.filter((t, i) => repartidos.indexOf(t) !== i)
    expect(repetidos).toEqual([])
    expect(sql).toContain('business_type text primary key')
  })

  it('el menú nunca ofrece una categoría vacía', () => {
    expect(sql).toMatch(/having count\(b\.id\) > 0/)
    // Y «disponible» significa que puede recibir un pedido AHORA.
    for (const condicion of ['b.active', 'b.suspended is not true', 'b.takes_orders', 'b.storefront_enabled']) {
      expect(sql, condicion).toContain(condicion)
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// EL COMANDO MENÚ Y EL BLOQUEO DE FLUJO (fase 5)
// ═══════════════════════════════════════════════════════════════════════════

describe('el comando MENÚ', () => {
  it('se reconoce escrito como sea', async () => {
    const { esComandoMenu } = await import('../dist/services/marketplace-menu.js')
    for (const forma of ['menu', 'menú', 'MENU', 'MENÚ', 'Menú', '  menu  ', 'MENÚ!', 'inicio', 'cancelar']) {
      expect(esComandoMenu(forma), forma).toBe(true)
    }
  })

  it('no se dispara con un mensaje que solo lo contiene', async () => {
    const { esComandoMenu } = await import('../dist/services/marketplace-menu.js')
    // «quiero ver el menu de pizzas» es una búsqueda, no el comando global.
    for (const frase of ['quiero ver el menu de pizzas', 'menu del dia', '', 'menudo lio']) {
      expect(esComandoMenu(frase), frase).toBe(false)
    }
  })
})

describe('volver al menú con un pedido en marcha', () => {
  it('va DIRECTO a las categorías, sin preguntar', async () => {
    const { responderAlMenu } = await import('../dist/services/marketplace-menu.js')
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
    const r = responderAlMenu(
      { bloqueado: true, negocio: { name: 'El Puerto', slug: 'el-puerto' } },
      CATEGORIAS,
    )
    expect(r.vista.vista).toBe('categorias')
    expect(r.options).toEqual(['🍕 Pizzerías', '🍔 Hamburguesas', '🐟 Mariscos y ceviches'])
    // Quien llega aquí con un pedido sin pagar lo tiene CANCELADO por el
    // llamador, no caducado: avisar no puede costar una falta.
    expect(r.reply).not.toContain('El Puerto')
  })

  it('sin pedido en marcha, vuelve al menú directo', async () => {
    const { responderAlMenu } = await import('../dist/services/marketplace-menu.js')
    const r = responderAlMenu({ bloqueado: false, negocio: null }, CATEGORIAS)
    expect(r.vista.vista).toBe('categorias')
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('«sí» reinicia y «no» conserva el pedido', async () => {
    const { resolverReinicio, SI_REINICIAR, NO_CONTINUAR } =
      await import('../dist/services/marketplace-menu.js')
    const estado = { bloqueado: true, negocio: { name: 'El Puerto', slug: 'el-puerto' } }

    expect(resolverReinicio(SI_REINICIAR, estado, CATEGORIAS).reinicia).toBe(true)
    expect(resolverReinicio('1', estado, CATEGORIAS).reinicia).toBe(true)

    const no = resolverReinicio(NO_CONTINUAR, estado, CATEGORIAS)
    expect(no.reinicia).toBe(false)
    expect(no.respuesta.reply).toContain('El Puerto')
  })

  it('ante una respuesta ambigua NO decide por el cliente', async () => {
    const { resolverReinicio } = await import('../dist/services/marketplace-menu.js')
    // Tirar un carrito por un «ok» ambiguo es lo único que no tiene vuelta
    // atrás: se repite la pregunta.
    const r = resolverReinicio('ok', { bloqueado: true, negocio: { name: 'X', slug: 'x' } }, CATEGORIAS)
    expect(r.reinicia).toBe(false)
    expect(r.respuesta.vista.vista).toBe('confirmando_reinicio')
    // Y desde el 2026-09-24 no se le reprocha: «ok» es español. Se le recuerda
    // dónde está, igual que a quien saluda.
    expect(r.respuesta.reply).toBe('Estás pidiendo en *X*.\n\n¿Empezamos de nuevo o sigues con tu pedido?')
  })
})

describe('intentar empezar otra cosa con un pedido abierto', () => {
  it('dice dónde lo tiene y cómo salir, en el mismo mensaje', async () => {
    const { recordarPedidoEnProceso } = await import('../dist/services/marketplace-menu.js')
    // ⚠️ Cada respuesta se paga: no se gasta un mensaje en decir solo «no».
    const r = recordarPedidoEnProceso({ name: 'El Puerto' })
    expect(r.reply).toContain('El Puerto')

    // ⚠️ CAMBIADO EL 2026-08-23, y la intención es la MISMA: decirle cómo
    // salir. Antes el texto mandaba «escribe *MENÚ*»… y escribir MENÚ llevaba
    // a una pregunta que MENÚ no podía responder, así que el cliente se
    // quedaba dando vueltas. Ahora se le dan las dos salidas de verdad.
    expect(r.options).toHaveLength(2)
    expect(r.options.join(' ')).toMatch(/Empezar de nuevo/)
    expect(r.options.join(' ')).toMatch(/Seguir mi pedido/)
    expect(r.vista.vista).toBe('confirmando_reinicio')
  })

  // ⚠️ EL BUCLE que vivió el dueño: «sigue enviando y enviando lo mismo».
  // MENÚ se comprueba antes que la vista, así que escribirlo estando ya en la
  // confirmación volvía a preguntar lo mismo, para siempre.
  //
  // Pedir el menú DOS VECES no es ambiguo: es la misma petición repetida.
  it('un segundo MENÚ confirma en vez de volver a preguntar', async () => {
    const entrada = await import('../dist/services/marketplace-entry.js')
    const fuente = fuenteDeLaEntradaDelMarketplace()
    expect(entrada.handleMarketplaceMessage).toBeTypeOf('function')
    // La rama existe y suelta el local, que es lo que rompe el bucle.
    expect(fuente).toMatch(// La ventana se amplió el 2026-09-04: entre la comprobación y el guardado
    // entra ahora `abandonarPedido`, que cancela el pedido sin pagar de quien
    // se va AVISANDO para que no le cueste una falta al caducar.
    /vista\.vista === 'confirmando_reinicio'[\s\S]{0,900}soltarLocal: true/)
  })
})

// ── Quien DEBE un comprobante lee otra cosa (2026-08-30) ──────────────────
//
// Desde que el candado dura hasta que la foto llega, este es el mensaje que
// más se va a leer del marketplace. `recordarPedidoEnProceso` dice
// «Termínalo», y a quien ya hizo su pedido y solo debe la captura eso lo manda
// a buscar un menú que ya completó.
describe('el recordatorio del comprobante', () => {
  it('dice qué falta y cómo salir, sin decir «termínalo»', async () => {
    const { recordarComprobantePendiente } = await import('../dist/services/marketplace-menu.js')
    const r = recordarComprobantePendiente({ name: 'Monster Pizza' })
    expect(r.reply).toContain('Monster Pizza')
    expect(r.reply.toLowerCase()).toContain('comprobante')
    // La salida tiene que estar NOMBRADA: sin ella, quien quiera pedir en otro
    // local se queda encerrado sin saber que hay puerta. Desde el 2026-09-27
    // es MENÚ escrito, no un botón.
    expect(r.reply).toContain('MENÚ')
    expect(r.reply.toLowerCase()).not.toContain('termínalo')
  })

  // ⚠️ SIN BOTONES (2026-09-27), igual que el de pago en revisión. El primero
  // era «✅ Empezar de nuevo» y un toque por error cancelaba el pedido de
  // quien estaba a punto de pagar —o ya había pagado—. Lo vio el dueño con el
  // «Hola, te envío el comprobante…» que precarga la mini app.
  it('no ofrece «Empezar de nuevo» ni ningún otro botón', async () => {
    const menu = await import('../dist/services/marketplace-menu.js')
    const conComprobante = menu.recordarComprobantePendiente({ name: 'X' })
    expect(conComprobante.options).toEqual([])
    expect(conComprobante.options).toEqual(menu.recordarPagoEnRevision({ name: 'X' }).options)
  })

  // Con la vista de la pregunta, un «1» —escrito o de un mensaje anterior—
  // se seguiría leyendo como «Empezar de nuevo».
  it('no deja la pregunta de reinicio pendiente', async () => {
    const menu = await import('../dist/services/marketplace-menu.js')
    expect(menu.recordarComprobantePendiente({ name: 'X' }).vista.vista).not.toBe('confirmando_reinicio')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// VOLVER AL INICIO SE RECONOCE, Y LO QUE NO ES TEXTO SE NOMBRA
//
// Los dos los probó el dueño en su teléfono el 2026-09-06:
//
//   · escribió MENÚ y recibió «¿Qué deseas pedir?» a secas — «como una
//     pregunta simple», sin nada delante;
//   · subió una foto cualquiera y recibió el mismo «no te entendí» que
//     recibiría un «asdfghjkl». La foto se entendió perfectamente: lo que
//     pasa es que este chat todavía no hace nada con ella.
// ═══════════════════════════════════════════════════════════════════════════
describe('la bienvenida de vuelta', () => {
  it('MENÚ saluda de vuelta y ofrece las categorías', async () => {
    const { responderAlMenu } = await import('../dist/services/marketplace-menu.js')
    const r = responderAlMenu({ bloqueado: false, negocio: null }, CATEGORIAS)
    expect(r.reply).toContain('vuelta')
    expect(r.reply).toContain('Umbani')
    expect(r.reply).toContain('¿Qué deseas pedir?')
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('«✅ Empezar de nuevo» saluda igual: es la misma puerta', async () => {
    const menu = await import('../dist/services/marketplace-menu.js')
    const { reinicia, respuesta } = menu.resolverReinicio(
      menu.SI_REINICIAR, { bloqueado: true, negocio: { name: 'X', slug: 'x' } }, CATEGORIAS,
    )
    expect(reinicia).toBe(true)
    expect(respuesta.reply).toContain('vuelta')
    expect(respuesta.options).toContain('🍕 Pizzerías')
  })

  // ⚠️ Lo que NO puede pasar: saludar en mitad de la navegación. Quien toca
  // «⬅️ Volver» no ha vuelto al principio de nada, y darle la bienvenida ahí
  // leería como si el bot le hubiera perdido el hilo.
  it('pero «⬅️ Volver» NO saluda: el cliente no se ha ido a ninguna parte', () => {
    const r = paso({
      mensaje: VOLVER,
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [neg('pizza-uno', 'Pizza Uno')],
    })
    expect(r.vista.vista).toBe('categorias')
    expect(r.reply).not.toContain('vuelta')
    expect(r.reply).toContain('¿Qué deseas pedir?')
  })

  // El saludo del primer contacto NO cambia: sigue siendo «Bienvenido a
  // Umbani», que es lo que se le dice a quien llega, no a quien vuelve.
  it('y quien llega por primera vez sigue recibiendo SU bienvenida', () => {
    const r = paso({
      mensaje: 'Hola', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [], primerContacto: true,
    })
    expect(r.reply).toContain('Bienvenido a')
    expect(r.reply).not.toContain('vuelta')
  })
})

describe('lo que llega y no es texto', () => {
  const enPortada = { vista: 'categorias', pagina: 0 }

  it('una foto se responde COMO foto, no como una opción equivocada', () => {
    const r = paso({
      mensaje: '[foto]', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toContain('foto')
    expect(r.reply).not.toContain('no te puedo ayudar por aquí')
    // Y sigue siendo un «no casó»: el llamador necesita la señal.
    expect(r.noEntendido).toBe(true)
    expect(r.options).toContain('🍕 Pizzerías')
  })

  it('una nota de voz y una ubicación, igual', () => {
    const voz = paso({
      mensaje: '[nota de voz]', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(voz.reply).toContain('voz')
    expect(voz.reply).not.toContain('no te puedo ayudar por aquí')

    const donde = paso({
      mensaje: '[ubicación]', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(donde.reply).toContain('ubicación')
    expect(donde.reply).not.toContain('no te puedo ayudar por aquí')
  })

  // Dentro de una categoría la lista de locales se repinta igual que siempre:
  // lo único que cambia es el encabezado.
  it('con una lista de locales delante, repinta la lista', () => {
    const r = paso({
      mensaje: '[foto]',
      vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [neg('pizza-uno', 'Pizza Uno')],
    })
    expect(r.reply).toContain('foto')
    expect(r.reply).toContain('Elige un local')
    expect(r.options).toContain('Pizza Uno')
  })

  // ⚠️ El texto de verdad sigue recibiendo el reproche: quien escribe
  // «asdfghjkl» tiene que saber que no se le entendió.
  it('un texto suelto SÍ recibe el reproche de siempre', () => {
    const r = paso({
      mensaje: 'asdfghjkl', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toContain('no te puedo ayudar por aquí')
    expect(r.reply).not.toContain('foto')
  })

  // La portada del «no casó» explica qué se hace aquí en vez de repetir la
  // pregunta: era lo que dejaba al cliente sin saber qué esperaba el bot.
  it('la portada dice qué se puede hacer, no solo que falló', () => {
    const r = paso({
      mensaje: 'asdfghjkl', vista: enPortada, categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toContain('elige una categoría')
    expect(r.options).toContain('🍕 Pizzerías')
  })

  // ⚠️ Un objeto indexado por texto del CLIENTE heredaría el prototipo: quien
  // escribiera «constructor» recibiría una función como respuesta. Por eso el
  // catálogo de adjuntos es un Map.
  it('«constructor» es un texto cualquiera, no una respuesta del prototipo', async () => {
    const { esAdjuntoSinTexto } = await import('../dist/services/marketplace-menu.js')
    expect(esAdjuntoSinTexto('constructor')).toBe(false)
    expect(esAdjuntoSinTexto('toString')).toBe(false)
    expect(esAdjuntoSinTexto('[foto]')).toBe(true)
    // El marcador real lleva tilde; la comparación va sobre el normalizado.
    expect(esAdjuntoSinTexto('[ubicación]')).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// LOS LOCALES CERRADOS SE VEN, PERO SE VEN CERRADOS
//
// Pedido del dueño (2026-09-03): «cuando el local esté cerrado aparecerá en
// las categorías pero para que no se pueda elegir y dirá local cerrado y abre
// a tal hora, para que aunque el cliente no pueda pedir igual vea la hora de
// apertura».
//
// Ya aparecían —las consultas del marketplace filtran por activo y tienda
// encendida, nunca por horario— pero sin ninguna señal: el cliente elegía, le
// llegaba «arma tu pedido aquí», entraba y se encontraba la tienda cerrada.
// ═══════════════════════════════════════════════════════════════════════════
describe('los locales cerrados en la lista', () => {
  const local = (slug, name, abierto, abre) => ({
    id: slug, slug, name, type: 'pizzeria', prep_min: 20, abierto, abre,
  })
  const abre8 = { open: '08:00', inDays: 0, dayName: 'Miércoles' }
  const cerrado = local('monster', 'Monster Pizza', false, abre8)
  const abierto = local('uno', 'Pizza Uno', true)

  it('el cerrado lleva luna y el abierto no', () => {
    const r = verNegocios(CATEGORIAS[0], [cerrado, abierto], 0)
    expect(r.options).toContain('🌙 Monster Pizza')
    expect(r.options).toContain('Pizza Uno')
  })

  // ⚠️ La hora va en el TEXTO y no en el título: WhatsApp recorta los títulos
  // a 20 caracteres, y un título recortado es imposible de elegir. Es la
  // cicatriz de «✅ Sí, empezar de nuevo».
  it('la hora de apertura va en el mensaje, no en el título', () => {
    const r = verNegocios(CATEGORIAS[0], [cerrado, abierto], 0)
    expect(r.reply).toContain('abre hoy 8:00 AM')
    for (const opcion of r.options) {
      expect(opcion.length, `«${opcion}» pasa de 20 caracteres`).toBeLessThanOrEqual(20)
    }
  })

  it('los abiertos van primero aunque lleguen después', () => {
    const r = verNegocios(CATEGORIAS[0], [cerrado, abierto], 0)
    expect(r.options[0]).toBe('Pizza Uno')
    expect(r.options[1]).toBe('🌙 Monster Pizza')
  })

  // ⚠️ EL PUNTO QUE MÁS PODÍA ROMPERSE: si `verNegocios` ordena y `paso` no,
  // el cliente toca el primero y recibe otro local.
  it('tocar un local devuelve EL QUE SE TOCÓ, con el orden nuevo', () => {
    const r = verNegocios(CATEGORIAS[0], [cerrado, abierto], 0)
    const primero = paso({
      mensaje: r.options[0], vista: r.vista,
      categorias: CATEGORIAS, negocios: [cerrado, abierto],
    })
    expect(primero.negocioElegido?.slug).toBe('uno')

    const conLuna = paso({
      mensaje: '🌙 Monster Pizza', vista: r.vista,
      categorias: CATEGORIAS, negocios: [cerrado, abierto],
    })
    expect(conLuna.negocioElegido?.slug).toBe('monster')
    // Y llega con su estado, que es lo que el llamador usa para avisar.
    expect(conLuna.negocioElegido?.abierto).toBe(false)
  })

  // ⚠️ ESTA es la que caza el desorden de verdad, y la primera versión NO lo
  // hacía: con pocos locales, `elegir` los resuelve por TEXTO y da igual el
  // orden. El fallo solo aparece con PAGINACIÓN — si `verNegocios` ordena y
  // `paso` no, la página que se pinta y la que se busca contienen locales
  // DISTINTOS, y tocar uno de la lista devuelve «no te entendí».
  it('con más de una página, pintar y elegir usan la MISMA lista', () => {
    // Tres cerrados delante y diez abiertos detrás: ordenados, la primera
    // página son nueve abiertos; sin ordenar, tres cerrados y seis abiertos.
    const muchos = [
      ...Array.from({ length: 3 }, (_, i) => local(`c${i}`, `Cerrado ${i}`, false, abre8)),
      ...Array.from({ length: 10 }, (_, i) => local(`a${i}`, `Abierto ${i}`, true)),
    ]
    const r = verNegocios(CATEGORIAS[0], muchos, 0)
    // El noveno de la página pintada es un abierto que, SIN ordenar, caería en
    // la segunda página: es el que delata la diferencia.
    const noveno = r.options[8]
    expect(noveno).toBe('Abierto 8')

    const elegido = paso({
      mensaje: noveno, vista: r.vista, categorias: CATEGORIAS, negocios: muchos,
    })
    expect(elegido.negocioElegido?.slug, 'tocó un local de la lista y no se resolvió')
      .toBe('a8')
  })

  it('dice hoy, mañana o el día que toque', () => {
    const manana = local('n', 'La Nona', false, { open: '11:00', inDays: 1, dayName: 'Jueves' })
    const lejos = local('t', 'Tres', false, { open: '09:30', inDays: 4, dayName: 'Domingo' })
    const r = verNegocios(CATEGORIAS[0], [manana, lejos], 0)
    expect(r.reply).toContain('abre mañana 11:00 AM')
    expect(r.reply).toContain('abre el domingo 9:30 AM')
  })

  // ⚠️ Sin estado NO se marca nada: el horario puede no estar configurado, o
  // la consulta puede fallar. Llamar «cerrado» a un local abierto le cuesta
  // ventas de verdad; no marcarlo solo le cuesta al cliente un viaje.
  it('sin saber el estado, la lista sale como salía antes', () => {
    const sinDato = local('x', 'Sin Horario', undefined, undefined)
    const r = verNegocios(CATEGORIAS[0], [sinDato], 0)
    expect(r.options).toEqual(['Sin Horario', VOLVER])
    expect(r.reply).not.toContain('🌙')
  })

  it('la búsqueda los marca igual: es la misma lista por otra puerta', async () => {
    const { verResultados } = await import('../dist/services/marketplace-menu.js')
    const r = verResultados('pizza', [cerrado, abierto], 0)
    expect(r.options[0]).toBe('Pizza Uno')
    expect(r.reply).toContain('abre hoy 8:00 AM')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// UN SALUDO NO ES UNA TONTERÍA, Y UNA FOTO SE NOMBRA
//
// Probado por el dueño en su teléfono (2026-09-03) con el local ya elegido:
//
//   · mandó una foto  → «Estás pidiendo en Monster Pizza» (cierto, pero no
//     decía nada de su foto: se quedaba sin saber si llegó o si servía);
//   · escribió «Hola» → «Eso no lo pude entender», y sus palabras fueron
//     «un hola se puede entender».
//
// El reproche NO desaparece: lo que se separa es «escribió algo que no toca»
// de «escribió cualquier cosa».
// ═══════════════════════════════════════════════════════════════════════════
describe('lo que se responde con un local ya elegido', () => {
  const enLocal = { bloqueado: true, negocio: { name: 'Monster Pizza', slug: 'monster' } }

  const resolver = async (mensaje, estado = enLocal) => {
    const { resolverReinicio } = await import('../dist/services/marketplace-menu.js')
    return resolverReinicio(mensaje, estado, CATEGORIAS)
  }

  it('un saludo recibe dónde está, no un reproche', async () => {
    for (const saludo of ['Hola', 'buenas', 'qué tal', 'hola buenas noches']) {
      const { respuesta } = await resolver(saludo)
      expect(respuesta.reply, saludo).toContain('Monster Pizza')
      expect(respuesta.reply, saludo).not.toContain('no te puedo ayudar por aquí')
    }
  })

  // ⚠️ Lo que NO puede perderse: quien escribe cualquier cosa sí tiene que
  // saber que no se le entendió, o la pregunta se vuelve ruido.
  it('pero una tontería SIGUE recibiendo el reproche', async () => {
    const { respuesta } = await resolver('asdfghjkl')
    expect(respuesta.reply).toContain('no te puedo ayudar por aquí')
  })

  // ⚠️ Y los dos botones se conservan en los dos casos: `resolverReinicio` los
  // interpreta por su texto, así que perderlos dejaría al cliente encerrado.
  it('las dos salidas siguen ahí, se salude o no', async () => {
    const menu = await import('../dist/services/marketplace-menu.js')
    for (const mensaje of ['Hola', 'asdfghjkl']) {
      const { respuesta } = await resolver(mensaje)
      expect(respuesta.options, mensaje).toEqual([menu.SI_REINICIAR, menu.NO_CONTINUAR])
      expect(respuesta.vista.vista, mensaje).toBe('confirmando_reinicio')
    }
  })

  it('sin local elegido, el saludo también se responde con calma', async () => {
    const { respuesta } = await resolver('Hola', { bloqueado: false, negocio: null })
    expect(respuesta.reply).not.toContain('no te puedo ayudar por aquí')
    expect(respuesta.reply).toContain('Hola')
  })

  it('la foto se nombra Y dice que aún no es un comprobante', async () => {
    const { textoDeAdjuntoRecibido } = await import('../dist/services/marketplace-menu.js')
    const foto = textoDeAdjuntoRecibido('[foto]')
    expect(foto).toContain('foto')
    // Las dos mitades: que llegó, y por qué todavía no vale.
    expect(foto).toContain('comprobante')
    expect(foto).toContain('no has hecho tu pedido')
  })

  it('la voz y la ubicación también, y un texto no', async () => {
    const { textoDeAdjuntoRecibido } = await import('../dist/services/marketplace-menu.js')
    expect(textoDeAdjuntoRecibido('[nota de voz]')).toContain('voz')
    expect(textoDeAdjuntoRecibido('[ubicación]')).toContain('ubicación')
    expect(textoDeAdjuntoRecibido('hola')).toBe(null)
    expect(textoDeAdjuntoRecibido('quiero una pizza')).toBe(null)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ABIERTO, PERO SIN CARTA A ESTA HORA (2026-09-17)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo abrieron los menús con reloj: una cafetería de desayunos puede tener el
// local abierto hasta las 22:00 y toda su carta en la franja 07:00–11:00. A
// las 9 de la noche el cliente entraba, veía la carta entera apagada y no
// podía pedir nada — peor que un local cerrado, porque ni siquiera se lo
// avisó. Se trata igual que un cerrado: luna, al final, y el motivo en el
// cuerpo del mensaje, que es donde no hay límite de caracteres.
describe('un local sin carta a esta hora', () => {
  const local = (slug, name, extra = {}) => ({
    id: slug, slug, name, type: 'cafetería', prep_min: 15, ...extra,
  })
  const sinCarta = local('mana', 'Café Maná', { abierto: true, con_carta: false, carta_desde: '07:00' })
  const conCarta = local('uno', 'Pizza Uno', { abierto: true, con_carta: true })

  it('lleva luna, como el cerrado: no se puede pedir ahí ahora', () => {
    const r = verNegocios(CATEGORIAS[0], [sinCarta, conCarta], 0)
    expect(r.options).toContain('🌙 Café Maná')
    expect(r.options).toContain('Pizza Uno')
  })

  it('el motivo va en el mensaje y dice desde qué hora se pide', () => {
    const r = verNegocios(CATEGORIAS[0], [sinCarta, conCarta], 0)
    expect(r.reply).toContain('Café Maná · su carta empieza 7:00 AM')
    for (const opcion of r.options) {
      expect(opcion.length, `«${opcion}» pasa de 20 caracteres`).toBeLessThanOrEqual(20)
    }
  })

  it('va al final, detrás de los que sí tienen carta', () => {
    const r = verNegocios(CATEGORIAS[0], [sinCarta, conCarta], 0)
    expect(r.options[0]).toBe('Pizza Uno')
    expect(r.options[1]).toBe('🌙 Café Maná')
  })

  it('sin la hora, se dice lo único cierto: ahora no se puede pedir', () => {
    const r = verNegocios(CATEGORIAS[0], [local('x', 'Sin Hora', { abierto: true, con_carta: false })], 0)
    expect(r.reply).toContain('Sin Hora · sin carta a esta hora')
  })

  // ⚠️ `undefined` NO es «sin carta»: la búsqueda del chat devuelve locales sin
  // ese dato, y marcarlos cerrados por no saberlo cuesta ventas. Es la misma
  // regla de los tres estados de `abierto`.
  it('no saberlo no es marcarlo: un local sin el dato se pinta normal', () => {
    const r = verNegocios(CATEGORIAS[0], [local('y', 'Sin Dato', { abierto: true })], 0)
    expect(r.options).toContain('Sin Dato')
    expect(r.reply).not.toContain('🌙')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// «BUENO» ES ESPAÑOL: SE CONTESTA, NO SE REPROCHA
// ═══════════════════════════════════════════════════════════════════════════
//
// 2026-09-24. El dueño escribió «Bueno» y recibió «🙏 Eso no lo pude
// entender»: «no es una palabra rara, es una palabra en español que existe».
// Las palabras con las que la gente contesta por WhatsApp reciben un acuse; lo
// que de verdad no es nada recibe «Con eso no te puedo ayudar por aquí», que
// no le atribuye el fallo a lo que escribió.
describe('las palabras de conversación', () => {
  it('reconoce cómo contesta la gente, también estirado y mezclado con saludos', () => {
    for (const mensaje of ['Bueno', 'ok', 'OK gracias', 'Siii', 'listo!!', 'muchas gracias',
      'hola bueno', 'dale', 'Perfecto 👍', 'jajaja']) {
      expect(esConversacion(mensaje), mensaje).toBe(true)
    }
  })

  it('una frase con algo que pedir sigue siendo una búsqueda, y un saludo sigue siendo saludo', () => {
    for (const mensaje of ['bueno quiero pizza', 'ok una hamburguesa', 'asdfgh', 'pollo', '']) {
      expect(esConversacion(mensaje), mensaje).toBe(false)
    }
    // El saludo puro tiene su propia respuesta: la bienvenida.
    expect(esConversacion('hola buenas noches')).toBe(false)
  })

  it('en la portada, «Bueno» recibe el acuse con las categorías y no dispara la búsqueda', () => {
    const r = paso({
      mensaje: 'Bueno', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toBe('🙂 ¡Listo! Cuando quieras pedir, elige una categoría y te llevo al local 👇')
    expect(r.options).toContain('🍕 Pizzerías')
    // `noEntendido` es lo que manda el texto a buscar locales: «bueno» no se busca.
    expect(r.noEntendido).toBeFalsy()
  })

  it('lo que no es nada recibe el mensaje nuevo, con la guía y las categorías', () => {
    const r = paso({
      mensaje: 'asdfgh', vista: { vista: 'categorias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [],
    })
    expect(r.reply).toBe(
      '🙏 Con eso no te puedo ayudar por aquí.\n\n'
      + 'Por este chat se pide en *Umbani*: elige una categoría y te llevo al local 👇',
    )
    expect(r.reply).not.toMatch(/no lo pude entender/)
    expect(r.options).toContain('🍕 Pizzerías')
    expect(r.noEntendido).toBe(true)
  })

  it('dentro de una categoría, un «ok» repinta los locales sin reprochar', () => {
    const r = paso({
      mensaje: 'ok', vista: { vista: 'negocios', categoria: 'pizzerias', pagina: 0 },
      categorias: CATEGORIAS, negocios: [neg('pizza-uno', 'Pizza Uno')],
    })
    expect(r.reply).not.toContain('no te puedo ayudar por aquí')
    expect(r.options).toContain('Pizza Uno')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// UNA CATEGORÍA ESCRITA POR SU NOMBRE, AUNQUE ESTÉ EN OTRA PÁGINA (2026-09-25)
// ═══════════════════════════════════════════════════════════════════════════
//
// Con los locales de muestra hubo más de nueve categorías con locales, y
// «Panaderías» y «Minimarkets» cayeron a la segunda página de la portada. El
// canario escribía su nombre desde la primera y no las encontraba: cinco
// veces seguidas, con dos locales invisibles para quien escribe.
describe('la categoría escrita por su nombre', () => {
  const MUCHAS = [
    cat('pizzerias', 'Pizzerías', '🍕'), cat('hamburguesas', 'Hamburguesas', '🍔'),
    cat('almuerzos', 'Almuerzos', '🍽️'), cat('restaurantes', 'Comida típica y restaurantes', '🍲'),
    cat('asados', 'Asados y parrilla', '🔥'), cat('mariscos', 'Mariscos y ceviches', '🐟'),
    cat('internacional', 'Comida internacional', '🌎'), cat('desayunos', 'Desayunos y café', '🍳'),
    cat('postres', 'Heladerías y postres', '🍦'), cat('jugos', 'Jugos y batidos', '🥤'),
    cat('panaderias', 'Panaderías', '🥖'), cat('minimarkets', 'Minimarkets', '🛒'),
  ]
  const portada = { vista: 'categorias', pagina: 0 }
  const escribir = mensaje => paso({ mensaje, vista: portada, categorias: MUCHAS, negocios: [] })

  it('parte de la premisa: esas dos NO están en la primera página', () => {
    expect(verCategorias(MUCHAS, 0).options).not.toContain('🥖 Panaderías')
    expect(verCategorias(MUCHAS, 0).options).not.toContain('🛒 Minimarkets')
  })

  it('las encuentra igual desde la portada, que es lo que hace el canario', () => {
    expect(escribir('Panaderías').vista).toEqual({ vista: 'negocios', categoria: 'panaderias', pagina: 0 })
    expect(escribir('Minimarkets').vista).toEqual({ vista: 'negocios', categoria: 'minimarkets', pagina: 0 })
  })

  it('sin tildes, en minúsculas y en singular, como escribe la gente', () => {
    expect(escribir('panaderia').vista.categoria).toBe('panaderias')
    expect(escribir('MINIMARKET').vista.categoria).toBe('minimarkets')
  })

  it('un NÚMERO sigue siendo la fila que el cliente tiene delante', () => {
    // «10» no es la décima categoría de una página que no ve.
    expect(escribir('3').vista).toEqual({ vista: 'negocios', categoria: 'almuerzos', pagina: 0 })
    expect(escribir('10').vista.vista).toBe('categorias')
  })

  it('con dos de otra página que empiezan igual no adivina: sigue buscando', () => {
    // Las dos «Comida…» empujadas a la segunda página.
    const relleno = Array.from({ length: 9 }, (_, i) => cat(`c${i}`, `Categoría ${i}`))
    const r = paso({
      mensaje: 'comida',
      vista: portada,
      categorias: [
        ...relleno,
        cat('restaurantes', 'Comida típica y restaurantes'),
        cat('internacional', 'Comida internacional'),
      ],
      negocios: [],
    })
    expect(r.vista.vista).toBe('categorias')
    expect(r.noEntendido).toBe(true)
  })

  it('una palabra corta tampoco secuestra la búsqueda', () => {
    expect(escribir('pan').noEntendido).toBe(true)
  })
})
