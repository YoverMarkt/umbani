// ═══════════════════════════════════════════════════════════════════════════
// EL BOCETO Y LA APP, LADO A LADO (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño diseñó la app de Umbani en Figma y la quiere «tal cual». Leer el
// código no dice si una pantalla se parece al diseño: hay que VERLAS juntas.
// Este guion fotografía una pantalla de la app al tamaño exacto del frame de
// Figma y guarda UNA imagen con tres paneles:
//
//   boceto (Figma) · app · diferencias (en rojo, lo que no coincide)
//
// Es la herramienta de la skill `fiel-al-boceto` (.claude/skills/).
//
//   npm run dev -w @botpanel/store -- --host 127.0.0.1 --port 5180   (en otra terminal)
//   npm run boceto -- --boceto .bocetos/figma/01-inicio.png \
//                     --url http://127.0.0.1:5180/t/u.html \
//                     [--datos .bocetos/datos/inicio.json] [--escala 3] \
//                     [--esperar 'text=Restaurantes'] [--clic 'text=Ver carrito'] \
//                     [--nombre inicio] [--umbral 16]
//
// Sin --boceto saca solo la foto de la app (--ancho y --alto; 390×844 a 3x si
// no se dicen): sirve para el «antes» de una pantalla o para mirarla a 360.
//
// ⚠️ TODO SE GUARDA EN `.bocetos/`, que git ignora: el repositorio es PÚBLICO
// y el diseño del dueño no se publica antes de tiempo (lo vigila
// `server/tests/bocetos-privados-guardian.test.js`).
//
// ⚠️ SOLO CORRE contra tu máquina o contra el staging de
// `server/.env.staging-remoto`. Una página abierta llama a la API, y
// producción tiene clientes reales: la lista es de lo PERMITIDO, igual que la
// de la prueba de carga — una lista de lo prohibido se queda corta el día que
// cambia la dirección (y el domingo cambia).
//
// ⚠️ CON --datos, la API no sale del navegador: cada petición a `/api` se
// responde con el JSON del archivo, para que la pantalla enseñe los MISMOS
// textos y precios que el diseño y la comparación sea de igual a igual. Una
// petición sin dato se responde 404 y se avisa al final: así se sabe qué falta.
// Formato:
//
//   { "almacenamiento": { "<clave de localStorage>": "<valor>" },
//     "api": { "GET /api/v1/marketplace": { "estado": 200, "cuerpo": { … } } } }

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LOCALES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
/** El ancho de un teléfono, en píxeles CSS: lo que puede medir un frame de Figma. */
const ANCHO_DE_TELEFONO = { min: 320, max: 480 }

const salir = (motivo) => {
  console.error(`\n❌ ${motivo}\n`)
  process.exit(1)
}

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

/** `--clave valor`; `--clic` se puede repetir y se ejecuta en orden. */
function leerArgumentos(lista) {
  const opciones = { clic: [] }
  for (let i = 0; i < lista.length; i++) {
    const clave = lista[i]
    if (!clave.startsWith('--')) salir(`No entiendo «${clave}»: cada opción va como --nombre valor`)
    const valor = lista[i + 1]
    if (valor === undefined || valor.startsWith('--')) salir(`A ${clave} le falta su valor`)
    i++
    if (clave === '--clic') opciones.clic.push(valor)
    else opciones[clave.slice(2)] = valor
  }
  return opciones
}

/** Ancho y alto de un PNG, leídos de su cabecera (sin librerías). */
function medidasDelPng(archivo) {
  const datos = readFileSync(archivo)
  const firma = '89504e470d0a1a0a'
  if (datos.length < 24 || datos.subarray(0, 8).toString('hex') !== firma || datos.toString('ascii', 12, 16) !== 'IHDR') {
    salir(`«${archivo}» no es un PNG. Expórtalo de Figma como PNG (no JPG ni PDF).`)
  }
  return { datos, ancho: datos.readUInt32BE(16), alto: datos.readUInt32BE(20) }
}

/**
 * A qué escala se exportó: la mayor que deja un ancho de teléfono entero.
 * 1170 px → 390 a 3x; 780 → 390 a 2x; 1080 → 360 a 3x.
 */
function escalaProbable(anchoPx) {
  for (const escala of [3, 2, 1]) {
    const css = anchoPx / escala
    if (Number.isInteger(css) && css >= ANCHO_DE_TELEFONO.min && css <= ANCHO_DE_TELEFONO.max) return escala
  }
  return null
}

function comprobarDestino(url) {
  let destino
  try { destino = new URL(url) } catch { salir(`«${url}» no es una dirección completa (empieza por http://)`) }
  const staging = leerEnv(path.join(raiz, 'server/.env.staging-remoto')).STAGING_REMOTO_URL || ''
  let hostDelStaging = null
  try { hostDelStaging = new URL(staging).host } catch { /* sin staging en internet: solo vale lo local */ }
  if (!LOCALES.has(destino.hostname) && destino.host !== hostDelStaging) {
    salir(`«${destino.host}» no es tu máquina ni el staging de server/.env.staging-remoto. El comparador no abre nada más.`)
  }
}

