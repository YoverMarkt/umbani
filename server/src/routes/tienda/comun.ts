// ═══════════════════════════════════════════════════════════════════════════
// LA TIENDA (MINI APP): LO QUE COMPARTEN SUS RUTAS
// ═══════════════════════════════════════════════════════════════════════════
//
// El router de la tienda es UNO (`routes/storefront.routes.ts`); sus secciones
// viven en esta carpeta desde el 2026-10-07, cuando el archivo pasó de 1.000
// líneas (regla del dueño, `archivos-grandes-guardian.test.js`). Aquí está lo
// que usan varias: la base, el horario, los frenos y el estado de la tienda.

import rateLimit from 'express-rate-limit'
import type { ScheduleRecord } from '../../db/types'
import { readToken } from '../../middleware/storefront'
import { hashToken } from '../../services/storefront-session'
import { storefrontStatus, type StorefrontBusiness } from '../../services/storefront'
import { metodoTarjeta, tarjetaDisponible } from '../../services/pago-con-tarjeta'
import { leerConfiguracionPayphone } from '../../config/payphone'

// resuelve cada importe desde la base (regla inviolable #8).

/** La fila de sesión, con lo que necesitan la redirección y la verificación. */
interface StorefrontSessionRow {
  id: string
  business_id: string
  customer_id: string
  contact_phone: string
  device_hash: string | null
  claimed_at: string | null
  expires_at: string | null
  revoked_at: string | null
  verified_at?: string | null
}

interface StorefrontRouteDatabase {
  /** «¿Llegó todo bien?» (2026-10-06): las reglas viven en la base. */
  confirmOrderReceived(orderId: string, phone: string): Promise<Record<string, unknown>>
  reportOrderProblem(orderId: string, phone: string, kind: string, lines: unknown, note: string | null): Promise<Record<string, unknown>>
  /** La regla de margen vigente del negocio, o null si no hay ninguna. */
  getBusinessPricingRule(businessId: string): Promise<Record<string, unknown> | null>
  getStorefrontPaymentMethods(businessId: string): Promise<Array<{
    code: string
    label: string
    help_text: string | null
    is_prepaid: boolean
    requires_proof: boolean
  }>>
  getBusinessBySlug(slug: string): Promise<StorefrontBusiness | null>
  /** Lo mínimo del pedido para cuadrar su comprobante: cuánto, cuándo y de quién. */
  getOrderForReceiptCheck(businessId: string, orderId: string): Promise<{
    total?: unknown
    created_at?: string | null
    contact_name?: string | null
  } | null>
  getBusinessById(businessId: string): Promise<{ slug?: string | null; name?: string | null } | null>
  getStorefrontSessionByHash(tokenHash: string): Promise<StorefrontSessionRow | null>
  bindStorefrontSession(sessionId: string, deviceHash: string): Promise<boolean>
  /** El bloqueo del dueño es total: quien está bloqueado no puede pedir. */
  isCustomerBlocked(businessId: string, customerId: string): Promise<boolean>
  getSchedule(businessId: string): Promise<ScheduleRecord[]>
  getStorefrontCategories(businessId: string): Promise<unknown[]>
  getStorefrontProducts(businessId: string): Promise<unknown[]>
  getStorefrontVariants(businessId: string): Promise<unknown[]>
  getStorefrontExtras(businessId: string): Promise<unknown[]>
  getStorefrontOptionGroups(businessId: string): Promise<unknown[]>
  getStorefrontOptions(businessId: string): Promise<unknown[]>
  getStorefrontRecommendations(businessId: string): Promise<unknown[]>
  getBusinessBankAccount(businessId: string): Promise<unknown>
  getCustomerAddresses(businessId: string, customerId: string): Promise<unknown[]>
  createCustomerAddress(input: Record<string, unknown>): Promise<unknown>
  /** Devuelve `null` cuando la dirección no es de ese cliente y ese negocio. */
  deactivateCustomerAddress(input: {
    businessId: string
    customerId: string
    addressId: string
  }): Promise<unknown>
  setCustomerAddressLocation(input: {
    businessId: string
    customerId: string
    addressId: string
    latitude: number
    longitude: number
    accuracyM: number | null
  }): Promise<unknown>
  getBusinessCustomer(businessId: string, customerId: string): Promise<unknown>
  setCustomerDisplayName(
    businessId: string,
    customerId: string,
    name: string,
  ): Promise<{ error: unknown }>
  /**
   * El dinero OFICIAL del pedido, leído de la fila ya sellada por el
   * disparador. Y su estado: la RPC no lo devuelve, y sin él no se sabe si
   * hay que pedir el comprobante por el chat.
   */
  getOrderMoney(businessId: string, orderId: string): Promise<{
    subtotal: number | string | null
    shipping: number | string | null
    total: number | string | null
    status: string | null
    payment_method: string | null
  } | null>
  /** El último intento de cobro con tarjeta de UN pedido de ESTE negocio. */
  getLatestCardPayment(businessId: string, orderId: string): Promise<{
    status: string
    card_brand: string | null
    card_last_digits: string | null
  } | null>
  createStorefrontOrder(input: Record<string, unknown>): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
  getStorefrontOrders(input: { businessId: string; contactPhone: string }): Promise<{
    data: unknown[] | null
    error: { message?: string } | null
  }>
  getStorefrontOrder(input: { businessId: string; contactPhone: string; orderId: string }): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
  attachStorefrontPaymentProof(input: Record<string, unknown>): Promise<{
    data: unknown
    error: { message?: string; code?: string } | null
  }>
}

