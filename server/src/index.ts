// ── ARRANQUE DEL SERVIDOR ───────────────────────────────────────────
// Este archivo solo compone Express, monta routers y levanta procesos.
// Las rutas, autenticación y lógica de negocio viven en sus módulos tipados.
import path from 'node:path'
import crypto from 'node:crypto'
import type { Server } from 'node:http'
import express, {
  type ErrorRequestHandler,
  type Request,
  type RequestHandler,
  type Response,
} from 'express'
import rateLimit from 'express-rate-limit'
import dotenv from 'dotenv'
import { assertEnvironment, esStaging } from './config/environment'
import { comprobarIdentidadDeLaBase } from './config/identidad-de-la-base'
import { decidirTareasDeFondo, explicarDecision } from './config/tareas-de-fondo'
import { asyncHandler } from './middleware/async'
import { getRecentWebhookFailures } from './services/channel-health'
import { recordError } from './services/error-log'
import {
  checkAllCredentials,
  checkPlatformCredentials,
  type MonitorableBusiness,
} from './services/credential-monitor'
import { getPlatformChannel } from './services/platform-channel'
import { expireUnpaidOrders } from './services/order-expiry'
import { pagosConTarjeta } from './services/pago-con-tarjeta'
import { cerrarSemanaAnterior } from './services/liquidacion'
import { cuadrarConPayphone } from './services/cuadre-payphone'
import { vigilarElCaminoDelCliente, ultimaVueltaDelCanario } from './services/canario'
import { providerStatusClient } from './integrations/provider-status'
import { activeClientGuard } from './middleware/auth'
import { securityHeaders } from './middleware/security-headers'
import * as bot from './services/bot-entry'
import { processInboundWebhook } from './services/inbound-webhook'
import * as tunnel from './services/tunnel'
import { createWebhookInboxWorker, fallaQueSeRegistra } from './services/webhook-inbox-worker'
import { getBotInstance, setupTelegram } from './integrations/telegram'
import authRouter = require('./routes/auth.routes')
import adminRouter = require('./routes/admin.routes')
import businessRouter = require('./routes/business.routes')
import blockedContactsRouter = require('./routes/blocked-contacts.routes')
import salesRouter = require('./routes/sales.routes')
import reportsRouter = require('./routes/reports.routes')
import scheduleRouter = require('./routes/schedule.routes')
import productsRouter = require('./routes/products.routes')
import ordersRouter = require('./routes/orders.routes')
import webhooksRouter = require('./routes/webhooks.routes')
import menuModifiersRouter = require('./routes/menu-modifiers.routes')
import productOptionsRouter = require('./routes/product-options.routes')
import catalogStructureRouter = require('./routes/catalog-structure.routes')
import storefrontRouter = require('./routes/storefront.routes')
import pagosRouter = require('./routes/pagos.routes')
import misPagosRouter = require('./routes/mis-pagos.routes')
import repartidoresRouter = require('./routes/repartidores.routes')
import appV1Router = require('./routes/app-v1.routes')
import appMotorizadoRouter = require('./routes/app-motorizado.routes')
import healthRouter = require('./routes/health.routes')
import { cachearEstaticos, enviarHtmlDeSpa } from './lib/cache-estaticos'
import { alEntrarUnMensaje } from './lib/despertador-de-la-cola'

interface StartupDatabase {
  getProductImageById(productId: string): Promise<{ image_url?: string | null } | null>
  /** El candado del arranque: `'staging'` o `null`. Ver `config/identidad-de-la-base.ts`. */
  leerMarcaDeEntorno(): Promise<string | null>
  carryCommissionAdjustments(periodStart: string): Promise<{
    periodo: string
    ajustes: number
    total_ajustado: number
  }>
  settleMonthCommission(periodStart: string): Promise<{
    periodo: string
    facturas_afectadas: number
    comision_total: number
    ya_pagadas: number
  }>
  ensureCurrentMonthBilling(): Promise<{
    data: number | null
    error: { message?: string } | null
  }>
  cleanupWebhookEvents(): Promise<{
    data: number | null
    error: { message?: string } | null
  }>
  getLastInboundAt(): Promise<string | null>
  getAllBusinessesWithSecrets(): Promise<MonitorableBusiness[]>
  cleanupStorefrontSessions(days?: number): Promise<{
    data?: unknown
    error?: { message?: string } | null
  }>
  cleanupPlatformErrors(days?: number): Promise<{
    data: number | null
    error: { message?: string } | null
  }>
}

