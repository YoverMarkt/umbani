import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import { esStaging } from '../config/environment'
import { leerConfiguracionCorreo } from '../config/correo'
import { leerConfiguracionTurnstile } from '../config/turnstile'
import { correoNormalizado } from '../lib/correo-normalizado'
// La misma regla que el repartidor: el celular de Ecuador, en dígitos y con su código de país.
import { telefonoDelRepartidor as telefonoDeCelular } from '../lib/telefono-del-repartidor'
import { crearTopePorVentana, enteroDelEntorno } from '../lib/tope-por-ventana'
import { enviarCorreo } from '../services/correo'
import { recordError } from '../services/error-log'
import {
  CODIGOS_POR_HORA_EN_TOTAL, canjearCodigoDeCorreo, pedirCodigoPorCorreo, type DependenciasDelCorreo,
} from '../services/entrar-con-correo'
import { authApp, correoDe, firmarSesionDeCorreo } from '../services/sesion-app'
import { comprobarFichaHumana } from '../services/turnstile'

// ═══════════════════════════════════════════════════════════════════════════
// ENTRAR A LAS APPS CON CORREO, Y EL TELÉFONO DE LA CUENTA (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// La puerta de las apps (`/u`, `/r` y las de Flutter) desde que no entran por
// WhatsApp. Las reglas están en `services/entrar-con-correo.ts`; aquí solo
// se traduce cada resultado a lo que ve la persona. Documentada en
// `docs/apps/openapi.yaml`.

const db = require('../db') as typeof import('../db')

const router = createRouter()

const limitador = (max: number, mensaje: string) => rateLimit({
  windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { error: mensaje },
})
// Por IP. El tope por CORREO (5 por hora) lo pone la base: este no basta,
// porque desde muchas IPs se podría llenar el buzón de una sola persona.
const pedirLimiter = limitador(5, 'Demasiados códigos pedidos, espera un momento')
const canjearLimiter = limitador(20, 'Demasiados intentos, espera un momento')
const cuentaLimiter = limitador(30, 'Demasiadas peticiones, espera un momento')

// El tope GLOBAL de códigos (2026-10-08): los de arriba cuentan por IP y por
// correo; este, para toda la plataforma. Ver `services/entrar-con-correo.ts`.
const topeDeCodigos = crearTopePorVentana({
  maximo: enteroDelEntorno(process.env.CORREO_CODIGOS_POR_HORA_EN_TOTAL, CODIGOS_POR_HORA_EN_TOTAL),
  ventanaMs: 60 * 60 * 1000,
  alLlenarse: () => {
    console.warn('⚠️ 📧 Se llenó el tope global de códigos por correo: ¿un bot pidiendo códigos?')
    void recordError({
      category: 'envio',
      code: 'correo_tope_global',
      message: 'Se llenó el tope de códigos por correo de la hora: o hay una campaña (súbelo con '
        + 'CORREO_CODIGOS_POR_HORA_EN_TOTAL) o un bot pidiendo códigos para correos inventados.',
    })
  },
})

const dependencias: DependenciasDelCorreo = {
  hayProveedor: () => Boolean(leerConfiguracionCorreo()),
  esStaging: () => esStaging(process.env),
  secreto: () => {
    const valor = process.env.JWT_SECRET
    if (!valor) throw new Error('Falta JWT_SECRET')
    return valor
  },
  contarCodigos: (correo, desde) => db.contarCodigosDeCorreo(correo, desde),
  guardarCodigo: (correo, huella, expira) => db.guardarCodigoDeCorreo(correo, huella, expira),
  enviar: correo => enviarCorreo(correo),
  codigoVigente: correo => db.codigoDeCorreoVigente(correo),
  gastarIntento: (id, intentosAntes) => db.gastarIntentoDeCodigoDeCorreo(id, intentosAntes),
  marcarUsado: id => db.marcarCodigoDeCorreoUsado(id),
  cabeOtroCodigo: () => topeDeCodigos.cabe(),
}

const cuerpo = (req: { body?: unknown }) => (req.body || {}) as Record<string, unknown>

// ── 0. Lo que necesita la pantalla de entrar ────────────────────────────────
// Si el captcha está encendido, su clave de SITIO (pública). Sin él, `null` y
// la app no pinta nada. Se lee en cada petición: encenderlo en Railway no
// pide volver a construir la app.
router.get('/api/v1/auth/config', cuentaLimiter, (_req, res) => {
  const turnstile = leerConfiguracionTurnstile()
  res.setHeader('Cache-Control', 'no-store')
  res.json({ turnstile: turnstile ? { claveDeSitio: turnstile.claveDeSitio } : null })
})

