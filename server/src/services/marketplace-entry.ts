import { codigoEnElMensaje } from './sesion-app'
import { avisoDeSilencio, TE_HEMOS_DESBLOQUEADO, avisoDePausaPorOpcionesViejas, type MarketplaceView } from './marketplace-menu'
import { enviosDelTurno, leerToque, menuEnPausa, queHacerConElToqueViejo, PAUSA_POR_OPCIONES_VIEJAS_MS } from './marketplace-envio'
import { esComprobante, esComprobanteAmbiguo, esFotoQueNoEsComprobante } from './payment-proof-inbox'
import { categoriasDe, ciudadEfectiva, ciudadesDe, conLaCiudad } from './marketplace-ciudad'
import type { MarketplaceEntryDatabase, MarketplaceEntryDeps } from './marketplace-entry-tipos'
import { recorrerElMenu } from './marketplace-recorrido'
import { atenderInsulto, atenderLaCiudad, atenderComandoMenu, atenderConfirmacionDeReinicio, atenderCandado, atenderComprobante } from './marketplace-comandos'

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

// Los tipos viven en `marketplace-entry-tipos.ts`; quien los importaba de aquí sigue igual.
export type { MarketplaceEntryDatabase, MarketplaceEntryDeps }

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
  // La pregunta de ciudad la consume `atenderLaCiudad`; para todo lo demás, la
  // pantalla en la que está es la portada.
  if (guardada && typeof guardada.vista === 'string' && typeof guardada.pagina === 'number'
    && guardada.vista !== 'ciudades') {
    return guardada
  }
  return { vista: 'categorias', pagina: 0 }
}

/**
 * Lo que hace falta para contestar: la conversación, las categorías de todas
 * las ciudades y el local elegido.
 *
 * ⚠️ A LA VEZ, no una tras otra (2026-09-25): son lecturas independientes, y
 * cada ida a la base se paga entera. El local sí depende de la conversación,
 * así que se encadena a ella sin esperar a las categorías. Las categorías
 * vienen de TODAS las ciudades en la misma consulta (2026-10-05): de ahí
 * salen también las ciudades con locales, sin una ida más.
 *
 * ⚠️ Pero DESPUÉS del bloqueo y del techo, nunca antes: a quien está
 * silenciado no se le gasta ni una consulta más. Lo fija
 * `techo-del-marketplace.test.js`, y es una de las capas anti-molestias.
 *
 * ⚠️ El local NO lleva `.catch` —a diferencia de `devolverElEnlace`— y la
 * asimetría es deliberada. Si aquí se fallara «abierto», `negocioActual`
 * quedaría en `null`, el paso 4 no entraría y quien tiene un pedido en curso
 * podría abrir OTRO: el candado de «un pedido a la vez» se saltaría justo
 * cuando la base no está para impedirlo. Propagando, el webhook reintenta
 * cuando la base vuelve — no se pierde el mensaje y el candado aguanta.
 */
