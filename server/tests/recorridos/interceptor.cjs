// ═══════════════════════════════════════════════════════════════════════════
// LOS RECORRIDOS NO SALEN A INTERNET
// ═══════════════════════════════════════════════════════════════════════════
//
// Se carga ANTES que el servidor (`node --require …/interceptor.cjs dist/index.js`)
// y solo en los recorridos: en producción no existe.
//
// El servidor bajo prueba es el de verdad, y por eso mismo intentaría hablar
// con PayPhone, con YCloud y con quien haga falta. Un recorrido que cobra con
// una tarjeta del sandbox real, o que le escribe por WhatsApp a un número, deja
// de ser una prueba: depende de que internet esté de buen humor y gasta saldo.
//
// Así que TODA llamada a un anfitrión que no sea esta máquina se desvía al
// proveedor falso de `proveedores-falsos.mjs`, con el anfitrión original
// delante de la ruta (`/pay.payphonetodoesposible.com/api/button/Prepare`). El
// falso contesta lo que contestaría el de verdad y anota lo que recibió, que es
// lo que las pruebas comprueban: qué se le cobró a la tarjeta, qué se devolvió,
// qué mensaje le llegó al cliente.
//
// ⚠️ Se desvía en las TRES puertas por las que el servidor puede salir —axios
// (todas las integraciones), `fetch` y `https.request` (cualquier SDK)—. Una
// sola que se quede abierta y una prueba podría cobrar de verdad sin que nadie
// lo note.

const http = require('node:http')
const https = require('node:https')
const path = require('node:path')

const FALSO = process.env.RECORRIDOS_PROVEEDOR_FALSO
if (!FALSO) {
  // Sin falso no hay a dónde desviar, y dejar pasar la llamada es justo lo
  // que este archivo existe para impedir.
  throw new Error('Falta RECORRIDOS_PROVEEDOR_FALSO: el interceptor no tiene a dónde desviar')
}
const falso = new URL(FALSO)

const LOCALES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])
const esLocal = (anfitrion) => LOCALES.has(String(anfitrion || '').toLowerCase())

/** `https://api.ycloud.com/v2/x?y` → `http://127.0.0.1:PUERTO/api.ycloud.com/v2/x?y` */
const desviar = (url) => {
  const original = new URL(url)
  if (esLocal(original.hostname)) return null
  return `${falso.origin}/${original.hostname}${original.pathname}${original.search}`
}

// ── 1. axios: lo que usan TODAS las integraciones (PayPhone, YCloud, Meta…) ──
//
// Se pide desde la carpeta del servidor para recibir la MISMA instancia que
// cargará `dist/`: Node la guarda por ruta resuelta, así que el interceptor que
// se cuelga aquí es el que ve cada `axios.post` del servidor.
const axiosDelServidor = require(require.resolve('axios', { paths: [path.resolve(__dirname, '../..')] }))
axiosDelServidor.interceptors.request.use((config) => {
  const completa = config.baseURL && !/^https?:\/\//i.test(config.url || '')
    ? `${config.baseURL.replace(/\/$/, '')}/${String(config.url || '').replace(/^\//, '')}`
    : String(config.url || '')
  const destino = desviar(completa)
  if (destino) {
    config.url = destino
    config.baseURL = undefined
    config.proxy = false
  }
  return config
})

// ── 2. fetch ──────────────────────────────────────────────────────────────
const fetchOriginal = globalThis.fetch
globalThis.fetch = (recurso, opciones) => {
  const url = typeof recurso === 'string' ? recurso : recurso?.url || String(recurso)
  let destino = null
  try {
    destino = desviar(url)
  } catch {
    destino = null
  }
  if (!destino) return fetchOriginal(recurso, opciones)
  if (typeof recurso === 'object' && recurso && 'url' in recurso) {
    return fetchOriginal(new Request(destino, recurso), opciones)
  }
  return fetchOriginal(destino, opciones)
}

// ── 3. https.request / https.get: cualquier SDK que no use axios ───────────
const anfitrionDe = (opciones) => opciones?.hostname || String(opciones?.host || '').split(':')[0]

function requestDesviado(original) {
  return function request(...args) {
    let url = null
    let opciones = {}
    let callback
    for (const arg of args) {
      if (typeof arg === 'string' || arg instanceof URL) url = new URL(String(arg))
      else if (typeof arg === 'function') callback = arg
      else if (arg && typeof arg === 'object') opciones = arg
    }
    const anfitrion = url ? url.hostname : anfitrionDe(opciones)
    if (esLocal(anfitrion)) return original.apply(this, args)
    const ruta = url ? `${url.pathname}${url.search}` : (opciones.path || '/')
    // http, no https: el falso escucha en claro. Sin el `agent` de https, que
    // http.request rechaza («Protocol "http:" not supported»).
    const { agent: _agent, ...resto } = opciones
    return http.request({
      ...resto,
      protocol: 'http:',
      hostname: falso.hostname,
      host: falso.hostname,
      port: falso.port,
      path: `/${anfitrion}${ruta}`,
    }, callback)
  }
}
https.request = requestDesviado(https.request)
https.get = function get(...args) {
  const peticion = https.request(...args)
  peticion.end()
  return peticion
}

console.log(`🧪 [recorridos] Las llamadas a internet van al proveedor falso (${falso.origin})`)
