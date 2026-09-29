import { codigoEnElMensaje } from './sesion-app'
import {
  esComandoMenu,
  paso,
  recordarComprobantePendiente,
  recordarPagoEnRevision,
  recordarPedidoEnProceso,
  responderAlMenu,
  verCategorias,
  verNegocios,
  esAdjuntoSinTexto,
  textoDeAdjuntoRecibido,
  verResultados,
  resolverReinicio,
  esSaludo,
  esPreguntaPorAbiertos,
  verAbiertos,
  avisoDeSilencio,
  ADVERTENCIA_POR_INSULTOS,
  avisoDeBloqueoPorInsultos,
  TE_HEMOS_DESBLOQUEADO,
  OPCION_ANTERIOR,
  avisoDePausaPorOpcionesViejas,
  type MarketplaceBusiness,
  type MarketplaceCategory,
  type MarketplaceReply,
  type MarketplaceView,
} from './marketplace-menu'
import { isOutsideHours, proximaApertura } from './schedule'
import {
  enviosDelTurno,
  leerToque,
  menuEnPausa,
  queHacerConElToqueViejo,
  PAUSA_POR_OPCIONES_VIEJAS_MS,
} from './marketplace-envio'
import { contieneInsulto } from '../lib/malas-palabras'
import type { ScheduleRecord } from './schedule'
import {
  esComprobante, esComprobanteAmbiguo, esFotoQueNoEsComprobante,
  preguntaDeQueLocal, rechazoDelMarcador, RESPUESTA_COMPROBANTE,
  respuestaNoEsComprobante,
  comprobanteCuadra,
  esComprobanteQueNoCuadra,
  motivoDelDescuadre,
  RESPUESTA_COMPROBANTE_CUADRA,
  respuestaComprobanteNoCuadra,
} from './payment-proof-inbox'

/**
 * LA ENTRADA DEL MARKETPLACE
 *
 * Qué pasa cuando alguien escribe al número de Umbani. Es el eslabón que
 * faltaba: `marketplace-menu.ts` sabía armar cada pantalla y
 * `marketplace_conversations` sabía dónde está cada cliente, pero nadie los
 * llamaba — el menú estaba construido y desconectado.
 *
 * ⚠️ Sin IA, como todo lo que ve el cliente desde el 2026-08-21: cada texto
 * de aquí sale del código con datos de la base.
 *
 * ⚠️ El menú termina en el ENLACE del local, a propósito. La mini app ya sabe
 * hacer productos, opciones, carrito, dirección, pago y seguimiento; rehacer
 * ese camino en botones de WhatsApp sería una segunda implementación del
 * mismo flujo y un cuarto sitio donde el precio puede divergir.
 */

export interface MarketplaceEntryDatabase {
  /**
   * Inicio de sesión de la app (2026-09-28): verifica el código con el
   * REMITENTE de WhatsApp. Opcional: el simulador y el canario no lo tienen.
   */
  verifyAppLoginCode?(code: string, phone: string): Promise<boolean>
  /**
   * Los horarios de varios locales de una vez, para marcar cuáles están
   * cerrados en el menú. Opcional: sin ella la lista sale sin marcar, que es
   * como salía antes de 2026-09-03.
   */
  getSchedulesFor?(businessIds: string[]): Promise<Map<string, ScheduleRecord[]>>
  /**
   * Revoca los enlaces del cliente al salir —MENÚ o «Empezar de nuevo»— salvo
   * donde aún tenga un pedido esperando pago o en revisión. Lo decide la base
   * mirando los PEDIDOS (2026-09-27). Opcional: sin ella el enlace anterior
   * sigue vivo, que es como estaba antes del 2026-09-03.
   */
  revokeStorefrontSessionsOnExit?(customerId: string): Promise<number>
  /** Deja constancia de un paso del menú. Opcional: es un registro, no dinero. */
  logMarketplaceEvent?(evento: {
    customerId: string | null
    tipo: 'menu' | 'cajon' | 'busqueda' | 'local'
    categoryCode?: string | null
    businessId?: string | null
    consulta?: string | null
    resultados?: number | null
  }): Promise<void>
  resolveMarketplaceCustomer(phone: string): Promise<{ id: string; name: string | null }>
  getConversation(customerId: string): Promise<{
    current_state: string
    selected_business_id: string | null
    shopping_locked: boolean
    flow_state: Record<string, unknown> | null
    version: number
    /** La marca de la última lista enviada (2026-09-26). */
    menu_mark?: string | null
    /** La huella de la última respuesta y cuándo salió. */
    last_reply_hash?: string | null
    last_reply_at?: string | null
    /** Cuándo se le advirtió por tocar una opción vieja (2026-09-28). */
    stale_tap_warned_at?: string | null
    /** Hasta cuándo no se le atiende el menú. */
    menu_paused_until?: string | null
  } | null>
  advanceConversation(
    customerId: string,
    patch: {
      state?: string
      businessId?: string
      clearBusiness?: boolean
      shoppingLocked?: boolean
      flowState?: Record<string, unknown>
      clearFlow?: boolean
    },
    expectedVersion?: number,
  ): Promise<{ conflicto: boolean }>
  getMarketplaceCategories(): Promise<MarketplaceCategory[]>
  getMarketplaceBusinesses(code: string): Promise<MarketplaceBusiness[]>
  getBusinessById(id: string): Promise<{
    id: string
    name: string
    slug: string | null
    storefront_enabled?: boolean | null
    takes_orders?: boolean | null
    /** El tipo decide si se pide en el chat o por la mini app. */
    type?: string | null
  } | null>
  /**
   * ¿Se le contesta a este cliente, o ya se pasó del techo de la hora?
   *
   * Opcional para no romper a quien construya estas dependencias sin él —el
   * simulador, las pruebas—: sin la función se atiende, que es fallar abierto.
   */
  claimMarketplaceReply?(
    customerId: string,
    messageId?: string | null,
  ): Promise<{
    permitido: boolean
    respuestas: number
    /** Solo en el mensaje que CRUZA el techo: el único que se explica. */
    aviso?: boolean
    /** Hasta cuándo dura el silencio. */
    hasta?: string | null
  }>
  /**
   * Buscar locales en TODO el marketplace, sin IA.
   *
   * ⚠️ Estuvo CONSTRUIDA Y DESCONECTADA desde el 2026-08-21: tres capas
   * (alias, texto completo, trigramas), su migración y sus pruebas, y ni un
   * llamador fuera de su repositorio. «Quiero ceviche» caía en «no te
   * entendí» aunque la base supiera resolverlo.
   */
  searchMarketplaceBusinesses?(
    query: string,
    limite?: number,
  ): Promise<{ id: string; slug: string; name: string; type: string }[]>
  /**
   * ¿Lo que escribió es comida CONOCIDA, aunque hoy no la venda nadie?
   *
   * Distingue «no te entiendo» de «te entiendo, pero no lo tengo». Sin esto,
   * «pollo» y «asdfghjkl» recibían el mismo reproche — y «pollo» se entiende
   * perfectamente: lo que falta es un asadero dado de alta.
   */
  marketplaceKnownTerm?(query: string): Promise<{ code: string; label: string } | null>
  /**
   * Cancela el pedido sin pagar de esta persona en este local.
   *
   * Solo cuando el cliente dice que lo deja. Opcional: sin ella el pedido
   * caduca solo a los 15 minutos, que es lo que pasaba antes.
   */
  cancelUnpaidOrderOnPurpose?(businessId: string, customerId: string): Promise<number>
  /** ¿Este local bloqueó a este teléfono? */
  isContactBlocked?(businessId: string, phone: string): Promise<boolean>
  /**
   * ¿Toca EXPLICARLE el bloqueo? Devuelve `true` una sola vez.
   *
   * Sin esto el bloqueado recibía siempre el mismo mensaje neutro y nunca
   * sabía qué hizo mal. Avisarle en CADA intento tampoco vale: quien molesta
   * insiste, y entonces el bloqueado costaría más mensajes que un cliente.
   */
  claimBlockedNotice?(businessId: string, customerId: string): Promise<boolean>
  /**
   * ¿Está bloqueado en TODA la plataforma? Y si vuelve de un bloqueo por
   * insultos —caducó o lo levantó el superadmin—, ¿toca decírselo?
   *
   * Distinto del anterior: este lo pone el superadmin (o el chat, por
   * insultos) y significa que Umbani entero deja de atenderlo. El del local
   * solo cierra ese local. ⚠️ ESCRIBE: reclama el aviso de vuelta.
   */
  claimPlatformBlockState?(customerId: string): Promise<{
    bloqueado: boolean
    avisarDesbloqueo?: boolean
  }>
  /**
   * Un insulto: advertencia la primera vez, 15 días fuera la siguiente
   * (2026-09-27). ⚠️ ESCRIBE: el canario y el simulador la sustituyen.
   */
  registerInsult?(customerId: string): Promise<{
    accion: 'advertido' | 'bloqueado' | 'ya_bloqueado' | 'nada'
    hasta?: string | null
  }>
  /**
   * Apunta la marca de la lista que se va a mandar, y la huella de la
   * respuesta que salió. Opcionales: sin ellas el chat funciona como antes del
   * 2026-09-26. Ver `marketplace-envio.ts`.
   */
  marcarUltimaLista?(customerId: string, marca: string): Promise<boolean>
  anotarUltimaRespuesta?(customerId: string, huella: string): Promise<void>
  /**
   * Tocar opciones viejas tiene consecuencia (2026-09-28): la advertencia se
   * anota, y el segundo toque pausa el menú. ⚠️ ESCRIBEN: el canario y el
   * simulador las sustituyen. Sin `pausarElMenu` nunca se pausa: se advierte.
   */
  anotarAvisoDeOpcionVieja?(customerId: string): Promise<void>
  pausarElMenu?(customerId: string, hasta: string): Promise<boolean>
}

export interface MarketplaceEntryDeps {
  database: MarketplaceEntryDatabase
  /** Crea la sesión de tienda y devuelve el enlace. Null si no se pudo. */
  issueLink(input: {
    business: { id: string; slug: string | null; storefront_enabled?: boolean | null }
    phone: string
    name?: string | null
    force?: boolean
    /** Que SOLO quede vivo este enlace, incluso dentro del mismo local. */
    soloEste?: boolean
  }): Promise<string | null>
  /**
   * Manda la respuesta. Una opción puede ser texto o `{title, description}`:
   * el precio de un producto y el detalle de un reparto viajan en la
   * descripción, y una fila de lista de WhatsApp la pinta debajo del título.
   */
  send(
    reply: string,
    options: (string | { title: string; description?: string })[],
    /** La marca de esta lista: viaja en el id de cada opción. */
    marca?: string | null,
  ): Promise<void>
  /**
   * El enlace de la tienda como BOTÓN de WhatsApp.
   *
   * Opcional: si no está, o si devuelve `false`, se manda el texto de siempre.
   * Un botón que no sale no puede costar el enlace — sin enlace no hay pedido.
   */
  sendLink?(mensaje: {
    body: string
    url: string
    label: string
    footer?: string | null
  }): Promise<boolean>
  logger?: { log(...args: unknown[]): void }
}

