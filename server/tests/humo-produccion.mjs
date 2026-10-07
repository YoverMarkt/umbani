// ============================================================================
// PRUEBA DE HUMO CONTRA PRODUCCIÓN
//
// La última capa, y la única que mira la aplicación DE VERDAD. Las otras dos
// verifican simulaciones:
//
//   · `verify:schema` ejecuta las funciones sobre un PostgreSQL en Docker —
//     una imitación de Supabase, no Supabase.
//   · `verify:drift` compara nombres, pero no ejecuta nada en producción.
//
// Entre las dos queda un hueco por el que caben los fallos de configuración:
// una variable de entorno ausente, un despliegue que no llegó, una credencial
// caducada. Nada de eso lo ve el CI, y es justo lo que deja la app muerta con
// todo en verde.
//
//   npm run verify:smoke -w @botpanel/server
//
// ⚠️ ESCRIBE EN PRODUCCIÓN, y por eso está acotado: crea UN negocio con nombre
// inequívocamente de prueba y lo borra en el `finally`. Si el borrado falla, lo
// grita con el id para que se limpie a mano. No manda ningún mensaje de
// WhatsApp: eso costaría dinero real y gastaría el saldo del canal.
//
// Se lanza después de cada despliegue. No corre en el CI porque el CI no debe
// tener las llaves de producción.
// ============================================================================

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const servidor = path.resolve(aqui, '..')
const require = createRequire(path.join(servidor, 'package.json'))
const jwt = require('jsonwebtoken')

// `BASE_URL` vive en Railway, no en el .env local (aquí va vacío a propósito
// para que el servidor levante su túnel). Así que se acepta por argumento o por
// `SMOKE_URL`, y solo se cae al .env si alguien lo tiene puesto.
const BASE = (process.argv[2] || process.env.SMOKE_URL || process.env.BASE_URL || '')
  .trim()
  .replace(/\/+$/, '')

if (!BASE) {
  console.error('❌ Falta la dirección de producción. Úsalo así:\n')
  console.error('   npm run verify:smoke -w @botpanel/server -- https://tu-dominio.com')
  console.error('   (o pon SMOKE_URL=https://… en server/.env)')
  process.exit(1)
}
if (!process.env.JWT_SECRET) {
  console.error('❌ Falta JWT_SECRET en server/.env: sin él no se puede probar el panel')
  process.exit(1)
}
if (!/^https?:\/\//i.test(BASE)) {
  console.error(`❌ "${BASE}" no parece una dirección web`)
  process.exit(1)
}

let fallos = 0
let avisos = 0

const revisar = (etiqueta, condicion, detalle = '') => {
  console.log(`   ${condicion ? '✅' : '❌'} ${etiqueta}${detalle ? ` — ${detalle}` : ''}`)
  if (!condicion) fallos += 1
  return condicion
}
const avisar = (etiqueta, detalle = '') => {
  console.log(`   ⚠️  ${etiqueta}${detalle ? ` — ${detalle}` : ''}`)
  avisos += 1
}

const token = jwt.sign(
  { role: 'admin', mfa: true, email: process.env.ADMIN_EMAIL || 'humo@local' },
  process.env.JWT_SECRET,
  { expiresIn: '5m' },
)

const pedir = async (ruta, opciones = {}) => {
  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: opciones.method || 'GET',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      ...(opciones.admin ? { authorization: `Bearer ${token}` } : {}),
      ...(opciones.headers || {}),
    },
    body: opciones.body ? JSON.stringify(opciones.body) : undefined,
  })
  const texto = await respuesta.text()
  let cuerpo = {}
  try { cuerpo = JSON.parse(texto) } catch { cuerpo = { texto } }
  return { status: respuesta.status, cuerpo, texto, headers: respuesta.headers }
}

console.log(`\n🔥 Prueba de humo contra ${BASE}\n`)

// ── 1. ¿Está viva? ──────────────────────────────────────────────────────────
console.log('1. Salud del servidor')
const salud = await pedir('/api/health')
revisar('responde', salud.status === 200, `status ${salud.status}`)
revisar('se declara sano', salud.cuerpo.ok === true)
revisar('la cola de webhooks está corriendo', salud.cuerpo.webhook_inbox?.running === true)
revisar(
  'puede escribir en la base',
  Boolean(salud.cuerpo.webhook_inbox?.last_database_success_at),
  salud.cuerpo.webhook_inbox?.last_database_success_at,
)

const canal = salud.cuerpo.inbound_channel
if (canal) {
  const horas = Number(canal.hours_since_last_inbound)
  console.log(`   ℹ️  último mensaje entrante hace ${horas?.toFixed?.(1) ?? '?'} h`)
  if (Number.isFinite(horas) && horas > 24) {
    avisar('el canal lleva más de un día sin recibir nada', 'puede ser normal de madrugada')
  }
  if (Number(canal.recent_failures) > 0) {
    avisar(`${canal.recent_failures} fallos recientes del webhook`, String(canal.last_failure || ''))
  }
}

