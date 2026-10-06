#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// PRESUPUESTO DE TAMAÑO DE LA MINI APP
// ═══════════════════════════════════════════════════════════════════════════
//
// Por qué existe: esta app la abre el cliente final desde WhatsApp, con datos
// móviles y a menudo con mala señal. Cada kilobyte se paga en gente que cierra
// antes de que cargue — y una venta perdida así no deja rastro en ningún log.
//
// Por eso la tienda va DELIBERADAMENTE sin router y sin cliente de datos, algo
// que un `import` distraído deshace en un segundo: react-router son ~10 kB
// gzip y react-query ~13 kB, cifras que nadie nota revisando un diff pero que
// se notan en el teléfono de quien compra.
//
// El presupuesto no premia adelgazar; solo impide engordar sin darse cuenta.
// Si un cambio lo necesita de verdad, se sube el número a propósito y queda
// escrito en el historial quién decidió que valía la pena.
import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(RAIZ, 'dist')

// Medido el 2026-08-02: 76,0 kB.
// Medido el 2026-08-06: 82,1 kB tras el rediseño de la tienda.
//
// El margen está calibrado a propósito por DEBAJO de la librería más pequeña
// que querríamos cazar: react-router son ~10 kB gzip. Un presupuesto con más
// holgura que eso deja pasar justo lo que dice vigilar y solo sirve para dar
// tranquilidad falsa.
//
// La subida del 2026-08-06 (82 → 86) es la que este guardián considera
// legítima: no entró ninguna dependencia. Los +2,0 kB son +1,3 de JS —portada
// del local, buscador, barra inferior y el observador que sincroniza las
// pestañas con el scroll— y +0,5 de CSS de la rejilla. Es una pantalla nueva,
// que es exactamente como crece esta app.
//
// Medido el 2026-08-10: 86,1 kB. La subida (86 → 88) también es sin
// dependencias, y las dos cosas que la causan arreglan fallos que se vieron en
// un teléfono de verdad:
//
//   · el carrito no enseñaba lo que el cliente había elegido —una pizza con
//     masa, sabor y borde salía como «Pizza · Familiar»— justo en la pantalla
//     donde confirma y paga;
//   · el aviso de la ubicación decía lo mismo para tres fallos distintos y
//     mandaba a abrir el enlace fuera de WhatsApp a quien ya estaba en Chrome
//     con el permiso bloqueado.
//
// El margen sigue en 1,9 kB, bastante por debajo de los ~10 kB de react-router:
// este guardián no ha perdido nada de su capacidad de cazar una dependencia.
//
// Medido el 2026-08-12: 84,7 kB. BAJA por primera vez (86,1 → 84,7). Se fueron
// la pantalla de seguimiento y la subida del comprobante: el pedido se sigue
// por WhatsApp y la captura se manda por el chat. El presupuesto se deja en 88
// a propósito —bajarlo a ras del número de hoy convierte cualquier pantalla
// nueva en una alarma, y este guardián está para cazar dependencias, no
// features—, pero el margen real vuelve a ser cómodo.
// Medido el 2026-08-27: 90,4 kB. SUBE de 88 a 92 por una decisión del dueño,
// no por descuido — que es el único motivo por el que este número se puede
// mover, y por eso queda escrito aquí quién lo decidió y qué se compró.
//
// Se cambió el set de iconos de **lucide** a **Remix Icon**. El dueño lo pidió
// así: «los iconos se ven muy hechos por IA». Tenía razón por una razón
// concreta —lucide es el set por defecto de shadcn y de casi toda interfaz
// generada por IA, así que se reconoce— y por otra que importa más: **lucide
// es solo LÍNEA**. Sin variantes rellenas no se puede dibujar el estado activo
// de la barra inferior, que es lo que hace que una barra se lea como una app y
// no como una plantilla. Remix trae `Line` y `Fill` del mismo icono.
//
// El coste REAL, medido con la app entera migrada: **86,6 → 90,4 kB**, o sea
// +3,8 kB por 26 iconos, cuatro de ellos en sus dos versiones. Los iconos de
// Remix son trazados rellenos y llevan más datos de ruta que el trazo simple
// de lucide; ese es todo el sobrecoste.
//
// ⚠️ Se midió antes **Phosphor**, que era el candidato obvio por su acabado:
// **+13,2 kB**, porque cada icono suyo empaqueta SEIS variantes de peso —thin,
// light, regular, bold, fill, duotone— y se descargan todas aunque se use una.
// Su entrada `/dist/ssr` no cambió nada. Se descartó por eso, no por gusto.
//
// El margen queda en ~1,6 kB, igual de estrecho que antes y muy por debajo de
// los ~10 kB de react-router: este guardián NO ha perdido nada de su capacidad
// de cazar una dependencia que entre sin que nadie la decida.
// Medido el 2026-08-27, después de rehacer la ficha y el carrito: 90,4 kB.
// El número NO se mueve, y esta vez la nota es para explicar por qué BAJA
// (91,0 → 90,4) justo cuando entran dos pantallas rediseñadas.
//
// Se difirieron las TRES PUERTAS —`Gate`, `Confirmar` y `DesktopGate`—, que
// suman ~2,9 kB y no se ven en una visita normal: `DesktopGate` solo en una
// computadora (o sea, nunca en el público de esta app), `Gate` solo con un
// enlace que no vale y `Confirmar` solo cuando falta demostrar el número.
//
// ⚠️ Se difirieron ESAS y no `OrderPlaced`, que era la candidata obvia por
// tamaño: aquella se pinta en el instante siguiente a confirmar un pedido, y
// si el trozo no llegara el cliente que acaba de comprar se quedaría sin su
// número de pedido y sin los datos para transferir. Diferir tiene un precio y
// se paga donde no duele.
//
// Es la salida que este guardián prefiere y así está escrito arriba: antes de
// subir el número, mirar qué se está descargando de más.
// 92 → 93 el 2026-08-30, y queda escrito por qué, que es para lo que sirve
// este número.
//
// Entró: la pantalla de bloqueo y la de sin conexión, el campo `blocked` de la
// portada y los dos campos nuevos de `ApiError`. Nada de eso es una librería —
// son ramas de decisión que la app no tenía y que evitan tres pantallas que
// mentían: la que enseñaba la carta a un bloqueado, la que culpaba al local de
// un fallo de red, y la que no ofrecía reintentar.
//
// ⚠️ ANTES de subirlo se sacó peso de verdad: `NoDisponible` vivía escrita a
// mano en `App.tsx` —o sea, en el paquete principal— para una pantalla que en
// una visita normal no se ve nunca. Ahora viaja aparte, como las otras cinco
// puertas. Subir el número fue el último recurso, no el primero.
//
// 93 → 94 el 2026-09-02, y también queda escrito por qué.
//
// Entró: `cuandoAbre` y la rama que enseña «Abre hoy 8:00 AM» en vez del rango
// cuando la tienda está cerrada. Son unos 100 bytes gzip y no es una librería:
// es el arreglo de un texto que hacía que la portada se contradijera sola
// —«Cerrado · 8:00 AM – 2:00 AM» leído a la 01:10— y que el dueño confundió
// con un fallo de la app. Si a él le pasó, a un cliente le pasa seguro.
//
// ⚠️ Se intentó que cupiera antes de tocar el número: `cuandoAbre` se compactó
// a un solo `return` en vez de tres ramas. No bastó por unas decenas de bytes.
//
// ⚠️ Y se DESCARTÓ la optimización grande a propósito. `ProductSheet` (703
// líneas) y `CartSheet` (755) viajan en el paquete principal y **ninguno se ve
// en la primera pantalla**: diferirlos sacaría muchos kilobytes de golpe. Pero
// los dos son el camino del DINERO —la ficha del producto y el checkout— y
// montarlos con `lazy` obliga a decidir qué pasa con la animación de salida al
// cerrarlos, que hoy depende de que estén siempre montados. Cambiar eso por
// 100 bytes es arriesgar el flujo de compra para ganar una cifra. Queda
// anotado como la palanca de verdad para el día que el presupuesto apriete
// —vale varios kB, no decenas de bytes— y ese día se hace con su prueba.
//
// 94 → 95 el 2026-09-14. Medido: 93,3 kB en `main` → 94,5 kB con el cambio.
//
// Entró: la MESA de la familia, el almuerzo por partes que pidió el dueño —«si
// en la familia son más, en ese mismo almuerzo me permita sumar más sopas y más
// segundos»—. Son +1,2 kB y ninguna librería: `lineasDelPlato` (la regla que
// cobra la base, copiada para pintar lo mismo que se va a cobrar), el desglose
// de la mesa en platos, «Editar» en el carrito y el «Gratis» de lo que acompaña.
//
// ⚠️ No se compactó la regla para que cupiera, y es a propósito: es la tercera
// copia de una cuenta de DINERO, con los mismos casos que la base. Quitarle
// comprobaciones para ahorrar bytes haría que la pantalla dijera un total y la
// base cobrara otro, que es exactamente lo que esa copia existe para impedir.
// La palanca grande sigue siendo la anotada arriba —diferir la ficha y el
// carrito— y sigue descartada por el mismo motivo.
//
// Entró (2026-09-17): el tope de lo gratis OPCIÓN POR OPCIÓN en la ficha
// (`topeDeLaOpcion`, `gratisDelGrupo`) y el cierre de lo que acompaña hasta
// que haya un plato. Son unas décimas y ninguna librería. Faltaban porque la
// ficha dejaba marcar diez jugos gratis sobre un almuerzo mientras el carrito
// los rechazaba: pantalla y cobro tienen que contar igual, y eso no se recorta.
//
// 96 → 97 el 2026-09-26. Medido en el CI: 95,4 kB en `main` antes de #412 →
// 96,0 kB con esto. Ninguna librería. Entraron, en dos pasos:
//   · #412 (+0,5): el `Aviso` y el `EstadoVacio` únicos que pidió el dueño
//     —«el diseño en todas sus pantallas y avisos»— y el icono de la
//     bienvenida en el `index.html`, que SÍ viaja entero (se le quitó el
//     comentario y se recortó el trazo a un decimal para que cupiera).
//   · Los tres fallos que el dueño encontró en producción (+0,1): «Mis
//     pedidos» que se quedaba cargando, la barra de categorías que no seguía
//     el scroll y el aviso del comprobante que solo salía al recargar. Son
//     arreglos de lo que el cliente ve roto: no se recortan para ahorrar
//     bytes. La palanca grande sigue siendo la de arriba (diferir la ficha y
//     el carrito), y la pantalla de Buscar nace diferida para no sumar aquí.
// 97 → 99 el 2026-10-05, y queda escrito por qué. Medido: 96,8 kB la tienda
// sola → 98,0 kB con la APP WEB DE CLIENTES (`/u`) compilada al lado.
//
// No entró ninguna librería ni una línea en la tienda. Entró una SEGUNDA
// página (`u.html`, la app de clientes tras el pivote a «solo la app» del
// dueño) y Rollup sacó lo común —React, `components/ui`, la sesión— a un
// archivo compartido. El mismo código, comprimido en dos archivos en vez de
// uno, pesa ~0,8 kB más: gzip no reutiliza su diccionario entre archivos.
//
// Se eligió a propósito frente a compilar la app aparte: quien abre la app y
// entra a un local descarga el código común UNA vez y la tienda lo reutiliza
// de la caché. Con dos compilaciones, React bajaría dos veces — justo a los
// clientes que ahora son el público de Umbani.
//
// ⚠️ Antes de subir el número se quitaron 0,3 kB de verdad: las etiquetas de
// «Mis pedidos» (`COMO_VA`) habían caído en `lib/estado.ts`, que se carga de
// entrada; viven en `lib/como-va.ts` y solo las baja quien abre sus pedidos.
// El margen sigue muy por debajo de los ~10 kB de react-router.
const PRESUPUESTO_KB = 99