/**
 * Los estados que escribía el PEDIDO POR CHAT, retirado el 2026-09-15.
 *
 * Ya nadie los escribe: todo local pide por su mini app. Se leen para que quien
 * se quedó a media compra con el código viejo no caiga en un motor que ya no
 * existe — se le trata como a quien tiene su enlace abierto (`en_local`).
 */
const ESTADOS_DEL_CHAT_RETIRADO = new Set([
  "pidiendo", "esperando_entrega", "esperando_ubicacion", "esperando_metodo_pago",
])

/** La vista guardada, o la portada si es el primer mensaje. */
const vistaDe = (flowState: Record<string, unknown> | null): MarketplaceView => {
  const guardada = flowState?.vista as MarketplaceView | undefined
  if (guardada && typeof guardada.vista === 'string' && typeof guardada.pagina === 'number') {
    return guardada
  }
  return { vista: 'categorias', pagina: 0 }
}

/**
 * Atiende un mensaje que llegó al número de la plataforma.
 *
 * El orden de las comprobaciones NO es casual:
 *
 *   1. MENÚ, siempre y en cualquier vista. Es la única salida del cliente, y
 *      hacerla depender de dónde está la volvería inútil justo el día que se
 *      atasque.
 *   2. La confirmación de reinicio, que es la única pregunta con consecuencia
 *      irreversible (tirar un carrito).
 *   3. El bloqueo de «un pedido a la vez».
 *   4. El menú normal.
 *
 * ⚠️ ESTA FUNCIÓN ERA DE 536 LÍNEAS y el 2026-09-19 se quedó en menos de 200.
 * Cada paso vive ahora en su propia función (`atenderComandoMenu`,
 * `atenderComprobante`, `atenderConfirmacionDeReinicio`, `atenderCandado`,
 * `recorrerElMenu`), y lo que queda aquí es solo el ORDEN en que se consultan.
 *
 * No se cambió ni una decisión al partirla: se movió código y se dejaron los
 * comentarios donde estaban. Lo que se gana es que el orden —que ES la lógica
 * de esta puerta, no una casualidad— pasó de vivir implícito en una pared de
 * código a estar a la vista y comprobado por un guardián
 * (`entrada-del-marketplace.test.js`).
 *
 * ⚠️ La numeración de los comentarios salta del 4 al 6: el paso 5 se perdió en
 * algún cambio anterior y no se renumera a propósito, porque los números se
 * citan en otros sitios. Que falte uno es, de hecho, la señal que destapó que
 * esta función ya no cabía en la cabeza de nadie.
 */
const SESION_DE_APP_INICIADA = '✅ Listo: ya iniciaste sesión en la app de Umbani con este número. '
  + 'Vuelve a la app para seguir.'
const CODIGO_DE_APP_VENCIDO = '⌛ Ese código ya no es válido. Pide uno nuevo en la app de Umbani.'

/**
 * El código para iniciar sesión en la app (2026-09-28).
 *
 * Va DESPUÉS de los tres frenos (bloqueo, techo, insultos): un bloqueado no
 * inicia sesión y el spam sigue frenado. Y ANTES del menú: el mensaje es para
 * la app, no para el chat — no mueve la conversación ni el candado. El
 * teléfono es el REMITENTE: lo prueba WhatsApp.
 */
async function atenderCodigoDeLaApp(deps: MarketplaceEntryDeps, text: string, from: string): Promise<boolean> {
  const codigo = codigoEnElMensaje(text)
  if (!codigo || !deps.database.verifyAppLoginCode) return false
  const valido = await deps.database.verifyAppLoginCode(codigo, from).catch(() => false)
  await deps.send(valido ? SESION_DE_APP_INICIADA : CODIGO_DE_APP_VENCIDO, [])
    .catch(() => { /* la app verá el resultado igual al preguntar */ })
  deps.logger?.log(`📱 [marketplace] código de la app ${valido ? 'verificado' : 'no válido'}`)
  return true
}

/**
 * ¿Está el menú de este cliente en PAUSA por tocar opciones viejas?
 * (2026-09-28)
 *
 * Quien volvió a tocar una opción vieja después de la advertencia no tiene
 * menú durante 5 minutos: ya se le dijo una vez hasta cuándo, y lo demás es
 * silencio. Decisión del dueño, como la regla de Luka que la sostiene.
 *
 * ⚠️ Se consulta ANTES que MENÚ, y a propósito: una pausa que se salta
 * escribiendo una palabra no frena a nadie.
 * ⚠️ EL COMPROBANTE SÍ pasa, igual que con el techo: quien ya pidió y manda
 * la foto de su pago no es a quien se está frenando.
 */
function menuPausado(
  deps: MarketplaceEntryDeps,
  conversation: { menu_paused_until?: string | null } | null,
  esMarcadorDeComprobante: boolean,
): boolean {
  if (esMarcadorDeComprobante || !menuEnPausa(conversation?.menu_paused_until)) return false
  deps.logger?.log('⏳ [marketplace] menú en pausa por opciones viejas: no se responde')
  return true
}

/**
 * El segundo toque viejo con la advertencia vigente: 5 minutos sin menú
 * (2026-09-28). Devuelve si pausó, y entonces el turno acaba aquí. El primero
 * no pasa por aquí: su ADVERTENCIA repinta lo de ahora como siempre, y
 * `conLaAdvertenciaAnotada` la apunta.
 *
 * ⚠️ El aviso sale ANTES de guardar la pausa. Al revés, un envío que falla
 * dejaría al cliente pausado sin saberlo —el reintento del webhook ya lo
 * encontraría en pausa y callaría—, que es justo el chat mudo que el dueño
 * vio y que esto viene a arreglar. Si lo que falla es guardar, se le avisó de
 * una pausa que no llega: lo peor es que pueda pedir antes.
 *
 * Sin `pausarElMenu` (el canario, el simulador) nunca se pausa: se advierte.
 */
async function pausarSiReincide(
  deps: MarketplaceEntryDeps,
  customerId: string,
  advertidoEn: string | null | undefined,
): Promise<boolean> {
  if (!deps.database.pausarElMenu || queHacerConElToqueViejo(advertidoEn) !== 'pausar') return false
  const hasta = new Date(Date.now() + PAUSA_POR_OPCIONES_VIEJAS_MS).toISOString()
  await deps.send(avisoDePausaPorOpcionesViejas(hasta), [])
  const pausado = await deps.database.pausarElMenu(customerId, hasta).catch(() => false)
  deps.logger?.log(pausado
    ? '⏳ [marketplace] segundo toque viejo: menú en pausa 5 minutos'
    : '⚠️ [marketplace] segundo toque viejo: no se pudo guardar la pausa')
  return true
}

/**
 * Los envíos de un turno con toque viejo, que anotan la ADVERTENCIA en cuanto
 * sale la primera respuesta.
 *
 * ⚠️ DESPUÉS de mandar, como la huella de #420: si el envío falla y el webhook
 * reintenta, el reintento no puede pausar a quien nunca leyó la advertencia.
 * La primera respuesta de un toque viejo ES la advertencia —con las opciones
 * de ahora—, venga del menú, del local o de la confirmación de reinicio.
 */
function conLaAdvertenciaAnotada(
  deps: MarketplaceEntryDeps,
  customerId: string,
): MarketplaceEntryDeps {
  const anotar = deps.database.anotarAvisoDeOpcionVieja
  if (!anotar) return deps
  const enviar = deps.send
  let pendiente = true
  return {
    ...deps,
    send: async (reply, options, marca) => {
      await enviar(reply, options, marca)
      if (!pendiente) return
      pendiente = false
      // Falla ABIERTO: sin la advertencia anotada, lo peor es advertir otra vez.
      await anotar(customerId).catch(() => undefined)
    },
  }
}

