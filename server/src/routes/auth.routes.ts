import crypto from 'node:crypto'
import type { Router } from 'express'
import type { BusinessRecord } from '../db/types'
import type { SegundoPasoDelAdmin } from '../db/repositories/admin-seguridad'
import rateLimit from 'express-rate-limit'
import jwt from 'jsonwebtoken'
import { JWT } from '../middleware/auth'
import { createRouter } from '../middleware/async'
import { enlaceDeConfiguracion, nuevaClave, verificarCodigo } from '../lib/codigos-de-un-solo-uso'

interface LoginBody {
  email?: unknown
  password?: unknown
}

interface ClientUser {
  id: string
  business_id: string
  password_hash: string
  name?: unknown
  role?: string | null
  permissions?: unknown
}

interface ModuloBcrypt {
  compare(value: string, hash: string): Promise<boolean>
}
const bcrypt: ModuloBcrypt = require('bcryptjs') as typeof import('bcryptjs')
interface ModuloDb {
  getClientByEmail(email: string): Promise<ClientUser | null>
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
  leerSegundoPasoDelAdmin(): Promise<SegundoPasoDelAdmin>
  guardarClavePendiente(clave: string): Promise<void>
  activarClave(clave: string, paso: number): Promise<void>
  anotarPasoUsado(paso: number): Promise<void>
}
const db: ModuloDb = require('../db') as typeof import('../db')

const LOGIN_RATE_LIMIT_OPTIONS = {
  windowMs: 15 * 60 * 1000,
  max: 20,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos fallidos. Espera 15 minutos.' },
}

type AuthRouter = Router & {
  loginRateLimitOptions: typeof LOGIN_RATE_LIMIT_OPTIONS
  /** Solo para las pruebas: vacía la cuenta global de códigos fallidos. */
  olvidarFallosDelSegundoPaso(): void
}

const router = createRouter() as AuthRouter
router.loginRateLimitOptions = LOGIN_RATE_LIMIT_OPTIONS

const loginLimiter = rateLimit(LOGIN_RATE_LIMIT_OPTIONS)

// ═══════════════════════════════════════════════════════════════════════════
// EL SUPERADMIN ENTRA EN DOS PASOS (2026-09-29)
// ═══════════════════════════════════════════════════════════════════════════
//
// Hasta hoy bastaban el correo y la contraseña, y la sesión duraba 7 días sin
// forma de cortarla — en la cuenta que ve el dinero de todos, enciende la
// tarjeta y marca liquidaciones como pagadas. El dueño eligió una app de
// códigos (ver `lib/codigos-de-un-solo-uso.ts`).
//
//   1. `/api/admin/login` — correo y contraseña. NO da la sesión: da un pase
//      de 10 minutos (`role: 'admin_2fa'`) que `authAdmin` rechaza, y dice si
//      toca el CÓDIGO o, la primera vez, CONFIGURAR la app.
//   2. `/api/admin/login/configurar` — solo la primera vez: la clave nueva
//      para escribirla en la app. Queda pendiente hasta que se confirme.
//   3. `/api/admin/login/codigo` — el código de 6 dígitos. Da la sesión de
//      verdad (`mfa: true`), de 12 horas.
//
// ⚠️ Falla CERRADO: si la base no responde, no se entra. Un segundo paso que
// se salta cuando algo va mal no es un segundo paso.

/** La sesión del superadmin. Antes 7 días; un día de trabajo basta. */
const DURACION_DE_LA_SESION = '12h'
/** El pase entre la contraseña y el código. */
const DURACION_DEL_PASE = '10m'
/** Una clave a medio configurar caduca: quien no terminó, empieza otra vez. */
const PENDIENTE_CADUCA_MS = 15 * 60_000

// ⚠️ Un tope GLOBAL de códigos fallidos, además del límite por IP: quien ya
// tiene la contraseña puede repartir intentos entre mil IP, y seis dígitos
// son un millón de combinaciones. Con esto, diez fallos en 15 minutos cierran
// el segundo paso a todo el mundo 15 minutos. Vive en memoria: con una sola
// réplica basta, y un reinicio solo lo vacía antes de tiempo.
const FALLOS_MAXIMOS = 10
const VENTANA_DE_FALLOS_MS = 15 * 60_000
let fallosDelSegundoPaso: number[] = []
const segundoPasoCerrado = (ahora: number): boolean => {
  fallosDelSegundoPaso = fallosDelSegundoPaso.filter(t => ahora - t < VENTANA_DE_FALLOS_MS)
  return fallosDelSegundoPaso.length >= FALLOS_MAXIMOS
}
router.olvidarFallosDelSegundoPaso = () => { fallosDelSegundoPaso = [] }

/** Igualdad que tarda lo mismo acierte o no: no deja adivinar letra a letra. */
const mismoTexto = (a: string, b: string): boolean => crypto.timingSafeEqual(
  crypto.createHash('sha256').update(a).digest(),
  crypto.createHash('sha256').update(b).digest(),
)

interface PaseDelAdmin {
  role: 'admin_2fa'
  email: string
  paso: 'codigo' | 'configurar'
}

const leerPase = (pase: unknown): PaseDelAdmin | null => {
  if (typeof pase !== 'string' || !pase) return null
  try {
    const decoded = jwt.verify(pase, JWT())
    if (typeof decoded === 'string' || decoded.role !== 'admin_2fa') return null
    if (decoded.paso !== 'codigo' && decoded.paso !== 'configurar') return null
    return { role: 'admin_2fa', email: String(decoded.email || ''), paso: decoded.paso }
  } catch {
    return null
  }
}

