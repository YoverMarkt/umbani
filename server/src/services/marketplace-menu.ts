import { VER_MAS, VOLVER, GUIA, ACUSE, normalizar, esSaludo, esConversacion, reproche, etiquetaCategoria } from './marketplace-menu-textos'
import { etiquetaNegocio, abiertosPrimero, paginar, elegir, categoriaEscrita, verCategorias, verNegocios, verResultados, ABIERTAS_AL_REPINTAR, pintarAbiertas, PasoInput } from './marketplace-menu-pantallas'

// Lo que vivía aquí hasta el 2026-10-07: quien lo importaba de este archivo sigue igual.
export { ADVERTENCIA_OPCION_VIEJA, OPCION_ANTERIOR, PAGINA, VER_MAS, VOLVER, esAdjuntoSinTexto, esConversacion, esSaludo, textoDeAdjuntoRecibido } from './marketplace-menu-textos'
export { ADVERTENCIA_POR_INSULTOS, PasoInput, TE_HEMOS_DESBLOQUEADO, avisoDeBloqueoPorInsultos, avisoDePausaPorOpcionesViejas, avisoDeSilencio, elegir, esPreguntaPorAbiertos, momentoDelDia, pieDeCiudad, verAbiertos, verCategorias, verNegocios, verResultados } from './marketplace-menu-pantallas'

// ═══════════════════════════════════════════════════════════════════════════
// EL MENÚ DEL MARKETPLACE
//
// Lo que ve quien escribe al número de Umbani: categorías → locales → y de ahí
// al enlace de la tienda de ese local.
//
// ⚠️ Termina en el ENLACE a propósito. La mini app ya sabe hacer productos,
// opciones, carrito, dirección, pago y seguimiento: rehacer todo eso en
// botones de WhatsApp sería una segunda implementación del mismo camino, y
// dos sitios donde el precio puede divergir. El menú solo lleva al cliente
// hasta la puerta del local correcto.
//
// ⚠️ Función PURA, como `bot-menu-flow.ts`: recibe los datos ya consultados y
// devuelve texto y opciones. Nada de base de datos aquí — así se prueba entera
// sin levantar nada, que es lo que permite confiar en ella.
//
// ⚠️ La paginación es de NUEVE, no diez. Una lista de WhatsApp admite diez
// filas y la última se la lleva «Ver más»; con diez opciones más el botón, la
// última se perdería sin que nada avisara.
// ═══════════════════════════════════════════════════════════════════════════

export interface MarketplaceCategory {
  code: string
  label: string
  emoji: string | null
  locales: number
  /**
   * La ciudad de estas categorías y si hay otras (2026-10-05). Viaja en cada
   * categoría para que TODO sitio que pinta el menú ponga el pie «📍 Estás en
   * Chone» sin acordarse. Ver `services/marketplace-ciudad.ts`.
   */
  ciudad?: string
  otrasCiudades?: boolean
}

export interface MarketplaceBusiness {
  id: string
  slug: string
  name: string
  type: string
  prep_min: number | null
  /**
   * ¿Tiene algo pedible AHORA? Lo abrieron los menús con reloj (2026-09-17):
   * una cafetería puede estar abierta hasta las 22:00 con toda su carta en la
   * franja 07:00–11:00, y a las 9 de la noche no se le puede pedir nada.
   *
   * ⚠️ `undefined` es «no lo sé» y se pinta como siempre, igual que `abierto`:
   * la búsqueda del chat no trae este dato, y marcar cerrado por no saberlo
   * cuesta ventas.
   */
  con_carta?: boolean
  /** Desde qué hora vuelve a haber carta, para el que no tiene ninguna ahora. */
  carta_desde?: string | null
  /**
   * ¿Está atendiendo AHORA? `undefined` cuando no se pudo averiguar.
   *
   * ⚠️ Los tres estados importan. `false` es «cerrado, díselo»; `undefined` es
   * «no lo sé», y ahí se pinta como siempre en vez de marcarlo cerrado por si
   * acaso: llamar cerrado a un local que está abierto le cuesta ventas de
   * verdad, y la consulta del horario puede fallar.
   */
  abierto?: boolean
  /** A qué hora abre, ya resuelto, para el que está cerrado. */
  abre?: { open: string; inDays: number; dayName: string } | null
}

