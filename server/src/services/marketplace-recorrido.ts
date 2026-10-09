import { paso, verCategorias, verNegocios, esAdjuntoSinTexto, verResultados, esSaludo, esPreguntaPorAbiertos, verAbiertos, type MarketplaceBusiness, type MarketplaceCategory, type MarketplaceReply, type MarketplaceView } from './marketplace-menu'
import { isOutsideHours, proximaApertura } from './schedule'
import type { MarketplaceEntryDeps } from './marketplace-entry-tipos'
import { mandarElEnlace, apuntarPaso, guardar } from './marketplace-enlace'

// Recorrer el menú: las categorías, los abiertos, la búsqueda y entregar un local.
// Una parte de la entrada del marketplace (`marketplace-entry.ts`), separada el
// 2026-10-07 cuando aquel archivo pasó de 1.000 líneas. Ver su cabecera.

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
export async function recorrerElMenu(
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
