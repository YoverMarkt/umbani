#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// EL STAGING EN INTERNET — el mismo staging, pero en el móvil de cualquiera
// ═══════════════════════════════════════════════════════════════════════════
//
// Nació el 2026-10-01 por dos motivos: que el dueño revise los cambios en SU
// teléfono (el staging local solo se ve en el escritorio, en modo móvil) y que
// los desarrolladores de las apps Flutter tengan un servidor de pruebas —
// nunca se desarrolla contra producción.
//
//   npm run staging:remoto -w @botpanel/server -- preparar   vacía y siembra su base
//   npm run staging:remoto -w @botpanel/server -- subir      despliega ESTA carpeta
//   npm run staging:remoto -w @botpanel/server -- humo       la prueba de humo, contra él
//
// Base: un proyecto de Supabase en una organización GRATIS (se duerme a los 7
// días sin uso; se despierta desde su panel). Servidor: un PROYECTO de Railway
// aparte («umbani-staging»), nunca un entorno dentro del de producción. Cuesta
// ~3 USD/mes (aprobado por el dueño).
//
// Las credenciales viven en `server/.env.staging-remoto` (ignorado por git) y
// en las variables del entorno «staging» de Railway. NUNCA en este archivo.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const servidor = path.resolve(aqui, '..')
const raiz = path.resolve(servidor, '..')
const ARCHIVO = path.join(servidor, '.env.staging-remoto')

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

const config = leerEnv(ARCHIVO)
const exigir = (clave) => {
  const valor = config[clave] || process.env[clave]
  if (!valor) {
    console.error(`\n❌ Falta ${clave} en server/.env.staging-remoto\n`)
    process.exit(1)
  }
  return valor
}

const LOCALES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]'])

// ── LA GUARDIA: esto VACÍA una base. Jamás la de producción. ──────────────────
//
// Tres comprobaciones, y cualquiera basta para negarse:
//   1. la dirección no es local (para eso está `staging.mjs`);
//   2. la dirección no es la de producción (la de `server/.env`);
//   3. la base, si tiene datos, está MARCADA como staging.
// La 3 es la que de verdad protege: aunque la 2 fallara por un cambio de
// formato en las URLs de Supabase, la base de producción tiene locales y no
// lleva la marca, así que no se toca.
function guardia(url) {
  let destino
  try {
    destino = new URL(url)
  } catch {
    console.error('\n❌ STAGING_REMOTO_DB_URL no es una dirección válida\n')
    process.exit(1)
  }
  if (LOCALES.has(destino.hostname)) {
    console.error('\n❌ Esa base es LOCAL: para esa está `npm run staging:preparar`\n')
    process.exit(1)
  }
  const produccion = leerEnv(path.join(servidor, '.env'))
  const refDeProduccion = (() => {
    try {
      return new URL(produccion.SUPABASE_URL || '').hostname.split('.')[0]
    } catch {
      return ''
    }
  })()
  const huellaDe = (u) => {
    try {
      const x = new URL(u)
      return `${decodeURIComponent(x.username)}@${x.hostname}:${x.port}${x.pathname}`
    } catch {
      return ''
    }
  }
  if ((refDeProduccion && url.includes(refDeProduccion))
      || (produccion.DATABASE_URL && huellaDe(produccion.DATABASE_URL) === huellaDe(url))) {
    console.error('\n❌ ESA ES LA BASE DE PRODUCCIÓN. No se toca.\n')
    process.exit(1)
  }
}

const hayPsql = (() => {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/** Corre SQL contra la base REMOTA: con `psql` si está, si no con un contenedor. */
const crearEjecutor = url => (args, entrada) => execFileSync(
  hayPsql ? 'psql' : 'docker',
  hayPsql
    ? [url, '-v', 'ON_ERROR_STOP=1', ...args]
    : ['run', '--rm', '-i', 'pgvector/pgvector:pg17', 'psql', url, '-v', 'ON_ERROR_STOP=1', ...args],
  { input: entrada, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 },
)

async function preparar() {
  const url = exigir('STAGING_REMOTO_DB_URL')
  const clave = exigir('STAGING_REMOTO_DUENO_CLAVE')
  guardia(url)
  const ejecutar = crearEjecutor(url)

  // La comprobación 3: si hay datos, tienen que ser de staging.
  let estado = ''
  try {
    estado = ejecutar(['-tAc', `select coalesce((select value from server_settings where key = 'entorno'), '')
                                  || '|' || (select count(*) from businesses)`]).trim()
  } catch {
    estado = 'vacia|0' // sin tablas todavía: base recién creada
  }
  const [marca, negocios] = estado.split('|')
  if (marca !== 'staging' && Number(negocios) > 0) {
    console.error(`\n❌ Esa base tiene ${negocios} negocio(s) y NO está marcada como staging. No se toca.\n`)
    process.exit(1)
  }

  console.log('\n🌍 STAGING EN INTERNET: vaciando y sembrando su base…')
  const staging = await import('./staging.mjs')
  staging.preparar({ ejecutar, claveDelDueno: clave, esperar: () => {} })
  console.log('   El dueño de pruebas entra con demo@umbani.local y la clave de server/.env.staging-remoto\n')
}

function correr(comando, args, extra = {}) {
  const hijo = spawn(comando, args, { cwd: raiz, stdio: 'inherit', ...extra })
  hijo.on('exit', codigo => process.exit(codigo ?? 0))
}

/**
 * Despliega ESTA carpeta (la rama que se está revisando) al staging.
 *
 * ⚠️ A un PROYECTO de Railway aparte, nunca a un entorno dentro del de
 * producción, y siempre nombrándolo: la carpeta está enlazada al proyecto de
 * PRODUCCIÓN (lo usan `railway status` y `railway run`), así que un `railway up`
 * sin `--project` desplegaría ahí. Y un entorno duplicado de producción nacería
 * con sus variables: una segunda producción procesando los pedidos de verdad.
 */
function subir() {
  const proyecto = exigir('STAGING_REMOTO_RAILWAY_PROYECTO')
  const produccion = (() => {
    try {
      return JSON.parse(execFileSync('npx', ['-y', '@railway/cli@latest', 'status', '--json'], {
        cwd: raiz, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      })).id
    } catch {
      return null
    }
  })()
  if (produccion && produccion === proyecto) {
    console.error('\n❌ STAGING_REMOTO_RAILWAY_PROYECTO es el proyecto de PRODUCCIÓN. No se despliega ahí.\n')
    process.exit(1)
  }
  // `--ci`: sigue el build hasta el final y devuelve error si falla.
  correr('npx', ['-y', '@railway/cli@latest', 'up', '--project', proyecto,
    '--environment', config.STAGING_REMOTO_RAILWAY_ENTORNO || 'production', '--service', 'web', '--ci'])
}

/** La misma prueba de humo de producción, contra el staging en internet. */
function humo() {
  const url = exigir('STAGING_REMOTO_URL')
  correr('node', [path.join(aqui, 'humo-produccion.mjs'), url], {
    cwd: servidor,
    env: {
      ...process.env,
      SMOKE_URL: url,
      JWT_SECRET: exigir('STAGING_REMOTO_JWT_SECRET'),
      ADMIN_EMAIL: exigir('STAGING_REMOTO_ADMIN_EMAIL'),
    },
  })
}

const comandos = { preparar, subir, humo }
const comando = process.argv[2]
if (!comandos[comando]) {
  console.error('\n❌ Usa: preparar | subir | humo\n')
  process.exit(1)
}
await comandos[comando]()
