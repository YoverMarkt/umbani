import type { MarketplaceBusiness } from './marketplace-menu'
import type { ScheduleRecord } from './schedule'
import type { CategoriaEnCiudad } from './marketplace-ciudad'

// Lo que la entrada del marketplace pide a la base y a quien la llama.
// Una parte de la entrada del marketplace (`marketplace-entry.ts`), separada el
// 2026-10-07 cuando aquel archivo pasó de 1.000 líneas. Ver su cabecera.

export interface MarketplaceEntryDatabase {
  /**
   * Inicio de sesión de la app (2026-09-28): verifica el código con el
   * REMITENTE de WhatsApp. Opcional: el simulador y el canario no lo tienen.
   */
  verifyAppLoginCode?(code: string, phone: string): Promise<boolean>
  /** «CERRAR SESIÓN» (2026-09-29). ⚠️ ESCRIBE: el canario y el simulador la sustituyen. */
  cerrarSesionesDeLaApp?(customerId: string): Promise<void>
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
  /** Con la ciudad que eligió (2026-10-05), si eligió alguna. */
  resolveMarketplaceCustomer(phone: string): Promise<{ id: string; name: string | null; city_id?: string | null }>
  /**
   * Anota la ciudad que eligió. ⚠️ ESCRIBE: el canario la sustituye. Opcional:
   * sin ella se le enseña la ciudad elegida este turno y se le vuelve a
   * preguntar en el siguiente, que es fallar hacia preguntar de más.
   */
  setCustomerCity?(customerId: string, cityId: string): Promise<void>
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
  /** Una fila por ciudad y categoría (2026-10-05). Ver `marketplace-ciudad.ts`. */
  getMarketplaceCategories(): Promise<CategoriaEnCiudad[]>
  /** Sin ciudad, ninguno: la base falla cerrado. La ata `conLaCiudad`. */
  getMarketplaceBusinesses(code: string, cityId?: string | null): Promise<MarketplaceBusiness[]>
  getBusinessById(id: string): Promise<{
    id: string
    name: string
    slug: string | null
    /** La ciudad del local: la de quien está a mitad de un pedido en él. */
    city_id?: string | null
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
    cityId?: string | null,
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
