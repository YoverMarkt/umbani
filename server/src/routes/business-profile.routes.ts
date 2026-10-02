import type { RequestHandler } from 'express'
import { getClientBusinessId } from '../lib/request'
import { leerUbicacion } from '../lib/ubicacion'
import { createRouter } from '../middleware/async'
import type { BusinessRecord } from '../db/types'

const editableBusinessFields = [
  'name',
  'slogan',
  'description',
  'hours',
  'address',
  // El punto en el mapa. `address` es lo que se LEE; esto es lo que se
  // NAVEGA — y en Ecuador «frente a Portocentro» no lo resuelve ningún
  // geocoder. Los dos juntos, como en cualquier app de reparto.
  'latitude',
  'longitude',
  'phone',
  'social',
  'payment_methods',
  'delivery_fee',
  'brand_color',
  'logo_url',
  'cover_url',
  // El dueño conoce su cocina mejor que nosotros: el tipo de negocio solo
  // pone el valor de arranque, y a partir de ahí manda él.
  'prep_time_minutes',
  'delivery_extra_minutes',
  // Los dos frenos del local. El mínimo lo decide el dueño según su producto
  // más barato: la plataforma no sabe si $5 sobra o cierra el negocio.
  'min_order_amount',
  'max_orders_per_hour',
  // Cuánto espera el local su comprobante antes de liberar el pedido. 0 = no
  // expira nunca, que es una decisión legítima de quien coordina por teléfono.
  'payment_window_minutes',
  // ⚠️ El aviso de pedido nuevo al WhatsApp del dueño. Nace APAGADO y lo
  // enciende él: son dos mensajes pagados por pedido, y la alarma del panel ya
  // avisa gratis. Que la factura la decida quien la paga.
  'notify_owner_whatsapp',
] as const

type EditableBusinessField = (typeof editableBusinessFields)[number]
type DatabaseResult = { error?: { message?: string } | null }

interface ModuloDb {
  getBusinessPaymentMethods(businessId: string): Promise<unknown[]>
  setBusinessPaymentMethod(
    businessId: string, methodCode: string, enabled: boolean,
  ): Promise<{ error?: { message?: string } | null }>
  getClientStats(businessId: string): Promise<unknown>
  getBusinessById(businessId: string): Promise<BusinessRecord | null>
  updateBusiness(
    businessId: string,
    data: Partial<Record<EditableBusinessField, unknown>>,
  ): Promise<DatabaseResult>
  getBusinessBankAccount(businessId: string): Promise<unknown>
  upsertBankAccount(businessId: string, data: Record<string, unknown>): Promise<DatabaseResult>
}
const db: ModuloDb = require('../db') as typeof import('../db')
interface ModuloAuth {
  authClient: RequestHandler
  requireOwner: RequestHandler
}
const auth: ModuloAuth = require('../middleware/auth') as typeof import('../middleware/auth')

const router = createRouter()

function assertDatabaseResult(result: DatabaseResult, operation: string): void {
  if (result?.error) throw new Error(`${operation}: ${result.error.message || 'Error desconocido'}`)
}

function databaseFailure(res: Parameters<RequestHandler>[1], operation: string, error: unknown) {
  console.error(`❌ ${operation}:`, error instanceof Error ? error.message : 'Error desconocido')
  return res.status(500).json({ error: `No se pudo ${operation}` })
}

router.get('/api/client/stats', auth.authClient, async (req, res) => {
  res.json(await db.getClientStats(getClientBusinessId(req)))
})

const flotaDelLocalEncendida = async (): Promise<boolean> =>
  (await (require('../services/settings') as typeof import('../services/settings')).get('flota_del_local').catch(() => null)) === '1'