interface OperationalError extends Error {
  status?: number
  publicMessage?: string
}

type CorsCallback = (error: Error | null, allow?: boolean) => void
type Cors = (options: {
  origin(origin: string | undefined, callback: CorsCallback): void
}) => RequestHandler

const cors = require('cors') as Cors
const db: StartupDatabase = require('./db') as typeof import('./db')
const webhookInboxWorker = createWebhookInboxWorker({
  workerId: `botpanel-${crypto.randomUUID()}`,
  processEvent: event => processInboundWebhook(event.payload, {
    businessId: event.business_id,
    provider: event.provider,
    eventId: event.id,
  }),
  onError: (error, context) => {
    console.error(
      `❌ Inbox webhook [${context.phase}:${context.provider || 'n/a'}:${context.eventId || 'n/a'}]:`,
      error.message,
    )
    // ⚠️ Y AL REGISTRO QUE EL SUPERADMIN PUEDE VER. Hasta el 2026-08-23 esto
    // solo escribía en la salida estándar: cuando el worker empezó a colgarse
    // con los mensajes del marketplace, el panel no mostraba absolutamente
    // nada y hubo que reconstruir el fallo consultando la base a mano.
    //
    // Un fallo de la cola de entrada es exactamente lo que el registro de
    // errores existe para enseñar: si deja de entrar, el negocio está mudo.
    //
    // `void` y `.catch`: registrar el error no puede provocar otro ni retrasar
    // el reintento del evento.
    //
    // ⚠️ Salvo el sondeo que falla UNA vez y se recupera al segundo
    // (2026-09-27): arriba ya quedó en la consola, pero en el registro le
    // costaba al dueño un día de correos del vigía por un corte de un segundo.
    // Ver `CORTE_QUE_SE_REGISTRA_MS`.
    if (!fallaQueSeRegistra(context)) return
    void recordError({
      category: 'canal',
      code: `inbox_${context.phase}`,
      message: error,
      context: {
        provider: context.provider || null,
        eventId: context.eventId || null,
      },
    }).catch(() => { /* registrar el fallo no puede provocar otro */ })
  },
})

// Al compilar, __dirname es server/dist. Estas raíces conservan exactamente
// las ubicaciones usadas antes desde server/index.js.
const serverRoot = path.resolve(__dirname, '..')
const projectRoot = path.resolve(serverRoot, '..')
dotenv.config({ path: path.join(serverRoot, '.env') })
const environment = assertEnvironment(process.env)

const app = express()
let httpServer: Server | null = null
let shuttingDown = false

// Railway/producción corre detrás de un proxy. Express necesita la IP real
// para que express-rate-limit no agrupe a todos los visitantes.
app.set('trust proxy', 1)
app.disable('x-powered-by')
app.use(securityHeaders)

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'apagado ordenado')
}

function shutdown(signal: string, error?: unknown): void {
  if (shuttingDown) return
  shuttingDown = true
  const exitCode = error ? 1 : 0
  console.error(`${error ? '🛑' : '⏹️'} ${signal}:`, errorMessage(error))
  const forceExit = setTimeout(() => process.exit(exitCode), 15_000)
  forceExit.unref()

  const closeHttp = new Promise<void>((resolve) => {
    if (!httpServer) return resolve()
    httpServer.close(() => resolve())
  })
  void (async () => {
    await Promise.allSettled([
      closeHttp,
      webhookInboxWorker.stop(),
    ])
    try {
      await bot.drainPendingMessages()
    } catch (drainError) {
      console.error('❌ Error drenando mensajes durante el apagado:', errorMessage(drainError))
    }
    try {
      getBotInstance()?.stop(signal)
    } catch (telegramError) {
      console.error('❌ Error deteniendo Telegram:', errorMessage(telegramError))
    }
    clearTimeout(forceExit)
    process.exit(exitCode)
  })()
}

process.on('uncaughtException', error => shutdown('uncaughtException', error))
process.on('unhandledRejection', reason => shutdown('unhandledRejection', reason))
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

