import type { RequestHandler } from 'express'
import { getClientBusinessId, getClientUserId } from '../lib/request'
import { createRouter } from '../middleware/async'
import { signedMediaUrl } from '../integrations/cloudinary'
import {
  seAvisa, type PedidoParaAvisar,
} from '../services/order-notify'
import { avisarAlCliente } from '../services/order-status-notice'
import { conOpcionesAgrupadasEnLote } from '../services/order-detail'
import type { BusinessRecord } from '../db/types'

// Estados que hoy acepta orders.status. El GET puede filtrar por cualquiera
// (la vigilancia del panel consulta «pendiente»); el PUT no acepta volver a
// «pendiente» porque es el estado inicial, nunca un destino.
//
// ⚠️ Esta lista es el TERCER sitio donde viven los estados, además del CHECK de
// `orders` y del tipo del panel. Quedarse corta aquí es especialmente traidor:
// el botón existe en el panel, el dueño lo toca, y esta ruta lo rechaza con un
// «estado no válido» que no explica nada. Lo vigila `estados-pedido.test.js`.
const ESTADOS_PEDIDO = [
  'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
  'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
  'cancelado', 'rechazado', 'expirado',
] as const
const ESTADOS_DESTINO = ESTADOS_PEDIDO.filter(estado => estado !== 'pendiente')

interface ModuloDb {
  // La cola de avisos: encolar antes de enviar y cerrar si salió.
  enqueueOutboxEvent(input: {
    businessId: string
    eventType: string
    aggregateId: string
    payload: Record<string, unknown>
  }): Promise<string | null>
  completeOutboxEvent(id: string, token: string | null): Promise<boolean>
  createOrder(
    order: Record<string, unknown>,
    items: Record<string, unknown>[],
  ): Promise<{ data?: unknown; error?: { message?: string; code?: string } | null }>
  getOrders(
    businessId: string,
    limit?: number,
    status?: string | string[] | null,
  ): Promise<unknown>
  getOrderProof(businessId: string, orderId: string): Promise<{
    payment_proof_url?: string | null
    payment_proof_public_id?: string | null
  } | null>
  getReceiptAnalysis(
    businessId: string,
    orderId: string,
  ): Promise<Record<string, unknown> | null>
  getBusinessBankAccount(businessId: string): Promise<{
    bank_name?: string | null
    account_number?: string | null
    holder_name?: string | null
  } | null>
  requestNewPaymentProof(
    businessId: string,
    orderId: string,
  ): Promise<{ data?: unknown; error?: { message?: string } | null }>
  setOrderStatus(
    businessId: string,
    orderId: string,
    status: string,
  ): Promise<{ data?: unknown; error?: { message?: string } | null }>
  confirmOrderPayment(
    businessId: string,
    orderId: string,
  ): Promise<{ id: string; status: string; payment_confirmed_at: string } | null>
  markOrderItemPrepared(
    businessId: string,
    orderId: string,
    itemId: string,
    userId: string | null,
  ): Promise<{ result: string; faltan?: number; total?: number; status?: string }>
  claimOrderNotification(
    businessId: string,
    orderId: string,
    status: string,
  ): Promise<PedidoParaAvisar | null>
  getBusinessById(id: string): Promise<BusinessRecord | null>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requirePermission(section: string): RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

/**
 * Le avisa al cliente por su canal que el pedido entró en preparación.
 *
 * **Nunca lanza, y por eso no se comprueba lo que devuelve.** Corre cuando el
 * estado YA cambió: la comanda está en la cocina. Si el aviso falla —fuera de
 * la ventana de 24 h de Meta, sin saldo, canal caído— el fallo va al registro
 * de errores y el dueño recibe su respuesta correcta igualmente. Convertir
 * esto en un 500 le diría que el pedido no arrancó cuando sí arrancó.
 */
// ── Ver el comprobante de una transferencia ────────────────────────────────
//
// El comprobante ya NO vive en una URL pública: es un movimiento bancario de
// un cliente real, con su nombre y su cuenta. Aquí se firma un acceso temporal
// —diez minutos— y solo para el dueño del negocio al que pertenece el pedido.
//
// Si la captura del panel acaba en un chat, el enlace ya no sirve.
router.get(
  '/api/client/orders/:id/proof',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const pedido = await db.getOrderProof(businessId, String(req.params.id || ''))
    if (!pedido) return res.status(404).json({ error: 'Ese pedido no existe' })
    if (!pedido.payment_proof_url) {
      return res.status(404).json({ error: 'Ese pedido no tiene comprobante' })
    }

    // Los comprobantes subidos ANTES de esto no tienen identificador: siguen
    // siendo públicos y se devuelven tal cual. Romperles el acceso escondería
    // el pago de un pedido en curso, que es peor que la fuga que ya ocurrió.
    if (!pedido.payment_proof_public_id) {
      return res.json({ url: pedido.payment_proof_url, firmada: false })
    }

    const url = await signedMediaUrl(pedido.payment_proof_public_id)
    if (!url) return res.status(503).json({ error: 'No se pudo abrir el comprobante ahora mismo' })
    return res.json({ url, firmada: true })
  },
)

