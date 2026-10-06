import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ═══════════════════════════════════════════════════════════════════════════
// CONTRATO ENTRE LOS PANELES Y EL SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════
//
// Nace de la auditoría del 2026-08-02, que encontró un hueco estructural: si
// una ruta se renombra o se retira, NADIE se entera hasta que un cliente ve la
// pantalla en blanco.
//
//   · TypeScript no lo ve: los paneles declaran sus propios tipos y no
//     comparten nada con el servidor. Cada lado compila feliz por su cuenta.
//   · Los tests del servidor no lo ven: falsean la capa `db`, no el contrato.
//   · Los E2E no lo ven: interceptan `**/api/client/**` con `route.fulfill`,
//     así que el backend Node NUNCA arranca en Playwright.
//
// Este test cierra ese hueco por el lado que más duele y que se puede
// comprobar sin ambigüedad: **toda ruta que un panel llama tiene que existir
// en el servidor**.
//
// No es una lista mantenida a mano —eso sería otra sensación de cobertura—:
// los dos lados se LEEN. Las llamadas salen de `api<Tipo>('/ruta')` en los
// paneles; las rutas, de lo que declaran los routers del servidor. Se comprobó
// que esa lectura devuelve EXACTAMENTE lo mismo que montar los routers en un
// Express real —125 rutas y 125, sin diferencias— antes de confiar en ella.
// El porqué de no importarlos está más abajo, donde se leen.
//
// Lo que este test NO comprueba, a propósito: los campos de cada respuesta.
// Casi todas las rutas devuelven lo que les da `db` tal cual, así que
// falsear `db` para mirar la forma sería asegurarse de que el propio simulacro
// tiene los campos que se le pusieron. Eso no probaría nada.

const serverDir = fileURLToPath(new URL('..', import.meta.url))
const raiz = path.resolve(serverDir, '..')

/** `:id`, `:slug`… se vuelven `:_`: lo que importa es la FORMA de la ruta. */
const canonica = ruta => ruta.replace(/:[^/]+/g, ':_').replace(/\/+$/, '') || '/'

// ── Lado servidor: las rutas que declaran los routers ──────────────────────
//
// Se LEEN de `src/routes/*.ts` en vez de importar los módulos compilados, y no
// es por comodidad: cargar un router dentro de un test hunde la cobertura
// medida. Comprobado aislando la causa —requerir solo `admin.routes` en un
// archivo de prueba nuevo baja los statements del 70,11 % al 68,17 % sin que
// nadie deje de probar nada— porque al fusionar los perfiles de v8 entre
// workers, un módulo cargado en varios sitios no se une, se pisa.
//
// Leer el código fuente da la misma lista sin ese efecto. Funciona aquí
// porque TODOS los routers declaran rutas absolutas y se montan en la raíz
// (`app.use(ordersRouter)` en `src/index.ts`), así que no hay prefijos que
// resolver en tiempo de ejecución. Si algún día se montara con prefijo, el
// umbral mínimo de este test y su ruta conocida lo delatarían.
const METODOS = 'get|post|put|patch|delete'

const rutasDeArchivo = (contenido) => {
  const patron = new RegExp(
    String.raw`\brouter\.(${METODOS})\(\s*['"\`]([^'"\`]+)['"\`]`,
    'g',
  )
  return [...contenido.matchAll(patron)]
    .map(([, metodo, ruta]) => `${metodo.toUpperCase()} ${canonica(ruta)}`)
}

const DEL_SERVIDOR = new Set(
  readdirSync(path.join(serverDir, 'src/routes'))
    .filter(nombre => nombre.endsWith('.routes.ts'))
    .flatMap(nombre => rutasDeArchivo(
      readFileSync(path.join(serverDir, 'src/routes', nombre), 'utf8'),
    )),
)

// ── Lado panel: lo que los paneles llaman de verdad ────────────────────────

function archivos(dir) {
  return readdirSync(dir).flatMap((entrada) => {
    if (entrada === 'node_modules' || entrada === 'dist') return []
    const completa = path.join(dir, entrada)
    if (statSync(completa).isDirectory()) return archivos(completa)
    return /\.tsx?$/.test(entrada) ? [completa] : []
  })
}

