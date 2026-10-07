import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// Quien escribe por molestar y los bloqueos del dueño, en la mini app y en
// su chat. Vivían en `storefront.ts` hasta el 2026-10-07 (ningún archivo pasa
// de 1.000 líneas). Todo filtra por business_id.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')
// La persona por su teléfono, como la resuelve la tienda: un bloqueo es de ESA persona.
const { resolveCustomer } = require('./storefront') as typeof import('./storefront')

const fail = (error: { message?: string } | null, context: string): void => {
  if (error) throw new Error(`${context}: ${error.message || 'sin detalle'}`)
}

// ── Quien escribe por molestar ─────────────────────────────────────────────

/**
 * ¿Se le contesta a este cliente, y cómo?
 *
 * Todo dentro de PostgreSQL y en una sola operación: contar aquí y escribir
 * después deja una carrera con los mensajes que llegan a la vez, que es justo
 * lo que hace quien escribe rápido para molestar.
 *
 * Nunca lanza hacia arriba con un `permitido: false`: si la base falla se
 * prefiere contestar. Quedarse callado por un fallo nuestro deja sin atender a
 * un cliente de verdad, y eso cuesta más que un mensaje de más.
 */
const claimMiniappReply = async (
  businessId: string,
  customerId: string,
  limites: {
    avisoDesde?: number
    tope?: number
    silencioHoras?: number
    /** El mensaje entrante que provocó la respuesta, para no contarlo dos veces. */
    mensajeId?: string | null
  } = {},
): Promise<{
  /** `false` = no se le contesta: está bloqueado o silenciado. */
  permitido: boolean
  motivo: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
  /** Cuántas van en esta hora, con esta incluida. */
  respuestas: number
}> => {
  const { data, error } = await db.rpc('claim_miniapp_reply', {
    p_business_id: businessId,
    p_customer_id: customerId,
    p_aviso_desde: limites.avisoDesde ?? 5,
    p_tope: limites.tope ?? 10,
    p_silencio_horas: limites.silencioHoras ?? 24,
    p_message_id: limites.mensajeId || undefined,
  })
  fail(error, 'No se pudo comprobar el ritmo de respuestas')
  const respuesta = (data || {}) as {
    permitido?: boolean
    motivo?: 'ok' | 'con_telefono' | 'bloqueado' | 'silenciado'
    respuestas?: number
  }
  return {
    permitido: respuesta.permitido !== false,
    motivo: respuesta.motivo || 'ok',
    respuestas: Number(respuesta.respuestas) || 0,
  }
}

/**
 * ¿Este teléfono está bloqueado en este negocio?
 *
 * ⚠️ Se normaliza a dígitos porque `customers.phone` se guarda así, y el bot
 * recibe el número con «+» (`+593…`). Buscar sin normalizar no falla: devuelve
 * vacío, que aquí significaría «no está bloqueado» — el peor fallo posible
 * para un bloqueo.
 */
/**
 * Lo que hay que saber de un bloqueo para poder explicarlo.
 *
 * ⚠️ El tipo va ESCRITO EN LÍNEA y no como `interface` con nombre: este
 * archivo termina en `export =`, que no admite otros `export`, y sin exportar
 * el nombre TypeScript no puede describir `db` para quien lo importa
 * («cannot be named», TS4023). Escrito así viaja estructuralmente y no hay
 * nada que exportar.
 */
type EstadoDeBloqueo = {
  blocked: boolean
  /** Del dueño: no caduca, y por eso no promete plazo. */
  permanent: boolean
  /** Hasta cuándo, solo en los temporales que siguen vigentes. */
  until: string | null
}

const SIN_BLOQUEO = { blocked: false, permanent: false, until: null }

/**
 * El estado del bloqueo de esta persona en este local.
 *
 * ⚠️ Lo responde la BASE (`storefront_customer_block_state`) y no TypeScript,
 * y ese es el arreglo entero del 2026-08-29. Aquí vivía una segunda regla
 * —`Boolean(blocked_at)`— que se contradecía con la del disparador de pedidos:
 * con un bloqueo temporal ya VENCIDO el chat decía «bloqueado» y la base
 * dejaba insertar. Por esa grieta entró el pedido #74. Ahora solo hay una
 * respuesta, y la da quien también decide si el `insert` pasa.
 *
 * ⚠️ Falla ABIERTO (`SIN_BLOQUEO`): dejar fuera a un cliente legítimo por un
 * fallo nuestro es peor que dejar entrar a un bloqueado, que además choca
 * contra el disparador al confirmar.
 */
