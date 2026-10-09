import type { MarketplaceCategory, MarketplaceBusiness, MarketplaceView, MarketplaceReply } from './marketplace-menu'
import { VER_MAS, VOLVER, PAGINA, PREGUNTA, normalizar, cabecera, etiquetaCategoria } from './marketplace-menu-textos'

// Las pantallas del chat: categorías, locales, resultados, los abiertos y los avisos.
// Una parte del menú del marketplace (`marketplace-menu.ts`), separada el
// 2026-10-07 cuando aquel archivo pasó de 1.000 líneas. Solo pide TIPOS a
// `marketplace-menu.ts` —que la reexporta—: así no hay ciclo al cargar.

/**
 * Cómo se lee un local en la lista.
 *
 * ⚠️ El cerrado lleva una LUNA delante y nada más, y esa es toda la libertad
 * que hay: WhatsApp recorta los títulos a 20 caracteres, y un título recortado
 * es un título IMPOSIBLE DE ELEGIR — pasó con «✅ Sí, empezar de nuevo», que
 * volvía cortado y no casaba con nada, dejando al cliente en bucle. Un emoji
 * cabe; «· Cerrado» no. La hora de apertura va en el TEXTO del mensaje, que no
 * tiene ese límite.
 */
const LUNA = '🌙'

/**
 * No se puede pedir aquí ahora: o el local está cerrado, o su carta de esta
 * hora está vacía. Para el cliente son la misma noticia, así que se pintan
 * igual — y las dos llevan su motivo en el cuerpo del mensaje.
 */
const noSePuedePedir = (negocio: MarketplaceBusiness): boolean => (
  negocio.abierto === false || negocio.con_carta === false
)

export const etiquetaNegocio = (negocio: MarketplaceBusiness): string => (
  noSePuedePedir(negocio) ? `${LUNA} ${negocio.name}` : negocio.name
)

/**
 * Los abiertos primero, y entre iguales se respeta el orden que trajo la base.
 *
 * ⚠️ `sort` en JavaScript es estable desde ES2019, así que esto NO revuelve
 * los locales: solo baja los cerrados al final. Y los de estado desconocido
 * cuentan como abiertos, que es el lado que no cuesta ventas.
 */
export const abiertosPrimero = (locales: MarketplaceBusiness[]): MarketplaceBusiness[] => (
  locales.slice().sort((a, b) => (
    Number(noSePuedePedir(a)) - Number(noSePuedePedir(b))
  ))
)

/**
 * La línea que dice a qué hora abren los cerrados de esta pantalla.
 *
 * Va en el cuerpo del mensaje porque ahí no hay límite de caracteres, y solo
 * nombra a los que se están viendo: prometer horarios de locales que no están
 * en la lista es ruido.
 */
/**
 * «08:00» → «8:00 AM». Es como se dice una hora en Ecuador y Colombia, y es lo
 * mismo que enseña la mini app: el cliente ve el mismo formato en los dos
 * sitios. Una hora que no se entiende se devuelve tal cual — mejor «08:00» que
 * un «NaN:00 AM» delante del cliente.
 */
const hora12 = (hhmm: string): string => {
  const partes = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim())
  if (!partes) return String(hhmm || '')
  const horas = Number(partes[0].slice(0, 2))
  if (!Number.isInteger(horas) || horas < 0 || horas > 23) return String(hhmm)
  const doce = horas % 12 === 0 ? 12 : horas % 12
  return `${doce}:${partes[2]} ${horas < 12 ? 'AM' : 'PM'}`
}

const avisoDeCerrados = (mostrados: MarketplaceBusiness[]): string => {
  const cerrados = mostrados.filter(noSePuedePedir)
  if (!cerrados.length) return ''
  return `\n\n${cerrados.map(lineaDeCerrado).join('\n')}`
}

/**
 * Todos los locales de la página, no solo los cerrados (2026-09-26).
 *
 * ⚠️ Es para los RESULTADOS de una búsqueda. «Esto encontré para…» seguido
 * solo de los cerrados se leía como que había encontrado menos de los que
 * había: el dueño vio tres en la lista y dos en el texto, y preguntó por el
 * tercero. En una categoría no hace falta —su cabecera no promete una lista—,
 * y allí el texto sigue nombrando solo lo que hay que avisar.
 */
