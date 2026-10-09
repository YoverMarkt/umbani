#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// LA PRUEBA DE CARGA Y DE ATAQUES — SOLO CONTRA EL STAGING (2026-10-08)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedido del dueño antes de enseñarle la app a un programador de fuera:
// «pruebas de DDoS, protección a bots o atacantes». Responde lo que UNA
// máquina puede responder sobre el servidor de verdad (Railway + Supabase):
//
//    1. Sin nadie molestando, cuánto tarda cada cosa.
//    1b. UN contador por cliente: `RateLimit-Remaining` baja de uno en uno.
//       Si salta (89, 88, 89…), el servidor cuenta por nodo de Railway y no
//       por cliente — lo que destapó esta prueba el primer día.
//    2. Una avalancha contra la vitrina: el freno salta (429) y el servidor
//       sigue contestando a los demás mientras tanto.
//    3. Falsear `X-Forwarded-For` no salta el freno (si lo saltara, cualquiera
//       se inventaría una IP por petición y ningún límite valdría nada).
//    4. Una avalancha contra `/api/health`, que NO tiene freno a propósito:
//       aguanta porque pregunta a la base como mucho una vez cada 2 s.
//    5. Fuerza bruta al login del panel: a los 20 fallos, 429. Y un correo sin
//       cuenta tarda lo mismo que uno con cuenta.
//    6. Adivinar un código del correo: al 5.º fallo muere, y ni el bueno entra.
//    7. Pedir códigos sin parar: a los 5 por minuto, 429.
//    8. Un cuerpo de 3 MB: 413, y la base ni se entera.
//    9. Cabeceras a cuentagotas («slowloris»): cuánto tarda en cortarse.
//   10. Muchas conexiones a la vez pidiendo la app: cuántas por segundo sirve.
//
// ⚠️ Lo que NO mide: un DDoS de verdad. Llega desde miles de direcciones a la
// vez y no se para en el servidor —ninguno solo lo aguanta— sino delante, en
// Cloudflare, cuando el dominio pase por él. Desde un portátil no se simula, y
// fingirlo aquí sería dar una tranquilidad falsa.
//
// ⚠️ Deja ESTA IP frenada en el staging un rato (el login, 15 min): quien
// comparta la conexión de este equipo tampoco podrá entrar al panel del
// staging hasta entonces. Un despliegue vacía los contadores.
//
// LA GUARDIA, y cualquiera de las dos basta para negarse:
//   · solo hay DOS destinos posibles: el staging en internet de
//     `server/.env.staging-remoto`, o uno local. Una lista de lo PERMITIDO y no
//     de lo prohibido: la primera versión comparaba con el `BASE_URL` de
//     `server/.env`… que no existe (en producción vive en Railway), así que no
//     comparaba con nada. Lo destapó probar la guardia antes de usarla;
//   · el servidor tiene que DECLARARSE staging en `/api/health` — y uno de
//     staging no arranca contra una base sin su marca (`config/identidad-de-la-base.ts`).
//
//   npm run test:carga -w @botpanel/server                     el staging en internet
//   npm run test:carga -w @botpanel/server -- <url>            otra dirección de staging
//   npm run test:carga -w @botpanel/server -- --informe <a.md> además, el informe escrito

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import tls from 'node:tls'
import { fileURLToPath } from 'node:url'

const servidor = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** `KEY=VALOR` por línea; sin comillas ni interpolación. */
function leerEnv(archivo) {
  if (!existsSync(archivo)) return {}
  const valores = {}
  for (const linea of readFileSync(archivo, 'utf8').split('\n')) {
    const igual = linea.indexOf('=')
    if (igual < 1 || linea.trim().startsWith('#')) continue
    valores[linea.slice(0, igual).trim()] = linea.slice(igual + 1).trim().replace(/^"|"$/g, '')
  }
  return valores
}

const salir = (motivo) => {
  console.error(`\n❌ ${motivo}\n`)
  process.exit(1)
}

