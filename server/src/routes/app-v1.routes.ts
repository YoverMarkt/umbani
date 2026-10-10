import rateLimit from 'express-rate-limit'
import multer from 'multer'
import type { RequestHandler } from 'express'
import { createHash } from 'node:crypto'
import { MEDIA_LIMITS, mapMulterError, validateMediaFile } from '../lib/media'
import { isConfigured, uploadPrivateMedia } from '../integrations/cloudinary'
import { enSegundoPlano } from '../lib/segundo-plano'
import { createRouter } from '../middleware/async'
import { deviceFingerprint } from '../services/storefront-session'
import { issueStorefrontSession } from '../services/storefront-link'
import { authApp, telefonoDe } from '../services/sesion-app'
import { conOpcionesAgrupadas } from '../services/order-detail'
import { reglaDeMargen } from '../services/storefront'
import { pedidoParaElCliente, porcentajePorProducto } from '../lib/precio-para-el-cliente'
import { ciudadesDe } from '../services/marketplace-ciudad'
import { conConfirmacion, leerReclamo, respuestaAlCliente, respuestaDelReclamo } from '../services/reclamos'
import { clienteDeLaSesion, telefonoDelCliente } from '../services/cliente-de-la-app'

// ═══════════════════════════════════════════════════════════════════════════
// LA API DE LA APP DEL CLIENTE (v1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que la app necesita ADEMÁS de la API de la tienda (`/api/store/:slug/*`),
// que usa tal cual: ver el marketplace y pedir una sesión de tienda para entrar
// en un local. Se entra con el correo (`app-entrar.routes.ts`). Documentada en
// `docs/apps/openapi.yaml` — si una ruta cambia aquí, cambia allí (lo vigila
// `docs-apps.test.js`).
//
// ⚠️ La app PINTA, nunca calcula: todo importe llega del servidor.

const db = require('../db') as typeof import('../db')

const router = createRouter()

const limitador = (max: number, mensaje: string) => rateLimit({
  windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: mensaje },
})
const codigoLimiter = limitador(5, 'Demasiados códigos pedidos, espera un momento')
const verificarLimiter = limitador(60, 'Demasiados intentos, espera un momento')
const appLimiter = limitador(90, 'Demasiadas peticiones, espera un momento')
const fotoLimiter = limitador(10, 'Demasiadas fotos seguidas, espera un momento')


// ── La entrada por WhatsApp, RETIRADA (2026-10-09) ────────────────────────
//
// Las apps entraban mandando un código al WhatsApp de Umbani. Decisión del
// dueño: Umbani es SOLO APP y se entra con el correo (`app-entrar.routes.ts`);
// después vendrán el SMS, Google y Apple. Las dos rutas siguen registradas
// —documentadas como retiradas en `docs/apps/openapi.yaml`— para que una app
// vieja reciba una respuesta clara en vez de un 404.
//
// El bot conserva su parte (reconocer «Mi código de Umbani» en el chat): es
// WhatsApp en espera, y sin una app que pida códigos no tiene nada que hacer.
const ENTRADA_RETIRADA = { error: 'Ya no se entra con WhatsApp. Entra con tu correo.' }
router.post('/api/v1/auth/whatsapp', codigoLimiter, (_req, res) => res.status(410).json(ENTRADA_RETIRADA))
router.post('/api/v1/auth/whatsapp/verificar', verificarLimiter, (_req, res) => res.status(410).json(ENTRADA_RETIRADA))

/** Con la ciudad que eligió el cliente (2026-10-05), si eligió alguna. */
router.get('/api/v1/yo', appLimiter, authApp, async (req, res) => {
  const cliente = await clienteDeLaSesion(req)
  // El saldo Umbani (2026-10-10). Si no se pudo leer, `null`: la app no
  // enseña un saldo que no conoce, y el resto de su cuenta sigue.
  const saldo = await db.customerCreditBalance(cliente.id).catch(() => null)
  // `telefono` null = entró con correo y aún no dijo a qué número le llaman.
  return res.json({ telefono: telefonoDe(req) || cliente.telefono, correo: cliente.correo, ciudadId: cliente.ciudadId, saldo })
})