export async function handleMarketplaceMessage(
  input: {
    from: string
    text: string
    /** Id del mensaje entrante: hace idempotente el reclamo del techo. */
    inboundId?: string | null
  },
  deps: MarketplaceEntryDeps,
): Promise<void> {
  const { database } = deps
  const { from } = input
  let text = input.text

  const customer = await database.resolveMarketplaceCustomer(from)

  // ── 0. EL TECHO DE GASTO ───────────────────────────────────────────
  //
  // Va lo PRIMERO de todo salvo por el comprobante, y el orden es el punto: el
  // número de Umbani contesta a cada mensaje, y desde el 1 de octubre de 2026
  // cada respuesta se paga. Sin techo, quinientos mensajes son quinientos
  // mensajes pagados — y no hay local al que cargárselos, porque quien molesta
  // no ha elegido ninguno.
  //
  // ⚠️ EL COMPROBANTE SE CONTESTA AUNQUE ESTÉ SILENCIADO. Quien acaba de pagar
  // no es quien molesta, y dejarlo sin respuesta con el dinero ya transferido
  // es el peor momento posible para callarse. Es la misma excepción que ya hace
  // `bot-conversation.ts` en el canal propio.
  //
  // ⚠️ Va ANTES que MENÚ, a diferencia de todo lo demás. MENÚ es la salida del
  // cliente y por eso se comprueba antes que cualquier intención, pero si el
  // techo fuera después bastaría con escribir «MENÚ» sin parar para tener
  // respuestas gratis para siempre — que es justo lo que el techo evita.
  const esMarcadorDeComprobante = esComprobante(text)
    || esFotoQueNoEsComprobante(text)
    || esComprobanteAmbiguo(text)

  // ── 0a. Bloqueado en TODA la plataforma ────────────────────────────
  //
  // Va antes que el techo porque es más fuerte y más barato: ni se cuenta ni se
  // contesta. Lo pone el superadmin, no un dueño — el bloqueo de un local se
  // comprueba mucho más abajo, al elegir ese local, porque solo cierra ese.
  //
  // ⚠️ NUNCA se le avisa, ni siquiera al comprobante: quien está bloqueado en
  // la plataforma entera no tiene ningún pedido válido esperando, y responder
  // es la reacción que busca.
  //
  // ⚠️ Falla ABIERTO: un fallo de la base no puede dejar mudo al marketplace.
  const bloqueo = database.claimPlatformBlockState
    ? await database.claimPlatformBlockState(customer.id)
      .catch(() => ({ bloqueado: false, avisarDesbloqueo: false }))
    : { bloqueado: false, avisarDesbloqueo: false }
  if (bloqueo.bloqueado) {
    deps.logger?.log('⛔ [marketplace] contacto bloqueado en toda la plataforma: no se responde')
    return
  }

  // ── 0b. Vuelve de un bloqueo por insultos ──────────────────────────
  //
  // Se le dice en su PRIMER mensaje, no al desbloquear (2026-09-27): pasados
  // 15 días la ventana de 24 h de WhatsApp está cerrada y un mensaje libre no
  // llegaría. Ahora, que acaba de escribir, sí. La base ya lo reclamó: sale
  // una vez. Y su mensaje se atiende como siempre, justo después.
  if (bloqueo.avisarDesbloqueo) {
    await deps.send(TE_HEMOS_DESBLOQUEADO, [])
      .catch(() => { /* el aviso es cortesía: su mensaje se atiende igual */ })
  }

  if (!esMarcadorDeComprobante && database.claimMarketplaceReply) {
    // Falla ABIERTO: un fallo de la base no puede dejar mudo al marketplace.
    const reclamo = await database
      .claimMarketplaceReply(customer.id, input.inboundId ?? null)
      .catch(() => ({ permitido: true, respuestas: 0, aviso: false, hasta: null }))
    if (!reclamo.permitido) {
      // ⚠️ UNA vez, y solo al cruzar el techo (2026-09-27). Antes: ni una
      // palabra, «avisar cuesta justo el mensaje que se está ahorrando». Pero
      // callar siempre dejó al dueño —probando con su teléfono— escribiendo
      // MENÚ a un chat mudo, sin saber por qué ni hasta cuándo. El resto de
      // intentos siguen sin respuesta: el aviso lo marca la base, y es uno por
      // silencio (la misma regla que el aviso al bloqueado).
      if (reclamo.aviso && reclamo.hasta) {
        await deps.send(avisoDeSilencio(reclamo.hasta), [])
          .catch(() => { /* callar era lo de antes: un fallo aquí no rompe nada */ })
      }
      deps.logger?.log(`🔇 [marketplace] techo alcanzado (${reclamo.respuestas}): no se responde`)
      return
    }
  }

  // ── 0c. Insultos (2026-09-27) ──────────────────────────────────────
  //
  // DESPUÉS del techo —la advertencia se paga— y ANTES que MENÚ. El detalle
  // vive en `atenderInsulto`.
  if (!esMarcadorDeComprobante && await atenderInsulto(deps, text, customer.id)) return

  // El código de la app: DESPUÉS de los tres frenos y ANTES del menú.
  if (await atenderCodigoDeLaApp(deps, text, from)) return

  // ⚠️ A LA VEZ, no una tras otra (2026-09-25): conversación, categorías y el
  // local elegido son lecturas independientes, y cada ida a la base se paga
  // entera. El local sí depende de la conversación, así que se encadena a ella
  // sin esperar a las categorías.
  //
  // ⚠️ Pero DESPUÉS del bloqueo y del techo, nunca antes: a quien está
  // silenciado no se le gasta ni una consulta más. Lo fija
  // `techo-del-marketplace.test.js`, y es una de las capas anti-molestias.
  //
  // ⚠️ El local NO lleva `.catch` —a diferencia de `devolverElEnlace`— y la asimetría es
  // deliberada. Si aquí se fallara «abierto», `negocioActual` quedaría en
  // `null`, el paso 4 no entraría y quien tiene un pedido en curso podría abrir
  // OTRO: el candado de «un pedido a la vez» se saltaría justo cuando la base
  // no está para impedirlo. Propagando, el webhook reintenta cuando la base
  // vuelve — no se pierde el mensaje y el candado aguanta. El «falla abierto»
  // del bloqueo sí vale, porque equivocarse ahí solo atiende a alguien a quien
  // se debía ignorar.
  const conversacionLeida = database.getConversation(customer.id)
  const [conversation, categorias, negocioActual] = await Promise.all([
    conversacionLeida,
    database.getMarketplaceCategories(),
    conversacionLeida.then(leida => (leida?.selected_business_id
      ? database.getBusinessById(leida.selected_business_id)
      : null)),
  ])

  // ── Solo vale el ÚLTIMO mensaje (2026-09-26) ───────────────────────
  //
  // Cada opción lleva la marca de su lista. Un toque con otra marca viene de
  // un mensaje anterior: NO se ejecuta —se convierte en un aviso que repinta
  // lo de ahora—. Antes el número de fila se aplicaba a la pantalla actual:
  // «Minimarkets» acabó buscando «3» y «Jugos y batidos» entregó la carta de
  // Monster Pizza. Ver `marketplace-envio.ts`.
  //
  // ⚠️ Va DESPUÉS del bloqueo y del techo: a quien está silenciado no se le
  // contesta nada, tampoco el aviso. La PAUSA, antes que MENÚ: `menuPausado`.
  if (menuPausado(deps, conversation, esMarcadorDeComprobante)) return
  const toque = leerToque(text, conversation?.menu_mark)
  if (toque.vieja) deps.logger?.log('✋ [marketplace] toque en una lista vieja: no se ejecuta')
  text = toque.texto

  // Y los envíos de este turno salen con su marca y sin repetir la misma
  // respuesta de hace menos de 60 s: veinte fotos seguidas daban veinte
  // respuestas idénticas, y cada una se paga.
  deps = {
    ...deps,
    ...enviosDelTurno(deps, customer.id, {
      huella: conversation?.last_reply_hash,
      at: conversation?.last_reply_at,
    }),
  }

  // Tocar opciones viejas tiene consecuencia (2026-09-28): `pausarSiReincide`.
  if (toque.vieja && await pausarSiReincide(deps, customer.id, conversation?.stale_tap_warned_at)) return
  if (toque.vieja) deps = conLaAdvertenciaAnotada(deps, customer.id)
  const { send } = deps

  // Un marketplace sin un solo local disponible no puede ofrecer nada, y una
  // lista vacía es una calle sin salida que además cuesta un mensaje.
  if (!categorias.length) {
    await send(
      '🙏 Ahora mismo no hay locales disponibles. Vuelve a escribirnos en un rato.',
      [],
    )
    return
  }

  const estado = {
    negocio: negocioActual
      ? { name: negocioActual.name, slug: negocioActual.slug || '' }
      : null,
    bloqueado: Boolean(conversation?.shopping_locked),
    // Lo pone el disparador `orders_mark_awaiting_receipt` al crear el pedido,
    // venga de la mini app o del chat. Sin él, a quien ya pidió se le decía
    // «termina tu pedido» — el pedido estaba terminado y faltaba la foto.
    esperandoComprobante: conversation?.current_state === 'esperando_comprobante',
  }
  const vista = vistaDe(conversation?.flow_state ?? null)

  // ── 1. MENÚ, antes que nada ────────────────────────────────────────
  //
  // El detalle vive en `atenderComandoMenu`. Que se compruebe aquí arriba, y
  // no más abajo, es lo que hace que MENÚ funcione siempre.
  if (await atenderComandoMenu(deps, text, customer, {
    vista,
    estado,
    categorias,
    negocioElegidoId: conversation?.selected_business_id,
    estadoDeLaConversacion: conversation?.current_state,
    version: conversation?.version,
  })) return

  // ── 1b. La foto que ya se procesó como comprobante ─────────────────
  //
  // El detalle vive en `atenderComprobante`, justo debajo: son cuatro
  // marcadores con un orden que importa y no cabían aquí sin tapar el resto.
  if (await atenderComprobante(deps, text, {
    customerId: customer.id,
    version: conversation?.version,
    categorias,
  })) return

  // ── 2. ¿Estaba respondiendo a «¿tiro tu pedido?» ───────────────────
  //
  // El detalle vive en `atenderConfirmacionDeReinicio`: «Empezar de nuevo»
  // cancela y revoca; «Seguir mi pedido» devuelve el enlace sin tocar nada.
  if (await atenderConfirmacionDeReinicio(deps, from, text, customer, {
    vista,
    estado,
    categorias,
    negocioElegidoId: conversation?.selected_business_id,
    esperandoComprobante: estado.esperandoComprobante,
    estadoDeLaConversacion: conversation?.current_state,
    version: conversation?.version,
  })) return

  // ── 3. Lo que quedó a medio pedir POR CHAT, antes de esto ────────────
  //
  // El pedido por chat se retiró el 2026-09-15: todo local pide por su mini
  // app. Las conversaciones que estaban a media compra se migraron a
  // `en_local`, pero entre la migración y el despliegue el código viejo pudo
  // volver a escribir uno de esos estados. Se leen como `en_local`: se le
  // recuerda dónde está y «Seguir mi pedido» le devuelve su enlace. MENÚ, que
  // se comprueba mucho antes, sigue siendo la salida.
  const aMediasEnElChatViejo = ESTADOS_DEL_CHAT_RETIRADO.has(conversation?.current_state || '')

  // ── 4. Un pedido a la vez ──────────────────────────────────────────
  //
  // El detalle vive en `atenderCandado`: son tres textos según en qué punto
  // esté el pedido, y elegir mal deja al cliente dando vueltas.
  if (await atenderCandado(deps, text, {
    customerId: customer.id,
    bloqueado: estado.bloqueado,
    negocio: negocioActual,
    estadoDeLaConversacion: conversation?.current_state,
    version: conversation?.version,
    aMediasEnElChatViejo,
  })) return

  // ── 6 y 7. El menú, y la búsqueda si no casó ───────────────────────
  //
  // El detalle vive en `recorrerElMenu`. Va el ÚLTIMO a propósito: todo lo de
  // arriba tiene prioridad sobre el menú.
  await recorrerElMenu(deps, from, text, customer, {
    vista,
    categorias,
    negocioElegidoId: conversation?.selected_business_id,
    huboConversacion: Boolean(conversation),
    version: conversation?.version,
  })

}

/**
 * Marca cuáles de estos locales están atendiendo AHORA, y a qué hora abren.
 *
 * ⚠️ UNA sola consulta para todos (`getSchedulesFor`), no una por local: el
 * menú enseña hasta nueve por pantalla y esto está en el camino más transitado
 * de la app.
 *
 * ⚠️ El estado se calcula con `services/schedule.ts`, la MISMA función que usa
 * la mini app para decidir si acepta pedidos. Si el chat dijera «abierto» y la
 * tienda «cerrado», el cliente entraría a una carta que no le deja pedir — y
 * esa contradicción es justo la que se arregló esta semana.
 *
 * ⚠️ Falla ABIERTO: si la consulta revienta, los locales se quedan sin marcar
 * y la lista sale como salía antes. Marcar «cerrado» a un local que está
 * abierto por un fallo de la base le cuesta ventas de verdad; no marcarlo solo
 * le cuesta al cliente un viaje a la mini app, que además ya se lo dice.
 */