// ── 2. ¿Se sirven las aplicaciones? ─────────────────────────────────────────
console.log('\n2. Aplicaciones servidas')
// Con la barra final: sin ella Express responde 301 hacia la versión correcta,
// que es lo esperado y no un fallo.
for (const [ruta, nombre, debeDecir = '<html'] of [
  ['/app/', 'panel del cliente'],
  ['/app-admin/', 'panel del superadmin'],
  ['/t/_', 'mini app de la tienda'],
  // Las apps web (2026-10-05), referencia de las apps Flutter. Se mira el
  // título: una ruta mal enlazada serviría OTRA página con un 200 igual.
  ['/u', 'app web de clientes', '<title>Umbani</title>'],
  ['/r', 'app web de repartidores', '<title>Umbani Repartidores</title>'],
  // El panel de las cooperativas de reparto (2026-10-06).
  ['/cooperativa/', 'panel de las cooperativas', '<title>Cooperativa — Umbani</title>'],
]) {
  const r = await pedir(ruta)
  revisar(nombre, r.status === 200 && r.texto.includes(debeDecir), `status ${r.status}`)
}
// Las apps instalables (2026-10-06). Si el comodín de la app se tragara
// `/u/sw.js`, la app abriría igual y simplemente dejaría de instalarse: solo
// se ve pidiéndolo (ver `lib/apps-instalables.ts`).
for (const alcance of ['/u', '/r']) {
  const r = await pedir(`${alcance}/sw.js`)
  const tipo = String(r.headers.get('content-type') || '')
  revisar(`service worker de ${alcance}`,
    r.status === 200 && tipo.includes('javascript') && r.headers.get('service-worker-allowed') === alcance,
    `status ${r.status}, ${tipo}`)
}
const ficha = await pedir('/t/u.webmanifest')
revisar('ficha de instalación de /u', ficha.status === 200 && ficha.texto.includes('"start_url": "/u"'),
  `status ${ficha.status}`)

// ── 3. La puerta de la tienda ───────────────────────────────────────────────
console.log('\n3. Tienda: el enlace es la credencial')
const corto = await pedir('/s/tokeninventadodeprueba')
revisar('el enlace corto redirige', corto.status === 302,
  `status ${corto.status} → ${corto.headers.get('location')}`)
revisar('un token inventado no revela ningún negocio',
  !String(corto.headers.get('location') || '').match(/\/t\/[a-z0-9-]{4,}/i),
  String(corto.headers.get('location')))

const sinSesion = await pedir('/api/store/cualquiera/catalog')
revisar('el catálogo exige sesión', [401, 404].includes(sinSesion.status),
  `status ${sinSesion.status}`)

// ── 4. Las rutas de admin exigen credenciales ───────────────────────────────
console.log('\n4. Autenticación del panel')
const sinToken = await pedir('/api/admin/clients')
revisar('sin token → 401', sinToken.status === 401, `status ${sinToken.status}`)
const conToken = await pedir('/api/admin/clients', { admin: true })
revisar('con token de admin → 200', conToken.status === 200, `status ${conToken.status}`)

// ── 5. Dar de alta un cliente: el camino que se rompió ──────────────────────
// Es la razón de ser de esta prueba. Llevaba meses roto y nadie lo supo hasta
// que hizo falta cobrarle a alguien.
console.log('\n5. Alta de clientes (el camino que se rompió el 2026-08-02)')
const marca = Date.now()
let creadoId = null

try {
  const alta = await pedir('/api/admin/clients', {
    admin: true,
    method: 'POST',
    body: {
      name: `ZZZ PRUEBA DE HUMO ${marca}`,
      type: 'negocio',
      whatsapp_number: `+59390000${String(marca).slice(-4)}`,
      whatsapp_provider: 'ycloud',
      ycloud_api_key: 'prueba-de-humo-no-es-una-clave',
      ycloud_webhook_secret: 'prueba-de-humo-no-es-un-secreto',
      ycloud_webhook_endpoint_id: 'prueba-de-humo',
      client_email: `humo-${marca}@prueba.local`,
      client_password: 'ClaveDePruebaLarga123',
      plan: 'micro',
    },
  })

  if (revisar('crea el negocio', alta.status === 201,
    alta.status === 201 ? '' : `${alta.status} — ${alta.cuerpo.error}`)) {
    creadoId = alta.cuerpo.id
    revisar('devuelve su identificador', Boolean(creadoId))
    revisar('NO devuelve credenciales',
      !JSON.stringify(alta.cuerpo).match(/prueba-de-humo-no-es/),
      'las claves enviadas no vuelven en la respuesta')

    const detalle = await pedir(`/api/admin/clients/${creadoId}`, { admin: true })
    revisar('se puede consultar', detalle.status === 200)
    revisar('nace con la tienda apagada', detalle.cuerpo.storefront_enabled !== true)
  }
} finally {
  if (creadoId) {
    const borrado = await pedir(`/api/admin/clients/${creadoId}`, {
      admin: true, method: 'DELETE',
    })
    const ok = [200, 204].includes(borrado.status)
    revisar('se borra sin dejar rastro', ok, ok ? '' : `status ${borrado.status}`)
    if (!ok) {
      console.log(`\n   🚨 LIMPIA A MANO el negocio ${creadoId} — quedó en producción`)
    } else {
      const quedan = await pedir(`/api/admin/clients/${creadoId}`, { admin: true })
      revisar('ya no existe', quedan.status === 404, `status ${quedan.status}`)
    }
  }
}

// ── Resumen ─────────────────────────────────────────────────────────────────
console.log(
  fallos
    ? `\n❌ ${fallos} comprobaciones fallaron${avisos ? ` (y ${avisos} avisos)` : ''}`
    // Dice a QUIÉN respondió, no «producción» a secas: desde 2026-09-19 esto
    // también se corre contra el staging local, y un resumen que diga
    // «producción» sobre una base de mentira es justo la confusión que el
    // staging viene a quitar.
    : `\n✅ ${BASE} responde correctamente${avisos ? ` (${avisos} avisos, revísalos)` : ''}`,
)
process.exit(fallos ? 1 : 0)
