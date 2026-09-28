import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '../tipos-generados'

// LOS COBROS CON TARJETA (PAYPHONE)
//
// Cada decisión de dinero vive en PostgreSQL (`migration-2026-09-27-tarjeta-
// payphone.sql`): cuánto se cobra, si se confirma, si cuadra al centavo y si
// hay que devolver. Aquí solo se llaman esas funciones y se leen sus
// respuestas con su forma estrecha — sin `as` sobre lo que devuelve la base.

const db: SupabaseClient<Database> = require('../client') as typeof import('../client')

export type ModoDeCobro = 'pruebas' | 'produccion'

/** Lo que contestan las funciones del cobro: siempre un `result` y a veces más. */
export interface RespuestaDelCobro {
  result: string
  reason?: string
  status?: string
  orderId?: string
  businessId?: string
  orderNumber?: number
  environment?: string
  clientTransactionId?: string
  providerTransactionId?: string
  amountCents?: number
}

const texto = (valor: unknown): string | undefined => (
  typeof valor === 'string' && valor.trim() ? valor : undefined
)
const entero = (valor: unknown): number | undefined => {
  const numero = typeof valor === 'number' ? valor : Number(valor)
  return Number.isInteger(numero) ? numero : undefined
}

/** Lee el jsonb de la base sin afirmar tipos que nadie comprobó. */
export const leerRespuesta = (datos: unknown): RespuestaDelCobro => {
  const fila = (datos && typeof datos === 'object' ? datos : {}) as Record<string, unknown>
  return {
    result: texto(fila.result) || 'error',
    reason: texto(fila.reason),
    status: texto(fila.status),
    orderId: texto(fila.order_id),
    businessId: texto(fila.business_id),
    orderNumber: entero(fila.order_number),
    environment: texto(fila.environment),
    clientTransactionId: texto(fila.client_transaction_id),
    providerTransactionId: texto(fila.provider_transaction_id),
    amountCents: entero(fila.amount_cents),
  }
}

const startCardPayment = async (input: {
  businessId: string
  orderId: string
  contactPhone: string
  environment: ModoDeCobro
}): Promise<RespuestaDelCobro> => {
  const { data, error } = await db.rpc('start_card_payment', {
    p_business_id: input.businessId,
    p_order_id: input.orderId,
    p_contact_phone: input.contactPhone,
    p_environment: input.environment,
  })
  if (error) throw new Error(error.message)
  return leerRespuesta(data)
}

const claimCardPayment = async (
  clientTransactionId: string,
  providerTransactionId: string | null,
): Promise<RespuestaDelCobro> => {
  const { data, error } = await db.rpc('claim_card_payment', {
    p_client_transaction_id: clientTransactionId,
    p_provider_transaction_id: providerTransactionId ?? undefined,
  })
  if (error) throw new Error(error.message)
  return leerRespuesta(data)
}

const settleCardPayment = async (input: {
  clientTransactionId: string
  providerTransactionId: string
  statusCode: number
  capturedCents: number | null
  currency: string | null
  authorizationCode?: string | null
  cardBrand?: string | null
  lastDigits?: string | null
  detail?: string | null
}): Promise<RespuestaDelCobro> => {
  const { data, error } = await db.rpc('settle_card_payment', {
    p_client_transaction_id: input.clientTransactionId,
    p_provider_transaction_id: input.providerTransactionId,
    p_status_code: input.statusCode,
    // ⚠️ Un monto que no es entero llega como NULO, y la base lo trata como
    // descuadre: nunca se redondea aquí para que «cuadre».
    p_captured_cents: input.capturedCents as number,
    p_currency: input.currency as string,
    p_authorization_code: input.authorizationCode ?? undefined,
    p_card_brand: input.cardBrand ?? undefined,
    p_last_digits: input.lastDigits ?? undefined,
    p_detail: input.detail ?? undefined,
  })
  if (error) throw new Error(error.message)
  return leerRespuesta(data)
}

export interface CobroPendiente {
  id: string
  business_id: string
  order_id: string
  environment: string
  client_transaction_id: string
  provider_transaction_id: string | null
  status: string
  amount_cents: number
  confirm_attempts: number
  created_at: string
}

const leaseCardPayments = async (limite = 5, leaseS = 45): Promise<CobroPendiente[]> => {
  const { data, error } = await db.rpc('lease_card_payments', {
    p_limite: limite,
    p_lease_s: leaseS,
  })
  if (error) throw new Error(error.message)
  return data || []
}

const expireCardPayment = async (clientTransactionId: string, detail?: string): Promise<boolean> => {
  const { data, error } = await db.rpc('expire_card_payment', {
    p_client_transaction_id: clientTransactionId,
    p_detail: detail,
  })
  if (error) throw new Error(error.message)
  return data === true
}

const finishCardRefund = async (
  clientTransactionId: string,
  reversed: boolean,
  detail?: string,
): Promise<boolean> => {
  const { data, error } = await db.rpc('finish_card_refund', {
    p_client_transaction_id: clientTransactionId,
    p_reversed: reversed,
    p_detail: detail,
  })
  if (error) throw new Error(error.message)
  return data === true
}

export interface EstadoDelCobro {
  status: string
  card_brand: string | null
  card_last_digits: string | null
  authorization_code: string | null
  approved_at: string | null
  created_at: string
}

/**
 * El último intento de cobro de UN pedido de ESTE negocio.
 *
 * ⚠️ Negocio + pedido siempre juntos. Quien llama desde la mini app además
 * ya comprobó que el pedido es de la persona de la sesión.
 */
const getLatestCardPayment = async (
  businessId: string,
  orderId: string,
): Promise<EstadoDelCobro | null> => {
  const { data, error } = await db
    .from('payments')
    .select('status, card_brand, card_last_digits, authorization_code, approved_at, created_at')
    .eq('business_id', businessId)
    .eq('order_id', orderId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

/** El cobro aprobado de varios pedidos de UN negocio, para su panel. */
const getApprovedCardPayments = async (
  businessId: string,
  orderIds: string[],
): Promise<Array<EstadoDelCobro & { order_id: string }>> => {
  if (orderIds.length === 0) return []
  const { data, error } = await db
    .from('payments')
    .select('order_id, status, card_brand, card_last_digits, authorization_code, approved_at, created_at')
    .eq('business_id', businessId)
    .in('order_id', orderIds.slice(0, 200))
    .in('status', ['aprobado', 'por_devolver', 'devuelto', 'devolucion_manual'])
  if (error) throw new Error(error.message)
  return data || []
}

/**
 * A qué pedido pertenece un cobro, solo para devolver al cliente a su tienda.
 *
 * La referencia es aleatoria (32 caracteres de un uuid) y la genera la base:
 * no se adivina. Y esto no devuelve nada del cobro, solo dónde volver.
 */
const getCardPaymentOrder = async (
  clientTransactionId: string,
): Promise<{ order_id: string; business_id: string } | null> => {
  const { data, error } = await db
    .from('payments')
    .select('order_id, business_id')
    .eq('client_transaction_id', clientTransactionId)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data || null
}

export {
  getCardPaymentOrder,
  startCardPayment,
  claimCardPayment,
  settleCardPayment,
  leaseCardPayments,
  expireCardPayment,
  finishCardRefund,
  getLatestCardPayment,
  getApprovedCardPayments,
}