async function conEstadoDeHorario(
  deps: MarketplaceEntryDeps,
  negocios: MarketplaceBusiness[],
): Promise<MarketplaceBusiness[]> {
  if (!negocios.length || !deps.database.getSchedulesFor) return negocios
  const horarios = await deps.database
    .getSchedulesFor(negocios.map(n => n.id))
    .catch(() => null)
  if (!horarios) return negocios
  return negocios.map((negocio) => {
    const suyo = horarios.get(negocio.id)
    // Sin horario configurado el negocio NO bloquea la atención —es la regla
    // de `isOutsideHours`—, así que se deja sin marcar.
    if (!suyo?.length) return negocio
    const abierto = !isOutsideHours(suyo)
    return {
      ...negocio,
      abierto,
      abre: abierto ? null : proximaApertura(suyo),
    }
  })
}

/**
 * Qué hay abierto ahora, categoría por categoría.
 *
 * ⚠️ Los locales se piden con la MISMA consulta que pinta cada categoría, y el
 * horario con la MISMA función que usa la mini app (`conEstadoDeHorario`): si
 * aquí se dijera «abierto» y al tocar la categoría saliera con luna, el
 * cliente dejaría de creerse la lista.
 *
 * ⚠️ El horario va en UNA consulta para todos los locales, no una por
 * categoría. `con_carta` se conserva POR CATEGORÍA, que es como lo calcula la
 * base (los menús con reloj).
 *
 * ⚠️ Falla abierto: una categoría que no se pudo leer cuenta como vacía, y si
 * el horario no se pudo leer los locales cuentan como abiertos — es lo que ya
 * hace la lista normal.
 */
async function responderAbiertos(
  deps: MarketplaceEntryDeps,
  categorias: MarketplaceCategory[],
): Promise<MarketplaceReply> {
  const listas = await Promise.all(categorias.map(categoria => (
    deps.database.getMarketplaceBusinesses(categoria.code).catch(() => [] as MarketplaceBusiness[])
  )))
  const unicos = new Map<string, MarketplaceBusiness>()
  for (const lista of listas) for (const negocio of lista) unicos.set(negocio.id, negocio)
  const conHorario = new Map(
    (await conEstadoDeHorario(deps, [...unicos.values()])).map(n => [n.id, n]),
  )
  const porCategoria = new Map(categorias.map((categoria, i) => [
    categoria.code,
    listas[i].map((negocio) => {
      const marcado = conHorario.get(negocio.id)
      return marcado ? { ...negocio, abierto: marcado.abierto, abre: marcado.abre } : negocio
    }),
  ]))
  return verAbiertos(categorias, porCategoria)
}

/**
 * Los locales que casan con lo que escribió el cliente.
 *
 * ⚠️ Nunca lanza: la búsqueda es una MEJORA sobre «no te entendí», así que un
 * fallo suyo devuelve al cliente exactamente lo que recibía antes en vez de
 * dejarlo sin respuesta. `prep_min` va a null porque la RPC no lo devuelve y
 * el menú solo lo usa para pintar tiempos de la categoría.
 */
async function buscarLocales(
  deps: MarketplaceEntryDeps,
  consulta: string,
): Promise<MarketplaceBusiness[]> {
  const texto = String(consulta || '').trim()
  if (!texto || !deps.database.searchMarketplaceBusinesses) return []
  const hits = await deps.database
    .searchMarketplaceBusinesses(texto, 9)
    .catch(() => [])
  return hits.map(hit => ({
    id: hit.id, slug: hit.slug, name: hit.name, type: hit.type, prep_min: null,
  }))
}

/**
 * El cliente eligió local: se le entrega su enlace y ahí pide.
 *
 * ⚠️ AQUÍ YA NO SE DECIDE NADA, y conviene saber por qué había una decisión.
 * Hasta el 2026-09-15 esta función elegía entre dos formas de pedir —el menú
 * por chat o la mini app—, primero contando PRODUCTOS (la «regla de los 20») y
 * después por el TIPO del local, corrección del dueño del 2026-08-23:
 *
 *   «una pizzería puede tener 10 productos pero al momento de elegir tiene
 *    muchas opciones, así como una heladería puede tener 10 helados pero
 *    muchos sabores: eso son mini app. Pero un restaurante que ofrece
 *    almuerzos solo, queda pedir por WhatsApp.»
 *
 * El 2026-09-15 se retiró el pedido por chat del marketplace y el 2026-09-16
 * del canal propio: TODO local pide por su mini app. Con ello se fueron la
 * columna que decidía (`marketplace_category_types.pide_en_chat`), su función
 * en la base (`tipo_pide_en_chat`) y su gemela del panel (`PEDIDO_SIMPLE`).
 *
 * Lo que queda vigente del criterio es la lección, no la rama: la tienda
 * atiende cualquier catálogo y cualquier cantidad de opciones, mientras que un
 * menú de chat deja al cliente recorriendo listas interminables. Por eso el
 * camino que sobrevive es el que nunca es inusable.
 */
async function entregarLocal(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  negocio: MarketplaceBusiness,
  version: number | undefined,
  desdeElCajon: string | null = null,
): Promise<void> {
  const { database, logger } = deps
  apuntarPaso(deps, {
    customerId: customer.id, tipo: 'local', businessId: negocio.id,
    categoryCode: desdeElCajon,
  })

  // ── ¿Este local bloqueó a este cliente? ────────────────────────────
  //
  // El bloqueo YA le impedía pedir —la tienda responde 403 y el disparador
  // `orders_reject_blocked` rechaza la inserción—, pero hasta aquí el menú le
  // entregaba igualmente el enlace: el cliente armaba su carrito entero y
  // descubría el rechazo AL CONFIRMAR, que es el peor momento para enterarse.
  //
  // ⚠️ Es del LOCAL, no de la plataforma: bloquear en El Puerto no puede dejar
  // a nadie fuera de Umbani entero. Por eso se comprueba al elegir local y no
  // a la entrada — y por eso el resto del menú sigue igual para él.
  //
  // ⚠️ Se le explica UNA VEZ, y solo una (decisión del dueño, 2026-08-25).
  // Hasta esa fecha no se le decía NUNCA —quien pide para molestar busca una
  // reacción, y avisar cuesta el mensaje que el bloqueo ahorra—, pero callando
  // siempre, el cliente bloqueado por no recoger sus pedidos no se enteraba de
  // qué hizo mal, y el bloqueado por error tampoco. El reclamo da la
  // explicación en su primer intento y vuelve al mensaje neutro después, así
  // el bloqueado nunca cuesta más mensajes que un cliente normal.
  //
  // ⚠️ El texto NO promete que sea temporal: hoy `blocked_at` no caduca, y lo
  // levanta el dueño. Prometer un plazo que el sistema no cumple es cómo nació
  // el fallo del número del 2026-08-23.
  //
  // ⚠️ Falla ABIERTO: si la consulta revienta se atiende. Dejar a un cliente
  // legítimo fuera de un local por un fallo nuestro es peor que dejar entrar a
  // un bloqueado, que además no va a poder cerrar el pedido.
  const bloqueado = database.isContactBlocked
    ? await database.isContactBlocked(negocio.id, phone).catch(() => false)
    : false
  if (bloqueado) {
    logger?.log(`⛔ [marketplace] ${negocio.slug} tiene bloqueado a este contacto`)
    // La PRIMERA vez se le explica; a partir de la segunda vuelve el mensaje
    // neutro. Falla hacia el silencio, que es la conducta anterior a esto.
    // ⚠️ La explicación ya NO invita a «comunicarse con el local»
    // (2026-09-07): es una puerta que no existe. Ver DECISIONES.md.
    const toca = database.claimBlockedNotice
      ? await database.claimBlockedNotice(negocio.id, customer.id).catch(() => false)
      : false
    // ⚠️ También aquí las CATEGORÍAS (2026-09-02): el texto ofrecía «escribe
    // MENÚ para elegir otro local» y hacía teclear para llegar a una lista que
    // cabe en el mismo mensaje. El bloqueo es del LOCAL; los demás siguen
    // abiertos para esta persona.
    const otras = verCategorias(await database.getMarketplaceCategories().catch(() => []), 0)
    await deps.send(
      toca
        ? `⛔ *${negocio.name}* pausó tus pedidos.\n\n`
          + 'Suele pasar cuando quedan pedidos sin confirmar o sin recoger.\n\n'
          + 'Mientras tanto puedes pedir en otros locales 👇'
        : `😕 *${negocio.name}* no está recibiendo pedidos tuyos ahora mismo. `
          + 'Elige otro local aquí abajo 👇',
      otras.options,
    )
    // Con opciones, la vista se guarda o el toque siguiente no se entiende.
    if (otras.options.length) {
      await database.advanceConversation(
        customer.id,
        { state: 'navegando', flowState: { vista: otras.vista }, clearBusiness: true },
        version,
      ).catch(() => ({ conflicto: false }))
    }
    return
  }

  await database.advanceConversation(
    customer.id,
    {
      state: 'en_local',
      businessId: negocio.id,
      // ⚠️ A partir de aquí el cliente ESTÁ pidiendo en este local: con el
      // enlace ya tiene su tienda abierta con su token, y en el chat va a
      // empezar a llenar el carrito. Cambiarlo de local en silencio le
      // tiraría lo que lleva —y le dejaría una mini app abierta que ya no
      // lleva a ninguna parte—, así que a partir de ahora se le PREGUNTA.
      //
      // Se suelta al crear el pedido o al reiniciar con MENÚ. Hasta el
      // 2026-08-22 esta columna existía y NADIE la ponía en `true`: el
      // bloqueo estaba escrito, probado… y nunca se activaba.
      shoppingLocked: true,
      // La vista se guarda para que «⬅️ Volver» devuelva a su categoría.
      flowState: { vista: { vista: 'negocios', categoria: negocio.type, pagina: 0 } },
    },
    version,
  )

  await mandarElEnlace(deps, customer, phone, negocio)
}

/**
 * El camino normal: pintar el menú, dejar elegir y, si no casó con nada,
 * buscar. Es lo que corre cuando ninguna de las puertas anteriores atendió.
 *
 * ⚠️ Extraída de `handleMarketplaceMessage` el 2026-09-19 sin cambiar una
 * decisión. Es el ÚLTIMO paso a propósito: todo lo que va antes —MENÚ, los
 * comprobantes, la confirmación de reinicio, el candado— tiene prioridad sobre
 * el menú, y ese orden es la lógica de la puerta, no una casualidad.
 */
