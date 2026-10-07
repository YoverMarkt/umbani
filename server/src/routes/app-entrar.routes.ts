import rateLimit from 'express-rate-limit'
import { createRouter } from '../middleware/async'
import { esStaging } from '../config/environment'
import { leerConfiguracionCorreo } from '../config/correo'
import { correoNormalizado } from '../lib/correo-normalizado'
// La misma regla que el repartidor: el celular de Ecuador, en dígitos y con su código de país.
import { telefonoDelRepartidor as telefonoDeCelular } from '../lib/telefono-del-repartidor'
import { enviarCorreo } from '../services/correo'
import {
  canjearCodigoDeCorreo, pedirCodigoPorCorreo, type DependenciasDelCorreo,
} from '../services/entrar-con-correo'
import { authApp, correoDe, firmarSesionDeCorreo } from '../services/sesion-app'

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
}

const cuerpo = (req: { body?: unknown }) => (req.body || {}) as Record<string, unknown>

// ── 1. Pedir el código ──────────────────────────────────────────────────────
// La misma respuesta exista o no la cuenta: la cuenta nace al canjearlo.
router.post('/api/v1/auth/correo', pedirLimiter, async (req, res) => {
  const correo = correoNormalizado(cuerpo(req).correo)
  if (!correo) return res.status(400).json({ error: 'Escribe un correo válido' })
  const r = await pedirCodigoPorCorreo(correo, dependencias)
  switch (r.estado) {
    case 'enviado': return res.status(201).json({ enviado: true, expiraEn: r.expiraEn })
    // ⚠️ SOLO EN STAGING, sin proveedor de correo: el código vuelve aquí.
    case 'pruebas': return res.status(201).json({ enviado: false, expiraEn: r.expiraEn, codigoDePruebas: r.codigo })
    case 'demasiados': return res.status(429).json({ error: 'Ya te mandamos varios códigos. Revisa tu correo (también el spam) o espera un rato.' })
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
