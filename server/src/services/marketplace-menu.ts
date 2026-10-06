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

export const VER_MAS = '➡️ Ver más'
export const VOLVER = '⬅️ Volver'
export const PAGINA = 9

const SALUDO = '👋 ¡Hola! Bienvenido a *Umbani*.'

/**
 * La bienvenida de quien VUELVE al inicio: MENÚ y «✅ Empezar de nuevo».
 *
 * ⚠️ Es un texto aparte del `SALUDO` a propósito. «Bienvenido a Umbani» se le
 * dice a quien llega; a quien ya está dentro y vuelve al inicio se le reconoce
 * que vuelve. Hasta el 2026-09-06 escribir MENÚ devolvía «¿Qué deseas pedir?»
 * a secas, y el dueño lo dijo probándolo: sonaba «como una pregunta simple»,
 * sin nada delante.
 *
 * ⚠️ NO cuesta un mensaje de más. Va dentro del mismo envío que la lista de
 * categorías —la línea de más es texto, no otro mensaje—, así que el motivo
 * que tenía escrito la prueba («sería un mensaje que se paga») no era cierto.
 * Lo que sí se evita es saludar en mitad de la navegación: ver `verCategorias`.
 */
const REGRESO = '👋 ¡Qué bueno tenerte de vuelta en *Umbani*!'

const PREGUNTA = '¿Qué deseas pedir?'

/**
 * La portada cuando el cliente NO eligió de la lista.
 *
 * ⚠️ Dice qué se puede hacer aquí, no solo que se falló. `PREGUNTA` a secas
 * detrás de un reproche deja al cliente sin saber por qué su mensaje no valía
 * —sobre todo si mandó una foto—, y este chat solo hace una cosa: llevar al
 * local correcto.
 */
const GUIA = 'Por este chat se pide en *Umbani*: elige una categoría y te llevo al local 👇'

/**
 * Lo que se le dice a quien escribió algo que no es un local, ni un plato, ni
 * una opción de la lista.
 *
 * ⚠️ Decía «🙏 Eso no lo pude entender» hasta el 2026-09-24, y el dueño lo
 * vio escribiendo «Bueno»: «no es una palabra rara, es una palabra en español
 * que existe». Tenía razón — sí se entiende; lo que pasa es que por aquí no se
 * puede hacer nada con ella. Así que se dice ESO, sin atribuir el fallo a lo
 * que escribió el cliente. Las palabras de conversación de verdad («bueno»,
 * «ok», «gracias») ni siquiera llegan aquí: ver `esConversacion`.
 */
const NO_ENTENDI = '🙏 Con eso no te puedo ayudar por aquí.'

/**
 * El acuse de quien contesta «bueno», «ok» o «gracias» estando en la portada.
 * No es un error: es conversación. Se le recuerda qué hacer sin regañarle.
 */
const ACUSE = '🙂 ¡Listo! Cuando quieras pedir, elige una categoría y te llevo al local 👇'

/**
 * Lo que se responde a un mensaje que NO es texto.
 *
 * ⚠️ Estas claves son los marcadores literales que pone `inbound-webhook.ts`
 * cuando llega una foto, un audio o una ubicación al número del marketplace y
 * no hay nada que hacer con ellos (sin pedido esperando pago, la media ni
 * siquiera se descarga). Antes caían aquí como texto cualquiera y recibían el
 * mismo «no te entendí» que un «asdfghjkl»: el dueño mandó una foto probando y
 * lo vio. Decirle a alguien que no se le entendió cuando lo que hizo fue
 * mandar una foto perfectamente clara es de las cosas que hacen que una app
 * parezca tonta — misma lección que `marketplaceKnownTerm` con «pollo».
 *
 * ⚠️ Van SIN reproche: no se equivocó de opción, mandó algo que este chat
 * todavía no usa. Y lo que sigue —la guía o la lista donde estaba— le dice qué
 * sí puede hacer.
 */
/**
 * Lo que llega en lugar de un toque en una lista VIEJA (2026-09-26).
 *
 * `marketplace-entry` lo pone cuando la marca del toque no es la de la última
 * lista enviada. Viaja como un adjunto más a propósito: así hereda lo que ya
 * hacen la foto y el audio —NO se busca, NO se ejecuta nada, y se repinta la
 * pantalla ACTUAL con sus opciones—, que es justo lo que hace el chat de Luka
 * que el dueño puso de referencia: solo vale el último mensaje.
 */
export const OPCION_ANTERIOR = '[opción anterior]'

/**
 * La ADVERTENCIA del primer toque viejo (2026-09-28, decisión del dueño).
 *
 * Antes solo avisaba —«aquí van las de ahora»— y el cliente seguía tocando
 * listas viejas: la segunda vez el anti-eco callaba y el chat parecía colgado.
 * Ahora dice lo que pasa si lo repite, porque lo siguiente es la pausa.
 *
 * ⚠️ «de ESTE mensaje»: la advertencia trae su propia lista, y eso convierte
 * en vieja la que el cliente tenía justo encima aunque fuera idéntica.
 */
