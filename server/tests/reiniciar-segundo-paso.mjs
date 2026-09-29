#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════════
// REINICIAR EL SEGUNDO PASO DEL SUPERADMIN — para cuando se pierde el móvil
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde el 2026-09-29 el superadmin entra con contraseña Y el código de su app
// de códigos. Si se pierde el móvil, la puerta queda cerrada también para el
// dueño. Esto borra la clave: en el siguiente inicio de sesión, tras la
// contraseña, el panel vuelve a enseñar «configura tu app de códigos».
//
//   npm run admin:reiniciar-codigos -w @botpanel/server              -- qué hay
//   npm run admin:reiniciar-codigos -w @botpanel/server -- --borrar  -- borrarla
//
// ⚠️ Solo corre donde está `server/.env` —el ordenador del dueño—, igual que
// `migrate` o `errores`: no es una ruta del servidor, y a propósito. Si lo
// fuera, cualquiera con la contraseña podría saltarse el segundo paso.
//
// ⚠️ Después de reiniciar, configúralo EN SEGUIDA: mientras no haya clave, el
// primero que entre con la contraseña es quien elige la app de códigos.
import { createClient } from '@supabase/supabase-js'

const CLAVES = ['admin_totp_secret', 'admin_totp_pending', 'admin_totp_last_step']

const url = process.env.SUPABASE_URL
const clave = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
if (!url || !clave) {
  console.error('❌ Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en server/.env')
  process.exit(1)
}
const db = createClient(url, clave, { auth: { persistSession: false } })

const { data, error } = await db.from('server_settings').select('key, updated_at').in('key', CLAVES)
if (error) {
  console.error(`❌ No se pudo leer: ${error.message}`)
  process.exit(1)
}
const activa = data.find(f => f.key === 'admin_totp_secret')
console.log(activa
  ? `🔐 El segundo paso está configurado desde ${activa.updated_at.slice(0, 16).replace('T', ' ')} UTC.`
  : '🔓 El segundo paso NO está configurado: el próximo inicio de sesión pedirá configurarlo.')

if (!process.argv.includes('--borrar')) {
  if (activa) console.log('\n   Para reiniciarlo (móvil perdido):  … -- --borrar')
  process.exit(0)
}

const { error: fallo } = await db.from('server_settings').delete().in('key', CLAVES)
if (fallo) {
  console.error(`❌ No se pudo borrar: ${fallo.message}`)
  process.exit(1)
}
console.log('\n✅ Reiniciado. Entra YA al superadmin y configura tu app de códigos:')
console.log('   hasta que lo hagas, la contraseña sola decide quién la configura.')