const argumentos = process.argv.slice(2)
const posInforme = argumentos.indexOf('--informe')
const archivoInforme = posInforme >= 0 ? argumentos[posInforme + 1] : null
const posicionales = argumentos.filter((a, i) => !a.startsWith('--') && (posInforme < 0 || i !== posInforme + 1))
if (posicionales.length > 1) salir('Una sola dirección, como mucho')
const STAGING_REMOTO = leerEnv(path.join(servidor, '.env.staging-remoto')).STAGING_REMOTO_URL || ''
// ⚠️ Una dirección dada pero VACÍA es un error, no «usa la de siempre».
const BASE = (posicionales.length ? posicionales[0] : STAGING_REMOTO).trim().replace(/\/$/, '')
const LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const DUENO_DE_PRUEBAS = 'demo@umbani.local' // el de `staging.mjs`
const MOTIVOS_DE_STAGING = new Set(['staging en internet', 'base local'])

// ── Utilidades ─────────────────────────────────────────────────────────────

const espera = (ms) => new Promise(r => setTimeout(r, ms))
const al = (ruta) => `${BASE}${ruta}`
const aleatorio = () => Math.random().toString(36).slice(2, 10)

function percentil(tiempos, p) {
  const orden = [...tiempos].sort((a, b) => a - b)
  return orden.length ? Math.round(orden[Math.min(orden.length - 1, Math.floor((p / 100) * orden.length))]) : NaN
}

async function pedir(ruta, { metodo = 'GET', cuerpo, cabeceras = {}, limiteMs = 20_000 } = {}) {
  const t0 = performance.now()
  try {
    const r = await fetch(al(ruta), {
      method: metodo,
      headers: cuerpo === undefined ? cabeceras : { 'content-type': 'application/json', ...cabeceras },
      body: cuerpo === undefined ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)),
      signal: AbortSignal.timeout(limiteMs),
    })
    const texto = await r.text()
    let json = null
    try { json = JSON.parse(texto) } catch { /* no era JSON */ }
    return { estado: r.status, ms: performance.now() - t0, json, cabeceras: r.headers }
  } catch (error) {
    return { estado: 0, ms: performance.now() - t0, error: error.name === 'TimeoutError' ? 'tiempo agotado' : error.message }
  }
}

/** `total` peticiones con `concurrencia` a la vez. */
async function rafaga(total, concurrencia, hacer) {
  const resultados = []
  let siguiente = 0
  const t0 = performance.now()
  await Promise.all(Array.from({ length: concurrencia }, async () => {
    while (siguiente < total) {
      const i = siguiente++
      resultados[i] = await hacer(i)
    }
  }))
  return { resultados, duracionMs: performance.now() - t0 }
}

const contar = (resultados) => resultados.reduce((c, r) => ({ ...c, [r.estado]: (c[r.estado] || 0) + 1 }), {})
const tiempos = (resultados) => resultados.map(r => r.ms)
const conEstado = (resultados, estado) => resultados.filter(r => r.estado === estado)
const fallos = (resultados) => resultados.filter(r => r.estado === 0 || r.estado >= 500)

/** Mientras dura una avalancha, alguien normal pregunta por la salud cada segundo. */
function vigia() {
  const muestras = []
  let sigue = true
  const bucle = (async () => {
    while (sigue) {
      muestras.push(await pedir('/api/health', { limiteMs: 10_000 }))
      await espera(1000)
    }
  })()
  return async () => { sigue = false; await bucle; return muestras }
}
const resumenDelVigia = (m) => `${m.length} consultas de salud mientras tanto: ${conEstado(m, 200).length} bien, p95 ${percentil(tiempos(m), 95)} ms`

// ── El informe ─────────────────────────────────────────────────────────────

const secciones = []
let sinFallos = true
function anotar(titulo, veredicto, lineas) {
  const icono = { bien: '✅', mal: '❌', info: 'ℹ️' }[veredicto]
  if (veredicto === 'mal') sinFallos = false
  secciones.push({ titulo, icono, lineas })
  console.log(`\n${icono} ${titulo}`)
  for (const l of lineas) console.log(`   ${l}`)
}

