// ═══════════════════════════════════════════════════════════════════════════
// EL CANARIO DEL CAMINO DEL CLIENTE
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ Nace de un día concreto: el 2026-09-13 se encontraron TRES fallos rojos
// probando la app a mano, y ninguno lo cazó el CI. El peor —el chat sin
// precios y sin botón de pedir, que dejó a los dos locales sin poder vender
// cuatro días— convivió con 2.727 pruebas en verde y seis checks pasando.
//
// El hueco es estructural y está descrito en la skill `camino-real`: una
// prueba responde «dado este input, el código hace X». Ninguna responde
// «¿un cliente REAL puede comprar ahora mismo?». Eso solo lo contesta
// recorrer el camino con los DATOS DE PRODUCCIÓN.
//
// ⚠️ NO ESCRIBE NADA. Ni pedidos, ni conversaciones, ni clientes: lee el
// catálogo real y le pone memoria falsa a lo que escribiría. Un vigilante que
// ensucia la base se acaba apagando, y entonces no vigila.
//
// ⚠️ NO MANDA UN SOLO WHATSAPP. Recorre el mismo código que el webhook, pero
// su `send` guarda en un array. Vigilar no puede costar dinero.
//
// ⚠️ Avisa por el REGISTRO DE ERRORES (decisión del dueño, 2026-09-13): es
// donde ya mira, no cuesta mensajes, y agrupa por huella — un fallo que dura
// una semana es UNA fila con su contador, no siete avisos.

import type { MarketplaceEntryDeps } from './marketplace-entry'

/**
 * La última vuelta del canario, para `/api/health`.
 *
 * ⚠️ Existe porque un vigilante SILENCIOSO no se distingue de uno MUERTO. El
 * canario calla cuando todo va bien —así debe ser: el registro de errores es
 * para errores— pero entonces «no hay entradas» significa a la vez «todo
 * correcto» y «nunca corrió», y no hay forma de saber cuál.
 *
 * Se descubrió al desplegarlo: sin CLI de Railway no había manera de
 * comprobar que se había ejecutado. Exponerlo en la salud es gratis, no
 * ensucia el registro y lo hace comprobable de un vistazo — el mismo remedio
 * que `version` para los despliegues colgados del 2026-08-29.
 */
export interface UltimaVuelta {
  at: string
  revisados: number
  locales: number
  cerrados: number
  fallos: number
}

let ultimaVuelta: UltimaVuelta | null = null

/** La última vuelta, o `null` si todavía no ha corrido ninguna. */
export const ultimaVueltaDelCanario = (): UltimaVuelta | null => ultimaVuelta

/** Un fallo del camino: qué local, qué paso y qué se esperaba. */
export interface HallazgoDelCanario {
  businessId: string
  negocio: string
  paso: string
  detalle: string
}

export interface CanarioDeps {
  database: Record<string, unknown>
  handleMarketplaceMessage(
    entrada: { from: string; text: string; inboundId?: string | null },
    deps: MarketplaceEntryDeps,
  ): Promise<void>
  registrarError(input: {
    businessId?: string | null
    category: 'servidor'
    code: string
    message: unknown
    context?: Record<string, unknown>
  }): void | Promise<unknown>
  logger?: { log(...args: unknown[]): void }
}

/**
 * El teléfono del canario.
 *
 * ⚠️ Nunca llega a la base —`resolveMarketplaceCustomer` se sustituye— pero se
 * deja reconocible por si algún día aparece en un registro: que se sepa de un
 * vistazo que no es una persona.
 */
const TELEFONO_CANARIO = '000000000001'

const textoDe = (enviados: { reply: string; options: unknown[] }[]): string => (
  enviados.map(e => `${e.reply} || ${JSON.stringify(e.options)}`).join('\n')
)

/**
 * Las dependencias del recorrido: catálogo REAL, escritura de mentira.
 *
 * ⚠️ Se sustituye TODO lo que escribiría. `resolveMarketplaceCustomer` crea un
 * cliente, `advanceConversation` escribe la conversación y `claimMarketplaceReply`
 * gasta del techo de mensajes: los tres se reemplazan por memoria. Lo demás
 * —productos, precios, opciones, horarios, la regla de margen— es el de verdad,
 * que es justo lo que hay que vigilar.
 */
