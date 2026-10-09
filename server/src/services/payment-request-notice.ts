/**
 * «Mándanos el comprobante»: el mensaje que cierra el ciclo mini app → chat.
 *
 * ── Por qué existe ────────────────────────────────────────────────────────
 *
 * `HITOS_QUE_SE_AVISAN` excluye `esperando_pago` a propósito, y su motivo
 * escrito es bueno: «son cosas que él mismo acaba de hacer». Vale para quien
 * pidió POR EL CHAT — el bot acaba de decírselo ahí mismo, en la conversación
 * que tiene abierta.
 *
 * **No vale para quien pidió por la mini app.** Esa persona está en un
 * navegador; a su WhatsApp no llega nada. Cierra la pestaña para ir al banco,
 * vuelve, y no tiene ni un mensaje al que responder con la foto — justo
 * cuando el comprobante tiene UNA sola vía desde el 2026-08-12, y es el chat.
 *
 * Por eso NO se añade a `HITOS_QUE_SE_AVISAN`: esa lista se dispara con cada
 * cambio de estado y en TODOS los caminos, así que un pedido del chat
 * recibiría un segundo mensaje diciéndole lo que el bot le acaba de decir —
 * y desde octubre se pagarían los dos. Este aviso lo manda solo la ruta de la
 * tienda.
 *
 * ── Lo que hereda, y no se reescribe ──────────────────────────────────────
 *
 * · **El reclamo atómico** (`claimOrderNotification`). Un pedido repetido con
 *   la misma `idempotency_key` devuelve el MISMO pedido y vuelve a recorrer la
 *   ruta: sin reclamar, un doble toque mandaría —y pagaría— dos mensajes.
 * · **La cola de reintentos** (`outbox`). Se encola ANTES de enviar: si el
 *   proceso muere entre el reclamo y el envío, o el envío falla —fuera de la
 *   ventana de 24 h, sin saldo, canal caído—, el aviso no se perdería.
 * · **El canal de salida.** `sendToContact` acaba en `conCanalDePlataforma`,
 *   que cambia un negocio de marketplace por el número de Umbani. Quien envía
 *   es la plataforma; quien gasta sigue siendo el local.
 *
 * ⚠️ **Nunca lanza.** El pedido ya está creado cuando esto corre. Devolverle
 * un error al cliente le haría creer que su pedido no entró —y volvería a
 * pedirlo—, que es exactamente el duplicado que todo esto evita.
 */
import { avisaAlClientePorWhatsApp } from '../config/avisos-al-cliente'

const db = require('../db') as typeof import('../db')
// Por PROPIEDAD y no desestructurando, igual que `order-status-notice`:
// desestructurar congela la referencia al cargar el módulo y el envío deja de
// poder ejercerse en una prueba. Lo que se paga tiene que poder comprobarse.
const notify = require('./order-notify') as typeof import('./order-notify')

/** El estado con el que se reclama. Es el real del pedido, no una etiqueta. */
const ESTADO = 'esperando_pago'

/**
 * El texto. Dice las tres cosas que esa persona necesita en ese momento: que
 * su pedido entró, cuánto es, y que la foto se manda AQUÍ MISMO.
 *
 * ⚠️ «responde a este mensaje con la foto» y no «escríbenos al
 * +593…»: el cliente ya está en la conversación correcta, y darle un número
 * que copiar es mandarlo a abrir un chat nuevo con el mismo destinatario.
 */
export const textoPideComprobante = (input: {
  negocio: string
  /**
   * Los tres llegan como `unknown` a propósito: salen de `OrderData`, que no
   * tiene tipo estrecho, y normalizarlos AQUÍ evita que cada llamador invente
   * su propia conversión — que es como el mismo importe acaba escrito de dos
   * maneras distintas en dos mensajes.
   */
  orderNumber?: unknown
  total?: unknown
  moneda?: unknown
}): string => {
  const numeroDePedido = Number(input.orderNumber)
  const numero = Number.isFinite(numeroDePedido) && numeroDePedido > 0
    ? ` #${numeroDePedido}`
    : ''
  const importe = Number(input.total)
  const moneda = String(input.moneda || 'USD').trim() || 'USD'
  const simbolo = moneda === 'USD' ? '$' : `${moneda} `
  const monto = Number.isFinite(importe) && importe > 0
    ? ` por ${simbolo}${importe.toFixed(2)}`
    : ''
  return [
    `📝 Recibimos tu pedido${numero} en ${input.negocio}${monto}.`,
    '',
    'Para que el local empiece a prepararlo, *responde a este mensaje con la '
    + 'foto de tu transferencia*.',
    '',
    'En cuanto la revisen te avisamos por aquí 🙌',
  ].join('\n')
}