const customerBlockState = async (
  businessId: string,
  customerId: string,
): Promise<{ blocked: boolean; permanent: boolean; until: string | null }> => {
  if (!businessId || !customerId) return SIN_BLOQUEO
  const { data, error } = await db.rpc('storefront_customer_block_state', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  if (error) return SIN_BLOQUEO
  const estado = (data || {}) as Partial<EstadoDeBloqueo>
  return {
    blocked: estado.blocked === true,
    permanent: estado.permanent === true,
    until: estado.until ?? null,
  }
}

/** El mismo estado, pero llegando por el TELÉFONO — que es lo que trae el chat. */
const contactBlockState = async (
  businessId: string,
  phone: string,
): Promise<{ blocked: boolean; permanent: boolean; until: string | null }> => {
  const digitos = String(phone || '').replace(/\D/g, '')
  if (!businessId || !digitos) return SIN_BLOQUEO
  const { data, error } = await db
    .from('business_customers')
    .select('customer_id,customers!inner(phone)')
    .eq('business_id', businessId)
    .eq('customers.phone', digitos)
    .maybeSingle()
  if (error) return SIN_BLOQUEO
  const customerId = (data as { customer_id?: string } | null)?.customer_id
  if (!customerId) return SIN_BLOQUEO
  return customerBlockState(businessId, customerId)
}

const isContactBlocked = async (businessId: string, phone: string): Promise<boolean> => (
  (await contactBlockState(businessId, phone)).blocked
)

/**
 * ¿Toca EXPLICARLE el bloqueo a este cliente? Una sola vez.
 *
 * Devuelve `true` en su primer intento tras ser bloqueado y `false` en todos
 * los siguientes, así el bloqueado nunca cuesta más mensajes que un cliente
 * normal — que es lo que pasaría avisando cada vez, porque quien molesta
 * insiste.
 *
 * ⚠️ Falla hacia el SILENCIO (`false`): ante un fallo de la base se manda el
 * mensaje neutro de siempre, que es la conducta anterior a esto. Al revés
 * —avisar por defecto— un fallo repetido convertiría el bloqueo en una fuente
 * de mensajes pagados.
 */
const claimBlockedNotice = async (
  businessId: string,
  customerId: string,
): Promise<boolean> => {
  if (!businessId || !customerId) return false
  const { data, error } = await db.rpc('claim_blocked_notice', {
    p_business_id: businessId,
    p_customer_id: customerId,
  })
  if (error) return false
  return data === true
}

/**
 * Lo mismo cuando ya se sabe QUIÉN es: el camino de la mini app.
 *
 * ⚠️ Pregunta a la BASE, como todo lo demás desde el 2026-08-29. Aquí vivía
 * una copia de la regla (`estaBloqueado`) y esa fue la tercera de cuatro: cada
 * copia acaba contestando distinto, y esta decide si un pedido se crea.
 */
const isCustomerBlocked = async (businessId: string, customerId: string): Promise<boolean> => (
  (await customerBlockState(businessId, customerId)).blocked
)

/**
 * Los contactos bloqueados AHORA de un negocio, con su plazo.
 *
 * Se consultan aparte y no dentro de la lista de conversaciones a propósito:
 * son POCOS —y en casi todos los negocios, ninguno—, mientras que la lista de
 * chats se pide cada pocos segundos.
 *
 * ⚠️ Lo calcula la BASE (`business_blocked_contacts`), que a su vez llama a
 * `storefront_customer_block_state` fila por fila. Aquí había un
 * `.not('blocked_at', 'is', null)` —la CUARTA copia de la regla— y mentía: el
 * bloqueo temporal también pone `blocked_at`, así que a los 30 minutos el
 * cliente ya podía pedir y el panel seguía diciendo «Bloqueado» para siempre.
 * Lo vio el dueño mirando su pantalla de Clientes el 2026-08-29.
 *
 * ⚠️ Devuelve el PLAZO además del teléfono: es lo que deja al panel distinguir
 * «Bloqueado por ti» de «Bloqueado 20 min», que son dos cosas distintas — una
 * la levanta el dueño y la otra se va sola.
 */
const getBlockedContacts = async (businessId: string): Promise<{
  phone: string
  until: string | null
  permanent: boolean
}[]> => {
  if (!businessId) return []
  const { data, error } = await db.rpc('business_blocked_contacts', {
    p_business_id: businessId,
  })
  fail(error, 'No se pudieron leer los números bloqueados')
  const filas = (data || []) as {
    phone?: string | null
    until?: string | null
    permanent?: boolean | null
  }[]
  return filas
    .map(fila => ({
      phone: String(fila.phone || '').trim(),
      until: fila.until ?? null,
      permanent: fila.permanent === true,
    }))
    .filter(fila => Boolean(fila.phone))
}

/**
 * El dueño bloquea o desbloquea un número desde su panel.
 *
 * Crea el cliente si no existía: quien escribe por molestar puede no haber
 * pedido nunca, y es justo a ese al que hay que poder bloquear.
 *
 * Desbloquear limpia TAMBIÉN el silencio automático y el contador: si el dueño
 * decide dar otra oportunidad, empieza de cero. Dejarle el silencio puesto
 * haría que el desbloqueo pareciera no funcionar durante horas.
 */
const setContactBlocked = async (
  businessId: string,
  phone: string,
  bloqueado: boolean,
): Promise<{ blocked: boolean }> => {
  const customer = await resolveCustomer({ businessId, phone })
  const ahora = new Date().toISOString()
  const { error } = await db
    .from('business_customers')
    .update(bloqueado
      // ⚠️ `blocked_until: null` al BLOQUEAR, y es un arreglo, no una limpieza
      // de cortesía (2026-08-29). Sin él, bloquear a quien tuvo un bloqueo
      // automático antes NO surtía efecto: la regla dice que un bloqueo es
      // permanente cuando `blocked_at` está puesto Y `blocked_until` es nulo,
      // así que con un `blocked_until` vencido no era ni permanente ni
      // temporal — el dueño pulsaba «Bloquear», el panel le decía «Cliente
      // bloqueado», y esa persona seguía pudiendo pedir. La decisión del dueño
      // manda sobre cualquier automático pendiente.
      ? { blocked_at: ahora, blocked_until: null, updated_at: ahora }
      // Desbloquear limpia también `blocked_notified_at`: si el dueño lo
      // vuelve a bloquear más adelante, esa es una decisión NUEVA y merece su
      // propia explicación.
      //
      // ⚠️ Y `blocked_until`, por lo mismo al revés: sin él, desbloquear a
      // quien tenía un temporal vigente lo dejaba bloqueado igual mientras el
      // panel ya lo mostraba libre. Cuando el dueño perdona, perdona entero.
      // ⚠️ Y los DOS contadores a cero (2026-09-03). Sin esto, el dueño
      // levantaba el bloqueo y el cliente seguía a UN paso del siguiente: con
      // `unpaid_expiries` en 4 y el límite en 2, el próximo pedido que se le
      // caducara lo bloqueaba otra vez, media hora, y otra vez, y otra. El
      // perdón duraba hasta el primer tropiezo, que no es perdonar.
      : {
        blocked_at: null, blocked_until: null, blocked_notified_at: null,
        muted_until: null, reply_count: 0, reply_window_start: null,
        unpaid_expiries: 0, rejected_receipts: 0,
        updated_at: ahora,
      })
    .eq('business_id', businessId)
    .eq('customer_id', customer.id)
  fail(error, 'No se pudo actualizar el bloqueo')
  return { blocked: bloqueado }
}

export = {
  claimMiniappReply,
  customerBlockState,
  contactBlockState,
  isContactBlocked,
  claimBlockedNotice,
  isCustomerBlocked,
  getBlockedContacts,
  setContactBlocked,
}
