#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// ERRORES RESUELTOS — que lo arreglado desaparezca del registro
// ═══════════════════════════════════════════════════════════════════════════
//
// El dueño (2026-09-27): «la idea es que si el agente capta errores y me los
// muestra, cuando se hagan cambios o mejoras se solucionen y desaparezcan; no
// que queden mucho tiempo, porque pensaré que algo está mal».
//
// El registro de errores guarda 30 días. Sin esto, un error ya arreglado
// seguía en la pantalla de Errores un mes —y el vigía de atención avisando por
// él un día entero—, así que era imposible distinguir lo pendiente de lo
// resuelto.
//
// ⚠️ Si el error VUELVE, reaparece solo: `record_platform_error` crea la fila
// otra vez. Borrar es marcar «resuelto», no esconder.
//
// ⚠️ Nunca borra una fila que se repitió DESPUÉS de `--hasta` (por defecto,
// ahora). Pásale la hora del despliegue del arreglo: si el error siguió
// ocurriendo con el arreglo ya en producción, no estaba arreglado, y esa fila
// se queda a la vista.
//
//   npm run errores -w @botpanel/server                          -- ver el registro
//   npm run errores -w @botpanel/server -- inbox_poll canario_x  -- qué borraría
//   npm run errores -w @botpanel/server -- inbox_poll --hasta=2026-09-27T15:00Z --borrar
//
// Es una herramienta de mano, como `migrate`: no corre en el CI ni en el
// servidor.
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Qué filas se borran: las de esos códigos EXACTOS vistas por última vez
 * hasta `hasta`. Pura, para poder probarla sin base.
 */
export function filasResueltas(filas, codigos, hasta) {
  const limite = new Date(hasta).getTime()
  if (!Number.isFinite(limite)) throw new Error(`--hasta no es una fecha: ${hasta}`)
  const buscados = new Set(codigos)
  return filas.filter(fila => buscados.has(fila.code)
    && new Date(fila.last_seen_at).getTime() <= limite)
}

const pintar = fila => `   ${fila.last_seen_at.slice(0, 16).replace('T', ' ')}  `
  + `[${fila.category}] ${fila.code || 'sin código'} ×${fila.occurrences} — ${fila.message.slice(0, 70)}`

async function main(argumentos) {
  const borrar = argumentos.includes('--borrar')
  const hasta = (argumentos.find(a => a.startsWith('--hasta=')) || '').slice('--hasta='.length)
    || new Date().toISOString()
  const codigos = argumentos.filter(a => !a.startsWith('--'))

  const url = process.env.SUPABASE_URL
  const clave = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
  if (!url || !clave) throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY')
  const db = createClient(url, clave, { auth: { persistSession: false } })

  const { data, error } = await db.from('platform_errors')
    .select('id, category, code, message, occurrences, last_seen_at')
    .order('last_seen_at', { ascending: false })
  if (error) throw new Error(error.message)

  if (!codigos.length) {
    console.log(`📋 Registro de errores (${data.length} fila(s)):\n`)
    for (const fila of data) console.log(pintar(fila))
    console.log('\n   Para retirar lo ya arreglado: pasa sus códigos y --hasta=<hora del despliegue>.')
    return
  }

  const resueltas = filasResueltas(data, codigos, hasta)
  const siguen = data.filter(f => codigos.includes(f.code) && !resueltas.includes(f))
  console.log(`🧹 ${resueltas.length} fila(s) resuelta(s) hasta ${hasta}:\n`)
  for (const fila of resueltas) console.log(pintar(fila))
  if (siguen.length) {
    console.log('\n⚠️  Se repitieron DESPUÉS de esa hora — NO están arregladas, se quedan:\n')
    for (const fila of siguen) console.log(pintar(fila))
  }
  if (!borrar) {
    console.log('\n   (solo se muestra; añade --borrar para retirarlas)')
    return
  }
  if (!resueltas.length) return
  const { error: fallo } = await db.from('platform_errors')
    .delete()
    .in('id', resueltas.map(f => f.id))
  if (fallo) throw new Error(fallo.message)
  console.log(`\n✅ Retiradas. Si alguna vuelve a ocurrir, reaparecerá sola.`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`❌ ${error.message}`)
    process.exit(1)
  })
}