// La app web de clientes (`/u`), con su propio tope. Medido el 2026-10-05:
// 82,6 kB, casi todo el código común con la tienda. Se calibra igual que el de
// la tienda: por debajo de una librería que querríamos cazar.
const PRESUPUESTO_APP_KB = 86

const recorrer = dir => readdirSync(dir).flatMap(entrada => {
  const completa = path.join(dir, entrada)
  return statSync(completa).isDirectory() ? recorrer(completa) : [completa]
})

// Lo que el navegador descarga para pintar la primera pantalla. Las fuentes y
// las imágenes quedan fuera a propósito: llegan después y no bloquean.
const CUENTA = new Set(['.js', '.css', '.html'])

const archivos = recorrer(DIST)
  .filter(f => CUENTA.has(path.extname(f)))
  .map(f => ({
    nombre: path.relative(DIST, f),
    gzip: gzipSync(readFileSync(f)).length,
  }))
  .sort((a, b) => b.gzip - a.gzip)

if (!archivos.length) {
  console.error('❌ No hay nada en dist/. Compila primero: npm run build -w @botpanel/store')
  process.exit(1)
}

// ── Qué es «primera carga» de verdad ─────────────────────────────────────
//
// ⚠️ Antes se sumaba TODO lo que hubiera en `dist`, y eso convertía en un
// suspenso justo la optimización correcta: al diferir el flujo de hospedaje
// —que un cliente de una pizzería jamás abre— la primera carga BAJÓ 4 kB y el
// guardián marcó que la app había engordado, porque contaba el trozo nuevo
// como si se descargara al entrar.
//
// La lista buena está escrita en el propio `index.html`: lo que trae en un
// `src` o un `href` es lo que el navegador pide para pintar —incluidos los
// `modulepreload` que Vite añade para los imports estáticos—. Lo demás son
// trozos que llegan cuando se necesitan, y se enseñan aparte para que se vean
// pero no cuenten.
const html = readFileSync(path.join(DIST, 'index.html'), 'utf8')
const referidos = new Set(
  [...html.matchAll(/(?:src|href)="\/?t?\/?([^"]+\.(?:js|css))"/g)]
    .map(coincidencia => coincidencia[1].replace(/^\/+/, '')),
)
const enLaPrimeraCarga = archivo => (
  archivo.nombre === 'index.html'
  || referidos.has(archivo.nombre)
  || [...referidos].some(ref => ref.endsWith(archivo.nombre))
)