async function recorrerElMenu(
  deps: MarketplaceEntryDeps,
  from: string,
  text: string,
  customer: { id: string; name: string | null },
  contexto: {
    vista: MarketplaceView
    categorias: MarketplaceCategory[]
    negocioElegidoId: string | null | undefined
    huboConversacion: boolean
    version: number | undefined
  },
): Promise<void> {
  const { database, send } = deps

  // ── 5b. «¿Hay locales abiertos?» (2026-09-27) ──────────────────────
  //
  // Va antes que el menú porque es una PREGUNTA, no una opción de la lista:
  // en la portada se trataba como búsqueda («Esto encontré para…») y, sin
  // resultados, como «Con eso no te puedo ayudar». El dueño la hizo a las
  // 00:16 y recibió eso.
  //
  // ⚠️ Solo sin local elegido, igual que la búsqueda: dentro de un local se
  // pregunta por ese local, y ahí manda su tienda.
  if (esPreguntaPorAbiertos(text) && !contexto.negocioElegidoId) {
    const abiertos = await responderAbiertos(deps, contexto.categorias)
    deps.logger?.log(`🌙 [marketplace] «${text}» → ${abiertos.vista.vista === 'abiertos' ? `${abiertos.vista.codigos?.length} categoría(s) abierta(s)` : 'nada abierto'}`)
    await guardar(deps, customer.id, contexto.version, abiertos, { soltarLocal: false })
    await send(abiertos.reply, abiertos.options)
    return
  }

  // ── 6. El menú ─────────────────────────────────────────────────────
  //
  // `paso` es una función PURA: no consulta nada. Cuando el cliente elige una
  // categoría devuelve la vista nueva con el texto vacío, porque los locales
  // de esa categoría todavía no están consultados. Se consultan y se vuelve a
  // llamar — dos fases, y por eso el bucle tiene tope: sin él, una vista que
  // no avanzara dejaría el proceso girando dentro de un webhook.
  let respuesta: MarketplaceReply = { reply: '', options: [], vista: contexto.vista }
  let vistaActual = contexto.vista
  for (let intento = 0; intento < 2; intento += 1) {
    let negocios: MarketplaceBusiness[] = []
    if (vistaActual.vista === 'negocios' && vistaActual.categoria) {
      negocios = await conEstadoDeHorario(
        deps, await database.getMarketplaceBusinesses(vistaActual.categoria),
      )
    } else if (vistaActual.vista === 'busqueda' && vistaActual.consulta && !esSaludo(text)) {
      // Se repite la búsqueda en vez de guardar los resultados: mantiene el
      // `flow_state` pequeño y la lista fresca. Falla hacia una lista vacía,
      // que `paso` resuelve devolviendo al cliente a las categorías.
      //
      // ⚠️ SALVO si el mensaje es un saludo: `paso` va a devolver la portada
      // igualmente (un «hola» aquí es «empecemos», no «repíteme la búsqueda»),
      // así que consultarla sería gastar una lectura para tirarla. Es la misma
      // regla que ya cumple la portada — «un saludo no dispara la búsqueda».
      negocios = await conEstadoDeHorario(deps, await buscarLocales(deps, vistaActual.consulta))
    }
    respuesta = paso({
      // ⚠️ En el segundo intento va VACÍO a propósito: el mensaje ya se
      // consumió al elegir la categoría, y esta llamada solo sirve para
      // pintar los locales que se acaban de consultar.
      mensaje: intento === 0 ? text : '',
      vista: vistaActual,
      categorias: contexto.categorias,
      negocios,
      // Nunca había escrito: su «hola» merece una bienvenida, no un reproche.
      primerContacto: !contexto.huboConversacion,
    })
    if (respuesta.reply || respuesta.negocioElegido) break
    vistaActual = respuesta.vista
  }

  // ── Queda constancia de dónde acabó, para los reportes ─────────────
  //
  // Se apunta la VISTA que se le acaba de pintar, que es exactamente lo que se
  // quiere medir: cuánta gente ve el menú y cuánta entra en un cajón. Va aquí
  // —después del bucle— y no en cada pantalla: un solo sitio, y el día que
  // haya una vista nueva se apunta sola.
  if (respuesta.vista.vista === 'categorias') {
    apuntarPaso(deps, { customerId: customer.id, tipo: 'menu' })
  } else if (respuesta.vista.vista === 'negocios') {
    apuntarPaso(deps, {
      customerId: customer.id, tipo: 'cajon', categoryCode: respuesta.vista.categoria,
    })
  }

  // ── El cliente llegó a un local: se le manda su enlace ─────────────
  if (respuesta.negocioElegido) {
    // ⚠️ POR DÓNDE llegó: el cajón desde el que lo eligió, o nada si llegó
    // escribiendo lo que quería. Es lo que le dice al dueño si le buscan
    // «almuerzo» o «cena», y se sabe SOLO aquí — dentro de `entregarLocal` ya
    // se perdió la vista de la que venía.
    await entregarLocal(
      deps, customer, from, respuesta.negocioElegido, contexto.version,
      vistaActual.vista === 'negocios' ? vistaActual.categoria : null,
    )
    return
  }

  // ── 7. No casó con el menú: quizá está BUSCANDO ────────────────────
  //
  // «Quiero ceviche» no es una opción equivocada: es un cliente diciendo lo
  // que quiere. La búsqueda existía desde el 2026-08-21 —alias curados, texto
  // completo en español y trigramas— y **no la llamaba nadie**, así que esa
  // frase recibía «🙏 No te entendí» aunque la base supiera resolverla.
  //
  // ⚠️ Va DESPUÉS del menú, no antes: si se buscara primero, «1» o «Pizzerías»
  // se tratarían como texto libre y el cliente que está eligiendo de la lista
  // acabaría en una búsqueda. El menú manda; buscar es la segunda oportunidad.
  //
  // ⚠️ Solo cuando `paso` no entendió Y no hay local elegido: dentro de un
  // local el ámbito es ese local, y traerle el ceviche de otro negocio metería
  // en el carrito un producto que no puede estar ahí.
  //
  // ⚠️ Falla hacia el mensaje de siempre: si la búsqueda revienta o no
  // encuentra nada, el cliente recibe exactamente lo que recibía antes.
  // ⚠️ Un ADJUNTO no se busca (2026-09-06). «[foto]», «[nota de voz]» y
  // «[ubicación]» son marcadores que pone el webhook, no algo que el cliente
  // quiera comer: mandarlos a la búsqueda eran DOS consultas a la base por
  // cada foto suelta —los locales y el diccionario de términos— que no pueden
  // encontrar nada. El menú ya le respondió nombrando lo que mandó.
  // ⚠️ Un NÚMERO suelto tampoco se busca (2026-09-26). Quien escribe «3» está
  // eligiendo una fila, no pidiendo comida; buscarlo enseñaba «Esto encontré
  // para 3» con los locales que tuvieran un 3 en algún producto. Si no es una
  // opción de lo que tiene delante, se le repinta con el «no te entendí».
  if (respuesta.noEntendido
    && !esAdjuntoSinTexto(text)
    && !/^\d+$/.test(text.trim())
    && !contexto.negocioElegidoId) {
    const encontrados = await conEstadoDeHorario(deps, await buscarLocales(deps, text))
    if (encontrados.length) {
      // ⚠️ La búsqueda se apunta UNA vez y donde se sabe TODO de ella: cuántos
      // locales salieron y —si no salió ninguno— si al menos se entendió lo
      // que pedía. Apuntarla dentro de `buscarLocales` contaba doble al pasar
      // de página y nunca llegaba a saber lo segundo.
      apuntarPaso(deps, {
        customerId: customer.id, tipo: 'busqueda', consulta: text, resultados: encontrados.length,
      })
      const resultados = verResultados(text, encontrados, 0)
      deps.logger?.log(`🔎 [marketplace] «${text}» encontró ${encontrados.length} local(es)`)
      await guardar(deps, customer.id, contexto.version, resultados, { soltarLocal: false })
      await send(resultados.reply, resultados.options)
      return
    }

    // ── No hay locales… ¿pero le entendimos? ─────────────────────────
    //
    // «pollo» y «asdfghjkl» recibían EXACTAMENTE el mismo «🙏 No te entendí»,
    // y no son lo mismo: el alias de «pollo» existe y apunta a `asados`, así
    // que se le entendió — lo que falta es un asadero dado de alta. Decirle
    // que no se le entendió cuando escribió bien es de las cosas que hacen
    // que una app parezca tonta, y es justo el cliente que SÍ sabe lo que
    // quiere.
    //
    // ⚠️ Falla hacia el mensaje de siempre: si esto revienta o el término no
    // está en el diccionario, se responde lo que se respondía antes.
    const conocido = database.marketplaceKnownTerm
      ? await database.marketplaceKnownTerm(text).catch(() => null)
      : null
    // Sin locales: se apunta igual, y con la categoría que se entendió si la
    // hay. «La gente pide internacional y no tienes ninguno» es demanda.
    apuntarPaso(deps, {
      customerId: customer.id, tipo: 'busqueda', consulta: text, resultados: 0,
      categoryCode: conocido?.code ?? null,
    })
    if (conocido) {
      // ── SEGUNDO INTENTO: con lo que SÍ entendimos ───────────────────────
      //
      // La búsqueda literal falló, pero el término se reconoció — porque venía
      // en plural («parrilladas») o con una errata («pizzza»). Si esa
      // categoría TIENE locales, se enseñan.
      //
      // ⚠️ Sin esto, a quien escribe «pizzza» se le respondería «todavía no
      // tenemos Pizzerías» teniendo una. Sería mentirle, y además la peor
      // mentira: la que le manda a otra app a buscar lo que aquí sí hay.
      const deLaCategoria = await conEstadoDeHorario(
        deps, await database.getMarketplaceBusinesses(conocido.code).catch(() => []),
      )
      if (deLaCategoria.length) {
        const categoria = contexto.categorias.find(c => c.code === conocido.code)
          || { code: conocido.code, label: conocido.label }
        const vista = verNegocios(categoria as MarketplaceCategory, deLaCategoria, 0)
        // Se dice lo que se entendió, en una línea y sin regañar. El cliente
        // aprende cómo se escribe viéndolo, no porque se lo pidan.
        const conAviso = {
          ...vista,
          reply: `🔎 Te muestro *${conocido.label}* 👇\n\n${vista.reply}`,
        }
        deps.logger?.log(
          `🔎 [marketplace] «${text}» → ${conocido.label}, ${deLaCategoria.length} local(es)`,
        )
        await guardar(deps, customer.id, contexto.version, conAviso, { soltarLocal: false })
        await send(conAviso.reply, conAviso.options)
        return
      }

      const portada = verCategorias(contexto.categorias, 0)
      const aviso = {
        ...portada,
        reply: `😔 Todavía no tenemos *${conocido.label}* por aquí.\n\n`
          + `Esto es lo que sí puedes pedir hoy 👇`,
      }
      deps.logger?.log(`🔎 [marketplace] «${text}» → ${conocido.label}, sin locales`)
      await guardar(deps, customer.id, contexto.version, aviso, { soltarLocal: false })
      await send(aviso.reply, aviso.options)
      return
    }
  }

  await guardar(deps, customer.id, contexto.version, respuesta, { soltarLocal: false })
  await send(respuesta.reply, respuesta.options)
}