/** Dónde está el cliente dentro del menú. Se guarda en `flow_state`. */
export interface MarketplaceView {
  vista: 'categorias' | 'negocios' | 'busqueda' | 'confirmando_reinicio' | 'abiertos' | 'ciudades'
  categoria?: string
  /**
   * Las categorías que se le enseñaron al preguntar «¿hay locales abiertos?».
   *
   * ⚠️ Se guardan porque la lista NO es la de la portada: un «2» tiene que ser
   * la segunda de ESTA lista. Recalcularla al tocar podría cambiarla —un local
   * cierra a esa hora en punto— y el cliente entraría en otra categoría.
   */
  codigos?: string[]
  /**
   * Lo que el cliente escribió, cuando la vista es una BÚSQUEDA.
   *
   * ⚠️ Se guarda la consulta, no los resultados. Volver a buscar cuesta una
   * consulta, pero mantiene `flow_state` pequeño y —lo que importa— los
   * resultados frescos: un local que se suspendió entre medias desaparece de
   * la lista en vez de seguir ofreciéndose.
   */
  consulta?: string
  pagina: number
}

export interface MarketplaceReply {
  reply: string
  options: string[]
  /**
   * El mensaje no casó con ninguna opción del menú.
   *
   * Es la señal de que quizá el cliente esté BUSCANDO («quiero ceviche») en
   * vez de equivocándose. El llamador la usa para consultar la búsqueda antes
   * de responder «no te entendí» — `paso` no puede hacerlo solo porque es una
   * función pura y buscar exige tocar la base.
   */
  noEntendido?: boolean
  /** Cuando el cliente eligió local: a partir de aquí manda la tienda. */
  negocioElegido?: MarketplaceBusiness
  vista: MarketplaceView
}

/**
 * Un paso del menú: qué contesta el bot ante este mensaje.
 *
 * Devuelve `negocioElegido` cuando el cliente llegó a un local; a partir de
 * ahí el llamador emite el enlace de su tienda.
 */