// ── La guardia ─────────────────────────────────────────────────────────────

async function guardia() {
  if (!BASE) salir('Falta la dirección: STAGING_REMOTO_URL en server/.env.staging-remoto, o pásala como argumento')
  let destino
  try { destino = new URL(BASE) } catch { salir(`«${BASE}» no es una dirección válida`) }
  let hostDelStaging = null
  try { hostDelStaging = new URL(STAGING_REMOTO).host } catch { /* sin staging en internet, solo vale el local */ }
  if (destino.host !== hostDelStaging && !LOCALES.has(destino.hostname)) {
    salir(`«${destino.host}» no es el staging de server/.env.staging-remoto ni uno local. Esta prueba no corre contra nada más.`)
  }
  const salud = await pedir('/api/health')
  const motivo = salud.json?.tareas_de_fondo?.motivo
  if (!MOTIVOS_DE_STAGING.has(motivo)) {
    salir(`El servidor no se declara staging (dice «${motivo ?? 'nada'}»). Esta prueba solo corre contra staging.`)
  }
  return salud.json
}

// ── Los escenarios ─────────────────────────────────────────────────────────

async function lineaBase() {
  const medir = async (ruta) => {
    const r = []
    for (let i = 0; i < 5; i++) r.push(await pedir(ruta))
    return `${ruta.padEnd(18)} p50 ${percentil(tiempos(r), 50)} ms · máx ${percentil(tiempos(r), 100)} ms`
  }
  const ciudades = await pedir('/api/v1/ciudades')
  const ciudad = ciudades.json?.ciudades?.[0]?.id ?? null
  anotar('Sin nadie molestando', 'info', [await medir('/api/health'), await medir('/u'), await medir('/api/v1/ciudades')])
  return ciudad
}

async function unContadorPorCliente() {
  // Ocho seguidas a una ruta con freno: con un solo contador para esta IP, lo
  // que queda baja de uno en uno. Con varios (uno por nodo), se repite o sube.
  const restantes = []
  for (let i = 0; i < 8; i++) {
    const r = await pedir('/api/v1/ciudades')
    restantes.push(Number(r.cabeceras?.get('ratelimit-remaining')))
  }
  const deUnoEnUno = restantes.every((n, i) => i === 0 || n === restantes[i - 1] - 1)
  anotar('Un contador por cliente (no uno por nodo de Railway)', deUnoEnUno ? 'bien' : 'mal', [
    `RateLimit-Remaining en ocho peticiones seguidas: ${restantes.join(', ')}`,
    deUnoEnUno
      ? 'Baja de uno en uno: el freno cuenta a ESTE cliente.'
      : '⚠️ Se repite o sube: hay varios contadores para una sola IP — el freno cuenta por nodo (ver config/ip-del-cliente.ts).',
  ])
}

async function avalanchaContraLaVitrina(ciudad) {
  const parar = vigia()
  const { resultados, duracionMs } = await rafaga(300, 30, () => pedir(`/api/v1/marketplace?ciudad=${ciudad}`))
  const salud = await parar()
  const frenadas = conEstado(resultados, 429)
  const ok = frenadas.length > 0 && fallos(resultados).length === 0 && conEstado(salud, 200).length === salud.length
  anotar('Avalancha contra la vitrina (300 peticiones, 30 a la vez)', ok ? 'bien' : 'mal', [
    `En ${(duracionMs / 1000).toFixed(1)} s: ${JSON.stringify(contar(resultados))}`,
    `Pasaron ${conEstado(resultados, 200).length} y las demás se frenaron: el freno contesta en p95 ${percentil(tiempos(frenadas), 95)} ms, sin tocar la base`,
    resumenDelVigia(salud),
  ])
}

