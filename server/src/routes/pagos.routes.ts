import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import { ID_PAYPHONE_VALIDO, REFERENCIA_VALIDA, pagosConTarjeta } from '../services/pago-con-tarjeta'

// ═══════════════════════════════════════════════════════════════════════════
// LA VUELTA DE PAYPHONE
// ═══════════════════════════════════════════════════════════════════════════
//
// Después de pagar, PayPhone manda el NAVEGADOR del cliente aquí con `id` y
// `clientTransactionId`. Esta es la URL registrada en PayPhone Developer como
// «Url de respuesta» — no se cambia de sitio sin cambiarla allí.
//
// ⚠️ Es PÚBLICA y no se fía de nada: cualquiera puede escribir esta URL con
// los parámetros que quiera. Lo único que hace es pedir que se confirme ese
// cobro; si se confirma lo decide la base con la respuesta de PayPhone, que
// valida la pareja `id` + referencia. Una URL inventada no paga nada.
//
// ⚠️ La redirección no es imprescindible: si el teléfono nunca llega aquí, la
// tarea del servidor (`procesarPendientes`) confirma igual. Esto solo hace
// que el cliente vea el resultado en segundos en vez de en un minuto.

interface PagosRouteDatabase {
  getCardPaymentOrder(ref: string): Promise<{ order_id: string; business_id: string } | null>
  getBusinessById(businessId: string): Promise<{ slug?: string | null } | null>
}

const db: PagosRouteDatabase = require('../db') as typeof import('../db')

const router = createRouter()

const retornoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Demasiadas peticiones, espera un momento',
})

/** Sin tienda a la que volver: un texto corto, nunca una página en blanco. */
const SIN_DESTINO = '<!doctype html><html lang="es"><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1">'
  + '<title>Umbani</title><body style="font-family:system-ui;padding:24px">'
  + '<p>No encontramos ese pago. Vuelve a WhatsApp y abre tu pedido desde el chat.</p></body></html>'

router.get('/pagos/payphone/retorno', retornoLimiter, async (req, res) => {
  // Ni la caché ni el `Referer` pueden llevarse esta URL a otro sitio.
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')

  const referencia = String(req.query.clientTransactionId || '').trim()
  const id = String(req.query.id || '').trim()
  if (!REFERENCIA_VALIDA.test(referencia)) return res.status(404).type('html').send(SIN_DESTINO)

  // Canceló en la página de PayPhone: no hay nada que confirmar. El pedido
  // sigue esperando y la tienda le deja reintentar o elegir otro método.
  if (req.query.cancelado !== '1') {
    await pagosConTarjeta().confirmar(referencia, ID_PAYPHONE_VALIDO.test(id) ? id : null)
  }

  const cobro = await db.getCardPaymentOrder(referencia).catch(() => null)
  const negocio = cobro ? await db.getBusinessById(cobro.business_id).catch(() => null) : null
  if (!cobro || !negocio?.slug) return res.status(404).type('html').send(SIN_DESTINO)

  // A su tienda, con el pedido que acaba de pagar. La tienda pregunta el
  // resultado con la sesión del cliente; aquí no se afirma nada.
  return res.redirect(303, `/t/${encodeURIComponent(negocio.slug)}?pago=${encodeURIComponent(cobro.order_id)}`)
})

export = router
