/**
 * El aviso al cliente cuando su pedido cambia de estado.
 *
 * Vivía dentro de `routes/orders.routes.ts`, donde solo lo alcanzaba el botón
 * del dueño. Se movió aquí el 2026-08-28, sin tocar una línea de su cuerpo,
 * porque ahora también lo necesita el barrido que expira los pedidos sin
 * pagar: duplicarlo daría dos sitios donde arreglar cada fallo del aviso, y el
 * aviso es lo que se paga.
 */
import { avisaAlClientePorWhatsApp } from '../config/avisos-al-cliente'

const db = require('../db') as typeof import('../db')
// ⚠️ Por PROPIEDAD, no desestructurando: desestructurar congela la referencia
// al cargar el módulo y el envío deja de poder ejercerse en una prueba — que
// es justo lo que hay que poder comprobar de lo que se paga.
const notify = require('./order-notify') as typeof import('./order-notify')

export const avisarAlCliente = async (
  businessId: string,
  orderId: string,
  status: string,
  /** Las faltas de pago del cliente, cuando el aviso es de expiración. */
  falta?: import('./order-notify').FaltaDePago | null,
): Promise<void> => {
  // Apagado mientras Umbani sea solo app, y ANTES de reclamar ni encolar: así
  // no queda nada que la cola reintente. Ver `config/avisos-al-cliente.ts`.
  if (!avisaAlClientePorWhatsApp()) return
  try {
    // Se RECLAMA el aviso antes de redactarlo: el reclamo es atómico y solo lo
    // gana quien de verdad avisa. `set_order_status` responde `updated`
    // también cuando el estado ya era ese, así que sin esto un segundo toque
    // en un botón mandaría un segundo mensaje — y desde octubre, lo cobraría
    // dos veces.
    const pedido = await db.claimOrderNotification(businessId, orderId, status)
    if (!pedido) return

    // ⚠️ Se ENCOLA antes de enviar, no después. El reclamo de arriba ya se
    // consumió: si el proceso muriera entre el reclamo y el envío, o si el
    // envío fallara —fuera de la ventana de 24 h, sin saldo, canal caído—,
    // ese aviso no volvería a intentarse nunca. Encolado, se reintenta.
    //
    // Encolar no puede impedir el aviso: si la cola falla, se envía igual.
    const evento = await db.enqueueOutboxEvent({
      businessId, eventType: 'order_status_notice',
      aggregateId: orderId, payload: { status },
    }).catch(() => null)

    const negocio = await db.getBusinessById(businessId)
    if (!negocio) return
    const enviado = await notify.notificarCambioDePedido(negocio, pedido, status, falta)

    // Salió: se cierra el evento y el worker no lo tocará. Si no salió, se
    // deja en la cola y el worker lo reintentará pasada su ventana.
    if (enviado && evento) {
      await db.completeOutboxEvent(evento, null).catch(() => { /* lo reintentará */ })
    }
  } catch (error) {
    console.error(
      '⚠️  aviso de pedido en preparación:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
  }
}