// ── Lo que el sistema leyó del comprobante ─────────────────────────────────
//
// Los campos extraídos de la imagen, las señales de riesgo y el score, para
// que el dueño decida con algo más que su intuición.
//
// ⚠️ ESTO NO CONFIRMA UN PAGO, y el panel lo dice con todas las letras encima
// de los datos. Un comprobante que se lee perfecto sigue siendo una imagen:
// pudo editarse, generarse con una plantilla o reutilizarse de otro pedido. Lo
// único que confirma un pago es el dueño mirando su banco.
//
// El `businessId` sale del JWT y viaja DENTRO de la función de base de datos:
// el identificador del pedido va en la URL y sin el negocio se estaría
// enseñando el comprobante de otro local.
router.get(
  '/api/client/orders/:id/receipt-analysis',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const analisis = await db.getReceiptAnalysis(businessId, String(req.params.id || ''))
    // Sin comprobante registrado no es un error: son todos los pedidos
    // anteriores a esta capa, y el panel tiene que pintarlos igual.
    if (!analisis || analisis.result === 'sin_analisis') {
      return res.json({ analisis: null, esperado: null })
    }

    // Lo ESPERADO viaja con lo detectado para que el panel los pueda poner
    // uno al lado del otro. El total ya lo tiene el panel —está pintando el
    // pedido—, pero la cuenta del negocio no, y es justo la comparación que
    // más pesa: si el dinero fue a otra cuenta, ese pago no va a llegar.
    const cuenta = await db.getBusinessBankAccount(businessId).catch(() => null)
    return res.json({
      analisis,
      esperado: cuenta
        ? {
          bank_name: cuenta.bank_name ?? null,
          account_number: cuenta.account_number ?? null,
          holder_name: cuenta.holder_name ?? null,
        }
        : null,
    })
  },
)