const sesionDelAdmin = (email: string): string => (
  jwt.sign({ role: 'admin', email, mfa: true }, JWT(), { expiresIn: DURACION_DE_LA_SESION })
)

router.post('/api/admin/login', loginLimiter, async (req, res) => {
  const { email, password } = (req.body || {}) as LoginBody
  const adminEmail = process.env.ADMIN_EMAIL?.trim()
  const adminPassword = process.env.ADMIN_PASSWORD
  if (!adminEmail || !adminPassword
    || typeof email !== 'string' || typeof password !== 'string'
    || !mismoTexto(email, adminEmail) || !mismoTexto(password, adminPassword)) {
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  }

  let estado: SegundoPasoDelAdmin
  try {
    estado = await db.leerSegundoPasoDelAdmin()
  } catch {
    return res.status(503).json({ error: 'No se pudo comprobar el segundo paso. Inténtalo en un momento.' })
  }
  const paso = estado.clave ? 'codigo' : 'configurar'
  const pase = jwt.sign({ role: 'admin_2fa', email, paso }, JWT(), { expiresIn: DURACION_DEL_PASE })
  res.json({ paso, pase })
})

router.post('/api/admin/login/configurar', loginLimiter, async (req, res) => {
  const pase = leerPase((req.body || {}).pase)
  if (!pase) return res.status(401).json({ error: 'El acceso venció. Vuelve a escribir tu contraseña.' })
  if (pase.paso !== 'configurar') return res.status(409).json({ error: 'El segundo paso ya está configurado.' })

  let estado: SegundoPasoDelAdmin
  try {
    estado = await db.leerSegundoPasoDelAdmin()
  } catch {
    return res.status(503).json({ error: 'No se pudo preparar el segundo paso. Inténtalo en un momento.' })
  }
  // ⚠️ Si otro ya lo configuró entre medias, NO se ofrece una clave nueva: sería
  // dejar que el pase de la contraseña sustituyera la app del dueño.
  if (estado.clave) return res.status(409).json({ error: 'El segundo paso ya está configurado.' })

  const clave = nuevaClave()
  await db.guardarClavePendiente(clave)
  res.json({ clave, enlace: enlaceDeConfiguracion(clave, pase.email) })
})

router.post('/api/admin/login/codigo', loginLimiter, async (req, res) => {
  const { pase: paseEnviado, codigo } = (req.body || {}) as { pase?: unknown; codigo?: unknown }
  const pase = leerPase(paseEnviado)
  if (!pase) return res.status(401).json({ error: 'El acceso venció. Vuelve a escribir tu contraseña.' })

  const ahora = Date.now()
  if (segundoPasoCerrado(ahora)) {
    return res.status(429).json({ error: 'Demasiados códigos incorrectos. Espera 15 minutos.' })
  }

  let estado: SegundoPasoDelAdmin
  try {
    estado = await db.leerSegundoPasoDelAdmin()
  } catch {
    return res.status(503).json({ error: 'No se pudo comprobar el código. Inténtalo en un momento.' })
  }

  const texto = typeof codigo === 'string' ? codigo : ''
  if (pase.paso === 'configurar') {
    const vigente = estado.pendiente && !estado.clave && estado.pendienteDesde
      && ahora - Date.parse(estado.pendienteDesde) < PENDIENTE_CADUCA_MS
    const paso = vigente ? verificarCodigo(estado.pendiente as string, texto, ahora) : null
    if (paso === null) {
      fallosDelSegundoPaso.push(ahora)
      return res.status(401).json({ error: vigente ? 'Código incorrecto' : 'La configuración caducó. Vuelve a empezar.' })
    }
    await db.activarClave(estado.pendiente as string, paso)
    return res.json({ token: sesionDelAdmin(pase.email) })
  }

  const paso = estado.clave ? verificarCodigo(estado.clave, texto, ahora, estado.ultimoPaso) : null
  if (paso === null) {
    fallosDelSegundoPaso.push(ahora)
    return res.status(401).json({ error: 'Código incorrecto' })
  }
  // Se apunta ANTES de dar la sesión: si no se pudiera, el mismo código
  // serviría otra vez dentro de su minuto y medio.
  await db.anotarPasoUsado(paso)
  res.json({ token: sesionDelAdmin(pase.email) })
})

router.post('/api/client/login', loginLimiter, async (req, res) => {
  const { email, password } = (req.body || {}) as LoginBody
  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(401).json({ error: 'Credenciales incorrectas' })
  }
  try {
    const user = await db.getClientByEmail(email)
    if (!user) return res.status(401).json({ error: 'Credenciales incorrectas' })

    const validPassword = await bcrypt.compare(password, user.password_hash)
    if (!validPassword) return res.status(401).json({ error: 'Credenciales incorrectas' })

    const business = await db.getBusinessById(user.business_id)
    if (!business?.active) {
      return res.status(403).json({
        error: 'Tu cuenta no está activa. Contacta al administrador.',
      })
    }

    const userRole = user.role || 'owner'
    const permissions = Array.isArray(user.permissions) ? user.permissions : []
    const token = jwt.sign({
      userId: user.id,
      businessId: user.business_id,
      role: 'client',
      urole: userRole,
      perms: permissions,
      email,
    }, JWT(), { expiresIn: '7d' })

    res.json({
      token,
      user: {
        name: user.name || '',
        role: userRole,
        permissions,
      },
      business: {
        id: business.id,
        name: business.name,
        type: business.type,
        suspended: business.suspended,
        bot_active: business.bot_active,
      },
    })
  } catch (error) {
    console.error('❌ Login cliente:', (error as Error).message)
    res.status(500).json({ error: 'No se pudo iniciar sesión' })
  }
})

export = router