async function falsearLaIp(ciudad) {
  // Ya frenados por la avalancha: si la IP inventada valiera, volverían los 200.
  const r = await rafaga(20, 5, (i) => pedir(`/api/v1/marketplace?ciudad=${ciudad}`, {
    cabeceras: { 'x-forwarded-for': `203.0.113.${i + 1}` },
  }))
  const colados = conEstado(r.resultados, 200).length
  anotar('Falsear X-Forwarded-For para saltar el freno', colados === 0 ? 'bien' : 'mal', [
    `20 peticiones, cada una con otra IP inventada: ${JSON.stringify(contar(r.resultados))}`,
    colados === 0
      ? 'El freno cuenta la IP que ve el proxy de Railway, no la que dice el cliente.'
      : `⚠️ ${colados} se colaron: \`trust proxy\` confía en más saltos de los que hay.`,
  ])
}

async function avalanchaContraLaSalud() {
  const { resultados, duracionMs } = await rafaga(600, 40, () => pedir('/api/health'))
  // Cada lectura de la base deja su `base_ms`; si se comparten, hay pocas distintas.
  const lecturas = new Set(resultados.filter(r => r.json).map(r => `${r.json.base_ms}|${r.json.inbound_channel?.last_inbound_at}`))
  const maximo = Math.ceil(duracionMs / 2000) + 1
  const ok = fallos(resultados).length === 0 && conEstado(resultados, 200).length === resultados.length && lecturas.size <= maximo
  anotar('Avalancha contra /api/health (600 peticiones, 40 a la vez; no tiene freno a propósito)', ok ? 'bien' : 'mal', [
    `En ${(duracionMs / 1000).toFixed(1)} s: ${JSON.stringify(contar(resultados))} · p50 ${percentil(tiempos(resultados), 50)} ms · p95 ${percentil(tiempos(resultados), 95)} ms`,
    `Lecturas distintas de la base: ${lecturas.size} (como mucho ${maximo} si se comparten cada 2 s; sin compartir serían cientos)`,
  ])
}

async function fuerzaBrutaAlLogin() {
  const intentar = (correo) => pedir('/api/client/login', { metodo: 'POST', cuerpo: { email: correo, password: `mala-${aleatorio()}` } })
  // Primero los tiempos, alternando: un correo con cuenta y otro sin ella.
  const conCuenta = []
  const sinCuenta = []
  for (let i = 0; i < 6; i++) {
    conCuenta.push(await intentar(DUENO_DE_PRUEBAS))
    sinCuenta.push(await intentar(`nadie-${aleatorio()}@umbani.test`))
  }
  const medianaCon = percentil(tiempos(conCuenta), 50)
  const medianaSin = percentil(tiempos(sinCuenta), 50)
  // Después, a seguir hasta que salte el freno.
  let intento = 12
  let frenado = null
  while (intento < 30 && !frenado) {
    intento++
    const r = await intentar(`nadie-${aleatorio()}@umbani.test`)
    if (r.estado === 429) frenado = intento
  }
  const parecidos = Math.abs(medianaCon - medianaSin) <= Math.max(40, 0.35 * medianaCon)
  const todos401 = [...conCuenta, ...sinCuenta].every(r => r.estado === 401)
  anotar('Fuerza bruta al login del panel', frenado && frenado <= 21 && parecidos && todos401 ? 'bien' : 'mal', [
    `Las 12 primeras, todas 401 con el mismo texto: ${todos401 ? 'sí' : 'NO'}`,
    `Mediana con cuenta ${medianaCon} ms · sin cuenta ${medianaSin} ms: ${parecidos ? 'no se distingue quién tiene cuenta' : '⚠️ el tiempo delata la cuenta'}`,
    frenado ? `El freno saltó en el intento ${frenado} (tope: 20 fallos cada 15 min por IP)` : '⚠️ El freno no saltó en 30 intentos',
  ])
}