export interface PideComprobanteDependencias {
  /** ¿Se le escribe al cliente por WhatsApp? Ver `config/avisos-al-cliente.ts`. */
  avisaAlCliente?: () => boolean
  claimOrderNotification: typeof db.claimOrderNotification
  getBusinessById: typeof db.getBusinessById
  enqueueOutboxEvent: typeof db.enqueueOutboxEvent
  completeOutboxEvent: typeof db.completeOutboxEvent
  enviar(negocio: Parameters<typeof notify.notificarCambioDePedido>[0], telefono: string, mensaje: string): Promise<unknown>
}

export const crearAvisoDeComprobante = (dependencias: PideComprobanteDependencias) =>
  async function pedirComprobantePorChat(
    businessId: string,
    orderId: string,
  ): Promise<boolean> {
    // Apagado mientras Umbani sea solo app: el comprobante se sube en la app.
    // ANTES de reclamar ni encolar, para no dejar nada que la cola reintente.
    if (dependencias.avisaAlCliente && !dependencias.avisaAlCliente()) return false
    try {
      // Se RECLAMA antes de redactar: el reclamo es atómico y solo lo gana
      // quien de verdad va a avisar.
      const pedido = await dependencias.claimOrderNotification(businessId, orderId, ESTADO)
      if (!pedido) return false

      // ⚠️ Solo si de verdad espera pago. El reclamo no comprueba el estado
      // —su trabajo es que no se avise dos veces—, así que un pedido en
      // efectivo que llegara aquí por error recibiría un mensaje pidiéndole
      // una transferencia que nadie le pidió.
      if (String(pedido.status || '') !== ESTADO) return false

      const telefono = String(pedido.contact_phone || '').trim()
      // Un pedido de mostrador no tiene a quién escribirle.
      if (!telefono || telefono === 'mostrador') return false

      // Se encola ANTES de enviar. Encolar no puede impedir el aviso: si la
      // cola falla, se envía igual y simplemente no habrá reintento.
      const evento = await dependencias.enqueueOutboxEvent({
        businessId,
        eventType: 'order_status_notice',
        aggregateId: orderId,
        payload: { status: ESTADO },
      }).catch(() => null)

      const negocio = await dependencias.getBusinessById(businessId)
      if (!negocio) return false

      await dependencias.enviar(negocio, telefono, textoPideComprobante({
        negocio: String(negocio.name || 'el local'),
        orderNumber: pedido.order_number ?? null,
        total: pedido.total ?? null,
        moneda: pedido.currency ?? null,
      }))

      if (evento) {
        await dependencias.completeOutboxEvent(evento, null)
          .catch(() => { /* saldrá otra vez por la cola; el cliente ya lo tiene */ })
      }
      return true
    } catch (error) {
      console.error(
        '⚠️  aviso «manda tu comprobante»:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      return false
    }
  }

export const pedirComprobantePorChat = crearAvisoDeComprobante({
  avisaAlCliente: () => avisaAlClientePorWhatsApp(),
  claimOrderNotification: (...args) => db.claimOrderNotification(...args),
  getBusinessById: (...args) => db.getBusinessById(...args),
  enqueueOutboxEvent: (...args) => db.enqueueOutboxEvent(...args),
  completeOutboxEvent: (...args) => db.completeOutboxEvent(...args),
  enviar(negocio, telefono, mensaje) {
    const contacto = require('./notify') as typeof import('./notify')
    return contacto.sendToContact(negocio, telefono, mensaje)
  },
})