router.get(
  '/api/client/orders',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    // authClient garantiza estos claims; nunca se acepta businessId del request.
    const businessId = getClientBusinessId(req)
    // Se admite una lista separada por comas porque lo que espera al negocio
    // son DOS estados —un pedido nuevo y un comprobante por revisar—, y la
    // alarma tiene que verlos de una sola consulta. Con uno solo se quedó
    // ciega el 2026-08-08.
    // Se deduplica: pedir doce veces el mismo estado no significa nada, y sin
    // esto una petición podía llevar cientos de repeticiones a la consulta.
    // Los estados posibles son doce contados, así que el conjunto es el tope.
    const crudo = req.query.status === undefined ? null : String(req.query.status)
    const estados = crudo === null
      ? null
      : [...new Set(crudo.split(',').map(estado => estado.trim()).filter(Boolean))]
    if (estados !== null && (
      !estados.length
      || estados.some(estado => !ESTADOS_PEDIDO.includes(estado as typeof ESTADOS_PEDIDO[number]))
    )) {
      return res.status(400).json({ error: 'Estado de pedido inválido' })
    }
    // Uno solo sigue viajando como texto: es como se pedía antes de admitir
    // listas, y el repositorio filtra igual en los dos casos.
    const filtro = estados === null ? null : estados.length === 1 ? estados[0] : estados
    // Las opciones salen ya agrupadas por grupo: el panel pinta lo que recibe
    // y no vuelve a agrupar por su cuenta, que es como el panel y la mini app
    // acabaron enseñando cosas distintas del mismo plato.
    res.json(conOpcionesAgrupadasEnLote(await db.getOrders(businessId, 100, filtro)))
  },
)

// ── Pedido de mostrador ────────────────────────────────────────────────────
//
// Lo que se vende en persona, por el MISMO camino que el resto: nace entregado
// y la propia función de base de datos le crea la venta. Antes esto era un
// segundo camino («Registrar venta») y por eso el dinero entraba de dos formas
// distintas.
//
// El precio NO viaja: se mandan ids y cantidades y la RPC resuelve cada
// importe del catálogo (regla inviolable #8).
// ── LA CHECKLIST: marcar una línea como metida en la bolsa ─────────────────
//
// El caso del dueño: «el cliente pide hamburguesa, papas y gaseosa; el
// empleado mete las dos primeras, olvida la gaseosa y el pedido sale
// incompleto».
//
// ⚠️ Esta ruta NO decide nada: la comprobación de que el pedido y la línea son
// de ESTE negocio vive en `marcar_linea_preparada`, en PostgreSQL. Aquí solo
// se pasa quién lo hizo, para que la línea de tiempo lo pueda decir.
//
// ⚠️ Y el CANDADO tampoco está aquí: vive en `set_order_status`, que es la
// única puerta que mueve un pedido de estado. Ponerlo en el panel dejaría la
// puerta abierta desde el navegador.
router.post(
  '/api/client/orders/:id/items/:itemId/prepared',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    const orderId = String(req.params.id || '').trim()
    const itemId = String(req.params.itemId || '').trim()
    if (!orderId || !itemId) {
      return res.status(400).json({ error: 'Falta el pedido o la línea' })
    }
    try {
      const estado = await db.markOrderItemPrepared(
        businessId, orderId, itemId, getClientUserId(req),
      )
      if (estado?.result === 'cerrado') {
        return res.status(409).json({
          error: 'Este pedido ya está cerrado y no se puede volver a preparar',
        })
      }
      return res.json(estado)
    } catch (error) {
      const mensaje = (error as Error).message || ''
      // 42501 lo lanza la base cuando el pedido o la línea no son de este
      // negocio. Se responde 404 y no 403: distinguirlos diría si ese id
      // existe en otro local.
      if (/no pertenece|no es de este pedido/i.test(mensaje)) {
        return res.status(404).json({ error: 'No encontramos esa línea' })
      }
      console.error('❌ marcar línea preparada:', mensaje)
      return res.status(500).json({ error: 'No pudimos marcar ese producto' })
    }
  },
)