// ── 1. Pedir el código ──────────────────────────────────────────────────────
// La misma respuesta exista o no la cuenta: la cuenta nace al canjearlo.
router.post('/api/v1/auth/correo', pedirLimiter, async (req, res) => {
  const correo = correoNormalizado(cuerpo(req).correo)
  if (!correo) return res.status(400).json({ error: 'Escribe un correo válido' })
  // ⚠️ El captcha ANTES que nada que gaste: ni se cuenta un código ni sale un
  // correo para quien no demuestra ser una persona. Ver `services/turnstile.ts`.
  const turnstile = leerConfiguracionTurnstile()
  if (turnstile) {
    const veredicto = await comprobarFichaHumana(cuerpo(req).turnstile, req.ip, { secreto: turnstile.secreto })
    if (veredicto === 'rechazado') {
      return res.status(403).json({ error: 'No pudimos comprobar que eres una persona. Vuelve a intentarlo.', falta: 'turnstile' })
    }
    if (veredicto === 'caido') {
      void recordError({
        category: 'servidor',
        code: 'turnstile_caido',
        message: 'Cloudflare Turnstile no contestó al comprobar a quien pedía un código: nadie pudo entrar mientras tanto.',
      })
      return res.status(503).json({ error: 'No pudimos comprobar que eres una persona. Inténtalo en un momento.' })
    }
  }
  const r = await pedirCodigoPorCorreo(correo, dependencias)
  switch (r.estado) {
    case 'enviado': return res.status(201).json({ enviado: true, expiraEn: r.expiraEn })
    // ⚠️ SOLO EN STAGING, sin proveedor de correo: el código vuelve aquí.
    case 'pruebas': return res.status(201).json({ enviado: false, expiraEn: r.expiraEn, codigoDePruebas: r.codigo })
    case 'demasiados': return res.status(429).json({ error: 'Ya te mandamos varios códigos. Revisa tu correo (también el spam) o espera un rato.' })
    case 'saturado':
      res.setHeader('Retry-After', '600')
      return res.status(503).json({ error: 'Hay muchas personas entrando ahora mismo. Inténtalo en unos minutos.' })
    case 'no_disponible': return res.status(503).json({ error: 'Entrar con correo todavía no está disponible' })
    default: return res.status(502).json({ error: 'No pudimos mandar el correo. Inténtalo en un momento.' })
  }
})

// ── 2. Canjearlo por la sesión ──────────────────────────────────────────────
router.post('/api/v1/auth/correo/verificar', canjearLimiter, async (req, res) => {
  const correo = correoNormalizado(cuerpo(req).correo)
  if (!correo) return res.status(400).json({ error: 'Escribe un correo válido' })
  const codigo = String(cuerpo(req).codigo ?? '').replace(/\s/g, '')
  const r = await canjearCodigoDeCorreo(correo, codigo, dependencias)
  if (r === 'ok') return res.json({ token: firmarSesionDeCorreo(correo), correo })
  if (r === 'incorrecto') return res.status(401).json({ error: 'Ese código no es correcto' })
  return res.status(410).json({ error: 'Ese código ya no vale. Pide uno nuevo.' })
})

// ── 3. A qué número le llama el repartidor ──────────────────────────────────
// Una cuenta de correo nace sin teléfono y lo pone antes de su primer pedido.
// ⚠️ En EXCLUSIVA: de ese número cuelgan sus pedidos (`db.reclamarTelefono`).
router.put('/api/v1/yo/telefono', cuentaLimiter, authApp, async (req, res) => {
  const correo = correoDe(req)
  if (!correo) return res.status(409).json({ error: 'Tu número ya lo confirmó WhatsApp' })
  const telefono = telefonoDeCelular(cuerpo(req).telefono)
  if (!telefono) return res.status(400).json({ error: 'Escribe tu celular, por ejemplo 0991234567' })
  const cuenta = await db.cuentaPorCorreo(correo)
  const r = await db.reclamarTelefono(cuenta.id, telefono)
  if (r === 'ok') return res.json({ telefono })
  if (r === 'ya_tiene') return res.status(409).json({ error: 'Tu cuenta ya tiene un número. Si cambió, escríbenos.' })
  // El mismo texto sea de quien sea: no se dice si es de WhatsApp o de otra cuenta.
  return res.status(409).json({ error: 'Ese número ya está en otra cuenta de Umbani. Si es tuyo, escríbenos.' })
})

export = router
