// ═══════════════════════════════════════════════════════════════════════════
// LOS QUE INTERVIENEN EN UN PEDIDO: CLIENTE, LOCAL, SUPERADMIN… Y EL RELOJ
// ═══════════════════════════════════════════════════════════════════════════
//
// Cada uno entra por SU puerta, la misma que usa en la vida real:
//
//   · el cliente, por WhatsApp (el chat le da el enlace de la tienda y confirma
//     su número) o por la app (inicia sesión mandando un código por WhatsApp);
//   · el local, con su correo y su contraseña en el panel;
//   · el superadmin, con su token. ⚠️ Aquí se FIRMA sin pasar por la app de
//     códigos: los dos pasos tienen sus propias pruebas (superadmin-dos-pasos y
//     el E2E del panel), y repetirlos aquí no prueba nada del pedido.
//
// La base se lee directamente para COMPROBAR el dinero —es la fuente de la
// verdad— y se toca solo para dos cosas que ninguna pantalla hace: mover el
// reloj (llevar un pedido a una semana ya terminada) y recoger la mesa entre
// recorridos.

import { inject } from 'vitest'
import { createRequire } from 'node:module'
import { randomBytes, randomUUID } from 'node:crypto'

const require = createRequire(import.meta.url)
const jwt = require('jsonwebtoken')
const pg = require('pg')

export const base = () => inject('base')
export const SLUG = () => inject('slug')

// ⚠️ Cada archivo de recorridos llega desde SU red. Los frenos contra abusos
// cuentan por IP (8 pedidos por minuto) y el servidor, como detrás de Railway,
// la lee de `X-Forwarded-For`. Sin esto, la batería entera sale de 127.0.0.1 y
// el freno —que funciona— tumba al tercer archivo. Vitest carga este módulo de
// nuevo para cada archivo, así que cada uno estrena dirección.
const IP = `10.${1 + Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`