router.get('/api/client/business', auth.authClient, async (req, res) => {
  const business = await db.getBusinessById(getClientBusinessId(req))
  // Puede haberse eliminado entre la validación de la sesión y esta consulta.
  if (!business) return res.status(404).json({ error: 'Negocio no encontrado' })
  res.json({
    id: business.id,
    name: business.name,
    type: business.type,
    slogan: business.slogan,
    description: business.description,
    hours: business.hours,
    address: business.address,
    latitude: business.latitude ?? null,
    longitude: business.longitude ?? null,
    notify_owner_whatsapp: business.notify_owner_whatsapp === true,
    phone: business.phone,
    social: business.social,
    payment_methods: business.payment_methods,
    takes_orders: business.takes_orders !== false,
    // Apariencia y envío de la mini app. El importe oficial del envío lo
    // vuelve a calcular la base al crear el pedido; esto es la configuración.
    delivery_fee: Number(business.delivery_fee) || 0,
    brand_color: business.brand_color ?? null,
    logo_url: business.logo_url ?? null,
    cover_url: business.cover_url ?? null,
    // Cuánto tarda en tenerlo listo y cuánto suma llevarlo. El primero decide
    // además las franjas que se ofrecen para programar.
    prep_time_minutes: Number(business.prep_time_minutes) || 25,
    delivery_extra_minutes: Number(business.delivery_extra_minutes) || 0,
    // ⚠️ `?? 0` y no `|| 0`: son distintos y aquí importa. Un mínimo de 0 es
    // «sin mínimo», un valor legítimo que `||` confundiría con «no vino».
    min_order_amount: Number(business.min_order_amount ?? 0),
    max_orders_per_hour: Number(business.max_orders_per_hour ?? 30),
    // Mismo `??` por el mismo motivo: aquí el 0 es «no expirar nunca».
    payment_window_minutes: Number(business.payment_window_minutes ?? 120),
    suspended: business.suspended,
    bot_active: business.bot_active,
    // ¿Puede registrar a sus propios repartidores? Lo enciende el superadmin
    // (`flota_del_local`); mientras tanto el menú no lo enseña.
    flota_propia: await flotaDelLocalEncendida(),
  })
})

