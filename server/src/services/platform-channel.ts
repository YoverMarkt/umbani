import { normalizeChannelIdentifier } from '../types/channels'
import type { WhatsAppChannelAddress } from '../types/channels'

/**
 * El canal del marketplace: UN número de WhatsApp para toda la plataforma.
 *
 * Hasta el 2026-08-20 el número ERA la llave de enrutado: cada negocio tenía
 * el suyo y `getBusinessByChannel` respondía «este mensaje es de tal local».
 * Con un número único esa pregunta ya no tiene respuesta en el número, así
 * que estas credenciales no pueden vivir en `businesses` — no son de ningún
 * local. Viven en `server_settings`, que es la tabla de la plataforma.
 *
 * Vive aparte para que el webhook, el envío y el enrutado no se inventen
 * cada uno su versión de «¿este número es el nuestro?», que es exactamente
 * como se acaba con dos respuestas distintas a la misma pregunta.
 */

interface ModuloSettings {
  get(key: string): Promise<string | null>
}
const settings: ModuloSettings = require('./settings') as typeof import('./settings')

export interface PlatformChannel {
  apiKey: string
  number: string
  webhookSecret: string | null
  endpointId: string | null
}

/**
 * Las credenciales del número de la plataforma, o `null` si no está
 * configurado.
 *
 * ⚠️ Exige API key Y número juntos: con solo uno de los dos el canal no
 * puede ni enviar ni reconocerse a sí mismo, y media configuración que
 * parece válida es peor que ninguna — fallaría más tarde y más lejos.
 */
export const getPlatformChannel = async (): Promise<PlatformChannel | null> => {
  // Un fallo leyendo `server_settings` devuelve «no configurado», que es el
  // comportamiento de antes de que la plataforma existiera: el mensaje se
  // descarta. Dejar que lance tumbaría el webhook ENTERO —incluidos los
  // negocios con número propio, que no tienen nada que ver con esto— y ese
  // es exactamente el fallo que dejó el canal mudo cinco días en julio.
  const leidas = await Promise.all([
    settings.get('platform_ycloud_api_key'),
    settings.get('platform_ycloud_number'),
    settings.get('platform_webhook_secret'),
    settings.get('platform_webhook_endpoint_id'),
  ]).catch(() => null)
  if (!leidas) return null
  const [apiKey, rawNumber, webhookSecret, endpointId] = leidas
  const number = normalizeChannelIdentifier('phone', rawNumber)
  if (!apiKey?.trim() || !number) return null
  return {
    apiKey: apiKey.trim(),
    number,
    webhookSecret: webhookSecret?.trim() || null,
    endpointId: endpointId?.trim() || null,
  }
}

/**
 * El número público del marketplace, y NADA MÁS.
 *
 * Existe para que las credenciales no se acerquen a una ruta pública.
 * `getPlatformChannel` devuelve también la API Key de YCloud y el signing
 * secret; pasar ese objeto a algo que termina en un `res.json()` es cómo se
 * filtra una credencial sin que nadie lo note en la revisión. Aquí solo sale
 * el teléfono.
 *
 * ⚠️ Devuelve el número SOLO si el canal está completo, porque hereda la
 * comprobación de `getPlatformChannel` (número **y** API Key). Y eso es lo
 * que se quiere: con el número configurado pero sin credenciales, ese
 * WhatsApp no recibe ni contesta nada. Mandar ahí a un cliente es peor que no
 * darle ningún número — se quedaría escribiéndole a un buzón mudo.
 */
export const getPlatformPhone = async (): Promise<string | null> =>
  (await getPlatformChannel())?.number ?? null

/**
 * ¿Alguna de estas direcciones es el número de la plataforma?
 *
 * Se compara SIEMPRE normalizado: el mismo número llega como `+593…` desde
 * un proveedor y como `593…` desde otro, y comparar en crudo daría «no» a
 * dos escrituras del mismo teléfono. Es el mismo motivo por el que
 * `getLastOrderForContact` busca por variantes.
 *
 * Solo mira direcciones de tipo `phone`: un `account_id` de Meta no es un
 * número y compararlo con uno daría siempre falso, pero por accidente.
 */