/**
 * Insultos: la PRIMERA vez, una advertencia; la SEGUNDA, 15 días fuera de
 * toda la app (decisión del dueño, 2026-09-27, tras probarlo con su teléfono).
 *
 * Devuelve `true` cuando el mensaje era un insulto y ya se contestó.
 *
 * ⚠️ Solo las palabras fuertes, y la comida de Ecuador protegida: ver
 * `lib/malas-palabras.ts`.
 *
 * ⚠️ El mensaje NO se atiende —ni búsqueda ni menú—: solo se le responde a lo
 * que dijo. «menú, hijueputa» sigue siendo un insulto.
 *
 * ⚠️ Falla ABIERTO: si la base no contesta, el mensaje se atiende como antes.
 * Bloquear a alguien por un fallo nuestro no tiene vuelta atrás.
 */
async function atenderInsulto(
  deps: MarketplaceEntryDeps,
  text: string,
  customerId: string,
): Promise<boolean> {
  if (!deps.database.registerInsult || !contieneInsulto(text)) return false
  const falta = await deps.database.registerInsult(customerId).catch(() => null)
  if (falta?.accion !== 'advertido' && falta?.accion !== 'bloqueado') return false
  deps.logger?.log(`🤬 [marketplace] insulto: ${falta.accion}`)
  await deps.send(
    falta.accion === 'advertido'
      ? ADVERTENCIA_POR_INSULTOS
      : avisoDeBloqueoPorInsultos(falta.hasta ?? null),
    [],
  )
  return true
}

/**
 * MENÚ: la salida de cualquier sitio, y se comprueba antes que nada.
 *
 * Devuelve `true` cuando el mensaje era MENÚ y ya se contestó.
 *
 * ⚠️ Extraída de `handleMarketplaceMessage` el 2026-09-19 sin cambiar una
 * decisión. Que se compruebe ANTES que todo lo demás es la regla que sostiene
 * el resto: es lo único que siempre funciona, se esté donde se esté.
 */
async function atenderComandoMenu(
  deps: MarketplaceEntryDeps,
  text: string,
  customer: { id: string; name: string | null },
  contexto: {
    vista: MarketplaceView
    estado: { negocio: { name: string; slug: string } | null; bloqueado: boolean; esperandoComprobante: boolean }
    categorias: MarketplaceCategory[]
    negocioElegidoId: string | null | undefined
    estadoDeLaConversacion: string | null | undefined
    version: number | undefined
  },
): Promise<boolean> {
  const { send } = deps
  if (!esComandoMenu(text)) return false

    // ⚠️ SEGUNDO MENÚ = SÍ, y esto arregla un bucle real (2026-08-23).
    //
    // El muro de «un pedido a la vez» dice literalmente «escribe *MENÚ*». El
    // cliente lo escribe, se le pregunta si tira su pedido… y como MENÚ se
    // comprueba antes que la vista, escribirlo otra vez volvía a preguntar lo
    // mismo. Para siempre. El dueño lo vivió: «sigue enviando y enviando lo
    // mismo».
    //
    // Pedir el menú DOS VECES no es una respuesta ambigua: es la misma
    // petición repetida. La regla de no decidir por él sigue en pie para todo
    // lo demás —cualquier otro texto vuelve a preguntar—, porque tirar un
    // carrito es lo único que no tiene vuelta atrás.
    if (contexto.vista.vista === 'confirmando_reinicio') {
      // ⚠️ También aquí se cancela. Escribir MENÚ dos veces es la OTRA puerta
      // para abandonar —«✅ Empezar de nuevo» normaliza a un COMANDO_MENU, así
      // que el botón entra por aquí, no por el paso 2—. Si solo cancelara una
      // de las dos, la mitad de los abandonos avisados seguirían caducando y
      // sumando falta.
      await abandonarPedido(deps, contexto.negocioElegidoId, customer.id)
      await matarEnlaceAnterior(deps, customer.id)
      // 'vuelta': vuelve al inicio a propósito, igual que `responderAlMenu`.
      const respuesta = verCategorias(contexto.categorias, 0, 'vuelta')
      await guardar(deps, customer.id, contexto.version, respuesta, {
        soltarLocal: true,
      })
      await send(respuesta.reply, respuesta.options)
      return true
    }
    // ⚠️ MENÚ suelta SIEMPRE, y cancela lo que hubiera sin pagar (2026-09-05).
    //
    // Ya no hay una rama que pregunte: `responderAlMenu` devuelve las
    // categorías pase lo que pase. Escribir MENÚ es avisar de que se deja el
    // pedido, y avisar no puede costar una falta — por eso se cancela en vez
    // de dejarlo caducar, igual que hace «✅ Empezar de nuevo».
    await abandonarPedido(deps, contexto.negocioElegidoId, customer.id)
    // ⚠️ LOS DOS CAMINOS de MENÚ revocan, y conectar solo uno dejaría la mitad
    // de los MENÚ con el enlace vivo: aquí entra el MENÚ escrito, y arriba el
    // que llega estando en la pregunta de reinicio —donde además cae el botón
    // «✅ Empezar de nuevo», porque su texto normaliza a un COMANDO_MENU—.
    await matarEnlaceAnterior(deps, customer.id)
    const respuesta = responderAlMenu(contexto.estado, contexto.categorias)
    await guardar(deps, customer.id, contexto.version, respuesta, {
      soltarLocal: true,
    })
    await send(respuesta.reply, respuesta.options)
    return true
  

  return true
}

/**
 * La respuesta a «¿tiro tu pedido?»: o lo reinicia, o le devuelve su enlace.
 *
 * Devuelve `true` cuando estaba en esa pregunta y ya se contestó.
 *
 * ⚠️ Extraída de `handleMarketplaceMessage` el 2026-09-19 sin cambiar una
 * decisión. Las dos ramas revocan o conservan el enlace de forma distinta, y
 * ese reparto es lo que aquí no se puede tocar.
 */
async function atenderConfirmacionDeReinicio(
  deps: MarketplaceEntryDeps,
  from: string,
  text: string,
  customer: { id: string; name: string | null },
  contexto: {
    vista: MarketplaceView
    estado: { negocio: { name: string; slug: string } | null; bloqueado: boolean; esperandoComprobante: boolean }
    categorias: MarketplaceCategory[]
    negocioElegidoId: string | null | undefined
    esperandoComprobante: boolean
    estadoDeLaConversacion: string | null | undefined
    version: number | undefined
  },
): Promise<boolean> {
  const { send } = deps
  if (contexto.vista.vista === 'confirmando_reinicio') {
    const { reinicia, continua, respuesta } = resolverReinicio(text, contexto.estado, contexto.categorias)

    if (reinicia) {
      await abandonarPedido(deps, contexto.negocioElegidoId, customer.id)
      // ⚠️ Y SE REVOCA, igual que en las dos ramas de MENÚ (2026-09-17). Este
      // es el camino REAL del botón «✅ Empezar de nuevo»: con YCloud llega su
      // NÚMERO («1»), no su título, y «1» no es un comando de MENÚ. Se creía
      // que el botón entraba por arriba —la prueba mandaba el título—, así que
      // en producción el enlace seguía abriendo la carta después de reiniciar.
      await matarEnlaceAnterior(deps, customer.id)
    }

    await guardar(deps, customer.id, contexto.version, respuesta, {
      soltarLocal: reinicia,
      // ⚠️ Mientras NO reinicie, el estado del pago se conserva: si se pisara
      // con 'navegando', el «Seguir mi pedido» siguiente volvería a decir
      // «termínalo» a quien ya pidió. Al reiniciar da igual — el local se
      // suelta entero.
      conservarEstado: !reinicia
        && (contexto.estadoDeLaConversacion === 'esperando_comprobante'
          || contexto.estadoDeLaConversacion === 'pago_en_revision'),
    })
    // ⚠️ «Seguir mi pedido» DEVUELVE EL ENLACE (2026-09-03).
    //
    // Hasta ahora contestaba «Termina tu pedido cuando quieras 👍» y nada más:
    // una calle sin salida para quien escribió MENÚ justamente porque no
    // encontraba su enlace —lo borró, lo perdió entre mensajes, cambió de
    // teléfono—. Sus dos opciones eran tirar el pedido o seguir sin poder
    // entrar.
    //
    // Es la salida que el dueño puso como condición del enlace estricto:
    // «escribes MENÚ y listo». Sin esto, «estricto» sería una trampa.
    //
    // ⚠️ Emitirlo NO le mata la sesión que ya tenga abierta: la revocación
    // respeta el local vigente a propósito, o recargar con un token nuevo le
    // vaciaría el carrito.
    // ⚠️ A quien DEBE el comprobante NO se le manda el enlace (2026-09-04).
    //
    // El botón dice «Ver la carta», y esa es exactamente la invitación
    // equivocada: esta persona no puede pedir nada más hasta cerrar lo que ya
    // pidió. El dueño lo dijo probándolo: «no debería darme la opción de ver
    // la carta porque tengo que completar el pedido para hacer otro».
    //
    // ⚠️ No la deja sin nada: su enlace SIGUE VIVO —está unos mensajes más
    // arriba en el mismo chat, y la revocación respeta el local vigente— y los
    // datos para transferir viven ahí. Lo único que se retira es la invitación
    // a seguir mirando, que es lo que sobra.
    //
    // El enlace SÍ se manda a quien está a medio armar el carrito: ahí volver
    // a la carta es justo lo que necesita.
    if (continua && contexto.negocioElegidoId && !contexto.esperandoComprobante) {
      await devolverElEnlace(
        deps, customer, from, contexto.negocioElegidoId, respuesta,
      )
      return true
    }
    await send(respuesta.reply, respuesta.options)
    return true
  }

  return false
}

/**
 * Un pedido a la vez: a quien ya está pidiendo se le recuerda dónde, en vez de
 * enseñarle el menú.
 *
 * Devuelve `true` cuando el candado estaba puesto y ya se contestó.
 *
 * ⚠️ Extraída de `handleMarketplaceMessage` el 2026-09-19 sin cambiar una
 * decisión. Es una regla de DINERO: dos pedidos abiertos a la vez en locales
 * distintos es exactamente lo que impide.
 */