function logEnvironment(): void {
  if (environment.recommendedMissing.length) {
    console.warn(
      '⚠️  Faltan variables recomendadas:',
      environment.recommendedMissing.join(', '),
      '\n   Meta necesita META_VERIFY_TOKEN + META_APP_SECRET; YCloud usa el signing secret de cada endpoint.',
    )
  }
  console.log('✅ Variables de entorno críticas: OK')
}

app.use(cors({
  origin(origin, callback) {
    if (!origin || !process.env.BASE_URL) return callback(null, true)
    try {
      return callback(null, origin === new URL(process.env.BASE_URL).origin)
    } catch {
      return callback(new Error('BASE_URL inválida'))
    }
  },
}))

// Capturar raw body para verificar firmas de webhooks.
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buffer) => { (req as Request).rawBody = buffer },
}))

const clientDist = path.join(projectRoot, 'apps/client/dist')
const adminDist = path.join(projectRoot, 'apps/admin/dist')
// ⚠️ LA RAÍZ VA ANTES DEL `static`, y no es un adorno: `express.static` sirve
// el `index.html` él mismo cuando la ruta es la carpeta (`/app`), sin pasar por
// `enviarHtmlDeSpa`. El comodín de abajo solo atiende lo que NO casa con un
// archivo, así que `/app/pedidos` pasaba por la función y `/app` no.
//
// Se vio al comprobar la franja de entorno: aparecía en la tienda —donde la
// ruta `/t/<slug>` nunca casa con un archivo— y no en los dos paneles. La misma
// familia de fallo que ya cuenta la cabecera de `lib/cache-estaticos.ts`.
app.get('/app', (_req, res) => enviarHtmlDeSpa(res, path.join(clientDist, 'index.html')))
app.use('/app', express.static(clientDist, { setHeaders: cachearEstaticos }))
app.get('/app/*', (_req, res) => enviarHtmlDeSpa(res, path.join(clientDist, 'index.html')))
app.get('/app-admin', (_req, res) => enviarHtmlDeSpa(res, path.join(adminDist, 'index.html')))
app.use('/app-admin', express.static(adminDist, { setHeaders: cachearEstaticos }))
app.get('/app-admin/*', (_req, res) => enviarHtmlDeSpa(res, path.join(adminDist, 'index.html')))
// Mini app del negocio: /t/<slug>. La ruta es corta a propósito, porque el
// enlace viaja dentro de un mensaje de WhatsApp.
const storeDist = path.join(projectRoot, 'apps/store/dist')
app.use('/t', express.static(storeDist, { setHeaders: cachearEstaticos }))
app.get('/t/*', (_req, res) => enviarHtmlDeSpa(res, path.join(storeDist, 'index.html')))
// La app web de clientes (2026-10-05): otra página de la mini app, con sus
// archivos bajo /t/assets. Es la referencia de la app Flutter y se prueba aquí.
app.get(['/u', '/u/*'], (_req, res) => enviarHtmlDeSpa(res, path.join(storeDist, 'u.html')))
// Páginas legales públicas de Vezzper (sin login): las necesita Meta y las ven
// los clientes. Se sirven como HTML estático desde server/public.
const legalRoot = path.join(serverRoot, 'public')
app.get(['/privacidad', '/privacy'], (_req, res) => res.sendFile(path.join(legalRoot, 'privacidad.html')))
app.get(['/terminos', '/terms'], (_req, res) => res.sendFile(path.join(legalRoot, 'terminos.html')))
app.get(['/admin', '/admin/*'], (_req, res) => res.redirect('/app-admin'))
app.get(['/client', '/client/*'], (_req, res) => res.redirect('/app'))
app.get('/', (_req, res) => res.redirect('/app-admin'))