router.post(
  '/api/client/orders',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>
    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) {
      return res.status(400).json({ error: 'El pedido no tiene productos' })
    }

    const lineas = items.slice(0, 50).map((raw) => {
      const item = (raw ?? {}) as Record<string, unknown>
      return {
        product_id: String(item.product_id ?? item.productId ?? ''),
        quantity: Number(item.quantity) || 0,
      }
    })
    if (lineas.some(linea => !linea.product_id || linea.quantity < 1)) {
      return res.status(400).json({ error: 'Cada línea necesita un producto y una cantidad' })
    }

    const telefono = String(body.contact_phone ?? '').trim()
    try {
      const { data, error } = await db.createOrder(
        {
          business_id: getClientBusinessId(req),
          // Sin teléfono es una venta de paso. El literal lo convierte a nulo
          // la propia base al crear la venta, para no inventar un cliente.
          contact_phone: telefono || 'mostrador',
          contact_name: String(body.contact_name ?? '').trim().slice(0, 120) || null,
          status: 'completado',
          currency: 'USD',
          source: 'manual',
        },
        lineas,
      )
      if (error) {
        // 42501 y 40001 son del catálogo (producto ajeno, precio movido): es
        // un pedido que no debía existir, no un fallo del servidor.
        const codigo = ['42501', '40001'].includes(String(error.code)) ? 409 : 400
        return res.status(codigo).json({ error: error.message || 'No se pudo registrar el pedido' })
      }
      return res.status(201).json(data)
    } catch (error) {
      console.error('❌ pedido de mostrador:', error instanceof Error ? error.message : 'Error')
      return res.status(500).json({ error: 'No se pudo registrar el pedido' })
    }
  },
)

// ── «Ya me llegó el pago» ──────────────────────────────────────────────────
//
// El botón para el pago que NO pasó por la app: el cliente transfirió desde su
// banco —a veces desde la cuenta de un familiar— y mandó la captura por
// WhatsApp. Hasta ahora eso no se podía anotar en ningún sitio: el cliente
// seguía viendo el número de cuenta y el dueño, «sin comprobante todavía».
//
// Va SEPARADO de aceptar el pedido a propósito. Son dos momentos distintos:
// a las once de la noche el dueño da el pago por bueno pero no va a encender
// la cocina, y el cliente merece saber que su plata llegó igualmente.
router.put(
  '/api/client/orders/:id/payment-confirmed',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    try {
      const pedido = await db.confirmOrderPayment(businessId, String(req.params.id || ''))
      // Las condiciones viven en el `where` de la consulta, así que un `null`
      // significa «no cumplía»: de otro negocio, en efectivo, ya cerrado, o ya
      // marcado. No se distingue cuál para no confirmar qué pedidos existen.
      if (!pedido) {
        return res.status(409).json({
          error: 'Ese pedido no admite confirmar el pago ahora mismo',
        })
      }
      return res.json(pedido)
    } catch (error) {
      console.error(
        '❌ confirmar pago:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      return res.status(500).json({ error: 'No se pudo confirmar el pago' })
    }
  },
)

// ── Pedir otro comprobante ─────────────────────────────────────────────────
//
// Rechazar CIERRA el pedido: `rechazado` es final y al cliente le llega «tu
// pedido fue cancelado». Sin esto, una foto borrosa costaba una venta entera.
//
// Devuelve el pedido a `esperando_pago` y borra el comprobante anterior, que
// van juntas: sin borrarlo, el buzón de WhatsApp rechazaría la foto siguiente.
//
// ⚠️ NO manda ningún WhatsApp, y es deliberado: cada aviso automático es
// dinero en todos los negocios del SaaS. Aquí no hace falta — el pedido vuelve
// a esperar pago, así que al cliente le reaparece solo el aviso en la tienda y
// la pantalla que le dice qué hacer. Si el dueño quiere explicarle, le escribe.
/**
 * Le pide al cliente una foto nueva del comprobante.
 *
 * El dueño rechazó la anterior —borrosa, cortada, o sencillamente no era un
 * comprobante—, y el pedido volvió a `esperando_pago`. Sin este mensaje el
 * cliente no tiene forma de enterarse.
 */
