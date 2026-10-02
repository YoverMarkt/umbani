// ═══════════════════════════════════════════════════════════════════════════
// EL ESCENARIO DE LOS RECORRIDOS: BASE DE VERDAD, SERVIDOR DE VERDAD
// ═══════════════════════════════════════════════════════════════════════════
//
// Todo lo demás prueba piezas: Vitest prueba rutas y servicios con la base
// simulada, `verify:schema` ejecuta las funciones SQL una a una. Ninguna
// recorre un pedido ENTERO como lo vive la gente —el cliente pide y paga, el
// local acepta, prepara y entrega, el dinero se reparte y se liquida el lunes—
// con el servidor hablando con la base por HTTP, que es como corre en
// producción. Un fallo en la COSTURA entre dos piezas probadas no lo ve nadie.
//
// Este archivo monta el escenario una sola vez para todos los recorridos:
//
//   1. la base: el Supabase local del staging, vaciado y sembrado con el MISMO
//      `preparar()` del staging (que llama a la plantilla real del alta);
//   2. los proveedores falsos (PayPhone, WhatsApp), porque un recorrido que
//      cobra o escribe de verdad no es una prueba;
//   3. el servidor compilado, con `interceptor.cjs` delante para que no pueda
//      salir a internet aunque quiera.
//
// ⚠️ VACÍA EL STAGING LOCAL. Los datos de mentira que hubiera se pierden; vuelve
// a sembrarlos `npm run staging:preparar -w @botpanel/server`.

import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { crearProveedoresFalsos } from './proveedores-falsos.mjs'

const aqui = path.dirname(fileURLToPath(import.meta.url))
const servidorDir = path.resolve(aqui, '../..')

export const SLUG = 'demo'
export const DUENO = { email: 'demo@umbani.local', clave: 'staging-demo-2026' }
const PUERTO = process.env.RECORRIDOS_PORT || '3199'

/**
 * Lo que el staging NO trae y un recorrido necesita.
 *
 * ⚠️ El reloj de la liquidación: el corte real es el lunes 2026-09-28 y la
 * semana solo se cierra cuando TERMINÓ. Para liquidar hoy sin esperar al lunes,
 * los recorridos llevan sus pedidos a una semana pasada (`reloj.llevarA…`) y el
 * corte se adelanta aquí, en la base de la prueba y en ninguna otra.
 */
const SEMILLA_DE_RECORRIDOS = `
create or replace function public.liquidacion_semanal_desde()
returns date
language sql
stable
set search_path = public, pg_temp
as $$
  select date '2026-01-05'
$$;

-- La tarjeta, en pruebas: el servidor arranca con PAYPHONE_MODO=pruebas.
update businesses set card_mode = 'pruebas' where slug = '${SLUG}';

-- Lo demás (abierto siempre, los tres cobros, la cuenta, el número falso de
-- Umbani, el repartidor) ya lo pone la siembra común del staging.
`

async function esperarSalud(base, hijo) {
  const limite = Date.now() + 90_000
  while (Date.now() < limite) {
    if (hijo.exitCode !== null) throw new Error(`El servidor se cayó al arrancar (código ${hijo.exitCode})`)
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return
    } catch {
      // Todavía no escucha.
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('El servidor no contestó /api/health en 90 s')
}

export default async function montarEscenario({ provide }) {
  // Se importa aquí y no arriba: el módulo del staging se niega a cargar si la
  // base no es LOCAL, y esa guardia tiene que correr antes que nada.
  const staging = await import('../staging.mjs')

  const entorno = staging.entornoDeStaging()
  console.log('\n🧭 [recorridos] Sembrando el staging local desde cero…')
  staging.preparar()
  staging.psql(['-q'], SEMILLA_DE_RECORRIDOS)

  const falsos = crearProveedoresFalsos()
  const urlFalso = await falsos.escuchar()

  const base = `http://localhost:${PUERTO}`
  const registro = path.join(os.tmpdir(), 'umbani-recorridos-servidor.log')
  const salida = createWriteStream(registro, { flags: 'w' })
  const hijo = spawn(process.execPath, [
    '--require', path.join(aqui, 'interceptor.cjs'),
    path.join(servidorDir, 'dist/index.js'),
  ], {
    cwd: servidorDir,
    env: {
      ...entorno,
      PORT: PUERTO,
      BASE_URL: base,
      PAYPHONE_TOKEN: 'token-falso-de-los-recorridos',
      PAYPHONE_MODO: 'pruebas',
      RECORRIDOS_PROVEEDOR_FALSO: urlFalso,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  hijo.stdout.pipe(salida)
  hijo.stderr.pipe(salida)

  try {
    await esperarSalud(base, hijo)
  } catch (error) {
    hijo.kill('SIGKILL')
    await falsos.cerrar()
    throw new Error(`${error.message}. Registro del servidor: ${registro}`)
  }
  console.log(`🧭 [recorridos] Servidor en ${base} · registro: ${registro}\n`)

  provide('base', base)
  provide('falso', urlFalso)
  provide('jwtSecret', entorno.JWT_SECRET)
  provide('adminEmail', entorno.ADMIN_EMAIL)
  provide('slug', SLUG)
  provide('dueno', DUENO)
  provide('registro', registro)

  return async function desmontar() {
    hijo.kill('SIGTERM')
    await new Promise(resolve => {
      const corte = setTimeout(() => { hijo.kill('SIGKILL'); resolve() }, 5000)
      hijo.once('exit', () => { clearTimeout(corte); resolve() })
    })
    await falsos.cerrar()
  }
}