app.use(authRouter)
// El login se resuelve en authRouter. Toda ruta cliente posterior revalida
// usuario, negocio y permisos actuales antes de llegar a su router.
app.use('/api/client', activeClientGuard)
app.use(adminRouter)
app.use(businessRouter)
app.use(blockedContactsRouter)
app.use(salesRouter)
app.use(reportsRouter)
// Mis pagos: el estado de cuenta del local (solo el dueño).
app.use(misPagosRouter)
app.use(repartidoresRouter)
app.use(scheduleRouter)
app.use(productsRouter)
app.use(menuModifiersRouter)
app.use(productOptionsRouter)
app.use(catalogStructureRouter)
// Rutas públicas de la mini app: sin JWT, la credencial es el enlace del bot.
app.use(storefrontRouter)
// La vuelta de PayPhone tras pagar con tarjeta. Pública: la decide la base.
app.use(pagosRouter)
// La API de la app del cliente (Flutter). Ver docs/apps/.
app.use(appV1Router)
// La API de la app del motorizado. Ver docs/apps/APP-MOTORIZADO.md.
app.use(appMotorizadoRouter)
app.use(ordersRouter)
app.use(webhooksRouter)
// ⚠️ EL FRENO VA ANTES QUE EL ROUTER, y no es cuestión de estilo: Express
// recorre el stack en el orden en que se registra, así que si `healthRouter`
// se monta primero, contesta él y este limitador NO LLEGA A EJECUTARSE NUNCA.
// Quedaría escrito, revisado y muerto — y las pruebas del router, que lo
// despachan directo, seguirían en verde.
//
// El vigía consulta 4 veces por hora: 30 cada 5 minutos le sobran de largo, y
// a la fuerza bruta contra el token no le alcanzan para nada.
const healthDetailLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'no encontrado' },
})
app.use('/api/health/detalle', healthDetailLimiter)
app.use(healthRouter)

const telegramLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'rate limit' },
})
app.use('/webhook/telegram', telegramLimiter)

// ⚠️ Esta ruta es PÚBLICA: solo dice lo que se le puede contar a cualquiera.
// Su hermano con token —`/api/health/detalle`, en `routes/health.routes.ts`—
// es el que cuenta el saldo y las credenciales al vigía externo.
app.get('/api/health', asyncHandler(async (_req: Request, res: Response) => {
  const lastDatabaseSuccess = webhookInboxWorker
    .lastSuccessfulDatabaseOperationAt()
  // ⚠️ `ok` refleja SOLO si este proceso puede trabajar. Railway usa esta ruta
  // como healthcheck: si un canal en silencio la pusiera en 503, reiniciaría el
  // contenedor en bucle y convertiría un aviso en una caída. El estado del canal
  // viaja como dato informativo; para el diagnóstico completo por negocio está
  // /api/admin/channel-health.
  const ok = !shuttingDown && webhookInboxWorker.isReady()
  let lastInboundAt: string | null = null
  // Lo que tarda UNA consulta a la base desde el servidor (2026-09-26). Cada
  // respuesta del chat hace varias en fila, así que este número multiplicado
  // es el grueso de lo que el cliente espera. Con la región al lado, dice si
  // servidor y base están cerca o se cruzan medio continente.
  const antesDeLaBase = Date.now()
  try {
    lastInboundAt = await db.getLastInboundAt()
  } catch {
    lastInboundAt = null
  }
  const baseMs = Date.now() - antesDeLaBase
  const recentFailures = getRecentWebhookFailures(5)
  res.status(ok ? 200 : 503).json({
    ok,
    time: new Date().toISOString(),
    // ── QUÉ CÓDIGO ESTÁ CORRIENDO DE VERDAD ──────────────────────────────
    //
    // ⚠️ Existe por un fallo real del 2026-08-29, y de los caros: cuatro
    // despliegues seguidos se quedaron colgados en Railway y producción siguió
    // sirviendo el código de la mañana. Como la API de GitHub SÍ listaba esos
    // despliegues, se dio por hecho que habían llegado — y durante horas se
    // dijo «verificado en producción» sobre arreglos que no estaban ahí,
    // incluido uno de dinero. El dueño lo descubrió probando la app.
    //
    // Comprobar que EXISTE un despliegue no es comprobar que su código corre.
    // Esto lo hace comprobable de un vistazo: `npm run verify:deploy` compara
    // este valor con el commit que se acaba de fusionar y falla si no coinciden.
    //
    // Railway inyecta la variable sola. En local no existe y vale 'local',
    // que es exactamente lo que hay que ver ahí.
    version: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 7) || 'local',
    region: process.env.RAILWAY_REPLICA_REGION || null,
    base_ms: baseMs,
    // ── ¿El canario está VIVO? ───────────────────────────────────────────
    //
    // ⚠️ El canario calla cuando todo va bien, y eso lo hacía indistinguible
    // de un canario muerto: «sin entradas en el registro» significaba a la vez
    // «se puede comprar» y «nunca corrió». Aquí se ve cuándo dio su última
    // vuelta y qué encontró. `null` = todavía no ha corrido ninguna.
    canario: ultimaVueltaDelCanario(),
    // ⚠️ Cuando el freno de `config/tareas-de-fondo.ts` actúa, el worker no
    // arranca y este `ok` baja a `false` — correctamente, porque el proceso no
    // puede atender mensajes. Sin esta línea, un 503 en local parece una
    // avería en vez de lo que es: una decisión.
    tareas_de_fondo: decidirTareasDeFondo(process.env),
    webhook_inbox: {
      running: webhookInboxWorker.isRunning(),
      ready: webhookInboxWorker.isReady(),
      in_flight: webhookInboxWorker.inFlightCount(),
      last_database_success_at: lastDatabaseSuccess === null
        ? null
        : new Date(lastDatabaseSuccess).toISOString(),
    },
    inbound_channel: {
      last_inbound_at: lastInboundAt,
      hours_since_last_inbound: lastInboundAt === null
        ? null
        : Math.round(
          ((Date.now() - new Date(lastInboundAt).getTime()) / 3_600_000) * 10,
        ) / 10,
      recent_failures: recentFailures.length,
      last_failure: recentFailures[0] || null,
    },
  })
}))