const inicial = archivos.filter(enLaPrimeraCarga)
// La app de clientes (`/u`) es OTRA página: sus archivos no son pantallas
// diferidas de la tienda, y se miden aparte al final.
const esDeLaApp = archivo => archivo.nombre === 'u.html' || archivo.nombre.startsWith('assets/umbani-')
const diferidos = archivos.filter(archivo => !enLaPrimeraCarga(archivo) && !esDeLaApp(archivo))

const total = inicial.reduce((suma, a) => suma + a.gzip, 0)
const kb = n => (n / 1024).toFixed(1)

console.log('\n📦 Tamaño de la mini app (gzip, primera carga)\n')
for (const a of inicial) {
  console.log(`   ${kb(a.gzip).padStart(7)} kB  ${a.nombre}`)
}
console.log(`   ${'─'.repeat(9)}`)
console.log(`   ${kb(total).padStart(7)} kB  TOTAL   (presupuesto: ${PRESUPUESTO_KB} kB)\n`)

if (diferidos.length) {
  console.log('   Se descargan solo cuando hacen falta, y NO cuentan aquí:')
  for (const a of diferidos) {
    console.log(`   ${kb(a.gzip).padStart(7)} kB  ${a.nombre}`)
  }
  console.log('')
}

if (total > PRESUPUESTO_KB * 1024) {
  console.error(`❌ La tienda pesa ${kb(total)} kB y el presupuesto son ${PRESUPUESTO_KB} kB.`)
  console.error('')
  console.error('   Quien abre esto lo hace desde WhatsApp, con datos móviles. Antes de')
  console.error('   subir el número, mira qué entró: casi siempre es una librería que')
  console.error('   resuelve en 30 kB algo que aquí se hace en 30 líneas.')
  console.error('')
  console.error(`   Si de verdad hace falta, sube PRESUPUESTO_KB en ${path.relative(process.cwd(), fileURLToPath(import.meta.url))}`)
  console.error('   y explica en el commit por qué valía la pena.')
  process.exit(1)
}