router.put('/api/client/business', auth.authClient, auth.requireOwner, async (req, res) => {
  const data: Partial<Record<EditableBusinessField, unknown>> = {}
  for (const field of editableBusinessFields) {
    if (field in req.body) data[field] = req.body[field]
  }

  // El punto del local: las dos coordenadas o ninguna. Se valida aquí, antes
  // que el CHECK de la base, para poder explicar qué pasa — y se valida en
  // UNA sola función compartida con el alta del superadmin, o la que valide
  // más suelto sería la que manda.
  // Un interruptor es un booleano y nada más: un 'true' de texto lo dejaría
  // encendido sin que nadie lo decidiera.
  if ('notify_owner_whatsapp' in data) {
    data.notify_owner_whatsapp = data.notify_owner_whatsapp === true
  }
  if ('latitude' in data || 'longitude' in data) {
    const punto = leerUbicacion(data as Record<string, unknown>)
    if (!punto.ok) return res.status(400).json({ error: punto.error })
    data.latitude = punto.punto.latitude
    data.longitude = punto.punto.longitude
  }

  // Los dos campos que acaban en la mini app se validan aquí y no solo en el
  // CHECK: un 400 explicando qué pasa vale más que un 500 de la base.
  if ('delivery_fee' in data) {
    const monto = Number(data.delivery_fee)
    if (!Number.isFinite(monto) || monto < 0 || monto > 999) {
      return res.status(400).json({ error: 'El costo de envío debe estar entre 0 y 999' })
    }
    data.delivery_fee = Math.round(monto * 100) / 100
  }
  if ('brand_color' in data) {
    const color = typeof data.brand_color === 'string' ? data.brand_color.trim() : ''
    if (color && !/^#[0-9a-fA-F]{6}$/.test(color)) {
      return res.status(400).json({ error: 'El color debe ser un hex de 6 dígitos, por ejemplo #D9F950' })
    }
    // Vacío = volver al color de la plataforma.
    data.brand_color = color ? color.toUpperCase() : null
  }
  // El mínimo admite decimales; los demás son enteros, así que va aparte.
  if ('min_order_amount' in data) {
    const crudo = data.min_order_amount
    const vacio = crudo == null || (typeof crudo === 'string' && crudo.trim() === '')
    const monto = Number(crudo)
    if (vacio || !Number.isFinite(monto) || monto < 0 || monto > 999) {
      return res.status(400).json({
        error: 'El pedido mínimo debe estar entre 0 y 999. Deja 0 para no exigir mínimo.',
      })
    }
    data.min_order_amount = Math.round(monto * 100) / 100
  }

  // ⚠️ La ventana de pago se valida APARTE y no en el bucle de rangos: su
  // dominio no es continuo. El 0 vale —significa «no expirar nunca», para
  // quien cobra contra entrega o coordina por teléfono— y a partir de ahí el
  // mínimo es 15 minutos. Un rango 0..1440 dejaría pasar «5 minutos», que
  // cancelaría el pedido antes de que al cliente le dé tiempo a transferir.
  if ('payment_window_minutes' in data) {
    const crudo = data.payment_window_minutes
    // Misma cautela que el bucle de rangos: una cadena vacía NO es un cero, y
    // aquí el cero significa «no expirar nunca» — adivinarlo apagaría la
    // caducidad de un local sin que nadie lo pidiera.
    const vacio = crudo == null || (typeof crudo === 'string' && crudo.trim() === '')
    const minutos = Number(crudo)
    if (vacio || !Number.isInteger(minutos)
      || (minutos !== 0 && (minutos < 15 || minutos > 1440))) {
      return res.status(400).json({
        error: 'La espera del comprobante debe ser 0 (no expirar) o entre 15 y 1440 minutos',
      })
    }
    data.payment_window_minutes = minutos
  }

  // Los tiempos y el tope replican aquí el CHECK de la base a propósito: el
  // dueño lee «entre 1 y 480 minutos» en vez de un error de restricción de
  // PostgreSQL. Es el mismo criterio del motor de opciones.
  for (const [campo, minimo, maximo, texto] of [
    ['prep_time_minutes', 1, 480, 'El tiempo de preparación debe estar entre 1 y 480 minutos'],
    ['delivery_extra_minutes', 0, 240, 'El tiempo de entrega debe estar entre 0 y 240 minutos'],
    ['max_orders_per_hour', 1, 500, 'El tope de pedidos por hora debe estar entre 1 y 500'],
  ] as const) {
    if (!(campo in data)) continue
    const crudo = data[campo]
    // ⚠️ Una cadena VACÍA no es un cero. `Number('')` vale 0, así que un campo
    // que llegue vacío —un formulario que no lo saneó, otro cliente, una
    // petición a mano— guardaba 0 en silencio: el negocio se quedaba
    // prometiendo la comida sin sumar el reparto sin haberlo pedido nunca.
    // Se rechaza en vez de adivinar qué quiso decir.
    const vacio = crudo == null || (typeof crudo === 'string' && crudo.trim() === '')
    const minutos = Number(crudo)
    if (vacio || !Number.isInteger(minutos) || minutos < minimo || minutos > maximo) {
      return res.status(400).json({ error: texto })
    }
    data[campo] = minutos
  }

  // Las dos imágenes del negocio siguen la MISMA regla, y por eso comparten
  // bucle: acaban las dos en un <img> de una app pública, así que separarlas
  // sería tener dos criterios para el mismo riesgo.
  for (const [campo, nombre] of [
    ['logo_url', 'El logo'],
    ['cover_url', 'La portada'],
  ] as const) {
    if (!(campo in data)) continue
    // La sube el propio panel a Cloudinary; aquí solo se acepta el resultado.
    // Vacío = quitar la imagen.
    const url = typeof data[campo] === 'string' ? (data[campo] as string).trim() : ''
    if (url && !url.startsWith('https://')) {
      return res.status(400).json({ error: `${nombre} debe ser una imagen subida desde el panel` })
    }
    data[campo] = url || null
  }

  try {
    assertDatabaseResult(
      await db.updateBusiness(getClientBusinessId(req), data),
      'actualizar el negocio',
    )
    res.json({ ok: true })
  } catch (error) {
    databaseFailure(res, 'actualizar el negocio', error)
  }
})

// ⚠️ Aquí vivían `GET/PUT /api/client/policies` y `PUT /api/client/welcome-message`,
// retirados el 2026-09-20 con la pantalla «Bienvenida» del panel. El saludo y
// las políticas se guardaban en `bot_policies` y no los leía NADIE: ningún
// servicio del bot, del marketplace ni de la tienda los consultaba. Cada local
// se presenta desde Umbani, así que la tabla se fue con ellos.