app.get('/api/images/:productId', asyncHandler(async (req: Request, res: Response) => {
  const product = await db.getProductImageById(req.params.productId)
  if (!product?.image_url) return res.status(404).send('No image')

  if (product.image_url.startsWith('data:')) {
    const [header = '', base64 = ''] = product.image_url.split(',')
    const mimeType = header.match(/data:([^;]+)/)?.[1] || 'image/jpeg'
    const buffer = Buffer.from(base64, 'base64')
    res.set('Content-Type', mimeType)
    res.set('Cache-Control', 'public, max-age=86400')
    return res.send(buffer)
  }

  return res.redirect(product.image_url)
}))

const handleHttpError: ErrorRequestHandler = (error: OperationalError, req, res, next) => {
  const requestId = req.headers['x-request-id'] || 'sin-id'
  console.error(`❌ HTTP ${req.method} ${req.path} [${requestId}]:`, errorMessage(error))
  // Solo los fallos reales del servidor: un 400 por datos mal enviados es
  // comportamiento normal y llenaría el registro de ruido.
  if (!error.status || error.status >= 500) {
    void recordError({
      // El superadmin no tiene negocio: sus errores quedan como de plataforma.
      businessId: (req.user && 'businessId' in req.user ? req.user.businessId : null) || null,
      category: 'servidor',
      code: error.status || 500,
      message: errorMessage(error),
      context: { method: req.method, path: req.path },
    })
  }
  if (res.headersSent) return next(error)
  return res.status(error.status || 500).json({
    error: error.publicMessage || 'Error interno del servidor',
  })
}
app.use(handleHttpError)

async function generateCurrentMonthBilling(): Promise<void> {
  try {
    const result = await db.ensureCurrentMonthBilling()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) {
      console.log(`💳 Facturación mensual: ${result.data} cuota(s) generada(s)`)
    }
  } catch (error) {
    console.error('❌ Generación de facturación mensual:', errorMessage(error))
  }
}

/**
 * Lleva la comisión acumulada a la factura del mes.
 *
 * Corre a diario y cierra DOS meses: el actual, para que el comercio vea su
 * factura al día en vez de un número que aparece de golpe el día 1, y el
 * anterior, porque un pedido entregado tarde todavía pertenece al mes en que
 * se vendió. Es idempotente —recalcula desde `sales` y escribe el valor
 * absoluto— y nunca toca un mes ya pagado.
 */