// ── Las ciudades (2026-10-05) ─────────────────────────────────────────────
//
// Como las grandes, la app pregunta DÓNDE está el cliente antes de enseñarle
// nada. Solo salen las ciudades con al menos un local que puede recibir un
// pedido ahora; con una sola, la app la elige sin preguntar.
router.get('/api/v1/ciudades', appLimiter, async (_req, res) => {
  const filas = await db.getMarketplaceCategories()
  return res.json({ ciudades: ciudadesDe(filas).map(c => ({ id: c.id, nombre: c.nombre })) })
})

/**
 * ¿En qué ciudad estoy? (2026-10-05) La app manda el GPS y el servidor dice la
 * ciudad, como las grandes: el cliente no elige, se le enseña lo de donde está.
 *
 *   · Dentro de una ciudad → `{ ciudad, conLocales }`. Sin locales todavía, la
 *     app dice «pronto llegamos a {ciudad}».
 *   · Fuera de todas → `{ ciudad: null, cercana }` y queda ANOTADO (redondeado
 *     a ~1 km, una vez por día y dispositivo): de ahí sale dónde abrir la
 *     siguiente. Anotarlo falla abierto: la respuesta no espera a la base.
 *
 * Sin GPS (permiso negado), la app usa la lista de `/api/v1/ciudades`.
 */
router.get('/api/v1/ciudades/aqui', appLimiter, async (req, res) => {
  const lat = Number(req.query.lat)
  const lng = Number(req.query.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180
    || req.query.lat === undefined || req.query.lng === undefined) {
    return res.status(400).json({ error: 'Ubicación no válida (?lat=&lng=)' })
  }
  const punto = await db.cityAt(lat, lng)
  if (punto?.dentro) {
    const conLocales = (await db.getMarketplaceCategories()).some(c => c.city_id === punto.id)
    return res.json({ ciudad: { id: punto.id, nombre: punto.name }, conLocales })
  }
  const dispositivo = String(req.headers['x-umbani-dispositivo'] || req.headers['x-storefront-device'] || '').trim()
  const huella = dispositivo ? createHash('sha256').update(dispositivo).digest('hex').slice(0, 16) : ''
  void enSegundoPlano(db.recordCoverageRequest(lat, lng, huella).catch(() => { /* anotar no puede tumbar la respuesta */ }))
  return res.json({ ciudad: null, cercana: punto ? { nombre: punto.name, km: punto.km } : null })
})

/**
 * La ciudad que eligió en la app. Es la MISMA que usa el chat de WhatsApp: el
 * cliente es uno, entre por donde entre.
 */
router.put('/api/v1/yo/ciudad', appLimiter, authApp, async (req, res) => {
  const ciudadId = String((req.body as Record<string, unknown> | undefined)?.ciudadId || '').trim()
  if (!UUID.test(ciudadId)) return res.status(400).json({ error: 'Ciudad no válida' })
  const ciudad = await db.getCity(ciudadId)
  if (!ciudad || !ciudad.active) return res.status(404).json({ error: 'No atendemos en esa ciudad' })
  const cliente = await clienteDeLaSesion(req)
  await db.setCustomerCity(cliente.id, ciudad.id)
  return res.json({ ciudadId: ciudad.id, nombre: ciudad.name })
})

// ── El marketplace de UNA ciudad: categorías y sus locales ────────────────
//
// ⚠️ La ciudad es OBLIGATORIA (2026-10-05): sin ella, un cliente de Chone
// vería los locales de Portoviejo. La app la saca de `/api/v1/ciudades`.
router.get('/api/v1/marketplace', appLimiter, async (req, res) => {
  const ciudadId = String(req.query.ciudad || '').trim()
  if (!UUID.test(ciudadId)) return res.status(400).json({ error: 'Falta la ciudad (?ciudad=<id> de /api/v1/ciudades)' })
  const categorias = (await db.getMarketplaceCategories()).filter(c => c.city_id === ciudadId)
  const conLocales = await Promise.all(categorias.map(async categoria => ({
    codigo: categoria.code,
    nombre: categoria.label,
    emoji: categoria.emoji,
    locales: (await db.getMarketplaceBusinesses(categoria.code, ciudadId)).map(local => ({
      slug: local.slug,
      nombre: local.name,
      tipo: local.type,
      minutos: local.prep_min,
      // null = no se pudo saber: la app lo pinta como abierto, igual que el chat.
      abierto: local.abierto ?? null,
      conCarta: local.con_carta ?? null,
      cartaDesde: local.carta_desde ?? null,
    })),
  })))
  return res.json({ categorias: conLocales })
})