const listaDeLocales = (mostrados: MarketplaceBusiness[]): string => (
  mostrados.length
    ? `\n\n${mostrados.map(n => (noSePuedePedir(n) ? lineaDeCerrado(n) : `• ${n.name}`)).join('\n')}`
    : ''
)

const lineaDeCerrado = (n: MarketplaceBusiness): string => {
  // ⚠️ El local CERRADO manda sobre la carta: decirle «su carta empieza a
  // las 7» a quien tiene el local cerrado hasta mañana es prometer algo que
  // no va a poder hacer.
  if (n.abierto === false) {
    if (!n.abre?.open) return `${LUNA} ${n.name} · cerrado`
    const cuando = n.abre.inDays === 0
      ? 'hoy'
      : n.abre.inDays === 1 ? 'mañana' : `el ${n.abre.dayName.toLocaleLowerCase('es')}`
    return `${LUNA} ${n.name} · abre ${cuando} ${hora12(n.abre.open)}`
  }
  // Abierto, pero su carta de esta hora está vacía.
  return n.carta_desde
    ? `${LUNA} ${n.name} · su carta empieza ${hora12(n.carta_desde)}`
    : `${LUNA} ${n.name} · sin carta a esta hora`
}

/** El trozo de lista que toca, más «Ver más» si queda algo detrás. */
export function paginar<T>(todos: T[], pagina: number, etiqueta: (item: T) => string) {
  const desde = pagina * PAGINA
  const mostrados = todos.slice(desde, desde + PAGINA)
  const hayMas = todos.length > desde + PAGINA
  return { mostrados, hayMas, opciones: mostrados.map(etiqueta) }
}

/**
 * Casa lo que escribió el cliente contra las opciones ofrecidas.
 *
 * Acepta el texto exacto, el texto sin emoji, y el número de la fila — la app
 * de WhatsApp devuelve el título, pero mucha gente responde «3».
 */
export function elegir(mensaje: string, opciones: string[]): string | null {
  const texto = normalizar(mensaje)
  if (!texto) return null

  const posicion = Number.parseInt(texto, 10)
  if (Number.isInteger(posicion) && posicion >= 1 && posicion <= opciones.length) {
    return opciones[posicion - 1]
  }
  const exacta = opciones.find(opcion => normalizar(opcion) === texto)
  if (exacta) return exacta
  // Sin el emoji delante: «pizzerias» debe encontrar «🍕 Pizzerías».
  const porTexto = opciones.find((opcion) => {
    const limpia = normalizar(opcion).replace(/[^a-z0-9 ]/g, '').trim()
    return limpia === texto || (limpia.length > 2 && limpia.includes(texto))
  })
  if (porTexto) return porTexto

  // ⚠️ WHATSAPP RECORTA LOS TÍTULOS, y esto dejaba opciones IMPOSIBLES de
  // elegir. Un botón admite 20 caracteres: «✅ Sí, empezar de nuevo» son 22, así
  // que al tocarlo volvía «✅ Sí, empezar de nu…» y no casaba con nada. El
  // cliente tocaba el botón y recibía «no te entendí», una y otra vez.
  //
  // Se compara por PREFIJO, y solo si es inequívoco: con dos opciones que
  // empiecen igual no se adivina, se vuelve a preguntar.
  const recortado = texto.replace(/[…]+$/, '').replace(/\.{3,}$/, '').trim()
  if (recortado.length >= 4) {
    const candidatas = opciones.filter((opcion) => {
      const limpia = normalizar(opcion).replace(/[^a-z0-9 ]/g, '').trim()
      return limpia.startsWith(recortado) || normalizar(opcion).startsWith(recortado)
    })
    if (candidatas.length === 1) return candidatas[0]
  }
  return null
}