export const esNumeroDePlataforma = (
  addresses: WhatsAppChannelAddress[],
  platformNumber: string,
): boolean => addresses.some(address => (
  address.identifierType === 'phone'
  && normalizeChannelIdentifier('phone', address.identifier) === platformNumber
))

interface CanalDeSalida {
  sendText(business: unknown, to: string, text: string): Promise<void>
  sendInteractive(
    business: unknown,
    to: string,
    body: string,
    options: { id: string; title: string; description?: string }[],
    listButtonText?: string,
  ): Promise<boolean>
  sendLinkButton(
    business: unknown,
    to: string,
    message: { body: string; url: string; label: string; footer?: string | null },
  ): Promise<boolean>
  sendTyping(business: unknown, inboundId?: string | null): Promise<void>
}

/** El marcador que `conCanalDePlataforma` cambia por las credenciales reales. */
const MARCADOR = { id: null, whatsapp_provider: 'marketplace' }

/**
 * El id que viaja con cada fila de la lista.
 *
 * ⚠️ El id es el NÚMERO de la fila (1, 2, 3…) y no `opt_N`, que era lo que se
 * mandaba hasta el 2026-09-07. `ycloudContent` solo aprovecha el id si es un
 * número de uno o dos dígitos, así que con `opt_0` caía SIEMPRE al título — y
 * WhatsApp lo recorta a 20 caracteres en un botón y 24 en una fila de lista.
 * Con nombres reales de carta («Pollo en salsa de champiñones», 29) la opción
 * se volvía IMPOSIBLE de elegir tocándola. El menú entiende números desde el
 * primer día; solo había que mandárselos.
 *
 * ⚠️ SALVO cuando alguna fila ya ES un número, y esto sí es una trampa: en las
 * pantallas de «¿cuántos?» los títulos son `0`, `1`, `2`… Ahí el id por
 * posición choca con el título — tocar la primera fila de `[0][1][2]` mandaría
 * un «1» que se leería como la cantidad 1 en vez de 0. En esas listas se
 * conserva `opt_N`, que hace caer la resolución al título, y no se pierde
 * nada: un título de un dígito no lo recorta nadie.
 */
export const idsDeFila = (
  options: OpcionDeSalida[],
  marca?: string | null,
): { id: string; title: string; description?: string }[] => {
  const titulos = options.map(tituloDe)
  const hayNumeros = titulos.some(titulo => /^\d{1,2}$/.test(titulo.trim()))
  return options.map((opcion, indice) => ({
    // ⚠️ Con MARCA desde el 2026-09-26: «k3f9a.2» en vez de «2». El número
    // solo decía QUÉ FILA, no DE QUÉ LISTA, y un toque en una lista vieja se
    // aplicaba a la pantalla de ahora — «Minimarkets» (fila 3 de la portada)
    // acabó buscando «3», y «Jugos y batidos» entregó la carta de Monster
    // Pizza. La marca la guarda `marketplace-entry` y la compara al volver.
    id: hayNumeros
      ? `opt_${indice}`
      : marca ? `${marca}.${indice + 1}` : String(indice + 1),
    title: tituloDe(opcion),
    ...(typeof opcion === 'string' || !opcion.description
      ? {}
      : { description: opcion.description }),
  }))
}

/**
 * Una opción de salida: el título solo, o título + descripción.
 *
 * ⚠️ La descripción se PERDÍA hasta el 2026-09-07: el marketplace aplanaba
 * todo a títulos con `optionTitle`, así que el precio de cada producto —que
 * viaja ahí— no llegaba nunca al cliente. Una fila de lista admite 24
 * caracteres de título y 72 de descripción; renunciar a la segunda es tirar
 * tres cuartas partes del espacio que WhatsApp da para explicar la opción.
 */
export type OpcionDeSalida = string | { title: string; description?: string }

const tituloDe = (opcion: OpcionDeSalida): string => (
  typeof opcion === 'string' ? opcion : opcion.title
)