// ── Cuenta bancaria ─────────────────────────────────────────────────────────
//
// La tienda ya la mostraba en `/api/store/:slug/payment-info`, pero no había
// forma de cargarla salvo a mano en Supabase.
//
// El dueño DIJO que estos datos no son secretos: son con los que le pagan, y
// el banco es quien gestiona el riesgo. Aun así van tras `requireOwner` — un
// empleado con permiso de catálogo no tiene por qué cambiar a qué cuenta
// entra el dinero.

class InvalidBankInput extends Error {}

function bankField(value: unknown, name: string, max: number, required = false): string | null {
  if (value === null || value === undefined || value === '') {
    if (required) throw new InvalidBankInput(`${name} es obligatorio`)
    return null
  }
  if (typeof value !== 'string') throw new InvalidBankInput(`${name} es inválido`)
  const clean = value.trim()
  if ((required && !clean) || clean.length > max) throw new InvalidBankInput(`${name} es inválido`)
  return clean || null
}

router.get('/api/client/bank-account', auth.authClient, auth.requireOwner, async (req, res) => {
  res.json(await db.getBusinessBankAccount(getClientBusinessId(req)) || null)
})

router.put('/api/client/bank-account', auth.authClient, auth.requireOwner, async (req, res) => {
  try {
    const source = (req.body || {}) as Record<string, unknown>
    const account = {
      bank_name: bankField(source.bank_name, 'El banco', 80, true),
      account_type: source.account_type === 'corriente' ? 'corriente' : 'ahorros',
      account_number: bankField(source.account_number, 'El número de cuenta', 40, true),
      holder_name: bankField(source.holder_name, 'El titular', 120, true),
      holder_id: bankField(source.holder_id, 'La cédula o RUC', 20),
      instructions: bankField(source.instructions, 'Las instrucciones', 300),
    }
    assertDatabaseResult(
      await db.upsertBankAccount(getClientBusinessId(req), account),
      'guardar la cuenta bancaria',
    )
    res.json({ ok: true })
  } catch (error) {
    if (error instanceof InvalidBankInput) return res.status(400).json({ error: error.message })
    databaseFailure(res, 'guardar la cuenta bancaria', error)
  }
})


// ── Cómo le pagan a este negocio ───────────────────────────────────────────
//
// Hasta hoy el dueño creía que lo elegía —`payment_methods` era texto libre
// que solo veía el bot— y la tienda ofrecía los tres métodos a todo el mundo.
// Esto es el interruptor de verdad.
//
// ⚠️ El `business_id` sale SIEMPRE del JWT, nunca de la petición.
router.get('/api/client/payment-methods', auth.authClient, async (req, res) => {
  try {
    res.json(await db.getBusinessPaymentMethods(getClientBusinessId(req)))
  } catch (error) {
    console.error('❌ métodos de pago:', (error as Error).message)
    res.status(500).json({ error: 'No se pudieron cargar los métodos de pago' })
  }
})

router.put('/api/client/payment-methods/:code', auth.authClient, auth.requireOwner, async (req, res) => {
  const code = String(req.params.code || '')
  if (!/^[a-z_]{3,30}$/.test(code)) {
    return res.status(400).json({ error: 'Método de pago inválido.' })
  }
  const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Indica si se enciende o se apaga.' })
  }

  // Quedarse sin ningún método activo dejaría la tienda sin poder cobrar, y
  // el cliente lo descubriría al confirmar el pedido. Se impide aquí porque
  // es una regla de producto, no de integridad: la base admite cero.
  if (!enabled) {
    const actuales = await db.getBusinessPaymentMethods(getClientBusinessId(req))
    const activos = (actuales as Array<{ method_code: string, enabled: boolean }>)
      .filter(m => m.enabled && m.method_code !== code)
    if (activos.length === 0) {
      return res.status(400).json({
        error: 'Tiene que quedar al menos un método de pago activo.',
      })
    }
  }

  const { error } = await db.setBusinessPaymentMethod(getClientBusinessId(req), code, enabled)
  if (error) {
    // La base rechaza activar un método que la plataforma no procesa todavía.
    return res.status(400).json({
      error: 'Ese método de pago todavía no está disponible en la plataforma.',
    })
  }
  res.json({ ok: true })
})

export = router