async function atenderCandado(
  deps: MarketplaceEntryDeps,
  text: string,
  contexto: {
    customerId: string
    bloqueado: boolean
    negocio: { name: string } | null
    estadoDeLaConversacion: string | null | undefined
    version: number | undefined
    aMediasEnElChatViejo: boolean
  },
): Promise<boolean> {
  const { send } = deps
  if (contexto.bloqueado && contexto.negocio) {
    // ⚠️ Dos textos, porque son dos situaciones. Quien está a medio armar su
    // pedido tiene que TERMINARLO; quien ya lo hizo y debe la transferencia
    // tiene que mandar una FOTO. Decirle «termínalo» al segundo lo deja
    // buscando un menú que ya completó.
    // ⚠️ TRES mensajes, no dos (2026-08-30). Quien está a medio armar su
    // pedido tiene que TERMINARLO; quien ya lo hizo y debe la transferencia
    // tiene que mandar una FOTO; y quien YA la mandó no tiene que hacer nada
    // —solo esperar—. Decirle «mándanos la foto» a quien acaba de mandarla, o
    // «termínalo» a un pedido terminado, suena a que el bot no se enteró.
    const respuesta = contexto.estadoDeLaConversacion === 'pago_en_revision'
      ? recordarPagoEnRevision({ name: contexto.negocio.name })
      : contexto.estadoDeLaConversacion === 'esperando_comprobante'
        ? recordarComprobantePendiente({ name: contexto.negocio.name })
        // ⚠️ `en_local` = el enlace ya salió y NO hay pedido todavía. Sin
        // esto el mensaje decía «tienes un pedido en proceso» a quien acababa
        // de recibir la carta, que es sencillamente falso.
        : recordarPedidoEnProceso(
          { name: contexto.negocio.name },
          contexto.estadoDeLaConversacion === 'en_local' || contexto.aMediasEnElChatViejo,
        )
    // ⚠️ GUARDAR, no solo enviar (2026-08-24). Era la ÚNICA rama que respondía
    // sin persistir su vista, y el efecto no era cosmético: la respuesta ofrece
    // «✅ Empezar de nuevo», y ese texto normalizado es uno de los
    // `COMANDOS_MENU`. Sin la vista guardada, tocar ese botón se leía como MENÚ
    // con la vista ANTERIOR, así que volvía a PREGUNTAR en vez de reiniciar y
    // el cliente tenía que tocarlo dos veces —lo vivió el dueño—. Lo único que
    // evitaba que fuera un bucle infinito era el parche «segundo MENÚ = SÍ»,
    // que lo disfrazó de molestia cosmética en vez de dejarlo a la vista.
    //
    // ⚠️ `soltarLocal: false`: aquí solo se PREGUNTA. El carrito y el local
    // siguen donde estaban hasta que el cliente confirme — tirar un carrito es
    // lo único que no tiene vuelta atrás.
    // ⚠️ SE NOMBRA LO QUE LLEGÓ, y solo aquí (2026-09-03). El dueño mandó una
    // foto teniendo local elegido y recibió «Estás pidiendo en Monster Pizza»,
    // que es cierto pero no dice nada de su foto: se queda sin saber si llegó,
    // si servía, o si acaba de pagar sin querer.
    //
    // ⚠️ NO se aplica a quien DEBE un comprobante ni a quien lo tiene en
    // revisión, y ese corte es el punto: ahí una foto es justo lo que se
    // espera. Si una llega hasta aquí en ese estado es porque el buzón no pudo
    // procesarla, y decirle «esto no es un comprobante» sería lo contrario de
    // la verdad. Esos dos casos conservan su mensaje intacto.
    //
    // ⚠️ El toque viejo SÍ lleva su advertencia en esos dos estados
    // (2026-09-28): lo que se protege ahí es la FOTO, que es lo esperado. Una
    // opción vieja no lo es, y el siguiente toque viejo pausa el menú: nadie
    // puede llegar a la pausa sin haber leído antes la advertencia.
    const adjunto = text === OPCION_ANTERIOR
      || (contexto.estadoDeLaConversacion !== 'esperando_comprobante'
        && contexto.estadoDeLaConversacion !== 'pago_en_revision')
      ? textoDeAdjuntoRecibido(text)
      : null
    const conAviso = adjunto
      ? { ...respuesta, reply: `${adjunto}\n\n${respuesta.reply}` }
      : respuesta

    await guardar(deps, contexto.customerId, contexto.version, conAviso, {
      soltarLocal: false,
      // ⚠️ El estado del PAGO no se pisa. `guardar` escribe 'navegando' salvo
      // en la confirmación de reinicio, y eso borraría el
      // `pago_en_revision` que puso el disparador al llegar el comprobante —
      // con él perdido, el siguiente mensaje volvería a decir «termínalo» a
      // alguien que ya pagó.
      // ⚠️ Los DOS estados que pone la BASE, no solo el de revisión: sin
      // conservar `esperando_comprobante`, el primer recordatorio lo borraba y
      // el «Seguir mi pedido» siguiente volvía a decir «termínalo».
      conservarEstado: contexto.estadoDeLaConversacion === 'pago_en_revision'
        || contexto.estadoDeLaConversacion === 'esperando_comprobante',
    })
    await send(conAviso.reply, conAviso.options)
    return true
  }

  return false
}

/**
 * Los marcadores que deja el webhook tras procesar una captura de pago.
 *
 * Devuelve `true` cuando el mensaje era uno de ellos y ya se contestó.
 *
 * ⚠️ Se extrajo de `handleMarketplaceMessage` el 2026-09-19 sin tocar una sola
 * decisión: el orden entre los cuatro marcadores se conserva exacto, y es lo
 * único que aquí no se puede reordenar.
 */
async function atenderComprobante(
  deps: MarketplaceEntryDeps,
  text: string,
  contexto: {
    customerId: string
    version: number | undefined
    categorias: MarketplaceCategory[]
  },
): Promise<boolean> {
  const { send } = deps
  const { categorias } = contexto
  //
  // ⚠️ Estos textos NO los escribió el cliente: los pone el webhook después de
  // haber subido y adjuntado (o rechazado) su captura. Si cayeran al menú se
  // tratarían como una BÚSQUEDA, y quien acaba de pagar recibiría «no
  // encontramos locales para [el cliente envió su comprobante…]».
  //
  // ⚠️ Va detrás de MENÚ para no romper la regla de que MENÚ se comprueba
  // antes que nada, aunque ninguno de estos marcadores pueda confundirse con
  // él. Y NO toca el estado de la conversación: el carrito, el local elegido y
  // la vista se quedan exactamente donde estaban.
  // ⚠️ El que NO CUADRA va PRIMERO, y el orden importa: su marcador contiene
  // «un pago que no corresponde a este pedido», que no lleva la subcadena de
  // `esComprobante`, pero dejarlo detrás sería confiar en esa separación para
  // siempre. Aquí el error caro es decirle «recibimos tu comprobante» a quien
  // pagó a otra cuenta: se iría a esperar una comida que nadie va a preparar.
  if (esComprobanteQueNoCuadra(text)) {
    await send(respuestaComprobanteNoCuadra(motivoDelDescuadre(text)), [])
    return true
  }
  if (esComprobante(text)) {
    // Con el análisis encendido y todo cuadrando se le dice, porque es lo que
    // de verdad tranquiliza mientras el dueño mira. Sin análisis, el de
    // siempre.
    await send(
      comprobanteCuadra(text) ? RESPUESTA_COMPROBANTE_CUADRA : RESPUESTA_COMPROBANTE,
      [],
    )
    return true
  }
  if (esFotoQueNoEsComprobante(text)) {
    // ⚠️ La consecuencia viaja DENTRO del marcador, igual que los nombres del
    // comprobante ambiguo: quien lo escribió ya consultó la base, y volver a
    // consultarla aquí sería pagar dos veces por el mismo dato.
    //
    // Sin cola —los marcadores que ya circulaban antes de esto— la respuesta
    // es exactamente la de siempre.
    const rechazo = rechazoDelMarcador(text)

    // ⚠️ AL BLOQUEAR, se ofrecen las DEMÁS CATEGORÍAS (2026-09-02).
    //
    // El mensaje ya decía «mientras tanto puedes pedir en los demás locales» y
    // no daba ninguno: el cliente leía una salida que no podía tomar. El dueño
    // lo pidió con estas palabras: «que me salgan las demás categorías, porque
    // sí puedo pedir en otros locales».
    //
    // ⚠️ Se puede porque el bloqueo es del LOCAL, no de la plataforma. Y se
    // puede AHORA porque al bloquear se expira su pedido, así que ya no queda
    // nada retenido — antes de eso, ofrecerle categorías lo habría llevado
    // contra el muro de «tienes un pedido en proceso».
    //
    // ⚠️ Con opciones hay que GUARDAR la vista, o tocar una categoría se lee
    // con la vista anterior y el cliente tiene que tocarla dos veces. Es el
    // fallo del 2026-08-24, y aquí volvería a entrar por esta puerta.
    if (rechazo?.blocked) {
      const portada = verCategorias(categorias, 0)
      const respuesta = {
        ...portada,
        reply: `${respuestaNoEsComprobante(rechazo)}\n\n${portada.reply}`,
      }
      await guardar(deps, contexto.customerId, contexto.version, respuesta, {
        soltarLocal: true,
      })
      await send(respuesta.reply, respuesta.options)
      return true
    }

    await send(respuestaNoEsComprobante(rechazo), [])
    return true
  }
  if (esComprobanteAmbiguo(text)) {
    // Los nombres viajan dentro del propio marcador: quien lo escribió ya
    // consultó la base, y volver a consultarla sería pagar dos veces por la
    // misma respuesta. Es el mismo desempaquetado que hace `bot-conversation`.
    const locales = String(text).split(': ').slice(1).join(': ').replace(/\]$/, '')
    await send(
      preguntaDeQueLocal(
        locales.split(' / ').filter(Boolean).map(businessName => ({
          orderId: '', orderNumber: null, businessName,
        })),
      ),
      [],
    )
    return true
  }

  return false
}

/**
 * Lo que encabeza el enlace del local: abierto invita, cerrado avisa.
 *
 * ⚠️ El cerrado recibe el enlace IGUAL, y es a propósito. La mini app deja ver
 * la carta con la tienda cerrada —e impide pedir por su cuenta—, así que
 * negarle el enlace solo lograría que no supiera qué se vende ahí. Lo que
 * cambia es que se entera ANTES de entrar, no después.
 */
function textoDelLocal(negocio: MarketplaceBusiness): string {
  if (negocio.abierto !== false) {
    return `🛍️ *${negocio.name}*\n\nArma tu pedido aquí 👇`
  }
  return `🌙 *${negocio.name}* está cerrado ahora mismo.${cuandoAbre(negocio.abre)}\n\n`
    + 'Puedes ver la carta mientras tanto 👇'
}

/**
 * « Abre mañana a las 9:00 AM.» — o cadena vacía si no se sabe.
 *
 * ⚠️ Estaba escrito dentro de `textoDelLocal` y se saca porque ahora lo dicen
 * TRES sitios: el encabezado del enlace, el menú del chat cuando el local está
 * cerrado y el checkout que se niega a crear el pedido. Tres copias de esta
 * frase acabarían diciendo horas distintas.
 */
function cuandoAbre(abre: MarketplaceBusiness['abre']): string {
  if (!abre?.open) return ''
  const dia = abre.inDays === 0
    ? 'hoy'
    : abre.inDays === 1
      ? 'mañana'
      : `el ${abre.dayName.toLocaleLowerCase('es')}`
  return ` Abre ${dia} a las ${horaDoce(abre.open)}.`
}