async function avisarQueFaltaOtroComprobante(
  businessId: string,
  order: unknown,
): Promise<void> {
  try {
    const pedido = (order || {}) as {
      contact_phone?: string | null
      order_number?: number | null
      total?: unknown
    }
    const telefono = String(pedido.contact_phone || '').trim()
    if (!telefono) return
    const negocio = await db.getBusinessById(businessId)
    if (!negocio) return

    const whatsapp = require('../integrations/whatsapp') as {
      sendText(business: unknown, to: string, text: string): Promise<void>
    }
    const numero = pedido.order_number ? ` #${pedido.order_number}` : ''
    const total = Number(pedido.total || 0).toFixed(2)
    await whatsapp.sendText(
      negocio,
      telefono,
      `📸 No pudimos leer tu comprobante del pedido${numero}.\n\n`
      + `¿Puedes enviarnos otra foto? Que se vean el *valor ($${total})*, `
      + 'la *fecha* y el *banco*.',
    )
  } catch (error) {
    // Un fallo de envío no puede tumbar la respuesta al dueño: el pedido ya
    // volvió a esperar pago, que es lo que él pidió.
    console.error(
      '⚠️  aviso de comprobante nuevo:',
      error instanceof Error ? error.message : 'Error desconocido',
    )
  }
}

router.post(
  '/api/client/orders/:id/request-proof',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const businessId = getClientBusinessId(req)
    try {
      const { data, error } = await db.requestNewPaymentProof(
        businessId, String(req.params.id || ''),
      )
      if (error) {
        console.error('❌ pedir otro comprobante:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo pedir otro comprobante' })
      }
      const resultado = (data || {}) as { result?: string; order?: unknown }
      if (resultado.result === 'not_found') {
        return res.status(404).json({ error: 'Ese pedido no existe' })
      }
      if (resultado.result === 'invalid_transition') {
        return res.status(409).json({
          error: 'Solo se puede pedir otro comprobante mientras revisas el pago',
        })
      }
      // ⚠️ Y se le DICE al cliente. Hasta el 2026-08-22 no se le avisaba: en
      // la mini app lo veía al recargar la pantalla de pago, pero quien pidió
      // por el chat no se enteraba nunca — se quedaba esperando un pedido que
      // el dueño había devuelto a «esperando pago», sin saber por qué.
      //
      // Va sin reclamo ni cola, al revés que los hitos de estado: no se paga
      // por hito sino por acción manual del dueño, y la RPC ya impide el
      // doble toque (el segundo da `invalid_transition`). Sale sin `await` y
      // NUNCA lanza: el pedido ya volvió a esperar pago, y un fallo de envío
      // no puede tumbar la respuesta al dueño.
      void avisarQueFaltaOtroComprobante(businessId, resultado.order)
      return res.json({ ok: true })
    } catch (error) {
      console.error(
        '❌ pedir otro comprobante:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      return res.status(500).json({ error: 'No se pudo pedir otro comprobante' })
    }
  },
)