/**
 * Normaliza la ruta escrita en el panel a la forma que declara el servidor.
 *
 * La regla que distingue los dos usos de `${…}` en estas plantillas:
 *
 *   · precedido de `/` es un PARÁMETRO      → `/sessions/${phone}/quote`
 *   · no precedido de `/` es un SUFIJO      → `/errors${category ? '?…' : ''}`
 *
 * El sufijo siempre construye la query, que el servidor no declara, así que se
 * corta ahí. Sin esta distinción salían falsos positivos como
 * `/api/admin/errors${category`, y un guardián ruidoso se acaba ignorando.
 */
function rutaDelPanel(crudo) {
  const sinQuery = crudo.split('?')[0]
  const sufijo = [...sinQuery.matchAll(/\$\{/g)]
    .find(m => sinQuery[m.index - 1] !== '/')
  const soloRuta = sufijo ? sinQuery.slice(0, sufijo.index) : sinQuery
  return canonica(soloRuta.replace(/\$\{[^}]*\}/g, ':_'))
}

/** Cada `api<Tipo>('/ruta', { method: 'PUT' })` de los paneles. */
const LLAMADAS = ['apps/client/src', 'apps/admin/src', 'apps/cooperativa/src'].flatMap((relativo) => {
  const base = path.join(raiz, relativo)
  return archivos(base).flatMap((archivo) => {
    const contenido = readFileSync(archivo, 'utf8')
    const encontradas = []
    const patron = /\bapi<[^>]*>\(\s*([`'"])([^`'"]*)\1([^)]*)/g
    let coincidencia
    while ((coincidencia = patron.exec(contenido)) !== null) {
      const [, , crudo, resto] = coincidencia
      const metodo = (resto.match(/method:\s*['"](\w+)['"]/) || [])[1] || 'GET'
      const ruta = rutaDelPanel(crudo)
      if (!ruta.startsWith('/api')) continue
      encontradas.push({
        llamada: `${metodo.toUpperCase()} ${ruta}`,
        archivo: path.relative(raiz, archivo),
      })
    }
    return encontradas
  })
})

describe('contrato entre los paneles y el servidor', () => {
  it('encuentra rutas en el servidor y llamadas en los paneles (si no, no probaría nada)', () => {
    // Sin esto el test podría quedarse verde para siempre comparando dos
    // listas vacías, que es la forma más silenciosa de dejar de proteger.
    //
    // El 100 sale de las 125 rutas medidas el 2026-08-02, cuando se comprobó
    // que este parseo devuelve EXACTAMENTE las mismas que montar los routers
    // en un Express real: 125 y 125, sin diferencias en ninguno de los dos
    // sentidos. El margen deja sitio a retirar alguna sin tocar el test.
    expect(DEL_SERVIDOR.size).toBeGreaterThan(100)
    expect(LLAMADAS.length).toBeGreaterThan(50)
    expect([...DEL_SERVIDOR]).toContain('GET /api/client/orders')
    expect([...DEL_SERVIDOR]).toContain('PUT /api/client/orders/:_/status')
  })

  it('toda ruta que un panel llama existe en el servidor', () => {
    const huerfanas = LLAMADAS
      .filter(({ llamada }) => !DEL_SERVIDOR.has(llamada))
      .map(({ llamada, archivo }) => `${llamada}  ← ${archivo}`)

    expect(
      [...new Set(huerfanas)],
      'El panel llama a rutas que el servidor no sirve. O se renombró la ruta '
      + 'sin tocar el panel, o el panel se adelantó al servidor.',
    ).toEqual([])
  })

  it('el guardián detecta una ruta que el servidor no sirve', () => {
    // Que el test corra no significa que vea. Se comprueba el detector mismo.
    const inventada = 'GET /api/client/esta-ruta-no-existe'
    expect(DEL_SERVIDOR.has(inventada)).toBe(false)
  })
})