export const ADVERTENCIA_OPCION_VIEJA = '⚠️ Esa opción era de un mensaje anterior. '
  + 'Usa solo las opciones de *este* mensaje: si vuelves a tocar una vieja, no '
  + 'podrás pedir durante 5 minutos.'

const ADJUNTOS = new Map<string, string>([
  ['[opcion anterior]', ADVERTENCIA_OPCION_VIEJA],
  ['[foto]', '📷 Recibí tu foto, pero por aquí no me sirve todavía.'],
  ['[nota de voz]', '🎤 Recibí tu nota de voz, pero por aquí todavía no puedo escucharla.'],
  ['[ubicacion]', '📍 Recibí tu ubicación, pero ahora mismo no me hace falta.'],
])

/** Sin acentos ni mayúsculas: el cliente escribe «pizzerias» y también vale. */
const normalizar = (valor: string): string => String(valor || '')
  .trim()
  .toLocaleLowerCase('es')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')

/**
 * Los saludos que abren una conversación. No son opciones equivocadas.
 *
 * ⚠️ Nace de un fallo real: un cliente escribía «Hola» y recibía «🙏 No te
 * entendí. Elige una opción de la lista». La bienvenida existía, pero solo se
 * daba en el PRIMER mensaje de alguien que nunca había escrito —y como la
 * conversación no vence ni la borra nadie, el cliente que VUELVE (que es el
 * que más vale) recibía el reproche para siempre.
 */
const PALABRAS_DE_SALUDO = new Set([
  'hola', 'ola', 'holi', 'holis', 'hey', 'ey', 'alo', 'hello', 'hi',
  'buenas', 'buenos', 'buen', 'dia', 'dias', 'tarde', 'tardes', 'noche',
  'noches', 'saludos', 'que', 'tal', 'como', 'estas', 'feliz',
])

/** Un saludo suelto no puede ocupar media conversación. */
const MAX_PALABRAS_DE_SALUDO = 4

/**
 * Las palabras con las que la gente CONTESTA por WhatsApp sin pedir nada:
 * «bueno», «ok», «gracias», «listo», «sí». No son un saludo ni un error.
 *
 * ⚠️ Nace del 2026-09-24: el dueño escribió «Bueno» y recibió «Eso no lo pude
 * entender». Se exige, como con los saludos, que TODAS las palabras sean de
 * estas —se admiten saludos mezclados: «ok gracias», «hola bueno»—, así que
 * «bueno quiero pizza» sigue siendo una búsqueda.
 */
const PALABRAS_DE_CONVERSACION = new Set([
  'bueno', 'buena', 'ok', 'okey', 'okay', 'oki', 'okis', 'vale', 'dale', 'listo',
  'lista', 'perfecto', 'perfecta', 'genial', 'excelente', 'super', 'chevere',
  'bacan', 'bien', 'muy', 'gracias', 'grax', 'grasias', 'mil', 'muchas',
  'muchisimas', 'de', 'nada', 'igualmente', 'si', 'no', 'ya', 'claro',
  'entendido', 'entiendo', 'jaja', 'jajaja', 'jeje', 'ah', 'oh', 'mmm',
])

/**
 * ¿El mensaje es SOLO un saludo?
 *
 * ⚠️ Se exige que TODAS sus palabras sean de saludo, no que contenga una.
 * Así «hola buenas noches» se reconoce entero —que es como saluda la gente—
 * mientras que «hola quiero pizza» sigue siendo una BÚSQUEDA: tratarla como
 * saludo le devolvería la portada en vez de buscarle su pizza. Es el mismo
 * criterio que `esComandoMenu`, que tampoco se dispara con una frase que
 * solo contiene la palabra.
 *
 * Las letras estiradas del final se recortan («holaaa», «buenasss»): es como
 * se saluda de verdad por WhatsApp.
 */
const palabrasSueltas = (mensaje: string): string[] => {
  const texto = normalizar(mensaje)
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!texto) return []
  const palabras = texto.split(' ')
  if (palabras.length > MAX_PALABRAS_DE_SALUDO) return []
  // Las letras estiradas del final («holaaa», «graciasss», «okkk»).
  return palabras.map(palabra => palabra.replace(/(.)\1+$/, '$1'))
}

export function esSaludo(mensaje: string): boolean {
  const palabras = palabrasSueltas(mensaje)
  return palabras.length > 0 && palabras.every(palabra => PALABRAS_DE_SALUDO.has(palabra))
}