/**
 * La categoría que el cliente ESCRIBIÓ por su nombre, esté en la página que
 * esté.
 *
 * ⚠️ `elegir` solo mira las opciones de la página que se está viendo, y la
 * portada enseña 9. Con los locales de muestra hubo más de 9 categorías con
 * locales, y «Panaderías» y «Minimarkets» cayeron a la segunda página: quien
 * escribía su nombre desde la portada no las encontraba. Lo cazó el canario
 * cinco veces seguidas (2026-09-25), con los dos locales invisibles.
 *
 * ⚠️ Solo por NOMBRE, nunca por número: «3» es la tercera fila que el cliente
 * TIENE DELANTE, no la tercera de una página que no ve. Y se exige que sea
 * inequívoco: con dos categorías que empiezan igual se sigue preguntando —o
 * buscando—, como hacía antes.
 */
export function categoriaEscrita(
  mensaje: string,
  categorias: MarketplaceCategory[],
): MarketplaceCategory | null {
  const texto = normalizar(mensaje).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  if (texto.length < 4 || /^\d+$/.test(texto)) return null
  const limpia = (categoria: MarketplaceCategory) => normalizar(categoria.label)
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const exacta = categorias.find(categoria => limpia(categoria) === texto)
  if (exacta) return exacta
  // «panaderia» en singular, o «heladerias» sin «y postres».
  const porInicio = categorias.filter(categoria => limpia(categoria).startsWith(texto))
  return porInicio.length === 1 ? porInicio[0] : null
}

/**
 * La portada: las categorías que hoy tienen locales detrás.
 *
 * `saludar` tiene TRES estados, no dos (2026-09-06):
 *   · `false` — repintado normal. Es el de «⬅️ Volver» y el de una categoría
 *     que se quedó sin locales: el cliente no se ha ido a ninguna parte, y
 *     saludarlo ahí leería como si hubiera vuelto al principio.
 *   · `true` — llega por primera vez, o saludó. Recibe `SALUDO`.
 *   · `'vuelta'` — volvió al inicio a propósito (MENÚ, «✅ Empezar de nuevo»).
 *     Recibe `REGRESO`.
 */
export function verCategorias(
  categorias: MarketplaceCategory[],
  pagina = 0,
  saludar: boolean | 'vuelta' = false,
): MarketplaceReply {
  if (!categorias.length) {
    return {
      reply: '😔 Ahora mismo no tenemos locales disponibles. Vuelve a escribirnos en un rato.',
      options: [],
      vista: { vista: 'categorias', pagina: 0 },
    }
  }
  const { hayMas, opciones } = paginar(categorias, pagina, etiquetaCategoria)
  return {
    reply: `${cabecera(saludar)}${PREGUNTA}${pieDeCiudad(categorias)}`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : [])],
    vista: { vista: 'categorias', pagina },
  }
}

/**
 * El pie del menú cuando hay más de una ciudad: dónde está y cómo cambiarla.
 * Con una sola ciudad no se dice nada: no hay nada que cambiar.
 */
export function pieDeCiudad(categorias: MarketplaceCategory[]): string {
  const primera = categorias[0]
  return primera?.ciudad && primera.otrasCiudades
    ? `\n\n📍 Estás en *${primera.ciudad}*. Para ver otra ciudad, escribe *CIUDAD*.`
    : ''
}

/** Los locales de una categoría. */
export function verNegocios(
  categoria: MarketplaceCategory,
  negocios: MarketplaceBusiness[],
  pagina = 0,
): MarketplaceReply {
  if (!negocios.length) {
    // No debería pasar —la consulta solo devuelve categorías con locales—,
    // pero el último local pudo cerrar entre el menú y esta respuesta.
    return {
      reply: `😔 Justo ahora no hay locales abiertos en ${categoria.label}. Elige otra categoría 👇`,
      options: [VOLVER],
      vista: { vista: 'negocios', categoria: categoria.code, pagina: 0 },
    }
  }
  // ⚠️ Los abiertos primero (2026-09-03). Un local cerrado en lo alto de la
  // lista es el primero que toca el cliente, y el que peor puede acabar: mira
  // la carta, arma el pedido y se topa con el cierre al confirmar.
  const { mostrados, hayMas, opciones } = paginar(
    abiertosPrimero(negocios), pagina, etiquetaNegocio,
  )
  return {
    reply: `${etiquetaCategoria(categoria)}\n\nElige un local 👇${avisoDeCerrados(mostrados)}`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER],
    vista: { vista: 'negocios', categoria: categoria.code, pagina },
  }
}