async function settleCommissions(): Promise<void> {
  // En ECUADOR, no en UTC: el día 1 a las 00:30 de Londres aquí es todavía el
  // último día del mes anterior, y el cierre miraría el mes equivocado.
  const primerDia = (desplazamiento: number): string => {
    const partes = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Guayaquil', year: 'numeric', month: '2-digit',
    }).formatToParts(new Date())
    const anio = Number(partes.find(p => p.type === 'year')?.value)
    const mes = Number(partes.find(p => p.type === 'month')?.value)
    const d = new Date(Date.UTC(anio, mes - 1 + desplazamiento, 1))
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-01`
  }
  for (const periodo of [primerDia(0), primerDia(-1)]) {
    try {
      const r = await db.settleMonthCommission(periodo)
      if (r.facturas_afectadas > 0) {
        console.log(`💰 Comisión ${periodo}: ${r.facturas_afectadas} factura(s), $${r.comision_total}`)
      }
    } catch (error) {
      // Nunca tumba el arranque ni la tarea siguiente: si un mes falla, el
      // otro se intenta igual y mañana se reintenta solo.
      console.error(`❌ Cierre de comisión ${periodo}:`, errorMessage(error))
    }
  }

  // Y lo que cambió en meses YA PAGADOS se descuenta del mes en curso: una
  // factura emitida no se reescribe. Va DESPUÉS del cierre porque necesita
  // que la factura del mes exista para volcarle el ajuste.
  try {
    const a = await db.carryCommissionAdjustments(primerDia(0))
    if (a.ajustes > 0) {
      console.log(`↩️  Ajustes arrastrados: ${a.ajustes}, $${a.total_ajustado}`)
    }
  } catch (error) {
    console.error('❌ Arrastre de comisión:', errorMessage(error))
  }
}

async function cleanupWebhookInbox(): Promise<void> {
  try {
    const result = await db.cleanupWebhookEvents()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) console.log(`🧹 Inbox webhook: ${result.data} evento(s) purgado(s)`)
  } catch (error) {
    console.error('❌ Limpieza del inbox webhook:', errorMessage(error))
  }
}

// Revisa solo, cada pocas horas, que las credenciales de cada negocio sigan
// sirviendo: API key válida, número conectado, webhook apuntando aquí y con
// saldo. El panel ya permitía hacerlo A MANO, y por eso en julio de 2026 nadie
// se enteró de nada durante cinco días.
async function checkCredentials(): Promise<void> {
  try {
    const businesses = await db.getAllBusinessesWithSecrets()
    // ⚠️ LAS DOS, y en paralelo. Hasta el 2026-08-23 solo corría la primera, y
    // con todos los locales en el marketplace eso significaba no revisar nada:
    // ninguno tiene credenciales propias. La segunda mira el único canal que
    // de verdad recibe — el número de Umbani.
    const [deNegocios, deLaPlataforma] = await Promise.all([
      checkAllCredentials(businesses, providerStatusClient, {
        baseUrl: process.env.BASE_URL,
      }),
      // Un fallo leyendo `server_settings` no puede impedir la revisión de los
      // negocios con canal propio: se trata como «no configurado», que es lo
      // que ya avisa `checkPlatformCredentials`.
      getPlatformChannel()
        .catch(() => null)
        .then(canal => checkPlatformCredentials(canal, providerStatusClient, {
          baseUrl: process.env.BASE_URL,
        })),
    ])
    const problemas = [...deLaPlataforma, ...deNegocios]
    if (!problemas.length) {
      console.log('🔐 Credenciales: el número del marketplace y los negocios, en orden')
      return
    }
    for (const problema of problemas) {
      const etiqueta = problema.severity === 'error' ? '❌' : '⚠️ '
      console.error(
        `${etiqueta} [${problema.businessName}] ${problema.provider}: ${problema.message}`,
      )
      void recordError({
        businessId: problema.businessId,
        category: 'canal',
        code: problema.code,
        message: problema.message,
        context: { provider: problema.provider, severidad: problema.severity },
      })
    }
  } catch (error) {
    console.error('❌ Revisión de credenciales:', errorMessage(error))
  }
}

// El registro de errores no puede crecer sin fin: se purga lo más viejo de 30
// días. Si la migración todavía no se corrió, el fallo se anota y no molesta.
async function cleanupErrorLog(): Promise<void> {
  try {
    const result = await db.cleanupPlatformErrors()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) console.log(`🧹 Registro de errores: ${result.data} purgado(s)`)
  } catch (error) {
    console.error('❌ Limpieza del registro de errores:', errorMessage(error))
  }
}

// Las sesiones de la mini app tampoco pueden crecer sin fin: cada enlace que
// manda el bot deja una fila. La RPC de limpieza existía desde el primer día
// pero NADIE la llamaba — lo destapó el guardián de exports huérfanos
// (2026-08-02), no un problema en producción, que es como se prefiere.
async function cleanupStorefrontSessions(): Promise<void> {
  try {
    const result = await db.cleanupStorefrontSessions()
    if (result.error) throw new Error(result.error.message || 'RPC sin detalle')
    if (result.data) console.log(`🧹 Sesiones de la tienda: ${result.data} purgada(s)`)
  } catch (error) {
    console.error('❌ Limpieza de sesiones de la tienda:', errorMessage(error))
  }
}

const port = process.env.PORT || 3000

// Lo que pasa al abrir el puerto. Va en una constante y no dentro de
// `app.listen` para poder abrirlo DESPUÉS del candado de abajo.
const alAbrirElPuerto = (): void => {
  logEnvironment()
  console.log(`\n🚀 BotPanel corriendo en http://localhost:${port}`)
  console.log(`👑 Admin:   http://localhost:${port}/app-admin`)
  console.log(`👤 Cliente: http://localhost:${port}/app`)
  console.log(`📡 Webhook: http://localhost:${port}/webhook\n`)

  // ⚠️ EL FRENO. Todo lo que hay aquí dentro ESCRIBE en la base a la que
  // apunte este proceso, y `server/.env` apunta a la de producción: sin esto,
  // encender el servidor en un portátil para mirar una pantalla procesa
  // mensajes de clientes reales y a los 30 s empieza a cancelar sus pedidos.
  //
  // En producción esta condición siempre es `true` y no cambia nada.
  // Ver `config/tareas-de-fondo.ts`.
  const tareas = decidirTareasDeFondo(process.env)
  for (const linea of explicarDecision(tareas)) console.log(linea)

  if (tareas.permitido) {
    webhookInboxWorker.start()
    // El webhook despierta al worker en cuanto guarda un mensaje, en vez de
    // esperar a su próximo sondeo. Ver `lib/despertador-de-la-cola.ts`.
    alEntrarUnMensaje(espera => webhookInboxWorker.despertar(espera))
    setTimeout(generateCurrentMonthBilling, 3000)
    setInterval(generateCurrentMonthBilling, 24 * 60 * 60 * 1000)
    // Después de generar la cuota: la comisión se escribe sobre esa misma fila.
    setTimeout(settleCommissions, 12000)
    setInterval(settleCommissions, 24 * 60 * 60 * 1000)
    setTimeout(cleanupWebhookInbox, 5000)
    setInterval(cleanupWebhookInbox, 24 * 60 * 60 * 1000)
    setTimeout(cleanupErrorLog, 7000)
    setInterval(cleanupErrorLog, 24 * 60 * 60 * 1000)
    setTimeout(cleanupStorefrontSessions, 9000)
    setInterval(cleanupStorefrontSessions, 24 * 60 * 60 * 1000)
    // Cada 6 h: suficiente para enterarse el mismo día sin castigar a los
    // proveedores con consultas constantes.
    setTimeout(checkCredentials, 20_000)
    setInterval(checkCredentials, 6 * 60 * 60 * 1000)
    // ⌛ Los pedidos que se quedaron esperando un comprobante que no llegó.
    //
    // Cada 10 min: la ventana del negocio se mide en horas, así que afinar más
    // no adelanta nada y solo añade consultas. Con el tope de 20 por tanda son
    // 120 pedidos/hora como techo duro — el freno que sustituye a la vieja
    // prohibición de «no hay tarea que expire pedidos por su cuenta».
    //
    // ⚠️ El primer barrido espera 30 s: si arrancara a la vez que el servidor,
    // un despliegue con la base todavía fría empezaría cancelando pedidos.
    setTimeout(expireUnpaidOrders, 30_000)
    setInterval(expireUnpaidOrders, 10 * 60 * 1000)

    // 💳 Los cobros con tarjeta que nadie ha confirmado todavía.
    //
    // PayPhone devuelve el dinero si nadie confirma en 5 minutos, y la
    // confirmación NO puede depender de que el teléfono del cliente vuelva.
    // Cada 20 s: da tiempo de sobra dentro de esos 5 minutos, y con 5 cobros
    // por vuelta se queda muy por debajo de las 30 consultas/minuto de PayPhone.
    // Sin credenciales de PayPhone no consulta nada, ni la base.
    setInterval(() => {
      void pagosConTarjeta().procesarPendientes(5).catch(() => { /* registra ella misma */ })
    }, 20_000)

    // 💰 El cierre de la semana: cada lunes se liquida la anterior.
    //
    // Cada 6 h y no solo el lunes: si el servidor estaba caído el lunes a la
    // hora justa, el cierre saldría igual unas horas después. Repetido no hace
    // nada — la base no crea dos liquidaciones para la misma semana.
    setTimeout(() => { void cerrarSemanaAnterior() }, 15_000)
    setInterval(() => { void cerrarSemanaAnterior() }, 6 * 60 * 60 * 1000)

    // 🧮 El cuadre diario contra PayPhone (2026-09-29).
    //
    // Cada cobro de los últimos 3 días se le pregunta a PayPhone y se compara
    // con lo que dice nuestra base. NUNCA mueve dinero: guarda el resultado y
    // avisa en el registro de errores. Mira cada hora y solo actúa una vez al
    // día, desde las 6 de Ecuador: si el servidor estaba caído a esa hora, el
    // cuadre sale igual un rato después. Sin credenciales no consulta nada.
    setTimeout(() => { void cuadrarConPayphone() }, 3 * 60 * 1000)
    setInterval(() => { void cuadrarConPayphone() }, 60 * 60 * 1000)

    // 🐤 ¿Puede un cliente comprar AHORA MISMO?
    //
    // Recorre el camino real —saludar, entrar a cada local, pedir el menú— con
    // el catálogo de producción, y anota en el registro de errores lo que no
    // cuadre. No escribe una fila ni manda un WhatsApp.
    //
    // ⚠️ Existe porque el 2026-09-13 se encontraron tres fallos rojos probando a
    // mano, y el peor —el chat sin precios ni botón de pedir— llevaba CUATRO
    // DÍAS con el CI en verde y 2.727 pruebas pasando. Ninguna prueba contesta
    // «¿alguien puede comprar hoy?»; esto sí.
    //
    // ⚠️ Cada 12 h y no cada hora: lo que vigila cambia cuando se despliega, no
    // solo. Dos vueltas al día bastan para enterarse el mismo día sin recorrer
    // el catálogo entero sin motivo. La primera espera 60 s, después del primer
    // barrido de pedidos, para no competir con una base recién arrancada.
    setTimeout(() => { void vigilarElCaminoDelCliente() }, 60_000)
    setInterval(() => { void vigilarElCaminoDelCliente() }, 12 * 60 * 60 * 1000)

    setupTelegram(app, bot.handleMessage).then(() => {
      if (process.env.BASE_URL) console.log(`🌐 ${esStaging(process.env) ? 'Staging' : 'Producción'}: ${process.env.BASE_URL}`)
    }).catch(error => console.error('❌ Telegram setup:', errorMessage(error)))
  }

  // ⚠️ El staging local NO levanta túnel: nadie tiene que poder entrar desde
  // internet a una copia de la app con datos inventados, y además retrasa el
  // arranque para nada. Solo el desarrollo contra producción lo necesita, que
  // es cuando hace falta una URL pública para los webhooks.
  if (!process.env.BASE_URL && process.env.UMBANI_ENTORNO !== 'staging') {
    setTimeout(() => {
      tunnel.startTunnel(port)
        .then(state => console.log(`🌐 Túnel automático: ${state.url}`))
        .catch(error => {
          console.log('⚠️  No se pudo auto-iniciar el túnel:', errorMessage(error))
        })
    }, 2500)
  }
}

// 🔐 EL CANDADO DE LA BASE (2026-10-01): antes de abrir el puerto —y por tanto
// antes de arrancar ninguna tarea de fondo—, la base tiene que ser la que este
// proceso cree que es. Un staging contra la base de producción, o al revés, no
// arranca. Ver `config/identidad-de-la-base.ts`.
void comprobarIdentidadDeLaBase({
  staging: esStaging(process.env),
  leerMarca: () => db.leerMarcaDeEntorno(),
}).then((identidad) => {
  if (!identidad.ok) {
    console.error(`\n❌ ${identidad.motivo}\n`)
    process.exit(1)
  }
  httpServer = app.listen(port, alAbrirElPuerto)
})
