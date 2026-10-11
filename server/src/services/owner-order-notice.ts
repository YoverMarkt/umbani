// ── EL AVISO DE PEDIDO NUEVO AL WHATSAPP DEL DUEÑO ─────────────────────────
//
// El dueño se entera de un pedido nuevo por la ALARMA de su panel: suena, la
// lista se refresca y ahí está. Funciona y no cuesta nada. El problema es el
// dueño que no tiene el panel abierto — está cocinando, o son las nueve de la
// noche y cerró la computadora.
//
// ⚠️ ESTO CUESTA DINERO, y por eso nace APAGADO (`notify_owner_whatsapp`).
// Son DOS mensajes por pedido —el resumen y el mapa del cliente— por local y
// todos los días, y Meta los cobra desde el 1 de octubre de 2026. Con
// cincuenta pedidos diarios son cien mensajes que hoy no se pagan. Lo enciende
// quien paga, local por local.
//
// ⚠️ El mapa es el punto del CLIENTE, no el del local: al dueño le sirve para
// saber a dónde hay que llevarlo —y mañana, para pasárselo al repartidor—. Y
// va solo en los pedidos a domicilio: en un retiro no hay nada que llevar.
//
// ⚠️ NUNCA lanza y nunca bloquea. El pedido YA existe y está en el panel: si
// este aviso falla, el dueño se entera igual por donde se enteraba antes.
// Tumbar la creación de un pedido por un mensaje de cortesía sería el peor
// intercambio posible.

import type { BusinessRecord } from '../db/types'
import { porCobrarCents, saldoUsadoCents } from '../lib/por-cobrar'
import { tieneUbicacion } from '../lib/ubicacion'
import { detalleEnTexto } from './order-detail'
import type { OpcionDelPedido } from './order-detail'

export interface PedidoParaElDueno {
  order_number?: number | null
  contact_name?: string | null
  contact_phone?: string | null
  total?: number | string | null
  /** Lo que el cliente pagó con saldo Umbani (2026-10-10). */
  credit_cents?: number | string | null
  fulfillment?: string | null
  payment_method?: string | null
  delivery_address?: string | null
  delivery_reference?: string | null
  delivery_latitude?: number | string | null
  delivery_longitude?: number | string | null
  delivery_courier_notes?: string | null
  order_items?: {
    product_name?: string | null
    variant_name?: string | null
    quantity?: number | null
    order_item_options?: OpcionDelPedido[] | null
    extras_names?: string[] | null
  }[] | null
}

const money = (valor: unknown): string => `$${(Number(valor) || 0).toFixed(2)}`

/**
 * El texto que lee el dueño.
 *
 * ⚠️ Lleva TODO lo que necesita para decidir en el momento: qué se pidió, a
 * cuánto, cómo paga y a dónde va. Alargar el texto no cuesta un centavo más
 * —Meta cobra por mensaje, no por carácter— y el dueño que lo lee cocinando no
 * va a abrir el panel para ver el detalle.
 *
 * ⚠️ El importe llega tal como lo selló la base y aquí solo se le da formato
 * (regla inviolable #8).
 */
export function textoParaElDueno(
  pedido: PedidoParaElDueno,
): string {
  const numero = pedido.order_number ? `#${pedido.order_number}` : ''
  const lineas = [`🔔 *Pedido nuevo ${numero}*`.trim(), '']

  for (const item of (pedido.order_items || []).filter(i => i?.product_name)) {
    const cantidad = Number(item.quantity) || 1
    const variante = item.variant_name ? ` (${item.variant_name})` : ''
    lineas.push(`• ${cantidad}× ${item.product_name}${variante}`)
    for (const detalle of detalleEnTexto(item)) lineas.push(`   ${detalle}`)
  }

  lineas.push('')
  lineas.push(`*Total: ${money(pedido.total)}*`)
  // ⚠️ El saldo Umbani (2026-10-10). El total no cambia, pero lo que COBRA el
  // local sí: sin esta línea, quien lleva el pedido pediría el total entero a
  // un cliente que ya pagó una parte. Lo pone Umbani y el lunes se le reconoce.
  const saldo = saldoUsadoCents(pedido)
  if (pedido.payment_method === 'saldo') {
    lineas.push('Pago: saldo Umbani (ya está pagado)')
  } else {
    if (pedido.payment_method) lineas.push(`Pago: ${pedido.payment_method}`)
    if (saldo > 0) {
      lineas.push(`Pagó ${money(saldo / 100)} con saldo Umbani`)
      const metodo = String(pedido.payment_method || 'efectivo')
      if (metodo === 'efectivo' || metodo === 'pago_al_retirar') {
        lineas.push(`*Cobra: ${money(porCobrarCents(pedido) / 100)}*`)
      }
    }
  }

  const domicilio = String(pedido.fulfillment || 'delivery') === 'delivery'
  if (domicilio) {
    const direccion = String(pedido.delivery_address || '').trim()
    lineas.push('')
    lineas.push(direccion ? `📍 ${direccion}` : '📍 Sin dirección escrita')
    const referencia = String(pedido.delivery_reference || '').trim()
    if (referencia) lineas.push(`   ${referencia}`)
    const notas = String(pedido.delivery_courier_notes || '').trim()
    if (notas) lineas.push(`   ✏️ ${notas}`)
  } else {
    lineas.push('')
    lineas.push('🛍️ El cliente lo retira en el local.')
  }

  const cliente = String(pedido.contact_name || '').trim()
  if (cliente) {
    lineas.push('')
    lineas.push(`Cliente: ${cliente}`)
  }
  return lineas.join('\n')
}