/**
 * ¿El mensaje es SOLO conversación («bueno», «ok gracias», «siii»)?
 *
 * Un saludo puro NO cuenta aquí —ese tiene su propia respuesta, la
 * bienvenida—; lo que se reconoce es al menos una palabra de conversación y
 * ninguna que no lo sea.
 */
export function esConversacion(mensaje: string): boolean {
  const palabras = palabrasSueltas(mensaje)
  return palabras.some(palabra => PALABRAS_DE_CONVERSACION.has(palabra))
    && palabras.every(palabra => (
      PALABRAS_DE_CONVERSACION.has(palabra) || PALABRAS_DE_SALUDO.has(palabra)
    ))
}

/**
 * Lo que se le dice a quien mandó algo que este chat no usa, en vez del
 * reproche de siempre.
 *
 * Devuelve `null` cuando el mensaje es texto de verdad — entonces manda
 * `NO_ENTENDI`. Se compara sobre el texto NORMALIZADO, así que las claves van
 * sin tilde aunque el marcador real sea «[ubicación]».
 */
const textoDeAdjunto = (mensaje: string): string | null => (
  ADJUNTOS.get(normalizar(mensaje)) ?? null
)

/**
 * ¿Lo que llegó fue una foto, un audio o una ubicación en vez de texto?
 *
 * ⚠️ Lo usa `marketplace-entry` para NO mandar «[foto]» a la búsqueda de
 * locales. Eran dos consultas a la base —la búsqueda y el diccionario de
 * términos— por cada foto suelta, y ninguna de las dos puede encontrar nada:
 * el marcador no es algo que el cliente quiera comer.
 */
export const esAdjuntoSinTexto = (mensaje: string): boolean => (
  textoDeAdjunto(mensaje) !== null
)

/** Con qué se abre la portada: nada, la bienvenida, o el «de vuelta». */
const cabecera = (saludar: boolean | 'vuelta'): string => (
  saludar === 'vuelta' ? `${REGRESO}\n\n` : saludar ? `${SALUDO}\n\n` : ''
)

/**
 * Lo que se le dice a quien manda una foto TENIENDO local elegido y sin pedido.
 *
 * ⚠️ Es distinto del texto del menú, y por eso no se reutiliza: allí el cliente
 * está eligiendo local y basta con «por aquí no me sirve»; aquí ya está dentro
 * de un local y lo que necesita saber es que **su foto no es un comprobante
 * porque todavía no ha pedido nada**. Sin esa mitad, quien manda una captura
 * puede creer que acaba de pagar.
 *
 * Devuelve `null` cuando el mensaje es texto de verdad: entonces manda el
 * recordatorio de siempre, sin nada delante.
 */
export const textoDeAdjuntoRecibido = (mensaje: string): string | null => {
  const clave = normalizar(mensaje)
  // ⚠️ También dentro de un local (2026-09-28): el siguiente toque viejo es la
  // pausa, y nadie puede llegar a ella sin haber leído la advertencia. Hasta
  // hoy aquí salía el recordatorio a secas, sin decir que la opción era vieja.
  if (clave === '[opcion anterior]') return ADVERTENCIA_OPCION_VIEJA
  if (clave === '[foto]') {
    return '📷 Recibí tu foto, pero todavía no es un comprobante: aún no has '
      + 'hecho tu pedido.'
  }
  if (clave === '[nota de voz]') {
    return '🎤 Recibí tu nota de voz, pero por aquí todavía no puedo escucharla.'
  }
  if (clave === '[ubicacion]') {
    return '📍 Recibí tu ubicación. Te la pediré al finalizar el pedido, no antes.'
  }
  return null
}

/** El encabezado del «no casó con la lista», según lo que llegó. */
const reproche = (mensaje: string): string => textoDeAdjunto(mensaje) ?? NO_ENTENDI

const etiquetaCategoria = (categoria: MarketplaceCategory): string => (
  categoria.emoji ? `${categoria.emoji} ${categoria.label}` : categoria.label
)

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

const etiquetaNegocio = (negocio: MarketplaceBusiness): string => (
  noSePuedePedir(negocio) ? `${LUNA} ${negocio.name}` : negocio.name
)

/**
 * Los abiertos primero, y entre iguales se respeta el orden que trajo la base.
 *
 * ⚠️ `sort` en JavaScript es estable desde ES2019, así que esto NO revuelve
 * los locales: solo baja los cerrados al final. Y los de estado desconocido
 * cuentan como abiertos, que es el lado que no cuesta ventas.
 */
const abiertosPrimero = (locales: MarketplaceBusiness[]): MarketplaceBusiness[] => (
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
function paginar<T>(todos: T[], pagina: number, etiqueta: (item: T) => string) {
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
function categoriaEscrita(
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
const ABIERTAS_AL_REPINTAR = 'Estas categorías tienen locales abiertos ahora.'

/** La lista de categorías con algo abierto, paginada como cualquier otra. */
const pintarAbiertas = (
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
