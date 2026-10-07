// La tienda (mini app): crear el pedido, verlo y «¿Llegó todo bien?».
// Una sección del router de `storefront.routes.ts`, que las registra EN ORDEN.

import type { Router } from 'express'
import type { RequestHandler } from 'express'
import { conOpcionesAgrupadas } from '../../services/order-detail'
import { requireStorefrontSession } from '../../middleware/storefront'
import { pedirComprobantePorChat } from '../../services/payment-request-notice'
import { canOrder, reglaDeMargen } from '../../services/storefront'
import { avisarAlDuenoDelPedido } from '../../services/owner-order-notice'
import { tarjetaDisponible } from '../../services/pago-con-tarjeta'
import { pedidoParaElCliente, porcentajePorProducto } from '../../lib/precio-para-el-cliente'
import { conConfirmacion, leerReclamo, respuestaAlCliente } from '../../services/reclamos'
import { db, orderLimiter, readStatus } from './comun'

export function registrarPedidos(router: Router): void {
  // ── Pedido ─────────────────────────────────────────────────────────────────
  router.post('/api/store/:slug/orders', orderLimiter, requireStorefrontSession, async (req, res) => {
    const { businessId, customerId, contactPhone } = req.storefront!
    const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
    const { status } = await readStatus(business)

    const body = (req.body || {}) as Record<string, unknown>

    // ── Bloqueado por el dueño: no pide, ni con su enlace ───────────────────
    //
    // El bloqueo del panel es TOTAL por decisión del dueño (2026-08-13): si solo
    // callara al bot, quien tenga su enlace guardado seguiría metiendo pedidos y
    // el bloqueo no bloquearía nada.
    //
    // Va aquí y no en el middleware a propósito: mirar la carta no molesta a
    // nadie, y comprobarlo en cada petición de catálogo sería pagar una consulta
    // por cada persona que abre la tienda para algo que le pasa a casi ninguna.
    // Lo que hay que impedir es que ENTRE un pedido, y eso pasa por aquí.
    //
    // El mensaje no dice «estás bloqueado»: quien molesta busca una reacción, y
    // el dueño no tiene por qué dar explicaciones desde una pantalla.
    if (await db.isCustomerBlocked(businessId, customerId).catch(() => false)) {
      return res.status(403).json({
        // ⚠️ Sin «comunícate con el local»: el cliente no tiene su número, y no
        // debe tenerlo. Se dice el hecho y nada más; la salida —los otros
        // locales— vive en la pantalla de bloqueado, no en un error de la API.
        error: 'Este local no está recibiendo tus pedidos ahora mismo.',
      })
    }

    // ── Cerrado: se puede mirar, no pedir ───────────────────────────────────
    //
    // La tienda solo acepta pedidos inmediatos. Los programados se retiraron el
    // 2026-08-07 por decisión del dueño: no están en el diagrama de referencia.
    // Con esto vuelve el comportamiento anterior — con el local cerrado no entra
    // ningún pedido, ni siquiera para más tarde.
    if (!canOrder(status)) {
      return res.status(409).json({
        error: status === 'cerrada'
          ? 'El negocio está cerrado ahora mismo'
          : 'Esta tienda no está recibiendo pedidos',
        status,
      })
    }

    const items = Array.isArray(body.items) ? body.items : []
    if (!items.length) {
      return res.status(400).json({ error: 'El pedido no tiene productos' })
    }

    // Se reconstruye la lista dejando fuera cualquier precio que mande la app:
    // aquí solo viajan ids y cantidades.
    const safeItems = items.slice(0, 50).map((raw) => {
      const item = (raw || {}) as Record<string, unknown>
      return {
        product_id: String(item.productId || item.product_id || ''),
        variant_id: String(item.variantId || item.variant_id || '') || null,
        extra_ids: (Array.isArray(item.extraIds) ? item.extraIds : [])
          .slice(0, 20)
          .map(id => String(id)),
        // Del motor de opciones solo pasa el id y cuántas porciones. El recargo,
        // el nombre y la validación de obligatorios salen de la base.
        options: (Array.isArray(item.options) ? item.options : [])
          .slice(0, 30)
          .map((raw) => {
            const opcion = (raw || {}) as Record<string, unknown>
            return {
              option_id: String(opcion.optionId || opcion.option_id || ''),
              quantity: Math.min(100, Math.max(1, Number(opcion.quantity) || 1)),
            }
          })
          .filter(opcion => opcion.option_id),
        quantity: Number(item.quantity) || 0,
        note: String(item.note || '').slice(0, 200) || null,
      }
    })

    const fulfillment = ['delivery', 'pickup', 'onsite'].includes(String(body.fulfillment))
      ? String(body.fulfillment)
      : null

    // «pago_al_retirar» no es cómo paga, es CUÁNDO: al pasar por el local. La
    // app solo lo ofrece en modo retiro, y aquí se vuelve a comprobar — una app
    // vieja, o alguien tocando la petición, no puede prometerle al negocio que
    // pasará a recoger un pedido que pidió a domicilio.
    //
    // ⚠️ La TARJETA (2026-09-27) solo si este local la tiene y el servidor cobra
    // en su mismo modo. Y si no, se RECHAZA: los demás métodos desconocidos se
    // convierten en «sin método», pero quien eligió tarjeta cree que va a pagar
    // con ella — un pedido creado sin método le haría esperar un cobro que no
    // existe.
    const metodoPedido = String(body.paymentMethod)
    if (metodoPedido === 'tarjeta' && !tarjetaDisponible(business)) {
      return res.status(409).json({ error: 'El pago con tarjeta no está disponible en este local ahora mismo' })
    }
    const metodoValido = ['transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta'].includes(metodoPedido)
      && !(metodoPedido === 'pago_al_retirar' && fulfillment === 'delivery')
    const paymentMethod = metodoValido ? metodoPedido : null

    const contactName = String(body.name || '').slice(0, 120) || null

    const result = await db.createStorefrontOrder({
      businessId,
      customerId,
      contactPhone,
      contactName,
      addressId: String(body.addressId || '') || null,
      fulfillment,
      paymentMethod,
      items: safeItems,
      // La app la genera al abrir el checkout y la repite si reintenta. Sin
      // clave el comportamiento es el de siempre: cada envío, un pedido.
      idempotencyKey: String(body.idempotencyKey || '').trim().slice(0, 100) || null,
      // El tope replica el CHECK de la base: un texto larguísimo acabaría en el
      // panel del dueño y en el reporte.
      deliveryNotes: String(body.deliveryNotes || '').trim().slice(0, 300) || null,
      // La tienda ya no programa (retirado el 2026-08-07). La RPC conserva el
      // parámetro y la columna `scheduled_for` sigue en la base: quitarlos
      // exigiría recrear la función del dinero por un campo que nadie llena.
      scheduledFor: null,
    })

    if (result.error) {
      // 42501 es pertenencia (producto ajeno, dirección de otro): no es un fallo
      // del servidor, es un pedido que no debía existir.
      const code = result.error.code === '42501' ? 403 : 400
      return res.status(code).json({ error: result.error.message || 'No se pudo crear el pedido' })
    }

    // El nombre se recuerda para el próximo pedido.
    //
    // Va DESPUÉS de crear el pedido y sin `await` que lo bloquee: es una
    // comodidad, no un requisito, y si la base la rechaza el cliente ya tiene su
    // pedido hecho. Antes esto no ocurría en ningún sitio —`ensureCustomer` lo
    // intenta con un `upsert` que la fila existente ignora—, así que la mini app
    // tenía la precarga construida y `display_name` en nulo tras 25 pedidos.
    if (contactName && contactName.trim().length >= 2) {
      void db.setCustomerDisplayName(businessId, customerId, contactName.trim())
        .catch(() => { /* el pedido ya está: recordar el nombre no puede fallarlo */ })
    }

    // ── El aviso al DUEÑO, si lo tiene encendido ────────────────────────────
    //
    // ⚠️ Nace APAGADO (`notify_owner_whatsapp`) y por eso esto casi siempre no
    // gasta nada: son dos mensajes por pedido y Meta los cobra. El dueño se
    // entera igual por la alarma del panel, que es gratis; esto es para quien
    // no lo tiene abierto.
    //
    // ⚠️ Sin `await`, como el resto de esta zona: el pedido YA está creado y el
    // cliente tiene que ver su confirmación ahora. Un proveedor externo lento no
    // puede retrasar la pantalla de «pedido recibido».
    //
    // ⚠️ Con TARJETA no: ese pedido todavía no existe para el local — no suena
    // su alarma ni avanza hasta que PayPhone confirma el cobro. El aviso sale
    // desde `pago-con-tarjeta.ts` en ese momento, cuando el dinero ya está.
    if (paymentMethod !== 'tarjeta') {
      void avisarAlDuenoDelPedido(businessId, (result.data as { id?: string } | null)?.id).catch(() => {
        /* el pedido ya está: un aviso de cortesía no puede tumbarlo */
      })
    }

    // ── El aviso que cierra el ciclo mini app → WhatsApp ─────────────────────
    //
    // Quien pide por la mini app está en un NAVEGADOR: a su WhatsApp no le llega
    // nada, y el comprobante tiene una sola vía desde el 2026-08-12, que es el
    // chat. Sin este mensaje cierra la pestaña para ir al banco y vuelve sin
    // ninguna conversación a la que responder con la foto.
    //
    // ⚠️ Solo si el pedido nació ESPERANDO PAGO. Un pedido en efectivo no debe
    // recibir una petición de transferencia; lo comprueba también el propio
    // aviso, pero preguntarlo aquí evita una consulta para casi todos.
    //
    // ⚠️ Sin `await`, igual que el nombre: el pedido YA está creado y el cliente
    // tiene que ver su confirmación ahora. Esperar a un proveedor externo antes
    // de responder cambiaría su tiempo por el de un mensaje — y si el canal
    // estuviera lento, le diría que su pedido falló cuando no falló.
    //
    // ⚠️ El estado se lee de la FILA, más abajo, y no de `result.data`: la RPC
    // no devuelve `status`. Preguntarle a ella daba siempre falso, y este aviso
    // no salió NI UNA VEZ en un mes (0 en la cola de producción, 2026-09-27).
    // La prueba lo daba por bueno porque llamaba a la función suelta con un
    // pedido inventado que sí traía el campo.

    // ── El total que se le devuelve al cliente sale de la FILA ──────────────
    //
    // ⚠️ No de lo que calculó la RPC. `create_storefront_order` devuelve su
    // propia cuenta (`subtotal + envío`), y el disparador `orders_stamp_pricing`
    // corre DESPUÉS: en modo `on_top` suma el margen de la plataforma al total.
    //
    // El efecto era de dinero, no de pintura: la pantalla de «pedido recibido»
    // enseñaba $12.99 —y ese es el número que el cliente copia para transferir—
    // sobre un pedido que la base guardaba en $14.09. Siete pedidos nacieron así
    // antes de que se viera; ninguno llegó a pagarse, pero el siguiente sí.
    //
    // Si la relectura fallara se devuelve lo que hay: el pedido está creado y
    // dejar al cliente sin confirmación por un total sería peor que un total
    // corto. Lo vigila la prueba de que los dos números coinciden.
    const creado = (result.data || {}) as Record<string, unknown>
    const oficial = await db.getOrderMoney(businessId, String(creado.id || ''))
    // ⚠️ Con tarjeta NO se pide comprobante: no hay transferencia que fotografiar.
    if (oficial?.status === 'esperando_pago' && oficial.payment_method !== 'tarjeta') {
      void pedirComprobantePorChat(businessId, String(creado.id || ''))
    }
    return res.status(201).json(oficial ? { ...creado, ...oficial } : creado)
  })

  // ── Seguimiento del pedido ────────────────────────────────────────────────
  //
  // ⚠️ EXIGE SESIÓN, y no por costumbre: aquí se devuelve el pedido de UNA
  // persona. Sin ella bastaría con probar identificadores para leer pedidos
  // ajenos. Por eso el filtro es negocio + TELÉFONO DE LA SESIÓN + id, nunca el
  // número correlativo: ese es #1, #2, #3… y se adivina de corrido.
  //
  // Un pedido que no sea suyo devuelve el MISMO 404 que uno que no existe: si
  // distinguiera los dos casos, se podría averiguar qué pedidos tiene el vecino.
  /**
   * Mis pedidos en este negocio. Alimenta la pestaña de Cuenta.
   *
   * ⚠️ Va declarada ANTES que `/orders/:id`: Express resuelve por orden, y una
   * ruta con parámetro no se traga esta porque son caminos distintos, pero
   * dejarlas juntas y en este orden evita sorpresas si mañana cambia una.
   */
  /** El porcentaje por producto de ESTE local, para enseñar cada línea con su precio. */
  const porcentajeDelLocal = async (businessId: string): Promise<number | null> =>
    porcentajePorProducto(reglaDeMargen(await db.getBusinessPricingRule(businessId).catch(() => null)))

  router.get('/api/store/:slug/orders', requireStorefrontSession, async (req, res) => {
    const { businessId, contactPhone } = req.storefront!
    const { data, error } = await db.getStorefrontOrders({ businessId, contactPhone })
    if (error) return res.status(500).json({ error: 'No pudimos consultar tus pedidos' })
    // Agrupadas aquí, como en el pedido suelto: la lista enseña lo que se pidió.
    // Y con los precios que pagó el CLIENTE, nunca los del local (2026-10-01).
    const pct = await porcentajeDelLocal(businessId)
    const pedidos = (data || []).map(pedido => pedidoParaElCliente(conOpcionesAgrupadas(pedido as Record<string, unknown>), pct) as Record<string, unknown>)
    // «¿Llegó todo bien?» (2026-10-06): de todos los pedidos de una vez.
    return res.json(await conConfirmacion(pedidos))
  })

  router.get('/api/store/:slug/orders/:id', requireStorefrontSession, async (req, res) => {
    const { businessId, contactPhone } = req.storefront!
    const orderId = String(req.params.id || '').trim()
    if (!orderId) return res.status(404).json({ error: 'No encontramos ese pedido' })

    const { data, error } = await db.getStorefrontOrder({ businessId, contactPhone, orderId })
    if (error) return res.status(500).json({ error: 'No pudimos consultar tu pedido' })
    if (!data) return res.status(404).json({ error: 'No encontramos ese pedido' })
    // Agrupadas aquí y no en la app: el mismo plato tiene que leerse igual en el
    // seguimiento, en el panel del dueño y en el WhatsApp del cliente.
    const pedido = pedidoParaElCliente(
      conOpcionesAgrupadas(data as Record<string, unknown>),
      await porcentajeDelLocal(businessId),
    ) as Record<string, unknown>
    const [conEstado] = await conConfirmacion([pedido])
    return res.json(conEstado)
  })

  // ── «¿Llegó todo bien?» (2026-10-06) ─────────────────────────────────────
  // ⚠️ El pedido tiene que ser de ESTE local y de ESTE teléfono: la sesión de
  // tienda es de un local, y la base comprueba además el teléfono.
  const pedidoDeLaSesion: RequestHandler = async (req, res, next) => {
    const { businessId, contactPhone } = req.storefront!
    const orderId = String(req.params.id || '').trim()
    const { data } = await db.getStorefrontOrder({ businessId, contactPhone, orderId }).catch(() => ({ data: null }))
    if (!data) return res.status(404).json({ error: 'No encontramos ese pedido' })
    return next()
  }

  router.post('/api/store/:slug/orders/:id/todo-bien', requireStorefrontSession, pedidoDeLaSesion, async (req, res) => {
    const r = await db.confirmOrderReceived(String(req.params.id), req.storefront!.contactPhone)
    if (r.result === 'ok') return res.json({ ok: true })
    const e = respuestaAlCliente(r.result)
    return res.status(e.status).json({ error: e.error })
  })

  router.post('/api/store/:slug/orders/:id/reclamo', requireStorefrontSession, pedidoDeLaSesion, async (req, res) => {
    const { tipo, lineas, nota } = leerReclamo(req.body)
    const r = await db.reportOrderProblem(String(req.params.id), req.storefront!.contactPhone, tipo, lineas, nota)
    if (r.result === 'ok') return res.status(201).json({ ok: true, sugeridoCents: Number(r.sugeridoCents) || 0 })
    const e = respuestaAlCliente(r.result)
    return res.status(e.status).json({ error: e.error })
  })

  /** Datos bancarios para transferir. Solo con sesión y solo del propio negocio. */
  router.get('/api/store/:slug/payment-info', requireStorefrontSession, async (req, res) => {
    const account = await db.getBusinessBankAccount(req.storefront!.businessId)
    if (!account) return res.status(404).json({ error: 'El negocio no tiene datos de pago cargados' })
    return res.json(account)
  })
}