function dependenciasDelCanario(
  deps: CanarioDeps,
  enviados: { reply: string; options: unknown[] }[],
): MarketplaceEntryDeps {
  let memoria: Record<string, unknown> | null = null
  let localElegido: string | null = null
  return {
    database: {
      ...deps.database,
      resolveMarketplaceCustomer: async () => ({ id: 'canario', name: null }),
      getConversation: async () => ({
        current_state: localElegido ? 'pidiendo' : 'navegando',
        selected_business_id: localElegido,
        shopping_locked: Boolean(localElegido),
        flow_state: memoria,
        version: 1,
      }),
      advanceConversation: async (_id: string, patch: Record<string, unknown>) => {
        if (patch.flowState !== undefined) {
          memoria = patch.flowState as Record<string, unknown> | null
        }
        if (patch.businessId) localElegido = String(patch.businessId)
        if (patch.clearBusiness) localElegido = null
        return { conflicto: false }
      },
      claimMarketplaceReply: async () => ({ permitido: true, respuestas: 0 }),
      // Tampoco la marca de la lista ni la huella de la respuesta (2026-09-26):
      // escribirían en la conversación de un cliente que no existe.
      marcarUltimaLista: async () => false,
      anotarUltimaRespuesta: async () => undefined,
      // Ni la advertencia por opciones viejas ni la pausa (2026-09-28).
      anotarAvisoDeOpcionVieja: async () => undefined,
      pausarElMenu: async () => false,
      // Ni cerrar las sesiones de la app (2026-09-29).
      cerrarSesionesDeLaApp: async () => undefined,
      // Ni los pasos del menú (2026-09-27). Se colaban: en cada vuelta intentaba
      // guardarlos con el cliente 'canario', que no es un uuid, y el log se
      // llenaba de «❌ registrar el paso del menú». Si llegara a funcionar,
      // inflaría los reportes de «Uso de Umbani» con visitas que no existen.
      logMarketplaceEvent: async () => undefined,
      // El bloqueo de plataforma y los insultos ESCRIBEN (2026-09-27): el
      // primero reclama el aviso de vuelta, el segundo advierte o bloquea.
      claimPlatformBlockState: async () => ({ bloqueado: false }),
      registerInsult: async () => ({ accion: 'nada' }),
      isContactBlocked: async () => false,
    } as unknown as MarketplaceEntryDeps['database'],
    send: async (reply: string, options: unknown[] = []) => {
      enviados.push({ reply, options })
    },
    // El enlace no se emite: crearía una sesión de tienda por cada vuelta.
    issueLink: async () => null,
    sendLink: async () => true,
    // Si el canario llegara a intentar crear un pedido, que falle ruidosamente
    // en vez de dejar uno de prueba en la cocina de alguien.
    crearPedidoCompleto: async () => {
      throw new Error('el canario nunca crea pedidos')
    },
  } as unknown as MarketplaceEntryDeps
}

