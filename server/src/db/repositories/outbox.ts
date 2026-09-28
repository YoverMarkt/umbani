import type { SupabaseClient } from '@supabase/supabase-js'

// LA COLA DE AVISOS QUE FALLARON
//
// El aviso al cliente se RECLAMA antes de enviarse, y el reclamo es atómico
// para que dos toques en el botón no manden —ni cobren— dos mensajes. La
// consecuencia que no se veía: si el envío falla, el reclamo ya se consumió y
// ese aviso no sale nunca más.
//
// Aquí queda encolado hasta que salga o se agoten los intentos.

const db: SupabaseClient = require('../client') as typeof import('../client')

export interface OutboxEvent {
  id: string
  business_id: string
  event_type: string
  aggregate_id: string
  payload: Record<string, unknown>
  attempts: number
  lease_token: string | null
}

/**
 * Encola un aviso. Devuelve el id, o `null` si ese hito ya estaba encolado.
 *
 * ⚠️ Nace con una ventana de gracia: el envío inmediato corre justo después y
 * lo completa. Sin ella, el worker podría tomarlo mientras ese envío está en
 * vuelo y mandar el mismo mensaje dos veces.
 */
const enqueueOutboxEvent = async (input: {
  businessId: string
  eventType: string
  aggregateId: string
  payload: Record<string, unknown>
  esperaSegundos?: number
}): Promise<string | null> => {
  const { data, error } = await db.rpc('enqueue_outbox_event', {
    p_business_id: input.businessId,
    p_event_type: input.eventType,
    p_aggregate_id: input.aggregateId,
    p_payload: input.payload,
    p_aggregate_type: 'order',
    p_espera_s: input.esperaSegundos ?? 60,
  })
  if (error) throw new Error(error.message)
  return (data as string | null) ?? null
}

/** Toma trabajo. Dos workers nunca reciben el mismo evento. */
const leaseOutboxEvents = async (
  owner: string,
  limite = 10,
  leaseSegundos = 60,
): Promise<OutboxEvent[]> => {
  const { data, error } = await db.rpc('lease_outbox_events', {
    p_owner: owner, p_limite: limite, p_lease_s: leaseSegundos,
  })
  if (error) throw new Error(error.message)
  return (data || []) as OutboxEvent[]
}

/** `token` nulo = lo completa el envío inmediato, que no llegó a tomarlo. */
const completeOutboxEvent = async (
  id: string,
  token: string | null = null,
): Promise<boolean> => {
  const { data, error } = await db.rpc('complete_outbox_event', {
    p_id: id, p_token: token,
  })
  if (error) throw new Error(error.message)
  return data === true
}

/** Devuelve 'reintentar' | 'muerto' | 'sin_lease'. */
const failOutboxEvent = async (
  id: string, token: string, motivo: string,
): Promise<string> => {
  const { data, error } = await db.rpc('fail_outbox_event', {
    p_id: id, p_token: token, p_error: motivo,
  })
  if (error) throw new Error(error.message)
  return String(data || 'sin_lease')
}

/**
 * El pedido tal y como lo necesita el aviso, SIN reclamar.
 *
 * ⚠️ El worker no puede reclamar: el reclamo ya se gastó cuando el estado
 * cambió. Solo necesita los datos para volver a redactar el mismo mensaje.
 */
const getOrderForNotice = async (businessId: string, orderId: string) => {
  const { data, error } = await db
    .from('orders')
    .select(
      'id,order_number,status,fulfillment,contact_phone,contact_name,total,currency,'
      + 'payment_method,payment_confirmed_at,'
      + 'order_items(*, order_item_options(option_group_name,option_name,quantity,group_sort))',
    )
    .eq('business_id', businessId)
    .eq('id', orderId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

export {
  enqueueOutboxEvent,
  leaseOutboxEvents,
  completeOutboxEvent,
  failOutboxEvent,
  getOrderForNotice,
}