function leerDatos(archivo) {
  if (!archivo) return null
  if (!existsSync(archivo)) salir(`No existe el archivo de datos «${archivo}»`)
  let datos
  try { datos = JSON.parse(readFileSync(archivo, 'utf8')) } catch (e) { salir(`«${archivo}» no es JSON válido: ${e.message}`) }
  for (const [ruta, respuesta] of Object.entries(datos.api || {})) {
    if (!/^(GET|POST|PUT|PATCH|DELETE) \/api\//.test(ruta)) salir(`En --datos, «${ruta}» tiene que ser «MÉTODO /api/...»`)
    if (!respuesta || !('cuerpo' in respuesta)) salir(`En --datos, «${ruta}» necesita su «cuerpo»`)
  }
  return { almacenamiento: datos.almacenamiento || {}, api: datos.api || {} }
}

/** La foto de la app: el viewport mide lo que el frame, a su misma escala. */
async function fotografiarLaApp(navegador, { url, ancho, alto, escala, datos, esperar, clic }) {
  const contexto = await navegador.newContext({
    viewport: { width: ancho, height: alto },
    deviceScaleFactor: escala,
    isMobile: true,
    hasTouch: true,
    locale: 'es-EC',
    timezoneId: 'America/Guayaquil',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    // El service worker de la app contestaría ANTES que las rutas de abajo, y
    // la pantalla enseñaría datos reales en vez de los del diseño.
    serviceWorkers: 'block',
  })
  const pagina = await contexto.newPage()
  const sinDato = new Set()
  const errores = []
  pagina.on('pageerror', (error) => errores.push(error.message))

  if (datos) {
    await pagina.addInitScript((almacenamiento) => {
      for (const [clave, valor] of Object.entries(almacenamiento)) {
        window.localStorage.setItem(clave, typeof valor === 'string' ? valor : JSON.stringify(valor))
      }
    }, datos.almacenamiento)
    await pagina.route('**/api/**', (ruta) => {
      const peticion = ruta.request()
      const clave = `${peticion.method()} ${new URL(peticion.url()).pathname}`
      const respuesta = datos.api[clave]
      if (!respuesta) {
        sinDato.add(clave)
        return ruta.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Sin dato de prueba' }) })
      }
      return ruta.fulfill({
        status: respuesta.estado ?? 200,
        contentType: 'application/json',
        body: JSON.stringify(respuesta.cuerpo),
      })
    })
  }

  await pagina.goto(url, { waitUntil: 'networkidle' })
  if (esperar) await pagina.waitForSelector(esperar, { timeout: 15_000 })
  for (const objetivo of clic) {
    await pagina.click(objetivo, { timeout: 15_000 })
    // `networkidle` ya se cumplió al cargar y no vuelve a esperar: se da
    // tiempo a que la hoja o el modal terminen de abrirse y pidan sus datos.
    await pagina.waitForTimeout(600)
  }
  // Las fuentes propias y las fotos, cargadas: si no, se fotografía la de reserva.
  await pagina.evaluate(async () => {
    await document.fonts.ready
    await Promise.all([...document.images].map((imagen) => (imagen.complete ? null : imagen.decode().catch(() => null))))
  })
  const foto = await pagina.screenshot()
  await contexto.close()
  return { foto, sinDato: [...sinDato], errores }
}

/** Los tres paneles en una página, y la cuenta de píxeles distintos. */
async function componer(navegador, { boceto, app, ancho, escala, umbral, titulo }) {
  const contexto = await navegador.newContext({ deviceScaleFactor: 2, colorScheme: 'light' })
  const pagina = await contexto.newPage()
  const comoDato = (png) => `data:image/png;base64,${png.toString('base64')}`
  const panel = (texto, contenido) =>
    `<figure><figcaption>${texto}</figcaption>${contenido}</figure>`
  await pagina.setViewportSize({ width: ancho * 3 + 64, height: 400 })
  await pagina.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #f4f4f2; color: #14181a; font: 14px/1.4 system-ui, sans-serif; }
    header { padding: 12px 16px 0; font-weight: 600; }
    main { display: flex; gap: 16px; padding: 12px 16px 16px; align-items: flex-start; }
    figure { margin: 0; width: ${ancho}px; }
    figcaption { font-size: 12px; color: #5b6366; margin-bottom: 6px; }
    img, canvas { display: block; width: ${ancho}px; height: auto; box-shadow: 0 0 0 1px #d9dcd8; }
  </style></head><body>
    <header id="titulo"></header>
    <main>
      ${panel('Boceto (Figma)', `<img id="boceto" src="${comoDato(boceto)}">`)}
      ${panel('App', `<img id="app" src="${comoDato(app)}">`)}
      ${panel('Diferencias (en rojo)', '<canvas id="diferencias"></canvas>')}
    </main></body></html>`)

  const cuenta = await pagina.evaluate(async (umbralDeColor) => {
    const imagenes = [document.getElementById('boceto'), document.getElementById('app')]
    await Promise.all(imagenes.map((imagen) => imagen.decode()))
    const ancho = imagenes[0].naturalWidth
    const alto = imagenes[0].naturalHeight
    // Sobre blanco: un PNG con transparencia se comparará como se ve.
    const pixeles = (imagen) => {
      const lienzo = document.createElement('canvas')
      lienzo.width = ancho
      lienzo.height = alto
      const ctx = lienzo.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, ancho, alto)
      ctx.drawImage(imagen, 0, 0, ancho, alto)
      return ctx.getImageData(0, 0, ancho, alto).data
    }
    const [a, b] = imagenes.map(pixeles)
    const salida = new ImageData(ancho, alto)
    let distintos = 0
    for (let i = 0; i < a.length; i += 4) {
      const diferencia = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]))
      if (diferencia > umbralDeColor) {
        distintos++
        salida.data.set([226, 38, 38, 255], i)
      } else {
        // Lo que coincide queda en gris muy claro: el rojo es lo único que grita.
        const gris = 255 - (255 - (a[i] * 0.3 + a[i + 1] * 0.59 + a[i + 2] * 0.11)) * 0.25
        salida.data.set([gris, gris, gris, 255], i)
      }
    }
    const lienzo = document.getElementById('diferencias')
    lienzo.width = ancho
    lienzo.height = alto
    lienzo.getContext('2d').putImageData(salida, 0, 0)
    return { distintos, total: ancho * alto }
  }, umbral)

  const porcentaje = (cuenta.distintos / cuenta.total) * 100
  const texto = `${titulo} · ${porcentaje.toLocaleString('es-EC', { maximumFractionDigits: 1 })} % de píxeles distintos (umbral ${umbral}) · ${escala}x`
  await pagina.evaluate((t) => { document.getElementById('titulo').textContent = t }, texto)
  const imagen = await pagina.screenshot({ fullPage: true })
  await contexto.close()
  return { imagen, porcentaje }
}

async function main() {
  const opciones = leerArgumentos(process.argv.slice(2))
  if (!opciones.url) salir('Falta --url: la pantalla de la app que se fotografía')
  comprobarDestino(opciones.url)

  let boceto = null
  let escala = Number(opciones.escala) || null
  let ancho = Number(opciones.ancho) || 390
  let alto = Number(opciones.alto) || 844
  if (opciones.boceto) {
    if (!existsSync(opciones.boceto)) salir(`No existe el boceto «${opciones.boceto}»`)
    boceto = medidasDelPng(opciones.boceto)
    escala = escala || escalaProbable(boceto.ancho)
    if (!escala) salir(`No adivino la escala de un PNG de ${boceto.ancho} px de ancho: dila con --escala 1, 2 o 3`)
    ancho = Math.round(boceto.ancho / escala)
    alto = Math.round(boceto.alto / escala)
  }
  escala = escala || 3
  // 16 de 255 en el canal que más cambia: lo bastante fino para cazar un gris
  // que no es el del diseño (con 40 se escapaba el fondo de una pastilla), y
  // lo bastante grueso para no pintar de rojo el ruido de la compresión.
  const umbral = Number(opciones.umbral) || 16
  const nombre = opciones.nombre || (opciones.boceto ? path.basename(opciones.boceto, '.png') : `app-${ancho}x${alto}`)
  const carpeta = path.resolve(opciones.salida || path.join(raiz, '.bocetos/comparaciones'))
  mkdirSync(carpeta, { recursive: true })

  const navegador = await chromium.launch()
  try {
    const { foto, sinDato, errores } = await fotografiarLaApp(navegador, {
      url: opciones.url,
      ancho,
      alto,
      escala,
      datos: leerDatos(opciones.datos),
      esperar: opciones.esperar,
      clic: opciones.clic,
    })
    const archivoApp = path.join(carpeta, `${nombre}.app.png`)
    writeFileSync(archivoApp, foto)
    console.log(`📸 La app, a ${ancho}×${alto} y ${escala}x: ${path.relative(raiz, archivoApp)}`)

    if (boceto) {
      const { imagen, porcentaje } = await componer(navegador, {
        boceto: boceto.datos,
        app: foto,
        ancho,
        escala,
        umbral,
        titulo: `${nombre} · ${ancho}×${alto}`,
      })
      const archivo = path.join(carpeta, `${nombre}.png`)
      writeFileSync(archivo, imagen)
      console.log(`✅ Boceto | app | diferencias: ${path.relative(raiz, archivo)} (${porcentaje.toFixed(1)} % distinto)`)
    }
    for (const clave of sinDato) console.warn(`⚠️ Sin dato de prueba (se respondió 404): ${clave}`)
    // Una pantalla que lanzó un error no se compara: lo que se ve está roto.
    for (const error of errores) console.warn(`⚠️ La página lanzó un error: ${error}`)
    if (errores.length) process.exitCode = 1
  } finally {
    await navegador.close()
  }
}

await main()
