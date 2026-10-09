import { esComandoMenu, recordarComprobantePendiente, recordarPagoEnRevision, recordarPedidoEnProceso, responderAlMenu, verCategorias, textoDeAdjuntoRecibido, resolverReinicio, ADVERTENCIA_POR_INSULTOS, avisoDeBloqueoPorInsultos, OPCION_ANTERIOR, type MarketplaceCategory, type MarketplaceReply, type MarketplaceView } from './marketplace-menu'
import { contieneInsulto } from '../lib/malas-palabras'
import { esComprobante, esComprobanteAmbiguo, esFotoQueNoEsComprobante, preguntaDeQueLocal, rechazoDelMarcador, RESPUESTA_COMPROBANTE, respuestaNoEsComprobante, comprobanteCuadra, esComprobanteQueNoCuadra, motivoDelDescuadre, RESPUESTA_COMPROBANTE_CUADRA, respuestaComprobanteNoCuadra } from './payment-proof-inbox'
import { categoriasDe, ciudadEscrita, esComandoCiudad, preguntarCiudad, type CategoriaEnCiudad, type CiudadConLocales } from './marketplace-ciudad'
import type { MarketplaceEntryDeps } from './marketplace-entry-tipos'
import { apuntarPaso, matarEnlaceAnterior, abandonarPedido, devolverElEnlace, guardar } from './marketplace-enlace'

// Las puertas antes del menú: insultos, la ciudad, MENÚ, el reinicio, el candado y el comprobante.
// Una parte de la entrada del marketplace (`marketplace-entry.ts`), separada el
// 2026-10-07 cuando aquel archivo pasó de 1.000 líneas. Ver su cabecera.

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
export async function atenderInsulto(
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
 * La ciudad del cliente (2026-10-05). La regla de qué ciudad se le enseña vive
 * en `marketplace-ciudad.ts`; aquí se le pregunta y se anota lo que elige.
 *
 * Contesta y devuelve `true` en tres casos:
 *   · escribió CIUDAD («cambiar de ciudad»…): se le enseña la lista;
 *   · eligió una —tocándola o escribiendo su nombre— cuando se le preguntó o
 *     cuando no tenía ninguna: se anota y se le da la bienvenida con el menú
 *     de ESA ciudad;
 *   · no tiene ciudad y hay varias con locales: se le pregunta.
 *
 * ⚠️ Va ANTES que MENÚ porque MENÚ pinta el menú, y sin ciudad no hay nada
 * que pintar. Y DESPUÉS de la pausa y del techo: a quien está silenciado no se
 * le pregunta nada.
 *
 * ⚠️ Un COMPROBANTE nunca se intercepta: quien acaba de pagar no puede
 * quedarse sin respuesta por una pregunta de ciudad. En la práctica no pasa
 * —quien paga tiene un local elegido y su ciudad sale de él—, pero esta puerta
 * no puede depender de eso.
 *
 * ⚠️ Con un local elegido, CIUDAD no le cambia el menú por debajo del pedido:
 * se le dice cómo salir primero. Soltar el local aquí se saltaría lo que MENÚ
 * cuida al salir (el pedido sin pagar, el comprobante pendiente).
 */
export async function atenderLaCiudad(
  deps: MarketplaceEntryDeps,
  text: string,
  customerId: string,
  contexto: {
    filas: CategoriaEnCiudad[]
    ciudades: CiudadConLocales[]
    ciudad: CiudadConLocales | null
    negocio: { name: string } | null
    comprobante: boolean
    flowState: Record<string, unknown> | null | undefined
    version: number | undefined
  },
): Promise<boolean> {
  const { ciudades, ciudad, negocio } = contexto
  // ⚠️ También el que NO cuadra: `esMarcadorDeComprobante` no lo incluye, y la
  // prueba lo cazó preguntándole la ciudad a quien acababa de pagar.
  if (contexto.comprobante || esComprobanteQueNoCuadra(text)) return false
  const responder = async (respuesta: MarketplaceReply) => {
    await guardar(deps, customerId, contexto.version, respuesta, { soltarLocal: false, conservarEstado: true })
    await deps.send(respuesta.reply, respuesta.options)
    return true
  }

  if (esComandoCiudad(text)) {
    if (negocio) {
      await deps.send(`Estás en el pedido de *${negocio.name}*. Para cambiar de ciudad, escribe *MENÚ* y después *CIUDAD*.`, [])
      return true
    }
    return responder(preguntarCiudad(ciudades))
  }

  const enLaPregunta = (contexto.flowState?.vista as MarketplaceView | undefined)?.vista === 'ciudades'
  const elegida = (enLaPregunta || !ciudad) && !negocio ? ciudadEscrita(text, ciudades) : null
  if (elegida) {
    // Falla ABIERTO: sin anotarla se le enseña igual, y el próximo mensaje se
    // le vuelve a preguntar — mejor preguntar de más que dejarle sin menú.
    await deps.database.setCustomerCity?.(customerId, elegida.id).catch(() => undefined)
    deps.logger?.log(`📍 [marketplace] eligió ${elegida.nombre}`)
    apuntarPaso(deps, { customerId, tipo: 'menu' })
    return responder(verCategorias(categoriasDe(contexto.filas, elegida, ciudades.length > 1), 0, true))
  }

  // ⚠️ Con un local elegido NUNCA se pregunta, aunque no se sepa la ciudad
  // (un local que se quedó sin ella): se le dejaría preguntando sin poder
  // elegir, y ese pedido no necesita el menú. MENÚ lo saca de ahí.
  if (!ciudad && !negocio) return responder(preguntarCiudad(ciudades))
  return false
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
export async function atenderComandoMenu(
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
export async function atenderConfirmacionDeReinicio(
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
export async function atenderCandado(
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
export async function atenderComprobante(
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