export function crearCanario(deps: CanarioDeps) {
  /**
   * El catálogo que lee la MINI APP: que todo producto tenga precio.
   *
   * ⚠️ Es la otra mitad del mismo fallo. El #343 dejó al chat sin precios
   * durante cuatro días y la mini app se salvó por usar otra conversión —
   * pero el fallo simétrico existe, y por esta puerta entra el mismo dinero.
   *
   * ⚠️ Se usa `precioDeVitrina` con la regla REAL del negocio: comprobar el
   * precio del comercio no serviría, porque lo que el cliente lee —y paga— es
   * el que lleva el margen.
   */
  async function revisarCatalogo(
    negocio: { id: string },
    anotar: (paso: string, detalle: string) => void,
  ): Promise<void> {
    const base = deps.database as {
      getStorefrontProducts(id: string): Promise<Array<Record<string, unknown>>>
      getBusinessPricingRule(id: string): Promise<unknown>
    }
    const tienda = require('./storefront') as typeof import('./storefront')
    const [productos, reglaCruda] = await Promise.all([
      base.getStorefrontProducts(negocio.id).catch(() => []),
      base.getBusinessPricingRule(negocio.id).catch(() => null),
    ])
    const activos = (productos || []).filter(p => p.active !== false)
    if (!activos.length) {
      anotar('catalogo', 'la tienda no tiene un solo producto activo')
      return
    }
    const regla = tienda.reglaDeMargen(reglaCruda)
    const sinPrecio = activos.filter((p) => {
      const crudo = Number(p.price_sale) > 0 ? p.price_sale : p.price
      const numero = Number.parseFloat(String(crudo ?? ''))
      const vitrina = Number.isFinite(numero) ? tienda.precioDeVitrina(numero, regla) : null
      return !(Number(vitrina) > 0)
    })
    if (sinPrecio.length) {
      anotar('precio', `${sinPrecio.length} producto(s) de la tienda sin precio: `
        + sinPrecio.slice(0, 3).map(p => String(p.name)).join(', '))
    }
  }

  /**
   * Recorre UN local como lo haría un cliente y devuelve lo que falle.
   *
   * El recorrido es el mínimo que habría cazado los tres fallos del
   * 2026-09-13: saludar, entrar al local y pedir que enseñe sus productos.
   */
  async function revisarLocal(
    negocio: { id: string; name?: string | null; type?: string | null },
    categoria: string,
  ): Promise<{ fallos: HallazgoDelCanario[]; revisado: boolean }> {
    const nombre = String(negocio.name || negocio.id)
    const fallos: HallazgoDelCanario[] = []
    const anotar = (paso: string, detalle: string) => {
      fallos.push({ businessId: negocio.id, negocio: nombre, paso, detalle })
    }

    let revisado = true
    const enviados: { reply: string; options: unknown[] }[] = []
    const entrada = dependenciasDelCanario(deps, enviados)
    const escribir = (texto: string) => deps.handleMarketplaceMessage(
      { from: TELEFONO_CANARIO, text: texto, inboundId: null }, entrada,
    )

    try {
      // 1. El saludo tiene que RECIBIR, no repetir una búsqueda anterior.
      await escribir('hola')
      if (!enviados.length) {
        anotar('bienvenida', 'Umbani no contestó al saludo')
        return { fallos, revisado }
      }

      // 2. La CATEGORÍA. Sin este paso, escribir el nombre del local desde la
      //    portada es una BÚSQUEDA y no una selección: el canario se quedaba
      //    en la lista de resultados y daba por roto un local perfecto. Se
      //    descubrió corriéndolo contra producción — un canario que grita en
      //    falso se acaba ignorando, y entonces no vigila.
      //
      // ⚠️ La categoría viene DADA, no deducida del tipo. Adivinarla con
      //    `code === type` también falló contra producción: el tipo de Monster
      //    Pizza es «pizzería» y el código de su categoría «pizzerias». La base
      //    los relaciona normalizando, y duplicar esa normalización aquí sería
      //    la segunda copia que acaba discrepando.
      enviados.length = 0
      await escribir(categoria)
      if (!textoDe(enviados).includes(nombre)) {
        anotar('categoria', `no aparece en «${categoria}»`)
        return { fallos, revisado }
      }

      // 3. Entrar al local, ahora sí tocándolo en su lista.
      enviados.length = 0
      await escribir(nombre)
      const alEntrar = textoDe(enviados)
      if (!alEntrar.trim()) {
        anotar('entrar', 'el local no respondió al elegirlo')
        return { fallos, revisado }
      }
      // Cerrado no es un fallo: es la respuesta correcta fuera de horario.
      // ⚠️ Cerrado NO es un fallo —es la respuesta correcta fuera de horario—
      // pero TAMPOCO es una revisión: su menú no se pudo mirar. Se marca, y el
      // resumen lo dice. Un canario que canta «todo bien» sobre lo que no pudo
      // ver es peor que uno que calla: da una seguridad que no tiene.
      if (/cerrado ahora mismo/i.test(alEntrar)) return { fallos, revisado: false }

      // 4. La carta que ve el cliente vive en la MINI APP desde que se retiró
      //    el pedido por chat (2026-09-15), así que se vigila el CATÁLOGO que
      //    lee la tienda: ahí es donde estaría el mismo fallo de precios del
      //    #343 —una carta entera sin una sola cifra—.
      await revisarCatalogo(negocio, anotar)
    } catch (error) {
      anotar('excepción', (error as Error).message || 'error desconocido')
    }
    return { fallos, revisado }
  }

  /**
   * La ronda completa. Se llama sola cada mañana desde `index.ts`.
   *
   * ⚠️ Nunca lanza: un canario que tumba el arranque es peor que no tenerlo.
   */
  async function vigilar(): Promise<HallazgoDelCanario[]> {
    const todos: HallazgoDelCanario[] = []
    try {
      // ⚠️ Se recorre el marketplace COMO LO RECORRE EL CLIENTE: las
      // categorías que ve, y dentro de cada una los locales que la base dice
      // que tiene. No se parte de `getAllBusinesses` a propósito — un local
      // activo que NO aparezca en ninguna categoría es invisible para quien
      // compra, y eso es justo un fallo que hay que cazar, no un caso que
      // saltarse listándolo por otro camino.
      const base = deps.database as {
        getMarketplaceCategories(): Promise<Array<{ code?: string; label?: string }>>
        getMarketplaceBusinesses(codigo: string): Promise<Array<Record<string, unknown>>>
      }
      const categorias = await base.getMarketplaceCategories()
      let locales = 0
      let cerrados = 0

      for (const categoria of categorias || []) {
        if (!categoria.code || !categoria.label) continue
        const negocios = await base.getMarketplaceBusinesses(categoria.code).catch(() => [])
        for (const negocio of negocios || []) {
          locales += 1
          const visita = await revisarLocal(
            {
              id: String(negocio.id),
              name: negocio.name as string | null,
              type: negocio.type as string | null,
            },
            String(categoria.label),
          )
          todos.push(...visita.fallos)
          if (!visita.revisado) cerrados += 1
        }
      }

      for (const fallo of todos) {
        await deps.registrarError({
          businessId: fallo.businessId,
          category: 'servidor',
          code: `canario_${fallo.paso}`,
          message: `${fallo.negocio}: ${fallo.detalle}`,
          context: { paso: fallo.paso, negocio: fallo.negocio },
        })
      }

      ultimaVuelta = {
        at: new Date().toISOString(),
        revisados: locales - cerrados,
        locales,
        cerrados,
        fallos: todos.length,
      }
      // ⚠️ El resumen distingue lo revisado de lo que no se pudo mirar.
      const sinMirar = cerrados ? ` · ${cerrados} cerrado(s), sin revisar` : ''
      deps.logger?.log(todos.length
        ? `🐤 [canario] ${todos.length} fallo(s) en el camino del cliente${sinMirar}`
        : `🐤 [canario] ${locales - cerrados}/${locales} local(es) revisados: se puede comprar${sinMirar}`)
    } catch (error) {
      // Que el canario falle NO es que la app falle, pero hay que enterarse:
      // un vigilante mudo se confunde con «todo va bien».
      await Promise.resolve(deps.registrarError({
        category: 'servidor',
        code: 'canario_caido',
        message: (error as Error).message || 'el canario no pudo correr',
      })).catch(() => undefined)
    }
    return todos
  }

  return { vigilar, revisarLocal }
}

/**
 * El canario ya cableado con lo de verdad.
 *
 * ⚠️ Se arma aquí y no en `index.ts` para que exista UN solo canario: si el
 * arranque construyera el suyo, una prueba podría pasar sobre un canario que
 * no es el que corre en producción — que es la clase de fallo que este módulo
 * existe para cazar.
 */
export async function vigilarElCaminoDelCliente(): Promise<HallazgoDelCanario[]> {
  const database = require('../db') as Record<string, unknown>
  const { handleMarketplaceMessage } = require('./marketplace-entry') as typeof import('./marketplace-entry')
  const { recordError } = require('./error-log') as typeof import('./error-log')
  return crearCanario({
    database,
    handleMarketplaceMessage: handleMarketplaceMessage as CanarioDeps['handleMarketplaceMessage'],
    registrarError: recordError as CanarioDeps['registrarError'],
    logger: console,
  }).vigilar()
}