async function leerElTurno(database: MarketplaceEntryDatabase, customerId: string) {
  const conversacionLeida = database.getConversation(customerId)
  const [conversation, filas, negocioActual] = await Promise.all([
    conversacionLeida,
    database.getMarketplaceCategories(),
    conversacionLeida.then(leida => (leida?.selected_business_id
      ? database.getBusinessById(leida.selected_business_id)
      : null)),
  ])
  return { conversation, filas, negocioActual }
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
// ⚠️ Con la salida a la vista (2026-09-29): la estafa de «mándame el código que
// te llegó» abre la app con el número de otro, y quien lo mandó recibe AQUÍ la
// única señal de que pasó. Por eso dice cómo cortarlo.
export const SESION_DE_APP_INICIADA = '✅ Listo: iniciaste sesión en la app de Umbani con este número. '
  + 'Vuelve a la app para seguir.\n\n'
  + '🔒 ¿No fuiste tú, o alguien te pidió que le enviaras este código? Escribe '
  + '*CERRAR SESIÓN* y la cerramos al instante.'
const CODIGO_DE_APP_VENCIDO = '⌛ Ese código ya no es válido. Pide uno nuevo en la app de Umbani.'
export const SESIONES_DE_APP_CERRADAS = '🔒 Listo: cerramos todas las sesiones de la app de Umbani '
  + 'abiertas con tu número. Para volver a entrar hace falta un código nuevo, y solo lo puede '
  + 'confirmar este WhatsApp.\n\n'
  + 'Si alguien te pidió que le enviaras un código de Umbani, no lo hagas: nosotros nunca te lo '
  + 'pediremos. Para seguir pidiendo por aquí, escribe *MENÚ*.'

/** «cerrar sesión», «CERRAR SESIÓN», «cierra mis sesiones de la app»… */
export const esCerrarSesion = (texto: string): boolean => /^(cerrar|cierra|cierren|cierre)\s+(la\s+|las\s+|mis?\s+|todas\s+las\s+)?sesion(es)?(\s+de\s+(la\s+)?app)?[\s.!]*$/i
  .test(String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\*/g, '').trim())

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
 * «CERRAR SESIÓN» (2026-09-29): las sesiones de la app de este número dejan de
 * valer al instante, y los enlaces de tienda se cierran como con MENÚ —salvo el
 * del local donde un pedido espera su pago—.
 *
 * ⚠️ En la misma puerta que el código de la app, y por eso también antes de la
 * pausa por opciones viejas: cortar un acceso robado no puede esperar 5 minutos.
 * ⚠️ Falla hacia DECIRLO: si la base no pudo cerrarlas, no se contesta «listo»
 * —sería mentirle a quien acaba de descubrir que le robaron la sesión—.
 */
async function atenderCerrarSesion(deps: MarketplaceEntryDeps, text: string, customerId: string): Promise<boolean> {
  if (!esCerrarSesion(text) || !deps.database.cerrarSesionesDeLaApp) return false
  try {
    await deps.database.cerrarSesionesDeLaApp(customerId)
  } catch {
    await deps.send('⚠️ No pudimos cerrar las sesiones ahora mismo. Vuelve a escribir *CERRAR SESIÓN* en un momento.', [])
      .catch(() => undefined)
    return true
  }
  await deps.database.revokeStorefrontSessionsOnExit?.(customerId).catch(() => 0)
  await deps.send(SESIONES_DE_APP_CERRADAS, []).catch(() => undefined)
  deps.logger?.log('🔒 [marketplace] sesiones de la app cerradas desde WhatsApp')
  return true
}

/** Lo que es para la APP y no para el chat: su código, o cerrar sus sesiones. */
const atenderLaApp = async (deps: MarketplaceEntryDeps, text: string, from: string, customerId: string) => (
  await atenderCodigoDeLaApp(deps, text, from) || atenderCerrarSesion(deps, text, customerId)
)

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

  // Lo de la app —su código, o CERRAR SESIÓN—: DESPUÉS de los tres frenos y ANTES del menú.
  if (await atenderLaApp(deps, text, from, customer.id)) return

  // Lo que hace falta para contestar, leído A LA VEZ y DESPUÉS de los frenos:
  // `leerElTurno`. Y la ciudad del cliente (2026-10-05), que ata el catálogo
  // para todo lo que viene después: `marketplace-ciudad.ts`.
  const { conversation, filas, negocioActual } = await leerElTurno(database, customer.id)
  const ciudades = ciudadesDe(filas)
  const ciudad = ciudadEfectiva(ciudades, customer.city_id, negocioActual?.city_id)
  const categorias = categoriasDe(filas, ciudad, ciudades.length > 1)
  deps = conLaCiudad(deps, ciudad)

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

  // Un marketplace sin un solo local disponible —en NINGUNA ciudad— no puede
  // ofrecer nada, y una lista vacía es una calle sin salida que cuesta un mensaje.
  if (!ciudades.length) {
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

  // ── 0d. La ciudad (2026-10-05): antes que MENÚ, que sin ella no tiene menú.
  if (await atenderLaCiudad(deps, text, customer.id, {
    filas, ciudades, ciudad, negocio: estado.negocio, comprobante: esMarcadorDeComprobante,
    flowState: conversation?.flow_state, version: conversation?.version,
  })) return

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