export interface AvisoAlDuenoDependencias {
  enviarTexto(negocio: BusinessRecord, telefono: string, mensaje: string): Promise<unknown>
  enviarUbicacion?(
    negocio: BusinessRecord,
    telefono: string,
    ubicacion: { latitude: number; longitude: number; name?: string | null; address?: string | null },
  ): Promise<unknown>
  registrarError(input: {
    businessId?: string | null
    category: 'envio'
    message: unknown
    context?: Record<string, unknown>
  }): Promise<void>
}

/**
 * ¿Hay que avisar a este dueño?
 *
 * Las TRES condiciones, y las tres son necesarias:
 *   · el interruptor encendido — nace apagado y lo enciende quien paga;
 *   · un `owner_phone` al que mandarlo;
 *   · que ese número no sea el del propio marketplace, que sería el bot
 *     escribiéndose a sí mismo.
 */
export const tocaAvisarAlDueno = (negocio: {
  notify_owner_whatsapp?: unknown
  owner_phone?: unknown
} | null | undefined): boolean => (
  negocio?.notify_owner_whatsapp === true
  && String(negocio?.owner_phone || '').replace(/\D/g, '').length >= 8
)

export const crearAvisoAlDueno = (dependencias: AvisoAlDuenoDependencias) =>
  async function avisarAlDueno(
    negocio: BusinessRecord,
    pedido: PedidoParaElDueno,
  ): Promise<boolean> {
    if (!tocaAvisarAlDueno(negocio)) return false
    const telefono = String(negocio.owner_phone || '').trim()

    try {
      await dependencias.enviarTexto(negocio, telefono, textoParaElDueno(pedido))
    } catch (error) {
      await dependencias.registrarError({
        businessId: negocio.id,
        category: 'envio',
        message: error,
        context: { motivo: 'aviso de pedido al dueño', pedido: pedido.order_number ?? null },
      }).catch(() => { /* registrar el fallo no puede provocar otro */ })
      return false
    }

    // El mapa del CLIENTE, y solo a domicilio: en un retiro no hay a dónde ir.
    // Va después del texto y nunca lo bloquea — el resumen ya lleva la
    // dirección escrita, así que un mapa que no sale no pierde el aviso.
    const domicilio = String(pedido.fulfillment || 'delivery') === 'delivery'
    const punto = {
      latitude: pedido.delivery_latitude,
      longitude: pedido.delivery_longitude,
    }
    if (domicilio && dependencias.enviarUbicacion && tieneUbicacion(punto)) {
      await dependencias.enviarUbicacion(negocio, telefono, {
        latitude: Number(punto.latitude),
        longitude: Number(punto.longitude),
        name: String(pedido.contact_name || 'El cliente'),
        address: String(pedido.delivery_address || '') || null,
      }).catch(() => false)
    }
    return true
  }

// Carga diferida, como el resto de servicios que hablan con los canales: un
// import arriba cerraría el ciclo al arrancar.
export const avisarAlDueno = crearAvisoAlDueno({
  enviarTexto(negocio, telefono, mensaje) {
    const notify = require('./notify') as typeof import('./notify')
    return notify.sendToContact(negocio, telefono, mensaje)
  },
  enviarUbicacion(negocio, telefono, ubicacion) {
    const whatsapp = require('../integrations/whatsapp') as typeof import('../integrations/whatsapp')
    return whatsapp.sendLocation(negocio, telefono, ubicacion)
  },
  registrarError(input) {
    const log = require('./error-log') as typeof import('./error-log')
    return log.recordError(input)
  },
})

/**
 * El puente entre «acaba de nacer un pedido» y «avísale a su dueño».
 *
 * Lo llaman los DOS caminos que crean pedidos —la mini app y el checkout del
 * chat— y por eso vive aquí y no en ninguno de los dos: dos copias acabarían
 * avisando distinto según por dónde entró el cliente.
 *
 * ⚠️ Pregunta por el interruptor ANTES de leer el pedido. Con el aviso apagado
 * —que es como nacen todos— esto es una consulta al negocio y nada más: no se
 * paga un viaje a la base por cada pedido de todos los locales del SaaS.
 *
 * ⚠️ NUNCA lanza. El pedido ya existe y el dueño lo ve en su panel: un aviso
 * de cortesía no puede tumbar una venta.
 */
export async function avisarAlDuenoDelPedido(
  businessId: string,
  orderId: string | null | undefined,
): Promise<boolean> {
  if (!businessId || !orderId) return false
  try {
    const db = require('../db') as typeof import('../db')
    const negocio = await db.getBusinessById(businessId)
    if (!tocaAvisarAlDueno(negocio as Parameters<typeof tocaAvisarAlDueno>[0])) return false

    const pedido = await db.getOrderForOwnerNotice(businessId, orderId)
    if (!pedido) return false
    return await avisarAlDueno(negocio as BusinessRecord, pedido as PedidoParaElDueno)
  } catch {
    // Ni siquiera se registra: si la base falla aquí, ya lo registró quien la
    // llamó, y un error de un aviso opcional no merece una fila propia.
    return false
  }
}