/**
 * Lo que encontró la búsqueda. Un local es un local: se pintan igual que los
 * de una categoría, y al tocar uno se entra por el mismo camino.
 *
 * ⚠️ Se dice QUÉ se buscó («Esto encontré para "ceviche"»). Sin eso, una lista
 * suelta de locales después de escribir una frase parece que el bot cambió de
 * tema — sobre todo si el nombre del local no contiene la palabra buscada, que
 * es justo el caso para el que existen los alias y los trigramas.
 */
export function verResultados(
  consulta: string,
  negocios: MarketplaceBusiness[],
  pagina = 0,
): MarketplaceReply {
  const limpia = String(consulta || '').trim().slice(0, 60)
  // Misma regla que en la carta: los que atienden ahora, arriba.
  const { mostrados, hayMas, opciones } = paginar(
    abiertosPrimero(negocios), pagina, etiquetaNegocio,
  )
  return {
    reply: `🔎 Esto encontré para *${limpia}*:${listaDeLocales(mostrados)}`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER],
    vista: { vista: 'busqueda', consulta: limpia, pagina },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// «¿HAY LOCALES ABIERTOS?» (2026-09-27)
//
// El dueño lo preguntó a las 00:16 y recibió «🙏 Con eso no te puedo ayudar por
// aquí» con la búsqueda anterior repintada. Nadie reconocía la PREGUNTA,
// aunque todas las piezas para contestarla existían: el horario de cada local,
// «abre hoy 12:00 PM», las categorías.
//
// Lo que pidió, en su orden:
//   · primero preguntar QUÉ quiere comer, y según la hora — solo las
//     categorías que tienen algo abierto AHORA;
//   · si no hay NADA abierto en toda la app, decirlo, y enseñar los que abren
//     antes sin importar su categoría;
//   · «pizza» y el resto de búsquedas, como siempre.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ¿Pregunta qué hay abierto? «¿hay locales abiertos?», «qué está abierto»,
 * «quién atiende a esta hora», «qué abre ahora».
 *
 * ⚠️ «atiende» y «abre» solos NO bastan —«¿atienden a domicilio?» no pregunta
 * por la hora—: tienen que venir con una palabra de tiempo.
 */
export function esPreguntaPorAbiertos(mensaje: string): boolean {
  const texto = normalizar(mensaje).replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  // Una frase larga es otra cosa que casualmente dice «abierto».
  if (!texto || texto.split(' ').length > 12) return false
  if (/\babiert[oa]s?\b/.test(texto)) return true
  const deTiempo = /\b(ahora|hora|hoy|todavia|aun|ya|temprano)\b/.test(texto)
  return deTiempo && /\b(atiende|atienden|atendiendo|abre|abren)\b/.test(texto)
}

const ZONA = 'America/Guayaquil'

/** La hora de Ecuador (0–23), que es la que manda aquí. */
const horaDeEcuador = (ahora: Date): number => Number(
  new Intl.DateTimeFormat('en-US', { timeZone: ZONA, hour: 'numeric', hourCycle: 'h23' })
    .format(ahora),
) % 24

/**
 * Cómo se abre la respuesta según la hora: no es lo mismo preguntar a las
 * 00:16 que a mediodía.
 */
export function momentoDelDia(ahora = new Date()): string {
  const hora = horaDeEcuador(ahora)
  if (hora < 5) return '🌙 A esta hora de la madrugada'
  if (hora < 11) return '☀️ Para el desayuno'
  if (hora < 15) return '🍽️ Para el almuerzo'
  if (hora < 19) return '☕ Para la tarde'
  return '🌆 Para la cena'
}

const ABIERTAS_AHORA = 'estas categorías tienen locales abiertos ahora.'
/** Al repintar ya no se saluda por la hora: el cliente sigue en la misma lista. */
export const ABIERTAS_AL_REPINTAR = 'Estas categorías tienen locales abiertos ahora.'

/** La lista de categorías con algo abierto, paginada como cualquier otra. */
export const pintarAbiertas = (
  abiertas: MarketplaceCategory[],
  pagina: number,
  cabecera: string,
): MarketplaceReply => {
  const { hayMas, opciones } = paginar(abiertas, pagina, etiquetaCategoria)
  return {
    reply: `${cabecera}\n\n¿Qué te gustaría comer? 👇`,
    options: [...opciones, ...(hayMas ? [VER_MAS] : []), VOLVER],
    vista: { vista: 'abiertos', codigos: abiertas.map(c => c.code), pagina },
  }
}

/** Minutos hasta poder pedir, para ordenar a los que abren antes. */
const claveDeApertura = (negocio: MarketplaceBusiness): number | null => {
  const minutos = (hhmm: string): number => {
    const [h, m] = String(hhmm || '').split(':').map(Number)
    return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : Number.NaN
  }
  const clave = negocio.abierto === false
    ? (negocio.abre?.open ? negocio.abre.inDays * 1440 + minutos(negocio.abre.open) : Number.NaN)
    : (negocio.carta_desde ? minutos(negocio.carta_desde) : Number.NaN)
  return Number.isFinite(clave) ? clave : null
}

/** Cuántos de los que abren antes se nombran si no hay nada abierto. */
const PROXIMOS = 5

/**
 * La respuesta a «¿hay locales abiertos?».
 *
 * `negociosPorCategoria` trae los locales de CADA categoría ya marcados con su
 * horario — lo consulta el llamador, esta función no toca la base.
 */
export function verAbiertos(
  categorias: MarketplaceCategory[],
  negociosPorCategoria: Map<string, MarketplaceBusiness[]>,
  ahora = new Date(),
): MarketplaceReply {
  if (!categorias.length) return verCategorias(categorias, 0)
  // Mismo criterio que la luna de las listas: abierto Y con carta a esta hora.
  // Un «no lo sé» cuenta como abierto, que es el lado que no cuesta ventas.
  const abiertas = categorias.filter(categoria => (
    (negociosPorCategoria.get(categoria.code) || []).some(n => !noSePuedePedir(n))
  ))
  if (abiertas.length) {
    return pintarAbiertas(abiertas, 0, `${momentoDelDia(ahora)}, ${ABIERTAS_AHORA}`)
  }

  // ── Nada abierto en toda la app ────────────────────────────────────
  //
  // ⚠️ Se dice claro y se enseña cuándo SÍ: «no hay nada» a secas manda al
  // cliente a otra app. Los que abren antes van SIN importar su categoría, y
  // los botones son la portada de siempre: puede mirar cartas para luego.
  const unicos = new Map<string, MarketplaceBusiness>()
  for (const lista of negociosPorCategoria.values()) {
    for (const negocio of lista) unicos.set(negocio.id, negocio)
  }
  const proximos = [...unicos.values()]
    .map(negocio => ({ negocio, clave: claveDeApertura(negocio) }))
    .filter((x): x is { negocio: MarketplaceBusiness; clave: number } => x.clave !== null)
    .sort((a, b) => a.clave - b.clave)
    .slice(0, PROXIMOS)
    .map(x => x.negocio)
  const portada = verCategorias(categorias, 0)
  return {
    ...portada,
    reply: '🌙 Ahora mismo no tenemos locales abiertos.'
      + (proximos.length
        ? `\n\nLos primeros en abrir:\n${proximos.map(lineaDeCerrado).join('\n')}`
        : '')
      + '\n\nMientras tanto puedes mirar sus cartas 👇',
  }
}

/**
 * Lo que se le dice UNA vez al que cruza el techo de mensajes (2026-09-27).
 *
 * Hasta hoy se callaba sin más, y el dueño —probando con su teléfono— se quedó
 * escribiendo MENÚ a un chat mudo: lo leyó como que la app se colgó o que
 * WhatsApp lo frenaba. Se dice hasta cuándo, en hora de Ecuador, y que el
 * comprobante y los avisos del pedido SÍ siguen llegando, que es verdad.
 */
export function avisoDeSilencio(hasta: string, ahora = new Date()): string {
  const fin = new Date(hasta)
  const dia = (fecha: Date) => new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(fecha)
  const hhmm = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(fin)
  const cuando = Number.isNaN(fin.getTime())
    ? 'dentro de unas horas'
    : `${dia(fin) === dia(ahora) ? 'hoy' : 'mañana'} a las ${hora12(hhmm)}`
  return '⏸️ Recibimos muchos mensajes seguidos, así que pausamos las respuestas '
    + `un rato.\n\nVuelve a escribirnos desde ${cuando} 🙏\n\n`
    + 'Si tienes un pedido en curso, sus avisos te siguen llegando por aquí, y la '
    + 'foto de tu comprobante la recibimos igual.'
}

/**
 * Lo que se le dice UNA vez al que vuelve a tocar una opción vieja después de
 * la advertencia (2026-09-28): 5 minutos sin menú. Lo que llegue mientras
 * tanto no recibe respuesta —MENÚ tampoco la levanta—, salvo el comprobante
 * de un pedido ya hecho, que se atiende igual.
 */
export function avisoDePausaPorOpcionesViejas(hasta: string): string {
  const fin = new Date(hasta)
  const cuando = Number.isNaN(fin.getTime())
    ? 'dentro de 5 minutos'
    : `desde las ${hora12(new Intl.DateTimeFormat('en-GB', {
      timeZone: ZONA, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(fin))}`
  return '⏳ Volviste a tocar una opción de un mensaje anterior, así que '
    + 'pausamos tu pedido por el chat durante 5 minutos.\n\n'
    + `Podrás pedir de nuevo ${cuando} 🙏\n\n`
    + 'Si ya hiciste un pedido, la foto de tu comprobante la recibimos igual.'
}

// ── Insultos (2026-09-27) ─────────────────────────────────────────────────
//
// Los textos que pidió el dueño: advertencia la primera vez, bloqueo de 15
// días la segunda, y al volver, «te hemos desbloqueado». Ver
// `lib/malas-palabras.ts` y `register_insult`.

/** La primera vez: se le avisa de lo que pasará, sin atender el mensaje. */
export const ADVERTENCIA_POR_INSULTOS = '⚠️ Por favor, mantén el respeto: en *Umbani* '
  + 'tratamos a todos con respeto y esperamos lo mismo.\n\n'
  + 'Si vuelves a usar insultos o malas palabras, tu número se bloqueará '
  + 'automáticamente y no podrás pedir en Umbani durante 15 días.'

/**
 * La segunda: 15 días fuera. Se dice hasta cuándo —el plazo se cumple solo, así
 * que prometerlo no es mentir—.
 */
export function avisoDeBloqueoPorInsultos(hasta: string | null, ahora = new Date()): string {
  const fin = hasta ? new Date(hasta) : new Date(ahora.getTime() + 15 * 86_400_000)
  const fecha = Number.isNaN(fin.getTime())
    ? 'dentro de 15 días'
    : `el ${new Intl.DateTimeFormat('es-EC', {
      timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long',
    }).format(fin)}`
  return '🚫 Tu número quedó bloqueado por 15 días por usar insultos o malas palabras.\n\n'
    + `Podrás volver a pedir en Umbani desde ${fecha}.`
}

/** Al volver —caducó, o lo levantó el superadmin—, en su primer mensaje. */
export const TE_HEMOS_DESBLOQUEADO = '✅ Te hemos desbloqueado. Esperamos que '
  + 'mejores tu conducta.\n\n'
  + 'Si vuelve a pasar, tu número se bloqueará automáticamente.'

export interface PasoInput {
  /**
   * Lo que escribió el cliente.
   *
   * ⚠️ **Vacío significa REPINTAR, no «se equivocó»**. Al elegir una
   * categoría, `paso` devuelve una vista sin texto para que el llamador
   * consulte los locales y vuelva a llamar — y en esa segunda llamada el
   * mensaje ya se consumió, así que llega vacío. Tratarlo como una elección
   * fallida dejaba el menú en bucle: el cliente tocaba «🍕 Pizzerías», la
   * vista avanzaba bien a los locales… y encima le decía «no te entendí».
   */
  mensaje: string
  vista: MarketplaceView
  categorias: MarketplaceCategory[]
  /** Los locales de `vista.categoria`. El llamador los consulta. */
  negocios: MarketplaceBusiness[]
  /**
   * Primera vez que este cliente escribe al marketplace.
   *
   * ⚠️ Un «hola» NO es una opción equivocada. Sin esto, el primerísimo
   * mensaje de alguien que nunca ha escrito recibía «🙏 No te entendí» como
   * bienvenida a Umbani.
   */
  primerContacto?: boolean
}