/** Una petición HTTP. Devuelve siempre `{ status, body }`, nunca lanza por un 4xx. */
export async function http(metodo, ruta, { token, cuerpo, cabeceras = {} } = {}) {
  const r = await fetch(`${base()}${ruta}`, {
    method: metodo,
    redirect: 'manual',
    headers: {
      'x-forwarded-for': IP,
      ...(cuerpo !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...cabeceras,
    },
    body: cuerpo !== undefined ? JSON.stringify(cuerpo) : undefined,
  })
  const texto = await r.text()
  let body = texto
  try {
    body = texto ? JSON.parse(texto) : null
  } catch {
    // HTML o texto plano: se devuelve tal cual.
  }
  return { status: r.status, body, headers: r.headers }
}

/** Exige un estado HTTP y devuelve el cuerpo; si no, falla diciendo qué llegó. */
export async function exigir(estado, promesa) {
  const r = await promesa
  if (r.status !== estado) {
    throw new Error(`Se esperaba ${estado} y llegó ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`)
  }
  return r.body
}

// ── El superadmin ───────────────────────────────────────────────────────────

export function tokenDeAdmin() {
  return jwt.sign({ role: 'admin', email: inject('adminEmail'), mfa: true }, inject('jwtSecret'), { expiresIn: '1h' })
}

export const admin = {
  pedir: (metodo, ruta, cuerpo) => http(metodo, ruta, { token: tokenDeAdmin(), cuerpo }),
  /** Lo que haría un mensaje de WhatsApp al número de Umbani (el simulador del panel). */
  async escribirAlChat(texto) {
    const cuerpo = await exigir(200, admin.pedir('POST', '/api/admin/simulate', { message: texto }))
    return (cuerpo.replies || []).map(r => r.reply).join('\n\n')
  },
  olvidarConversacion: () => exigir(200, admin.pedir('DELETE', '/api/admin/simulate/history')),
}

// ── El local ────────────────────────────────────────────────────────────────

export async function entrarComoLocal() {
  const { email, clave } = inject('dueno')
  const cuerpo = await exigir(200, http('POST', '/api/client/login', { cuerpo: { email, password: clave } }))
  const token = cuerpo.token
  const pedir = (metodo, ruta, c) => http(metodo, ruta, { token, cuerpo: c })
  return {
    token,
    pedir,
    pedidos: async (estado) => (await exigir(200, pedir('GET', `/api/client/orders${estado ? `?status=${estado}` : ''}`))),
    cambiarEstado: (pedidoId, estado) => pedir('PUT', `/api/client/orders/${pedidoId}/status`, { status: estado }),
    marcarPreparado: (pedidoId, lineaId) => pedir('POST', `/api/client/orders/${pedidoId}/items/${lineaId}/prepared`, { prepared: true }),
    confirmarPago: pedidoId => pedir('PUT', `/api/client/orders/${pedidoId}/payment-confirmed`, {}),
  }
}

// ── El cliente ──────────────────────────────────────────────────────────────

/** Las cabeceras que atan la sesión de tienda a ESTE dispositivo. */
function dispositivo() {
  return {
    'x-storefront-device': `recorrido-${randomBytes(6).toString('hex')}`,
    'user-agent': 'UmbaniRecorridos/1.0 (Prueba)',
    'accept-language': 'es-EC',
  }
}

function clienteDeTienda(token, cabeceras, telefono) {
  const slug = SLUG()
  const pedir = (metodo, ruta, cuerpo) => http(metodo, ruta.replace(':slug', slug), {
    cuerpo,
    cabeceras: { ...cabeceras, 'x-storefront-token': token },
  })
  return {
    telefono,
    pedir,
    catalogo: () => exigir(200, pedir('GET', '/api/store/:slug/catalog')),
    cotizar: cuerpo => exigir(200, pedir('POST', '/api/store/:slug/quote', cuerpo)),
    pedido: id => exigir(200, pedir('GET', `/api/store/:slug/orders/${id}`)),
    async direccion() {
      const creada = await exigir(201, pedir('POST', '/api/store/:slug/addresses', {
        label: 'Casa', address: 'Av. de las Pruebas 123', reference: 'Portón verde',
        latitude: -2.9, longitude: -79.0,
      }))
      return creada.id || creada.address?.id
    },
    /** Crea el pedido con su clave de idempotencia, como la app al confirmar. */
    pedir_: cuerpo => pedir('POST', '/api/store/:slug/orders', { idempotencyKey: randomUUID(), name: 'Cliente de Pruebas', ...cuerpo }),
  }
}

/**
 * El cliente de HOY: escribe al WhatsApp de Umbani, elige el local en el menú,
 * recibe el enlace de la tienda y, al abrirlo, confirma su número.
 */
export async function clientePorWhatsApp() {
  await admin.olvidarConversacion()
  const bienvenida = await admin.escribirAlChat('hola')
  if (!bienvenida) throw new Error('El chat no contestó al «hola»')
  // Primera categoría y primer local: el staging tiene uno solo.
  await admin.escribirAlChat('1')
  const conEnlace = await admin.escribirAlChat('1')
  const enlace = conEnlace.match(/\/s\/([A-Za-z0-9_-]{16,})/)
  if (!enlace) throw new Error(`El chat no mandó el enlace de la tienda. Contestó: ${conEnlace.slice(0, 300)}`)
  const token = enlace[1]
  const cabeceras = dispositivo()
  // Abrir un enlace nuevo pide el número: así un enlace reenviado no sirve.
  await exigir(200, http('POST', `/api/store/${SLUG()}/session/verify`, {
    cuerpo: { phone: '000000000000' },
    cabeceras: { ...cabeceras, 'x-storefront-token': token },
  }))
  return clienteDeTienda(token, cabeceras, '000000000000')
}

/**
 * El cliente de la APP (Flutter): pide un código, lo manda por WhatsApp (aquí,
 * por el simulador) y con la sesión de la app abre la tienda del local.
 */
export async function clientePorLaApp() {
  const { codigo } = await exigir(201, http('POST', '/api/v1/auth/whatsapp'))
  await admin.escribirAlChat(`Mi código de Umbani: ${codigo}`)
  const { token: tokenApp, telefono } = await exigir(200, http('POST', '/api/v1/auth/whatsapp/verificar', { cuerpo: { codigo } }))
  const cabeceras = dispositivo()
  const { token } = await exigir(201, http('POST', `/api/v1/locales/${SLUG()}/sesion`, { token: tokenApp, cabeceras }))
  return { ...clienteDeTienda(token, cabeceras, telefono), tokenApp }
}

// ── El dinero del local, configurado desde los paneles ──────────────────────

/**
 * Envío, margen de Umbani y tarifa de servicio, puestos por donde los pone la
 * gente: el envío lo fija el DUEÑO en su panel; el margen y la tarifa, el
 * SUPERADMIN en el suyo. Nada se escribe a mano en la base: así el recorrido
 * prueba también que lo que se configura en una pantalla llega al cobro.
 */
export async function configurarElDinero({ envio = 1.5, margen = 10, tarifa = 0.1 } = {}) {
  const local = await entrarComoLocal()
  await exigir(200, local.pedir('PUT', '/api/client/business', { delivery_fee: envio }))
  const [{ id: negocio }] = await sql('select id from businesses where slug = $1', [SLUG()])
  const reglas = (await exigir(200, admin.pedir('GET', '/api/admin/pricing-rules')))
  for (const regla of (Array.isArray(reglas) ? reglas : reglas.rules || [])) {
    if (regla.business_id === negocio) await exigir(200, admin.pedir('DELETE', `/api/admin/pricing-rules/${regla.id}`))
  }
  const creada = await admin.pedir('POST', '/api/admin/pricing-rules', {
    scope: 'business', business_id: negocio, strategy: 'percentage', percentage: margen, markup_mode: 'on_top',
  })
  if (creada.status >= 300) throw new Error(`No se pudo crear la regla de margen: ${JSON.stringify(creada.body)}`)
  await exigir(200, admin.pedir('POST', '/api/admin/server-settings', { service_fee: String(tarifa) }))
  return negocio
}

/** Centavos enteros: el dinero se compara así, nunca en coma flotante. */
export const centavos = monto => Math.round(Number(monto) * 100)

/** El primer producto que se puede pedir sin elegir nada (sin variantes ni opciones obligatorias). */
export function productosSimples(carta) {
  return (carta.products || []).filter(p => !(p.variants || []).length
    && !(p.option_groups || p.optionGroups || []).some(g => g.required || Number(g.min_selectable) > 0))
}

/**
 * El local lleva el pedido hasta entregarlo, como en su panel: lo acepta, lo
 * prepara línea a línea (el candado no deja sacar nada incompleto), sale y lo
 * entrega.
 */
export async function llevarHastaEntregar(local, pedidoId, { aDomicilio = true } = {}) {
  await exigir(200, local.cambiarEstado(pedidoId, 'aceptado'))
  await exigir(200, local.cambiarEstado(pedidoId, 'preparacion'))
  const [pedido] = (await local.pedidos()).filter(p => p.id === pedidoId)
  for (const linea of pedido.order_items || []) {
    await exigir(200, local.marcarPreparado(pedidoId, linea.id))
  }
  await exigir(200, local.cambiarEstado(pedidoId, aDomicilio ? 'en_camino' : 'listo_para_retiro'))
  await exigir(200, local.cambiarEstado(pedidoId, 'completado'))
}

/** La línea del libro de un pedido entregado (o `undefined` si no la hay). */
export async function lineaDelLibro(pedidoId) {
  const [linea] = await sql(`select * from order_ledger where order_id = $1 and kind = 'venta'`, [pedidoId])
  return linea
}

// ── La tarjeta ──────────────────────────────────────────────────────────────

/** Lo que hace el navegador del cliente al volver de PayPhone. */
export const volverDePayPhone = (id, referencia) => http('GET', `/pagos/payphone/retorno?id=${id}&clientTransactionId=${referencia}`)

/** El cobro (más reciente) de un pedido con tarjeta. */
export async function cobroDelPedido(pedidoId) {
  const [cobro] = await sql(`select client_transaction_id as referencia, amount_cents, captured_cents, status
                               from payments where order_id = $1 order by created_at desc limit 1`, [pedidoId])
  return cobro
}

/**
 * El cliente pide con tarjeta, va a PayPhone, paga y vuelve: el pedido queda
 * PAGADO, como lo deja la vida real. Devuelve el pedido y su cobro.
 */
export async function pedirYPagarConTarjeta(cliente, cuerpoDelPedido) {
  const pedido = await exigir(201, cliente.pedir_({ ...cuerpoDelPedido, paymentMethod: 'tarjeta' }))
  await exigir(200, cliente.pedir('POST', `/api/store/:slug/orders/${pedido.id}/tarjeta`, {}))
  const cobro = await cobroDelPedido(pedido.id)
  const { id } = await payphone.pagar(cobro.referencia)
  await volverDePayPhone(id, cobro.referencia)
  return { pedido, cobro: await cobroDelPedido(pedido.id), idPayPhone: id }
}

// ── El motorizado ───────────────────────────────────────────────────────────

/**
 * La sesión de la app para un teléfono cualquiera. ⚠️ Se FIRMA aquí: el
 * simulador del chat es un solo teléfono (el del cliente de los recorridos),
 * y el inicio de sesión por WhatsApp ya lo recorre `00-escenario`. Se firma
 * con la misma función y el mismo secreto que el servidor.
 */
export function sesionDeLaAppPara(telefono) {
  process.env.JWT_SECRET = inject('jwtSecret')
  return require('../../dist/services/sesion-app').firmarSesionApp(telefono)
}

export function comoMotorizado(telefono) {
  const token = sesionDeLaAppPara(telefono)
  const pedir = (metodo, ruta, cuerpo) => http(metodo, `/api/v1/motorizado${ruta}`, { token, cuerpo })
  return {
    pedir,
    disponible: () => exigir(200, pedir('PUT', '/disponible', { disponible: true })),
    pedidos: async () => (await exigir(200, pedir('GET', '/pedidos'))).pedidos,
    tomar: id => pedir('POST', `/pedidos/${id}/tomar`),
    recogido: id => pedir('POST', `/pedidos/${id}/recogido`),
    entregado: id => pedir('POST', `/pedidos/${id}/entregado`),
  }
}

// ── Los proveedores falsos ──────────────────────────────────────────────────

const control = async (ruta, cuerpo) => (await fetch(`${inject('falso')}/__control/${ruta}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(cuerpo || {}),
})).json()

export const payphone = {
  /** «El cliente escribió su tarjeta en la página de PayPhone.» */
  pagar: (referencia, { aprobado = true, centavos } = {}) => control('pagar', { referencia, aprobado, centavos }),
  estado: () => control('estado'),
  reiniciar: () => control('reiniciar'),
}

// ── La base ─────────────────────────────────────────────────────────────────

let conexion = null
export async function sql(texto, valores = []) {
  if (!conexion) {
    conexion = new pg.Client({ connectionString: process.env.STAGING_DB_URL || 'postgresql://postgres:postgres@127.0.0.1:54322/postgres' })
    await conexion.connect()
  }
  return (await conexion.query(texto, valores)).rows
}
export async function cerrarSql() {
  if (conexion) await conexion.end()
  conexion = null
}

/** Pregunta hasta que se cumpla o se acabe el tiempo (las tareas corren cada 20 s). */
export async function esperarHasta(comprobar, { segundos = 60, cada = 1000, que = 'la condición' } = {}) {
  const limite = Date.now() + segundos * 1000
  let ultimo
  while (Date.now() < limite) {
    ultimo = await comprobar()
    if (ultimo) return ultimo
    await new Promise(resolve => setTimeout(resolve, cada))
  }
  throw new Error(`Pasaron ${segundos} s y no se cumplió ${que}`)
}

/**
 * Recoge la mesa: ningún pedido del recorrido anterior queda abierto. El techo
 * de pedidos abiertos por cliente es real, y todos los recorridos son el MISMO
 * cliente (el teléfono del simulador).
 */
export async function recogerLaMesa() {
  await sql(`update orders set status = 'cancelado', updated_at = now()
              where status not in ('completado','cancelado','rechazado','expirado')`)
  // Los cobros de los recorridos anteriores pasan a AYER. Los frenos de la
  // tarjeta (5 intentos por hora y 3 rechazos al día, por cliente) son de
  // verdad y cuentan por fecha; sin esto, el mismo cliente de prueba los
  // agotaría a mitad de la batería.
  await sql(`update payments set created_at = created_at - interval '25 hours',
                                 updated_at = updated_at - interval '25 hours'`)
  await payphone.reiniciar()
}

export const reloj = {
  /**
   * Lleva estos pedidos —su venta y su línea del libro— al miércoles de la
   * semana que empieza `lunes`. Es la única forma de liquidar hoy sin esperar
   * al lunes de verdad, y la base de la prueba adelanta el corte para admitirlo.
   */
  async llevarALaSemana(pedidoIds, lunes) {
    const cuando = `${lunes} 12:00:00-05`
    await sql(`update sales set sold_at = $2::timestamptz + interval '2 days' where order_id = any($1::uuid[])`, [pedidoIds, cuando])
    await sql(`update order_ledger set sold_at = $2::timestamptz + interval '2 days' where order_id = any($1::uuid[])`, [pedidoIds, cuando])
  },
}
