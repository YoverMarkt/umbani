import type { MarketplaceCategory } from './marketplace-menu'

// Los textos del chat y cómo se lee lo que escribe el cliente (saludo, conversación, adjuntos).
// Una parte del menú del marketplace (`marketplace-menu.ts`), separada el
// 2026-10-07 cuando aquel archivo pasó de 1.000 líneas. Solo pide TIPOS a
// `marketplace-menu.ts` —que la reexporta—: así no hay ciclo al cargar.

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

export const PREGUNTA = '¿Qué deseas pedir?'

/**
 * La portada cuando el cliente NO eligió de la lista.
 *
 * ⚠️ Dice qué se puede hacer aquí, no solo que se falló. `PREGUNTA` a secas
 * detrás de un reproche deja al cliente sin saber por qué su mensaje no valía
 * —sobre todo si mandó una foto—, y este chat solo hace una cosa: llevar al
 * local correcto.
 */
export const GUIA = 'Por este chat se pide en *Umbani*: elige una categoría y te llevo al local 👇'

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
export const ACUSE = '🙂 ¡Listo! Cuando quieras pedir, elige una categoría y te llevo al local 👇'

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
export const normalizar = (valor: string): string => String(valor || '')
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
export const cabecera = (saludar: boolean | 'vuelta'): string => (
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
export const reproche = (mensaje: string): string => textoDeAdjunto(mensaje) ?? NO_ENTENDI

export const etiquetaCategoria = (categoria: MarketplaceCategory): string => (
  categoria.emoji ? `${categoria.emoji} ${categoria.label}` : categoria.label
)