export function paso(input: PasoInput): MarketplaceReply {
  const { mensaje, vista, categorias, negocios } = input
  // Repintar la vista tal cual: nadie se equivocó, no hay nada que reprochar.
  const repintar = !normalizar(mensaje)

  // ── Los resultados de una búsqueda ──────────────────────────────────
  //
  // Se pintan como cualquier lista de locales y al tocar uno se entra por el
  // MISMO camino (`negocioElegido`): un local es un local, venga del menú o de
  // haber escrito «quiero ceviche».
  if (vista.vista === 'busqueda' && vista.consulta) {
    // ⚠️ EL MISMO ORDEN que al pintar, o el cliente toca el tercero y recibe
    // otro: `verNegocios` y `verResultados` bajan los cerrados al final, así
    // que aquí hay que paginar sobre esa misma lista para resolver qué tocó.
    const { mostrados, hayMas, opciones } = paginar(
      abiertosPrimero(negocios), vista.pagina, etiquetaNegocio,
    )
    const elegida = elegir(mensaje, [
      ...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER,
    ])

    if (elegida === VOLVER) return verCategorias(categorias, 0)
    if (elegida === VER_MAS) return verResultados(vista.consulta, negocios, vista.pagina + 1)

    const negocio = mostrados.find(n => etiquetaNegocio(n) === elegida)
    if (negocio) {
      return {
        reply: '',
        options: [],
        negocioElegido: negocio,
        vista: { vista: 'busqueda', consulta: vista.consulta, pagina: vista.pagina },
      }
    }

    // ⚠️ UN SALUDO AQUÍ VUELVE A LA PORTADA, y es lo único que distingue esta
    // vista de la de locales (2026-09-13).
    //
    // Lo vio el dueño en su teléfono: escribió «Hola buenas» y recibió
    // «🔎 Esto encontré para *Quiero comer pizza*» — la búsqueda de antes,
    // repintada. Dos veces seguidas, porque lo intentó otra vez.
    //
    // La diferencia con la lista de locales no es de estilo: la cabecera de
    // una categoría («🍕 Pizzerías · elige un local») solo dice DÓNDE estás,
    // pero la de una búsqueda AFIRMA QUE PREGUNTASTE ALGO. Repintarla ante un
    // «hola» le atribuye al cliente una frase que no escribió, y desde su
    // lado se lee como que el bot no lo escuchó — que es justo el reproche
    // que `esSaludo` nació para evitar.
    //
    // Un saludo es «empecemos», así que se le devuelve la portada CON la
    // bienvenida. No se pierde nada: el carrito vive por local y aquí todavía
    // no hay ninguno elegido.
    const repetir = verResultados(vista.consulta, negocios, vista.pagina)
    if (esSaludo(mensaje)) return verCategorias(categorias, 0, true)
    // Repintado sin mensaje (una foto, un audio): no hay nada que reprochar y
    // tampoco una frase nueva que atribuirle, así que se queda donde estaba.
    // Un «ok» o un «gracias» tampoco: el cliente contesta, no se equivoca.
    if (repintar || esConversacion(mensaje)) return repetir
    return { ...repetir, reply: `${reproche(mensaje)}\n\n${repetir.reply}`, noEntendido: true }
  }

  if (vista.vista === 'negocios' && vista.categoria) {
    const categoria = categorias.find(c => c.code === vista.categoria)
    // La categoría dejó de tener locales mientras el cliente miraba.
    if (!categoria) return verCategorias(categorias, 0)

    // ⚠️ EL MISMO ORDEN que al pintar, o el cliente toca el tercero y recibe
    // otro: `verNegocios` y `verResultados` bajan los cerrados al final, así
    // que aquí hay que paginar sobre esa misma lista para resolver qué tocó.
    const { mostrados, hayMas, opciones } = paginar(
      abiertosPrimero(negocios), vista.pagina, etiquetaNegocio,
    )
    const elegida = elegir(mensaje, [
      ...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER,
    ])

    if (elegida === VOLVER) return verCategorias(categorias, 0)
    if (elegida === VER_MAS) return verNegocios(categoria, negocios, vista.pagina + 1)

    const negocio = mostrados.find(n => etiquetaNegocio(n) === elegida)
    if (negocio) {
      return {
        reply: '',
        options: [],
        negocioElegido: negocio,
        vista: { vista: 'negocios', categoria: categoria.code, pagina: vista.pagina },
      }
    }
    const repetir = verNegocios(categoria, negocios, vista.pagina)
    // Un saludo a media navegación tampoco es un error: se repinta la lista
    // donde estaba. Aquí NO se saluda con «Bienvenido a Umbani» — el cliente
    // ya está dentro de una categoría, y darle la bienvenida otra vez leería
    // como si hubiera vuelto al principio.
    if (repintar || esSaludo(mensaje) || esConversacion(mensaje)) return repetir
    return { ...repetir, reply: `${reproche(mensaje)}\n\n${repetir.reply}`, noEntendido: true }
  }

  // ── Las categorías con algo abierto (2026-09-27) ────────────────────
  //
  // Se eligen sobre la lista que SE LE ENSEÑÓ (`vista.codigos`), no sobre la
  // portada: un «2» es la segunda de esta lista.
  if (vista.vista === 'abiertos') {
    const abiertas = (vista.codigos || [])
      .map(code => categorias.find(c => c.code === code))
      .filter((c): c is MarketplaceCategory => Boolean(c))
    // Sus categorías ya no existen: la portada, sin reproche.
    if (!abiertas.length) return verCategorias(categorias, 0)

    const { mostrados, hayMas, opciones } = paginar(abiertas, vista.pagina, etiquetaCategoria)
    const elegida = elegir(mensaje, [...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER])
    const repetir = pintarAbiertas(abiertas, vista.pagina, ABIERTAS_AL_REPINTAR)

    if (elegida === VOLVER) return verCategorias(categorias, 0)
    if (elegida === VER_MAS) return pintarAbiertas(abiertas, vista.pagina + 1, ABIERTAS_AL_REPINTAR)

    const categoria = mostrados.find(c => etiquetaCategoria(c) === elegida)
      ?? categoriaEscrita(mensaje, categorias)
    if (categoria) {
      return { reply: '', options: [], vista: { vista: 'negocios', categoria: categoria.code, pagina: 0 } }
    }
    // Lo mismo que en la portada: un saludo es «empecemos», un «ok» se
    // contesta, y lo demás quizá es una búsqueda («quiero pizza»).
    if (esSaludo(mensaje)) return verCategorias(categorias, 0, true)
    if (repintar || esConversacion(mensaje)) return repetir
    return { ...repetir, reply: `${reproche(mensaje)}\n\n${repetir.reply}`, noEntendido: true }
  }

  // Estamos en la portada.
  const { mostrados, hayMas, opciones } = paginar(categorias, vista.pagina, etiquetaCategoria)
  const elegida = elegir(mensaje, [...opciones, ...(hayMas ? [VER_MAS] : [])])

  if (elegida === VER_MAS) return verCategorias(categorias, vista.pagina + 1)

  const categoria = mostrados.find(c => etiquetaCategoria(c) === elegida)
    ?? categoriaEscrita(mensaje, categorias)
  if (categoria) {
    // El llamador aún no trae los locales de ESTA categoría: los pide y
    // vuelve a llamar. Se devuelve la vista para que sepa cuál consultar.
    return {
      reply: '',
      options: [],
      vista: { vista: 'negocios', categoria: categoria.code, pagina: 0 },
    }
  }
  // Repintado, o el primer «hola» de alguien que nunca ha escrito: en los dos
  // casos se le da la bienvenida, no un reproche.
  const saluda = esSaludo(mensaje)
  if (repintar || input.primerContacto || saluda) {
    return verCategorias(
      categorias, vista.pagina, Boolean(input.primerContacto) || saluda,
    )
  }
  // «Bueno», «ok», «gracias»: se le contesta, no se le reprocha — y tampoco
  // se busca un local con esa palabra (`noEntendido` es lo que dispara la
  // búsqueda en `marketplace-entry`).
  if (esConversacion(mensaje)) {
    return { ...verCategorias(categorias, vista.pagina), reply: ACUSE }
  }
  // ⚠️ Aquí NO se repite `PREGUNTA`, se explica (2026-09-06). «No te entendí.
  // ¿Qué deseas pedir?» deja al cliente sin saber qué esperaba el bot — y el
  // caso más común no es fallar una opción, es mandar una foto.
  const repetir = verCategorias(categorias, vista.pagina)
  return {
    ...repetir,
    reply: `${reproche(mensaje)}\n\n${GUIA}`,
    noEntendido: true,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EL COMANDO MENÚ Y EL BLOQUEO DE FLUJO
//
// Un cliente atiende UN pedido a la vez. Si está en El Puerto y escribe «ahora
// quiero pizza», cambiarlo de local en silencio le tira lo que llevaba: la
// mini app de El Puerto se le queda abierta con un carrito que ya no lleva a
// ninguna parte.
//
// ⚠️ El bloqueo NO es un muro: se le dice qué tiene abierto y cómo salir. Un
// «no puedes» sin salida es peor que no bloquear.
//
// ⚠️ MENÚ se comprueba ANTES que ninguna otra intención, siempre. Es la única
// forma que tiene el cliente de salir de donde esté, así que no puede depender
// de en qué vista se encuentre — que es justo lo que lo volvería inútil el día
// que se atasque.
// ═══════════════════════════════════════════════════════════════════════════

const COMANDOS_MENU = [
  'menu', 'menú', 'inicio', 'empezar', 'empezar de nuevo', 'volver al menu',
  'volver al menú', 'reiniciar', 'cancelar', 'salir',
]

export const SI_REINICIAR = '✅ Empezar de nuevo'
export const NO_CONTINUAR = '↩️ Seguir mi pedido'

/**
 * ¿Es el comando global de volver al menú?
 *
 * Se compara sobre el texto normalizado —sin tildes, sin signos— porque quien
 * escribe «MENÚ!» o «menu» quiere exactamente lo mismo.
 */
export function esComandoMenu(mensaje: string): boolean {
  const texto = normalizar(mensaje).replace(/[^a-z0-9 ]/g, '').trim()
  if (!texto) return false
  return COMANDOS_MENU.some(comando => (
    normalizar(comando).replace(/[^a-z0-9 ]/g, '') === texto
  ))
}

export interface EstadoDeCompra {
  /** El local en el que está, si eligió uno. */
  negocio?: { name: string; slug: string } | null
  bloqueado: boolean
  /**
   * Ya pidió y debe la transferencia.
   *
   * Cambia lo que se le responde a «Seguir mi pedido»: a quien está a medio
   * armar el carrito se le dice que lo termine; a quien ya pidió, que mande la
   * foto. Decirle «termínalo» a un pedido terminado suena a que el bot no se
   * enteró — y es lo que pasaba hasta el 2026-09-04.
   */
  esperandoComprobante?: boolean
}

/**
 * Lo que se responde a MENÚ.
 *
 * ⚠️ Con un pedido en marcha NO se borra nada sin preguntar. El cliente pudo
 * escribir «menú» buscando ayuda, no queriendo tirar lo que llevaba — y la
 * mini app de ese local sigue abierta en su teléfono.
 */
export function responderAlMenu(
  estado: EstadoDeCompra,
  categorias: MarketplaceCategory[],
): MarketplaceReply {
  // ⚠️ MENÚ VA DIRECTO, SIEMPRE (decisión del dueño, 2026-09-05).
  //
  // Hasta ahora preguntaba «¿empezar de nuevo o seguir?» en cuanto había un
  // local elegido. El dueño lo probó y lo dijo con razón: «se supone que MENÚ
  // mata todo proceso, es la palabra clave y más fuerte».
  //
  // ⚠️ Y la pregunta era además FALSA en el caso más común. El candado se pone
  // al ELEGIR el local, antes de que exista ningún pedido: el dueño eligió
  // Monster Pizza, recibió el enlace, escribió MENÚ y le contestó «tienes un
  // pedido en proceso» **sin tener ninguno**. Comprobado contra producción: 0
  // pedidos abiertos. Se le pedía confirmar el descarte de algo que no existía.
  //
  // ⚠️ Y el propio mensaje del enlace dice «Para volver al inicio, escribe
  // MENÚ». Prometer una salida y luego pedir permiso es lo que hace que la
  // gente deje de creerse los textos.
  //
  // La pregunta NO desaparece: sigue saliendo ante cualquier OTRA cosa —otro
  // texto, una foto—, que es cuando de verdad hace falta avisar de que hay
  // algo abierto. Ver `recordarPedidoEnProceso` y `recordarComprobantePendiente`.
  //
  // ⚠️ Quien llega aquí con un pedido sin pagar lo tiene CANCELADO por el
  // llamador, no caducado: escribir MENÚ es avisar, y avisar no puede costar
  // una falta. El riesgo que queda —quien transfirió y aún no mandó la foto—
  // se le expuso al dueño antes de decidir.
  //
  // ⚠️ Y se saluda DE VUELTA (2026-09-06). Quien escribe MENÚ vuelve al
  // inicio, no navega: recibía «¿Qué deseas pedir?» a secas, que es lo que el
  // dueño describió como «una pregunta simple» al probarlo. No cuesta un
  // mensaje más — la línea viaja dentro del mismo envío que las categorías.
  return verCategorias(categorias, 0, 'vuelta')
}

/**
 * Lo que se responde a quien intenta empezar otra cosa con un pedido abierto.
 *
 * Se le dice DÓNDE lo tiene y CÓMO salir, en el mismo mensaje: cada respuesta
 * se paga, así que no se gasta una en decir solo «no».
 */
export function recordarPedidoEnProceso(
  negocio: { name: string },
  /**
   * `true` cuando solo hay un local elegido y todavía NINGÚN pedido.
   *
   * ⚠️ Sin esto el mensaje mentía: el candado se pone al elegir el local, así
   * que a quien acababa de recibir el enlace se le decía «tienes un pedido en
   * proceso» sin tener ninguno. Comprobado contra producción el 2026-09-05.
   */
  sinPedidoTodavia = false,
): MarketplaceReply {
  return {
    reply: (sinPedidoTodavia
      ? `Estás pidiendo en *${negocio.name}*.\n\n`
      : `Tienes un pedido en proceso en *${negocio.name}*.\n\n`)
      + 'Termínalo, o elige empezar de nuevo aquí abajo 👇',
    // ⚠️ Antes decía «escribe *MENÚ*» y no ofrecía nada. Escribir MENÚ llevaba
    // a una pregunta que MENÚ no podía responder, así que el cliente se quedaba
    // dando vueltas. Ahora se le dan las dos salidas, que es lo que de verdad
    // resuelve — y siguen siendo las mismas dos de la confirmación.
    options: [SI_REINICIAR, NO_CONTINUAR],
    vista: { vista: 'confirmando_reinicio', pagina: 0 },
  }
}

/**
 * Lo que ve quien escribe DEBIENDO un comprobante.
 *
 * ⚠️ `recordarPedidoEnProceso` dice «Termínalo», y a quien debe una foto eso
 * no le dice nada: su pedido ya está hecho, lo que falta es la captura. Desde
 * el 2026-08-30 el candado dura hasta que el comprobante llega, así que este
 * mensaje es el que más va a leerse — y tiene que decir las DOS cosas: qué
 * falta, y cómo salir si prefiere pedir en otro sitio.
 *
 * ⚠️ **SIN BOTONES desde el 2026-09-27**, igual que `recordarPagoEnRevision`.
 * Llevaba «✅ Empezar de nuevo» como PRIMER botón, y un toque por error
 * cancelaba el pedido. Lo vio el dueño con el texto que precarga la mini app
 * —«Hola, te envío el comprobante de mi pedido #N»—: quien lo manda está a
 * punto de pagar o ya pagó, y quien transfirió sin mandar aún la foto se ve
 * igual que quien no pagó nada. El segundo botón tampoco servía aquí: «Seguir
 * mi pedido» repetía esta misma instrucción en un mensaje que se paga.
 *
 * ⚠️ La salida sigue NOMBRADA —MENÚ, que cancela sin contar una falta—: quien
 * no piensa pagar tiene que saber que puede irse avisando. Solo deja de estar
 * en un botón que se toca sin leer.
 *
 * ⚠️ La vista NO es `confirmando_reinicio`: con ella, un «1» escrito o tocado
 * de un mensaje anterior seguiría leyéndose como «Empezar de nuevo».
 */
export function recordarComprobantePendiente(
  negocio: { name: string },
): MarketplaceReply {
  return {
    reply: `Tienes un pedido en *${negocio.name}* esperando tu comprobante.\n\n`
      + 'Mándanos aquí la foto de tu transferencia —a tu nombre— y el local empieza a '
      + 'prepararlo 📸\n\n'
      + 'Si prefieres dejarlo y pedir en otro local, escribe *MENÚ*.',
    options: [],
    vista: { vista: 'negocios', pagina: 0 },
  }
}

/**
 * Lo que ve quien YA mandó su comprobante y espera al local.
 *
 * ⚠️ Es un TERCER mensaje, y hace falta: `recordarComprobantePendiente` le
 * pide una foto que esta persona acaba de mandar, y `recordarPedidoEnProceso`
 * le dice «termínalo» a un pedido que ya terminó. Los dos suenan a que el bot
 * no se enteró.
 *
 * ⚠️ **Sin los botones de reinicio, a diferencia de los otros dos.** Aquí ya
 * hay dinero transferido: ofrecer «✅ Empezar de nuevo» a un toque de distancia
 * invita a abandonar un pedido pagado, y eso no tiene vuelta atrás. Quien de
 * verdad quiera salir escribe MENÚ, que sigue preguntándole antes de tirar
 * nada — la salida existe, solo que no está en un botón que se toca sin leer.
 */
export function recordarPagoEnRevision(
  negocio: { name: string },
): MarketplaceReply {
  return {
    reply: `🧾 Tu pedido en *${negocio.name}* está en revisión.\n\n`
      + 'El local está comprobando tu pago y te avisamos aquí mismo en cuanto '
      + 'empiece a prepararlo 👨‍🍳\n\n'
      + 'Mientras tanto no hace falta que hagas nada.',
    options: [],
    vista: { vista: 'negocios', pagina: 0 },
  }
}

/**
 * La respuesta a la confirmación de reinicio.
 *
 * ⚠️ `continua` NO es lo contrario de `reinicia`: son TRES respuestas, no dos.
 * «Empezar de nuevo» reinicia, «Seguir mi pedido» continúa, y cualquier otra
 * cosa no es ninguna de las dos —se vuelve a preguntar—. Quien llama necesita
 * distinguir la segunda de la tercera para devolverle el enlace solo a quien
 * dijo que sigue; deducirlo de `options.length === 0` funcionaba, pero ataba
 * una decisión de flujo a cuántos botones lleva un mensaje.
 */
export function resolverReinicio(
  mensaje: string,
  estado: EstadoDeCompra,
  categorias: MarketplaceCategory[],
): { reinicia: boolean; continua: boolean; respuesta: MarketplaceReply } {
  const elegida = elegir(mensaje, [SI_REINICIAR, NO_CONTINUAR])

  if (elegida === SI_REINICIAR) {
    // Vuelve al inicio igual que MENÚ, así que se le saluda igual: son la
    // misma puerta, una tocada y otra escrita.
    return {
      reinicia: true,
      continua: false,
      respuesta: verCategorias(categorias, 0, 'vuelta'),
    }
  }
  if (elegida === NO_CONTINUAR) {
    // ⚠️ Lo que falta NO es lo mismo según dónde esté (2026-09-04). A quien ya
    // pidió y debe la transferencia, «termina tu pedido cuando quieras» le
    // suena a que el bot no se enteró — el pedido está terminado, lo que falta
    // es la foto. Lo vivió el dueño: pidió por la mini app, escribió «hola» y
    // recibió ese texto con el enlace de la carta.
    //
    // ⚠️ Y se le nombra MENÚ como salida, a propósito: quien no piensa pagar
    // tiene que saber que puede irse diciéndolo, porque irse avisando cancela
    // el pedido y no le cuesta una falta. Callarlo empuja al abandono
    // silencioso, que es justo lo que se quiere evitar.
    const debeComprobante = estado.esperandoComprobante === true
    return {
      reinicia: false,
      continua: true,
      respuesta: {
        reply: !estado.negocio
          ? 'Perfecto 👍'
          : debeComprobante
            ? `Tu pedido en *${estado.negocio.name}* está esperando tu comprobante.\n\n`
              + 'Mándanos aquí la foto de tu transferencia —*a tu nombre*— y el '
              + 'local empieza a prepararlo 📸\n\n'
              // ⚠️ Decía «escribe MENÚ y te pregunto antes de soltarlo», y
              // dejó de ser verdad el 2026-09-05: MENÚ va DIRECTO y cancela
              // (decisión del dueño, ver `responderAlMenu`). Prometer una
              // pregunta que no llega es justo lo que hace que la gente deje
              // de creerse los textos (corregido el 2026-09-27).
              + 'Si prefieres dejarlo, escribe *MENÚ*.'
            : `Perfecto, sigues en *${estado.negocio.name}*. Termina tu pedido cuando quieras 👍`,
        options: [],
        vista: { vista: 'negocios', pagina: 0 },
      },
    }
  }
  // No entendió: se repite la pregunta, no se decide por él. Tirar un carrito
  // por un «ok» ambiguo es lo único que no tiene vuelta atrás.
  //
  // ⚠️ UN SALUDO NO ES UNA TONTERÍA (2026-09-03). «Hola» recibía «Eso no lo
  // pude entender», y el dueño lo dijo probándolo: «un hola se puede entender».
  // Se entiende perfectamente — lo que pasa es que no responde a la pregunta.
  // Se le recuerda dónde está en vez de reprocharle, que es lo mismo que ya
  // hacía el menú desde el 2026-08-25 y que aquí faltaba.
  //
  // ⚠️ El reproche NO desaparece: «asdfghjkl» lo sigue recibiendo. Lo que se
  // separa es «escribió algo que no toca» de «escribió cualquier cosa».
  const saluda = esSaludo(mensaje)
  const conversa = esConversacion(mensaje)
  const cabecera = (saluda || conversa) && estado.negocio
    ? `Estás pidiendo en *${estado.negocio.name}*.`
    : saluda
      ? '👋 ¡Hola!'
      : conversa
        ? '🙂 ¡Listo!'
        : reproche(mensaje)
  return {
    reinicia: false,
    continua: false,
    respuesta: {
      reply: `${cabecera}\n\n¿Empezamos de nuevo o sigues con tu pedido?`,
      options: [SI_REINICIAR, NO_CONTINUAR],
      vista: { vista: 'confirmando_reinicio', pagina: 0 },
    },
  }
}
