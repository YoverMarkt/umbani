import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import { getPlatformPhone } from '../services/platform-channel'
import { deviceFingerprint } from '../services/storefront-session'
import { issueStorefrontSession } from '../services/storefront-link'
import {
  CODIGO_VALIDO, VIGENCIA_DEL_CODIGO_MS, authApp, firmarSesionApp, generarCodigo, mensajeDelCodigo, telefonoDe,
} from '../services/sesion-app'

// ═══════════════════════════════════════════════════════════════════════════
// LA API DE LA APP DEL CLIENTE (v1)
// ═══════════════════════════════════════════════════════════════════════════
//
// Lo que la app necesita ADEMÁS de la API de la tienda (`/api/store/:slug/*`),
// que usa tal cual: iniciar sesión con WhatsApp, ver el marketplace y pedir una
// sesión de tienda para entrar en un local. Documentada en
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


// ── Iniciar sesión con WhatsApp ───────────────────────────────────────────
router.post('/api/v1/auth/whatsapp', codigoLimiter, async (_req, res) => {
  const umbani = String(await getPlatformPhone().catch(() => '') || '').replace(/\D/g, '')
  if (!umbani) return res.status(503).json({ error: 'El número de Umbani no está configurado' })
  const expira = new Date(Date.now() + VIGENCIA_DEL_CODIGO_MS)
  for (let intento = 0; intento < 3; intento++) {
    const codigo = generarCodigo()
    if (await db.createAppLoginCode(codigo, expira)) {
      return res.status(201).json({
        codigo,
        // Abre WhatsApp con el mensaje escrito: el cliente solo toca «enviar».
        enlace: `https://wa.me/${umbani}?text=${encodeURIComponent(mensajeDelCodigo(codigo))}`,
        expiraEn: expira.toISOString(),
      })
    }
  }
  return res.status(503).json({ error: 'No pudimos generar el código, inténtalo de nuevo' })
})

router.post('/api/v1/auth/whatsapp/verificar', verificarLimiter, async (req, res) => {
  const codigo = String((req.body as Record<string, unknown> | undefined)?.codigo || '').trim().toUpperCase()
  if (!CODIGO_VALIDO.test(codigo)) return res.status(400).json({ error: 'Código no válido' })
  const r = await db.consumeAppLoginCode(codigo)
  if (r.estado === 'ok') return res.json({ token: firmarSesionApp(r.phone), telefono: r.phone })
  // La app pregunta cada pocos segundos mientras el cliente manda el mensaje.
  if (r.estado === 'pendiente') return res.status(202).json({ pendiente: true })
  return res.status(410).json({ error: 'Ese código ya no vale. Pide uno nuevo.' })
})

router.get('/api/v1/yo', appLimiter, authApp, (req, res) => res.json({ telefono: telefonoDe(req) }))

// ── El marketplace: categorías y sus locales ──────────────────────────────
router.get('/api/v1/marketplace', appLimiter, async (_req, res) => {
  const categorias = await db.getMarketplaceCategories()
  const conLocales = await Promise.all(categorias.map(async categoria => ({
    codigo: categoria.code,
    nombre: categoria.label,
    emoji: categoria.emoji,
    locales: (await db.getMarketplaceBusinesses(categoria.code)).map(local => ({
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
  const business = await db.getBusinessBySlug(String(req.params.slug || '').trim())
  if (!business) return res.status(404).json({ error: 'No encontramos ese local' })
  const token = await issueStorefrontSession({
    business,
    phone: telefonoDe(req),
    deviceHash: deviceFingerprint({
      clientId: dispositivo,
      userAgent: req.headers['user-agent'] || '',
      acceptLanguage: req.headers['accept-language'] || '',
    }),
  })
  if (!token) return res.status(409).json({ error: 'Este local no está recibiendo pedidos ahora mismo' })
  return res.status(201).json({ token })
})

export = router