const margen = PRESUPUESTO_KB - total / 1024
console.log(`✅ Dentro del presupuesto (quedan ${margen.toFixed(1)} kB de margen).\n`)

// ── La app web de clientes (`/u`, 2026-10-05) ─────────────────────────────
// Su primera carga: la página y lo que ella pide. Comparte casi todo con la
// tienda, así que si esto engorda, casi siempre engorda también la tienda.
const paginaDeLaApp = path.join(DIST, 'u.html')
if (!existsSync(paginaDeLaApp)) {
  console.error('❌ Falta dist/u.html: la app de clientes no se compiló (vite.config.ts → build.rollupOptions.input).')
  process.exit(1)
}
const refsDeLaApp = new Set(
  [...readFileSync(paginaDeLaApp, 'utf8').matchAll(/(?:src|href)="\/?t?\/?([^"]+\.(?:js|css))"/g)]
    .map(coincidencia => coincidencia[1].replace(/^\/+/, '')),
)
const deLaApp = archivos.filter(archivo => (
  archivo.nombre === 'u.html' || refsDeLaApp.has(archivo.nombre) || [...refsDeLaApp].some(ref => ref.endsWith(archivo.nombre))
))
const totalApp = deLaApp.reduce((suma, a) => suma + a.gzip, 0)
console.log('📱 La app web de clientes (/u), primera carga\n')
for (const a of deLaApp) console.log(`   ${kb(a.gzip).padStart(7)} kB  ${a.nombre}`)
console.log(`   ${kb(totalApp).padStart(7)} kB  TOTAL   (presupuesto: ${PRESUPUESTO_APP_KB} kB)\n`)
if (totalApp > PRESUPUESTO_APP_KB * 1024) {
  console.error(`❌ La app de clientes pesa ${kb(totalApp)} kB y el presupuesto son ${PRESUPUESTO_APP_KB} kB.`)
  console.error('   Mira qué entró antes de subir PRESUPUESTO_APP_KB, y explica en el commit por qué.')
  process.exit(1)
}
console.log(`✅ Dentro del presupuesto (quedan ${(PRESUPUESTO_APP_KB - totalApp / 1024).toFixed(1)} kB de margen).\n`)