export const db: StorefrontRouteDatabase = require('../../db') as typeof import('../../db')
const schedule: {
  isOutsideHours(schedule: ScheduleRecord[] | null | undefined, now?: Date): boolean
  todaysHours(
    schedule: ScheduleRecord[] | null | undefined,
    now?: Date,
  ): { open: string; close: string; allDay?: boolean } | null
  proximaApertura(
    schedule: ScheduleRecord[] | null | undefined,
    now?: Date,
  ): { open: string; inDays: number; dayName: string } | null
} = require('../../services/schedule') as typeof import('../../services/schedule')

// Un enlace legítimo no necesita 200 peticiones por minuto. Frena el raspado
// del catálogo y los intentos de probar tokens a lo bruto.
export const storeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 90,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})

/**
 * Los métodos que ESE local acepta, con la tarjeta si le toca.
 *
 * La tarjeta no vive en `business_payment_methods` —esa lista la edita el
 * dueño, y el dinero de la tarjeta entra en la cuenta de Umbani—, así que se
 * añade aquí cuando el superadmin la encendió y el servidor cobra en el mismo
 * modo (`tarjetaDisponible`). Si la consulta falla, lista vacía: el cliente
 * puede mirar la carta igual y el checkout lo vuelve a comprobar.
 */
export async function metodosDeLaTienda(business: StorefrontBusiness) {
  const metodos = await db.getStorefrontPaymentMethods(business.id).catch(() => [])
  const config = leerConfiguracionPayphone()
  return config && tarjetaDisponible(business, config)
    ? [...metodos, metodoTarjeta(config)]
    : metodos
}

// Crear pedidos es mucho más caro y nadie pide 30 veces por minuto.
export const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de pedido, espera un momento' },
})

/**
 * El tope por ENLACE, que se suma al de IP.
 *
 * ⚠️ Los dos ejes son necesarios porque cada uno tapa el agujero del otro
 * (2026-09-06):
 *
 *   · Solo por IP —lo que había— falla en las dos direcciones con datos
 *     móviles. Muchos clientes salen por la MISMA IP del operador (CGNAT), así
 *     que uno que molesta se come el cupo de vecinos que no han hecho nada; y
 *     al revés, quien apaga y enciende los datos estrena IP y vuelve a tener
 *     el cupo entero. La dirección no identifica a nadie en un teléfono.
 *   · Solo por sesión no protege del que llega SIN enlace, que es quien puede
 *     raspar el catálogo público.
 *
 * Juntos, el que trae enlace responde por su enlace y el que no, por su IP.
 * Ninguno de los dos se esquiva cambiando de eje.
 *
 * ⚠️ La clave es el HASH del token, nunca el token: las claves del limitador
 * viven en memoria y se asoman en volcados y trazas. Es el mismo hash con el
 * que la sesión se busca en la base, así que «una clave» es exactamente «una
 * sesión».
 *
 * ⚠️ Más holgado que el de IP a propósito (60 < 90). Este cuenta a UNA persona
 * con su enlace; el de IP puede estar contando a varias a la vez, y estrecharlo
 * aquí castigaría al cliente legítimo que navega rápido.
 */
export const sesionLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  // Sin enlace no hay a quién contarle: de ese se ocupa `storeLimiter`.
  skip: (req) => !readToken(req),
  keyGenerator: (req) => `sesion:${hashToken(readToken(req))}`,
  message: { error: 'Demasiadas peticiones, espera un momento' },
})


export const readStatus = async (business: StorefrontBusiness | null) => {
  if (!business?.id) {
    return { status: storefrontStatus({ business: null, outsideHours: false }), hours: null }
  }
  const businessSchedule = await db.getSchedule(business.id).catch(() => [])
  const outsideHours = schedule.isOutsideHours(businessSchedule || [])
  return {
    status: storefrontStatus({ business, outsideHours }),
    outsideHours,
    // El horario vigente, para la píldora de la portada. Va junto al estado y
    // no dentro del negocio porque depende de QUÉ HORA ES, no de quién es.
    hours: schedule.todaysHours(businessSchedule || []),
    // ⚠️ Y CUÁNDO VUELVE A ABRIR, que es lo único que le importa a quien llega
    // con la tienda cerrada (2026-09-02). El rango del día a secas hacía que
    // «Cerrado · 8:00 AM – 2:00 AM» se leyera a la 01:10 como un error de la
    // app. Es `null` mientras está abierta: ahí no hay nada que anunciar.
    nextOpen: schedule.proximaApertura(businessSchedule || []),
  }
}