// ── La sesión de tienda para un local ─────────────────────────────────────
//
// Con ella la app usa `/api/store/:slug/*` enviando `x-storefront-token` y el
// MISMO `x-storefront-device`, `User-Agent` y `Accept-Language` que aquí: la
// sesión queda atada a esa huella. Pedir otra al entrar en otro local revoca
// la anterior (un enlace vivo a la vez, como por WhatsApp).
router.post('/api/v1/locales/:slug/sesion', appLimiter, authApp, async (req, res) => {
  const dispositivo = typeof req.headers['x-storefront-device'] === 'string' ? req.headers['x-storefront-device'].trim() : ''
  if (dispositivo.length < 8) return res.status(400).json({ error: 'Falta el identificador del dispositivo (x-storefront-device)' })
  // Sin teléfono no hay pedido: el repartidor tiene que poder llamar, y de él
  // cuelgan sus pedidos. La app lo pide con `PUT /api/v1/yo/telefono`.
  const telefono = await telefonoDelCliente(req)
  if (!telefono) return res.status(409).json({ error: 'Antes de pedir, dinos a qué número te llama el repartidor', falta: 'telefono' })
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  if (!business) return res.status(404).json({ error: 'No encontramos ese local' })
  const token = await issueStorefrontSession({
    business,
    phone: telefono,
    deviceHash: deviceFingerprint({
      clientId: dispositivo,
      userAgent: req.headers['user-agent'] || '',
      acceptLanguage: req.headers['accept-language'] || '',
    }),
  })
  if (!token) return res.status(409).json({ error: 'Este local no está recibiendo pedidos ahora mismo' })
  return res.status(201).json({ token })
})

// ── «Mis pedidos»: los de este teléfono en TODOS los locales (2026-10-01) ──
//
// La tienda solo enseña los pedidos del local de su sesión; una app necesita
// la lista entera. El teléfono sale del TOKEN (lo demostró WhatsApp), nunca de
// la petición, y cada pedido se enseña con lo que pagó el cliente: nada del
// local ni del margen (`lib/precio-para-el-cliente.ts`).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const porcentajeDe = async (businessId: string): Promise<number | null> =>
  porcentajePorProducto(reglaDeMargen(await db.getBusinessPricingRule(businessId).catch(() => null)))
const elLocal = (fila: { businesses?: { name?: string | null; slug?: string | null } | null }) => ({
  nombre: fila.businesses?.name ?? null,
  slug: fila.businesses?.slug ?? null,
})

router.get('/api/v1/pedidos', appLimiter, authApp, async (req, res) => {
  // Sin teléfono todavía, la lista sale vacía: nada cuelga de él.
  const { data, error } = await db.getAppOrders(await telefonoDelCliente(req))
  if (error) return res.status(500).json({ error: 'No pudimos consultar tus pedidos' })
  const porLocal = new Map<string, number | null>()
  const pedidos = []
  for (const fila of (data || []) as Record<string, unknown>[]) {
    const negocio = String(fila.business_id)
    if (!porLocal.has(negocio)) porLocal.set(negocio, await porcentajeDe(negocio))
    const { business_id: _negocio, contact_phone: _telefono, businesses, ...pedido } = fila
    pedidos.push({
      ...pedidoParaElCliente(conOpcionesAgrupadas(pedido), porLocal.get(negocio) ?? null),
      local: elLocal({ businesses: businesses as { name?: string; slug?: string } | null }),
    })
  }
  // «¿Llegó todo bien?» (2026-10-06): de todos los pedidos de una vez.
  return res.json({ pedidos: await conConfirmacion(pedidos as Record<string, unknown>[]) })
})

