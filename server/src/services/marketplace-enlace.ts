import type { MarketplaceBusiness, MarketplaceReply } from './marketplace-menu'
import type { MarketplaceEntryDeps } from './marketplace-entry-tipos'

// El ENLACE de la tienda: mandarlo, matar el anterior, devolverlo, y guardar dónde está el cliente.
// Una parte de la entrada del marketplace (`marketplace-entry.ts`), separada el
// 2026-10-07 cuando aquel archivo pasó de 1.000 líneas. Ver su cabecera.

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
export async function mandarElEnlace(
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
export function apuntarPaso(
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

export async function matarEnlaceAnterior(
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

export async function abandonarPedido(
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
export async function devolverElEnlace(
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
export async function guardar(
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