async function adivinarUnCodigo() {
  const correo = `carga-${aleatorio()}@umbani.test`
  const pedido = await pedir('/api/v1/auth/correo', { metodo: 'POST', cuerpo: { correo } })
  const bueno = pedido.json?.codigoDePruebas
  if (!bueno) {
    anotar('Adivinar un código del correo', 'info', [`No se pudo probar: pedir el código dio ${pedido.estado} sin código de pruebas (¿el staging tiene proveedor de correo?)`])
    return
  }
  const verificar = (codigo) => pedir('/api/v1/auth/correo/verificar', { metodo: 'POST', cuerpo: { correo, codigo } })
  const estados = []
  for (let k = 1; k <= 5; k++) estados.push((await verificar(String((Number(bueno) + k) % 1_000_000).padStart(6, '0'))).estado)
  const final = await verificar(bueno)
  const ok = JSON.stringify(estados) === JSON.stringify([401, 401, 401, 401, 410]) && final.estado === 410
  anotar('Adivinar un código del correo (6 dígitos, 5 intentos)', ok ? 'bien' : 'mal', [
    `Cinco códigos malos: ${estados.join(', ')} (el 5.º lo mata: 410)`,
    `Y después el BUENO: ${final.estado}${final.estado === 410 ? ' — ya no vale: quien adivina no tiene una sexta oportunidad' : ' ⚠️'}`,
  ])
}

async function pedirCodigosSinParar() {
  const r = []
  for (let i = 0; i < 8; i++) r.push(await pedir('/api/v1/auth/correo', { metodo: 'POST', cuerpo: { correo: `carga-${aleatorio()}@umbani.test` } }))
  const frenado = r.findIndex(x => x.estado === 429)
  anotar('Pedir códigos por correo sin parar (8 seguidos, cada uno a otro correo)', frenado >= 0 ? 'bien' : 'mal', [
    `Respuestas: ${r.map(x => x.estado).join(', ')}`,
    frenado >= 0 ? `El freno saltó en el ${frenado + 1}.º (tope: 5 por minuto por IP; contando el del escenario anterior)` : '⚠️ No saltó ningún freno',
  ])
}

async function cuerpoGigante() {
  const r = await pedir('/api/v1/auth/correo', {
    metodo: 'POST',
    cuerpo: JSON.stringify({ correo: 'gigante@umbani.test', relleno: 'a'.repeat(3 * 1024 * 1024) }),
    limiteMs: 60_000,
  })
  anotar('Un cuerpo de 3 MB', r.estado === 413 ? 'bien' : 'mal', [
    `Respuesta ${r.estado} en ${Math.round(r.ms)} ms (el tope es 2 MB; se corta antes de llegar a la ruta)`,
  ])
}

/** Una conexión que manda las cabeceras a cuentagotas y nunca las termina. */
function conexionLenta(destino, maximoMs) {
  return new Promise((resolve) => {
    const t0 = performance.now()
    const segura = destino.protocol === 'https:'
    const puerto = Number(destino.port) || (segura ? 443 : 80)
    const socket = segura
      ? tls.connect({ host: destino.hostname, port: puerto, servername: destino.hostname })
      : net.connect({ host: destino.hostname, port: puerto })
    let lineas = 0
    let primera = ''
    let hecho = false
    const goteo = setInterval(() => { if (!socket.destroyed) socket.write(`X-Goteo-${++lineas}: a\r\n`) }, 5000)
    const terminar = (como) => {
      if (hecho) return
      hecho = true
      clearInterval(goteo)
      clearTimeout(limite)
      socket.destroy()
      resolve({ ms: performance.now() - t0, como, primera })
    }
    const limite = setTimeout(() => terminar('seguía abierta'), maximoMs)
    socket.once(segura ? 'secureConnect' : 'connect', () => {
      socket.write(`GET /api/health HTTP/1.1\r\nHost: ${destino.host}\r\nUser-Agent: umbani-carga\r\n`)
    })
    socket.on('data', d => { primera ||= d.toString().split('\r\n')[0] })
    socket.on('close', () => terminar('cerrada'))
    socket.on('error', () => terminar('error'))
  })
}