/** «08:00» → «8:00 AM», como se dice una hora aquí. */
function horaDoce(hhmm: string): string {
  const partes = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim())
  if (!partes) return String(hhmm || '')
  const horas = Number(partes[1])
  if (!Number.isInteger(horas) || horas < 0 || horas > 23) return String(hhmm)
  return `${horas % 12 === 0 ? 12 : horas % 12}:${partes[2]} ${horas < 12 ? 'AM' : 'PM'}`
}

/** El local es grande: se pide en la mini app. */
async function mandarElEnlace(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  negocio: MarketplaceBusiness,
): Promise<void> {
  const { database, send, logger } = deps
  const business = await database.getBusinessById(negocio.id)
  const url = business
    ? await deps.issueLink({
        business,
        phone,
        name: customer.name,
        // El cliente acaba de pedirlo eligiendo el local: el cooldown de
        // reenvío no aplica, o elegir dos veces seguidas no daría enlace.
        force: true,
      })
    : null

  if (!url) {
    logger?.log(`⚠️  [marketplace] sin enlace para ${negocio.slug}`)
    await send(
      `😕 No pude abrir la tienda de *${negocio.name}* ahora mismo. `
      + 'Escribe *MENÚ* para elegir otro local.',
      [],
    )
    return
  }

  // ⚠️ BOTÓN primero, y el texto solo si el botón no sale (2026-08-29).
  //
  // Una URL cruda ocupa tres líneas, se parte en pantallas estrechas y se lee
  // como publicidad: la gente no la toca. `sendLinkButton` y
  // `storefrontInviteButton` existían desde el 2026-08-12 para el canal propio
  // y **nadie los llamaba desde el marketplace**, que es donde están hoy todos
  // los clientes.
  //
  // ⚠️ La etiqueta va SIN EMOJI y corta: WhatsApp la limita a 20 BYTES y un
  // emoji gasta cuatro. El adorno se queda en el cuerpo, que admite 1024.
  // ⚠️ Cerrado se AVISA aquí, antes de que abra la carta (2026-09-03). Sin
  // esto el cliente elegía el local, recibía «arma tu pedido aquí», entraba…
  // y se encontraba la tienda cerrada. Ahora se le dice antes y se le manda el
  // enlace igual: la carta se puede mirar con el local cerrado, y saber qué
  // hay es justo lo que le hace volver a la hora de apertura.
  const cuerpo = textoDelLocal(negocio)

  const enviadoComoBoton = deps.sendLink
    ? await deps.sendLink({
      body: cuerpo,
      url,
      label: 'Ver la carta',
      footer: 'Para volver al inicio, escribe MENÚ',
    }).catch(() => false)
    : false
  if (enviadoComoBoton) return

  await send(
    `${cuerpo}\n${url}\n\n`
    + 'Cuando termines te aviso por aquí mismo. Para volver al inicio, escribe *MENÚ*.',
    [],
  )
}

/**
 * El cliente dijo en voz alta que deja su pedido: se cancela en el momento.
 *
 * ⚠️ Hasta el 2026-09-04 ese pedido seguía vivo hasta caducar, y al caducar le
 * sumaba una falta de «pedido sin pagar» — la MISMA que suma quien nunca
 * volvió a contestar. **Avisar y desaparecer no pueden costar lo mismo**, o no
 * hay ningún motivo para avisar; y sin motivo para avisar, todos los
 * abandonos son silenciosos.
 *
 * ⚠️ Lo llaman las DOS puertas de reinicio: el botón «✅ Empezar de nuevo»
 * —que normaliza a un `COMANDO_MENU` y entra por el paso 1— y la respuesta a
 * la confirmación. Si solo lo hiciera una, la mitad de los abandonos avisados
 * seguirían costando una falta.
 *
 * ⚠️ Falla en silencio: si cancelar no sale, el pedido caduca solo a los 15
 * minutos como siempre. Nunca puede impedirle reiniciar.
 */
/**
 * MENÚ mata el enlace anterior, salvo cuando el cliente lo necesita.
 *
 * ⚠️ Hasta el 2026-09-03 MENÚ soltaba el local pero dejaba **el enlace vivo**:
 * el botón «Ver la carta» de unos mensajes más arriba seguía abriendo la
 * tienda anterior. Y como MENÚ también quita el candado de «un pedido a la
 * vez», por ahí se podía armar un pedido en un local mientras se navegaba
 * otro. El dueño lo pidió con estas palabras: «todo lo de la palabra menú
 * hacia arriba debería morirse».
 *
 * ⚠️ LA EXCEPCIÓN LA MARCÓ ÉL MISMO, y es la mitad importante: quien tiene un
 * pedido **esperando comprobante** o **en revisión** conserva su enlace. Ahí
 * la mini app es por donde manda su captura y por donde ve cómo va lo suyo;
 * revocárselo le dejaría un pedido pagado sin forma de rematarlo.
 *
 * ⚠️ Falla en SILENCIO: si la revocación revienta, MENÚ sigue funcionando como
 * siempre. Es una limpieza, no una defensa — la defensa de verdad es el 403
 * de `readStorefrontSession` y el candado de la conversación.
 */
/**
 * Apunta un paso del menú para los reportes: qué cajones se tocan, cuáles se
 * abandonan y qué escribe la gente (pedido del dueño, 2026-09-18).
 *
 * ⚠️ NUNCA espera ni lanza. Es un registro de producto: si la base falla, el
 * cliente recibe su respuesta igual. Perder una fila de un reporte no puede
 * costar una venta — es la misma regla que `matarEnlaceAnterior`.
 */
function apuntarPaso(
  deps: MarketplaceEntryDeps,
  evento: {
    customerId: string | null
    tipo: 'menu' | 'cajon' | 'busqueda' | 'local'
    categoryCode?: string | null
    businessId?: string | null
    consulta?: string | null
    resultados?: number | null
  },
): void {
  if (!deps.database.logMarketplaceEvent) return
  void deps.database.logMarketplaceEvent(evento).catch(() => {})
}

async function matarEnlaceAnterior(
  deps: MarketplaceEntryDeps,
  customerId: string,
): Promise<void> {
  // ⚠️ La excepción —quien debe un comprobante o lo tiene en revisión
  // conserva su enlace— la decide la BASE mirando los pedidos, no el estado
  // del chat (2026-09-27). Este se leyó al empezar el turno, ANTES de que
  // `abandonarPedido` cancelara el pedido: decía «esperando comprobante» de un
  // pedido que ya no existía, y el enlace sobrevivía. Por eso esto va SIEMPRE
  // después de `abandonarPedido`.
  if (!deps.database.revokeStorefrontSessionsOnExit) return
  const revocados = await deps.database
    .revokeStorefrontSessionsOnExit(customerId)
    .catch(() => 0)
  if (revocados) {
    deps.logger?.log(`🔗 [marketplace] MENÚ revocó ${revocados} enlace(s) anterior(es)`)
  }
}

async function abandonarPedido(
  deps: MarketplaceEntryDeps,
  businessId: string | null | undefined,
  customerId: string,
): Promise<void> {
  if (!businessId || !deps.database.cancelUnpaidOrderOnPurpose) return
  const cancelados = await deps.database
    .cancelUnpaidOrderOnPurpose(businessId, customerId)
    .catch(() => 0)
  if (cancelados) {
    deps.logger?.log(`🚪 [marketplace] se fue avisando: ${cancelados} pedido(s) cancelado(s)`)
  }
}

/**
 * «Seguir mi pedido»: se le recuerda dónde está y se le devuelve su enlace.
 *
 * ⚠️ Falla hacia el texto de siempre. Quedarse sin enlace no puede dejar sin
 * respuesta a alguien que acaba de decir que sigue con su pedido.
 */
async function devolverElEnlace(
  deps: MarketplaceEntryDeps,
  customer: { id: string; name: string | null },
  phone: string,
  businessId: string,
  respuesta: MarketplaceReply,
): Promise<void> {
  const { database, send, logger } = deps
  const business = await database.getBusinessById(businessId).catch(() => null)

  if (!business) {
    await send(respuesta.reply, respuesta.options)
    return
  }

  const url = await deps.issueLink({
    business,
    phone,
    name: customer.name,
    // Lo acaba de pedir con todas las letras: el cooldown no aplica.
    force: true,
    // ⚠️ Y SOLO este enlace queda vivo (2026-09-16). El dueño: «si el cliente
    // lo dejó y selecciona continuar con un pedido, que todo lo de atrás no
    // funcione». Sin esto, el enlace viejo de este mismo local seguía abriendo
    // la tienda. Quien debe dinero no llega aquí —lo filtra el `if` de quien
    // llama— y, por si acaso, la base tampoco le revoca ese local.
    soloEste: true,
  })
  if (!url) {
    logger?.log(`⚠️  [marketplace] «seguir mi pedido» sin enlace para ${business.slug}`)
    await send(respuesta.reply, respuesta.options)
    return
  }

  // Mismo botón que al entregar el local: es el mismo enlace y el mismo toque.
  const enviadoComoBoton = deps.sendLink && !respuesta.options.length
    ? await deps.sendLink({
      body: respuesta.reply,
      url,
      label: 'Ver la carta',
      footer: 'Para volver al inicio, escribe MENÚ',
    }).catch(() => false)
    : false
  if (enviadoComoBoton) return

  await send(`${respuesta.reply}\n\nSigue aquí 👇\n${url}`, respuesta.options)
}

/** Guarda dónde quedó la conversación. */
async function guardar(
  deps: MarketplaceEntryDeps,
  customerId: string,
  version: number | undefined,
  respuesta: MarketplaceReply,
  opciones: {
    soltarLocal: boolean
    /**
     * No tocar `current_state`.
     *
     * La RPC hace `coalesce(p_state, conv.current_state)`, así que un nulo lo
     * conserva. Hace falta para los estados que NO los pone el menú sino la
     * base —`pago_en_revision`, que escribe el disparador al llegar el
     * comprobante—: escribir 'navegando' encima los borraría y el bot
     * respondería lo de antes de pagar.
     */
    conservarEstado?: boolean
  },
): Promise<void> {
  await deps.database.advanceConversation(
    customerId,
    {
      // `undefined`, no `null`: el repositorio hace `patch.state ?? null` y la
      // RPC `coalesce(p_state, conv.current_state)`, así que omitirlo conserva
      // el estado. Ponerlo en `null` explícito choca con el tipo del parche.
      state: opciones.conservarEstado
        ? undefined
        : respuesta.vista.vista === 'confirmando_reinicio'
          ? 'confirmando_reinicio'
          : 'navegando',
      flowState: { vista: respuesta.vista },
      ...(opciones.soltarLocal ? { clearBusiness: true } : {}),
    },
    version,
  )
}