router.put(
  '/api/client/orders/:id/status',
  auth.authClient,
  auth.requirePermission('ventas'),
  async (req, res) => {
    const status = (req.body as { status?: unknown })?.status
    if (!ESTADOS_DESTINO.includes(String(status) as typeof ESTADOS_DESTINO[number])) {
      // Del mismo sitio que la validación: añadir un estado no puede dejar el
      // mensaje mintiendo sobre cuáles se aceptan.
      return res.status(400).json({
        error: `El estado debe ser ${ESTADOS_DESTINO.join(', ')}`,
      })
    }
    // Del JWT, nunca del request: es el mismo negocio para cambiar el estado,
    // marcar el pago y avisar al cliente.
    const businessId = getClientBusinessId(req)
    try {
      const { data, error } = await db.setOrderStatus(
        businessId,
        req.params.id,
        String(status),
      )
      if (error) {
        // ⚠️ 22023 es una REGLA dicha por la base, no un fallo: «este pedido se
        // paga con tarjeta y el cobro aún no está confirmado»
        // (`orders_card_requires_payment`). El panel enseña ese pedido con
        // «no lo prepares todavía», y si el dueño tocaba igual leía «no se pudo
        // actualizar el pedido», como si algo se hubiera roto. Lo encontraron
        // los recorridos de punta a punta (2026-10-01).
        if ((error as { code?: string }).code === '22023') {
          return res.status(409).json({ error: error.message })
        }
        console.error('❌ actualizar pedido:', error.message || 'Error desconocido')
        return res.status(500).json({ error: 'No se pudo actualizar el pedido' })
      }
      const result = data as {
        result?: 'updated' | 'not_found' | 'invalid_transition' | 'not_deliverable'
          | 'not_pickable' | 'incompleto'
        faltan?: string
        order?: unknown
      } | null
      if (result?.result === 'not_found') {
        return res.status(404).json({ error: 'Pedido no encontrado' })
      }
      if (result?.result === 'not_deliverable') {
        return res.status(409).json({
          error: 'Este pedido es para retirar en el local: no puede salir a reparto',
        })
      }
      // ⚠️ Las dos respuestas del candado de la checklist (#407). La base las
      // daba desde entonces, pero esta ruta no las conocía y caían en el 500 de
      // «respuesta inválida»: el dueño que tocaba «salió» con algo sin meter en
      // la bolsa leía un fallo de la base en vez de QUÉ le faltaba. La pantalla
      // esconde el botón mientras falte algo, así que casi nunca se veía; lo
      // encontraron los recorridos de punta a punta (2026-10-01).
      if (result?.result === 'not_pickable') {
        return res.status(409).json({
          error: 'Este pedido es a domicilio: no se marca «listo para retirar», sale a reparto',
        })
      }
      if (result?.result === 'incompleto') {
        return res.status(409).json({
          error: `Todavía falta meter en la bolsa: ${result.faltan || 'productos sin marcar'}`,
          faltan: result.faltan || null,
        })
      }
      if (result?.result === 'invalid_transition') {
        return res.status(409).json({ error: 'Ese cambio ya no es válido para el estado actual del pedido' })
      }
      if (result?.result !== 'updated') {
        return res.status(500).json({ error: 'La base de datos devolvió una respuesta inválida' })
      }

      // ── Lo que ocurre después de mover un pedido ────────────────────────
      //
      // Todo esto va después de responder al dueño en lo que importa: el
      // estado ya cambió y la cocina tiene su comanda. Nada de aquí puede
      // convertir un cambio que funcionó en un error en pantalla.

      // Aceptar el pedido ES dar el pago por bueno. El dueño que manda algo a
      // la cocina ya decidió que le van a pagar, así que un segundo toque para
      // decir lo mismo sobraba. La consulta filtra sola lo que no aplica
      // (efectivo, ya marcado).
      if (String(status) === 'preparacion') {
        await db.confirmOrderPayment(businessId, req.params.id)
          .catch(() => { /* el pedido ya avanzó: la marca es un extra */ })
      }

      // Y se le avisa al cliente en los hitos que le importan: cuando su
      // pedido arranca, cuando sale —o queda listo para retirar— y cuando se
      // entrega. Los demás estados no se avisan, y la lista está en el
      // servicio: es la que decide cuántos mensajes cuesta cada pedido.
      //
      // SIN esperar a que termine, a propósito: manda un mensaje por un canal
      // externo que puede tardar segundos o colgarse. El dueño toca el botón
      // con la cocina esperando; hacerle mirar una pantalla quieta hasta que
      // YCloud conteste es cambiar su tiempo por el de un aviso que se
      // registra solo si falla.
      if (seAvisa(String(status))) {
        void avisarAlCliente(businessId, req.params.id, String(status))
      }

      res.json(result.order)
    } catch (error) {
      console.error(
        '❌ actualizar pedido:',
        error instanceof Error ? error.message : 'Error desconocido',
      )
      res.status(500).json({ error: 'No se pudo actualizar el pedido' })
    }
  },
)

export = router