router.get('/api/v1/pedidos/:id', appLimiter, authApp, async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese pedido' })
  // El mismo 404 para «no existe» y «es de otro»: no se confirma qué ids hay.
  const dueno = await db.getAppOrderOwner(await telefonoDelCliente(req), id).catch(() => null)
  if (!dueno) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const { data, error } = await db.getStorefrontOrder({
    businessId: dueno.business_id, contactPhone: dueno.contact_phone, orderId: id,
  })
  if (error) return res.status(500).json({ error: 'No pudimos consultar tu pedido' })
  if (!data) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const [pedido] = await conConfirmacion([{
    ...pedidoParaElCliente(conOpcionesAgrupadas(data as Record<string, unknown>), await porcentajeDe(dueno.business_id)),
    local: elLocal(dueno),
  } as Record<string, unknown>])
  return res.json(pedido)
})

// ── «¿Llegó todo bien?» (2026-10-06) ─────────────────────────────────────
// Por el teléfono de la sesión: la base comprueba que el pedido es suyo, que
// se entregó y que no pasaron 48 horas; y calcula lo que le corresponde.
router.post('/api/v1/pedidos/:id/todo-bien', appLimiter, authApp, async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const r = await db.confirmOrderReceived(id, await telefonoDelCliente(req))
  if (r.result === 'ok') return res.json({ ok: true })
  const e = respuestaAlCliente(r.result)
  return res.status(e.status).json({ error: e.error })
})

router.post('/api/v1/pedidos/:id/reclamo', appLimiter, authApp, async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese pedido' })
  const { tipo, lineas, nota, foto } = leerReclamo(req.body)
  const r = await db.reportOrderProblem(id, await telefonoDelCliente(req), tipo, lineas, nota, foto)
  // Fase 2 (2026-10-10): si es pequeño y su historial está limpio, el saldo
  // llega AL INSTANTE (`estado: 'compensada'`); si no, lo revisa una persona.
  if (r.result === 'ok') return res.status(201).json(respuestaDelReclamo(tipo, r))
  const e = respuestaAlCliente(r.result)
  return res.status(e.status).json({ error: e.error })
})

// ── La foto del reclamo (2026-10-10) ──────────────────────────────────────
// «Vino mal» se aprueba al instante solo con foto. La sube el SERVIDOR, en
// privado, en la carpeta de ESE pedido; la app manda luego su identificador
// en `foto` y la base comprueba que es de ese pedido. Antes de subir nada se
// comprueba que el pedido es de la sesión y está entregado: nadie llena la
// nube de fotos de pedidos ajenos.
const subidaDeFoto: RequestHandler = (req, res, next) => {
  multer({ storage: multer.memoryStorage(), limits: { fileSize: MEDIA_LIMITS.image } })
    .single('file')(req, res, error => {
      if (error) {
        const mapped = mapMulterError(error, MEDIA_LIMITS.image)
        return res.status(mapped.status).json({ error: mapped.error })
      }
      next()
    })
}

router.post('/api/v1/pedidos/:id/reclamo/foto', fotoLimiter, authApp, subidaDeFoto, async (req, res) => {
  const id = String(req.params.id || '').trim()
  if (!UUID.test(id)) return res.status(404).json({ error: 'No encontramos ese pedido' })
  if (!req.file) return res.status(400).json({ error: 'No llegó la foto' })
  const invalido = validateMediaFile(req.file)
  if (invalido) return res.status(invalido.status).json({ error: invalido.error })
  if (!req.file.mimetype?.startsWith('image/')) return res.status(400).json({ error: 'Tiene que ser una foto' })
  // El mismo 404 para «no existe» y «es de otro».
  const dueno = await db.getAppOrderOwner(await telefonoDelCliente(req), id).catch(() => null)
  if (!dueno) return res.status(404).json({ error: 'No encontramos ese pedido' })
  if (dueno.status !== 'completado') return res.status(409).json({ error: 'Tu pedido todavía no se ha entregado' })
  if (!(await isConfigured())) return res.status(503).json({ error: 'No podemos recibir fotos ahora mismo. Inténtalo en un rato.' })
  try {
    const subida = await uploadPrivateMedia(req.file.buffer, dueno.business_id, `reclamos/${id}`)
    return res.status(201).json({ foto: subida.public_id })
  } catch (error) {
    console.error('❌ foto del reclamo:', error instanceof Error ? error.message : 'Error desconocido')
    return res.status(502).json({ error: 'No pudimos guardar tu foto. Inténtalo de nuevo.' })
  }
})

export = router