async function cabecerasACuentagotas() {
  const parar = vigia()
  const conexiones = await Promise.all(Array.from({ length: 20 }, () => conexionLenta(new URL(BASE), 70_000)))
  const salud = await parar()
  const cerradas = conexiones.filter(c => c.como !== 'seguía abierta')
  const respuestas = [...new Set(conexiones.map(c => c.primera).filter(Boolean))]
  anotar('Cabeceras a cuentagotas («slowloris», 20 conexiones, una línea cada 5 s)', 'info', [
    `${cerradas.length} de 20 cortadas antes de 70 s · al cortarse: mediana ${percentil(conexiones.map(c => c.ms), 50) / 1000 | 0} s`,
    `Lo que contestó quien las cortó: ${respuestas.length ? respuestas.join(' · ') : 'nada (cierre sin respuesta)'}`,
    resumenDelVigia(salud),
    'Delante está el proxy de Railway, que recibe las cabeceras antes que nosotros: esto mide al conjunto.',
  ])
}

async function muchasConexiones() {
  const parar = vigia()
  const { resultados, duracionMs } = await rafaga(1500, 100, () => pedir('/u'))
  const salud = await parar()
  const errores = fallos(resultados).length
  const ok = errores / resultados.length < 0.01 && conEstado(salud, 200).length === salud.length
  anotar('Muchas conexiones a la vez pidiendo la app (1.500 peticiones, 100 a la vez)', ok ? 'bien' : 'mal', [
    `En ${(duracionMs / 1000).toFixed(1)} s: ${Math.round(resultados.length / (duracionMs / 1000))} por segundo · ${JSON.stringify(contar(resultados))}`,
    `p50 ${percentil(tiempos(resultados), 50)} ms · p95 ${percentil(tiempos(resultados), 95)} ms · p99 ${percentil(tiempos(resultados), 99)} ms · errores ${errores}`,
    resumenDelVigia(salud),
  ])
}

// ── Todo, en orden ─────────────────────────────────────────────────────────

const salud = await guardia()
console.log(`\n🧪 Prueba de carga contra ${BASE} (versión ${salud.version}, ${salud.tareas_de_fondo.motivo})`)
const inicio = new Date()

const ciudad = await lineaBase()
await unContadorPorCliente()
if (ciudad) {
  await avalanchaContraLaVitrina(ciudad)
  await falsearLaIp(ciudad)
} else {
  anotar('Avalancha contra la vitrina', 'info', ['No hay ninguna ciudad con locales en este staging: sin vitrina que probar'])
}
await avalanchaContraLaSalud()
await fuerzaBrutaAlLogin()
await adivinarUnCodigo()
await pedirCodigosSinParar()
await cuerpoGigante()
await cabecerasACuentagotas()
await muchasConexiones()

const despues = await pedir('/api/health')
anotar('Al terminar', despues.estado === 200 ? 'bien' : 'mal', [`El servidor sigue en pie: /api/health ${despues.estado}, base_ms ${despues.json?.base_ms}`])

if (archivoInforme) {
  const md = [
    `# Prueba de carga y de ataques — ${inicio.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `Contra \`${BASE}\` (versión \`${salud.version}\`, ${salud.tareas_de_fondo.motivo}). Desde UNA máquina: mide los frenos`,
    'del servidor, no un DDoS distribuido (ese se para delante, en Cloudflare).',
    '',
    ...secciones.flatMap(s => [`## ${s.icono} ${s.titulo}`, '', ...s.lineas.map(l => `- ${l}`), '']),
  ].join('\n')
  writeFileSync(archivoInforme, md)
  console.log(`\n📝 Informe: ${archivoInforme}`)
}

console.log(sinFallos ? '\n✅ Ninguna defensa falló.\n' : '\n❌ Alguna defensa falló: mira arriba.\n')
process.exit(sinFallos ? 0 : 1)