/**
 * Manda un mensaje por el número de la plataforma.
 *
 * El «negocio» que se pasa es solo el marcador `marketplace`:
 * `conCanalDePlataforma` (integrations/whatsapp.ts) lo cambia por las
 * credenciales reales. Así el envío del marketplace no duplica la lógica de
 * envío ni conoce las claves.
 *
 * ⚠️ `id: null` a propósito: un mensaje de antes de elegir local no se le
 * cobra a ningún negocio. `recordOutboundUsage` con negocio nulo no escribe
 * nada, que es exactamente lo que debe pasar — el consumo es de la
 * plataforma, y cargárselo a un local elegido después sería inventarle gasto.
 *
 * ⚠️ Si la lista interactiva falla se cae a TEXTO con las opciones numeradas.
 * Quedarse sin respuesta es peor que responder sin botones, y `elegir()` del
 * menú acepta que el cliente escriba la opción.
 */
export const enviarPorLaPlataforma = async (
  to: string,
  reply: string,
  options: OpcionDeSalida[] = [],
  /** La marca de esta lista. Sin ella, las filas llevan solo su número. */
  marca?: string | null,
): Promise<void> => {
  // `require` diferido: `integrations/whatsapp` importa este módulo, así que
  // un import arriba cerraría el ciclo al arrancar.
  const whatsapp = require('../integrations/whatsapp') as CanalDeSalida
  const negocio = { id: null, whatsapp_provider: 'marketplace' }

  if (options.length) {
    const enviada = await whatsapp.sendInteractive(
      negocio,
      to,
      reply,
      idsDeFila(options, marca),
      'Ver opciones',
    )
    if (enviada) return
    // El respaldo en texto también lleva la descripción: si el interactivo
    // no sale, el cliente sigue necesitando ver el precio.
    const listado = options.map((opcion, i) => {
      const detalle = typeof opcion === 'string' ? '' : opcion.description
      return `${i + 1}. ${tituloDe(opcion)}${detalle ? ` — ${detalle}` : ''}`
    }).join('\n')
    await whatsapp.sendText(negocio, to, `${reply}\n\n${listado}`)
    return
  }
  await whatsapp.sendText(negocio, to, reply)
}

/**
 * El enlace de la tienda, como BOTÓN nativo de WhatsApp.
 *
 * ⚠️ Una URL cruda en el chat ocupa tres líneas, se parte en pantallas
 * estrechas y se lee como publicidad — la gente no la toca. El botón dice lo
 * mismo con una línea y un toque, y es como se manda por el canal propio desde
 * el 2026-08-12. El marketplace seguía mandando la URL pelada: `sendLinkButton`
 * y `storefrontInviteButton` existían y **nadie los llamaba desde aquí**.
 *
 * ⚠️ Devuelve `false` en vez de lanzar, y quien llama cae al TEXTO de siempre.
 * Un botón que no sale no puede costar el enlace: sin enlace no hay pedido.
 *
 * ⚠️ La etiqueta la recorta YCloud a 20 BYTES (`clipBytes`). «Ver la carta»
 * son 12; un emoji ahí gastaría cuatro de golpe, y por eso el adorno se queda
 * en el cuerpo, que admite 1024.
 */
export const enviarEnlacePorLaPlataforma = async (
  to: string,
  mensaje: { body: string; url: string; label: string; footer?: string | null },
): Promise<boolean> => {
  const whatsapp = require('../integrations/whatsapp') as CanalDeSalida
  try {
    return await whatsapp.sendLinkButton(MARCADOR, to, mensaje)
  } catch {
    return false
  }
}

/**
 * El visto azul y el «escribiendo…» del número de Umbani.
 *
 * ⚠️ El marketplace NO los mandaba: `sendTyping` —que hace las dos cosas— solo
 * lo llamaba `bot-entry`, el camino de los negocios con canal propio. Quien
 * escribía a Umbani veía su mensaje con un solo tic hasta que llegaba la
 * respuesta, que en un chat de venta se lee como «no me están leyendo».
 *
 * ⚠️ Best-effort de verdad: `sendTyping` no lanza —resuelve el canal dentro de
 * su propio `try` y usa `allSettled`—, pero se envuelve igual. Ningún adorno
 * puede impedir que se conteste.
 */
export const marcarLeidoPorLaPlataforma = async (
  inboundId?: string | null,
): Promise<void> => {
  if (!inboundId) return
  const whatsapp = require('../integrations/whatsapp') as CanalDeSalida
  try {
    await whatsapp.sendTyping(MARCADOR, inboundId)
  } catch { /* el visto azul nunca puede costar la respuesta */ }
}
