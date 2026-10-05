import { createClient } from '@supabase/supabase-js'
import path from 'node:path'
import { exigirBaseLocalEnPruebas } from '../lib/solo-base-local-en-pruebas'
import { conActorEnLaCabecera } from '../lib/actor-de-la-peticion'

require('dotenv').config({ path: path.join(__dirname, '../../.env') })

// Bajo Vitest, solo una base local: este es el SEGUNDO cliente del servidor, y
// sin la guarda aquí también, las pruebas lanzadas desde la raíz leerían los
// ajustes de PRODUCCIÓN. Ver `lib/solo-base-local-en-pruebas`.
exigirBaseLocalEnPruebas(process.env.SUPABASE_URL)

// ⚠️ Con el actor en la cabecera (2026-09-29): cambiar la tarifa de servicio o
// la comisión de PayPhone desde Ajustes queda en el registro de dinero con el
// nombre de quien lo hizo. Ver `lib/actor-de-la-peticion.ts`.
const supabase = createClient(
  process.env.SUPABASE_URL as string,
  (process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY) as string,
  { global: { fetch: conActorEnLaCabecera(fetch) } },
)

export const ALLOWED_KEYS = [
  'anthropic_api_key',
  'openai_api_key',
  'gemini_api_key',
  'groq_api_key',
  'deepseek_api_key',
  'ai_provider',
  'telegram_bot_token',
  'cloudinary_cloud_name',
  'cloudinary_api_key',
  'cloudinary_api_secret',
  // ── El número de la plataforma (Umbani) ──────────────────────────────
  // Con un solo número para todo el marketplace, estas credenciales NO
  // pueden vivir en la ficha de un negocio: el número no es de ningún
  // local. Guardarlo en uno obligaría a elegir a dedo un negocio
  // «portador», y el enrutado dependería de a cuál se mire primero —
  // que es justo lo que `businesses_marketplace_sin_canal_check`
  // prohíbe desde el 2026-08-20.
  //
  // ⚠️ `platform_webhook_secret` es lo que valida la firma de un mensaje
  // que llega SIN negocio que resolver. Sin él, ese camino no tendría con
  // qué comprobar la firma, y aceptar sin comprobar convertiría el webhook
  // en un buzón abierto.
  'platform_ycloud_api_key',
  'platform_ycloud_number',
  'platform_webhook_secret',
  'platform_webhook_endpoint_id',
  // ⚠️ Aquí vivía `marketplace_menu_max_productos`, el umbral de la «regla de
  // los 20», que decidía si un local se pedía por el chat o por la mini app.
  // Se retiró el 2026-08-23 en favor del TIPO del local, y ese criterio también
  // se fue: desde el 2026-09-16 TODO local pide por su mini app y no hay nada
  // que decidir. Contar productos mandaba una pizzería de 17 al chat, donde
  // pedirla es tamaño, masa, borde y dos sabores.
  // ── El análisis de comprobantes ───────────────────────────────────────
  //
  // ⚠️ `receipt_analysis_enabled` NACE APAGADO, y es deliberado. El análisis
  // es lo único de la plataforma que puede negarle algo a un cliente que YA
  // pagó («esa foto no parece un comprobante»). Fusionar despliega producción
  // sola, así que encenderlo con el merge convertiría al primer cliente real
  // en el conejillo de indias, de madrugada y sin nadie mirando. Lo enciende
  // el dueño desde Ajustes cuando pueda observar qué hace — y lo apaga en
  // cinco segundos si no le convence, sin esperar un despliegue.
  'receipt_analysis_enabled',
  // Los puntos de cada señal, en UNA clave JSON en vez de una por regla: así
  // añadir una señal mañana no obliga a tocar esta lista ni a desplegar. Lo
  // que no venga —o venga roto— cae a los valores por defecto del código.
  'receipt_risk_rules',
  // ── El dinero de Umbani (2026-09-28) ────────────────────────────────
  // La tarifa de servicio por pedido (USD, «0.25»). La lee la BASE
  // (`tarifa_de_servicio()`), que es la que cobra; nace sin valor = apagada.
  'service_fee',
  // Lo que cobra PayPhone, en puntos básicos (575 = 5,75 %). Solo sirve
  // para enseñarle a Umbani lo que le queda; se negocia con PayPhone.
  'payphone_fee_bps',
] as const

type AllowedKey = typeof ALLOWED_KEYS[number]
type SettingsRecord = Partial<Record<AllowedKey, string | null>>

let cache: SettingsRecord = {}
let cacheAt = 0
const CACHE_TTL = 60_000

async function loadAll(): Promise<SettingsRecord> {
  if (Date.now() - cacheAt < CACHE_TTL) return cache
  const { data, error } = await supabase.from('server_settings').select('key, value')
  if (error) throw new Error(error.message)

  const loaded: SettingsRecord = {}
  for (const row of data || []) {
    if (ALLOWED_KEYS.includes(row.key as AllowedKey)) {
      loaded[row.key as AllowedKey] = row.value
    }
  }
  cache = loaded
  cacheAt = Date.now()
  return cache
}

export async function get(key: AllowedKey): Promise<string | null> {
  const all = await loadAll()
  return all[key] || process.env[key.toUpperCase()] || null
}

export async function setMany(pairs: Record<string, unknown>): Promise<void> {
  const rows = Object.entries(pairs)
    .filter(([key]) => ALLOWED_KEYS.includes(key as AllowedKey))
    .map(([key, value]) => ({
      key,
      value: typeof value === 'string' && value ? value : null,
      updated_at: new Date().toISOString(),
    }))

  if (!rows.length) return
  const { error } = await supabase
    .from('server_settings')
    .upsert(rows, { onConflict: 'key' })
  if (error) throw new Error(error.message)
  cacheAt = 0
}

export async function getAll(): Promise<SettingsRecord> {
  return loadAll()
}
