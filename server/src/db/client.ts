import { createClient } from '@supabase/supabase-js'
import type { Database } from './tipos-generados'
import dotenv from 'dotenv'
import path from 'node:path'
import { exigirBaseLocalEnPruebas } from '../lib/solo-base-local-en-pruebas'

dotenv.config({ path: path.join(__dirname, '../../.env') })

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY

if (!url || !key) {
  throw new Error('Faltan SUPABASE_URL y SUPABASE_SERVICE_KEY en el servidor')
}

// Bajo Vitest, solo una base local: lanzadas desde la raíz, las pruebas
// cargaban `server/.env` y escribían en PRODUCCIÓN (2026-09-20).
exigirBaseLocalEnPruebas(url)

/**
 * Cuánto se espera a una llamada a la base antes de darla por colgada.
 *
 * ⚠️ ESTO NACE DE UN INCIDENTE REAL (2026-08-23) y es la causa raíz de que el
 * marketplace se quedara mudo durante horas.
 *
 * `createClient(url, key)` a secas usa el `fetch` global de Node, y **el fetch
 * de Node NO TIENE TIEMPO LÍMITE**. Una conexión que se queda colgada se queda
 * colgada: no falla, no vuelve, no hace nada. Espera para siempre.
 *
 * Lo que pasó: `complete_webhook_event` —cerrar un mensaje ya procesado— se
 * colgaba en la capa HTTP entre Railway y Supabase. Ni una consulta lenta en
 * `pg_stat_activity`, ni un bloqueo: la petición **no llegaba a PostgreSQL**.
 * A los ~110 s el borde de Cloudflare que hay delante de Supabase cortaba con
 * «upstream request timeout» — 100 s de su límite más el viaje.
 *
 * Ese cuelgue costaba carísimo: el evento se quedaba reservado, la cola es
 * FIFO por conversación, y **todos los mensajes siguientes de ese cliente se
 * quedaban esperando**. Al reintentarlo se reprocesaba y el cliente recibía la
 * misma respuesta cada tres minutos, en bucle.
 *
 * ⚠️ Con límite, un cuelgue se convierte en un error normal a los 30 s, que es
 * algo que el código YA sabe manejar: se registra, se reintenta, se recupera.
 *
 * ⚠️ Treinta segundos y no tres: hay consultas legítimamente pesadas —reportes,
 * embeddings, el cierre de mes— y cortarlas sería cambiar un fallo por otro.
 * Lo medido en el camino caliente son ~180 ms, así que 30 s solo actúa cuando
 * algo va de verdad mal.
 *
 * ⚠️ Abortar no garantiza que la operación no se hiciera: la petición pudo
 * llegar a PostgreSQL y confirmarse justo cuando cortamos. No es un riesgo
 * nuevo —un corte de red hace lo mismo— pero por eso quien reintente tiene que
 * ser idempotente. Las RPC de la cola lo son: llevan el `lease_token`.
 */
const TIMEOUT_MS = (() => {
  const crudo = Number(process.env.SUPABASE_TIMEOUT_MS)
  return Number.isFinite(crudo) && crudo >= 1_000 && crudo <= 120_000
    ? crudo
    : 30_000
})()

/**
 * `fetch` con tiempo límite, respetando la señal que traiga quien llame.
 *
 * `AbortSignal.any` combina las dos: si el llamador ya cancela por su cuenta,
 * su señal sigue funcionando; si no, manda la nuestra.
 */
const fetchConLimite: typeof fetch = (entrada, opciones) => {
  const propia = AbortSignal.timeout(TIMEOUT_MS)
  const ajena = opciones?.signal
  return fetch(entrada, {
    ...opciones,
    signal: ajena ? AbortSignal.any([ajena, propia]) : propia,
  })
}

// Cliente único del backend. La service role nunca se exporta al navegador.
// ⚠️ EL TIPO `Database` ES LO QUE HACE QUE ESTO SE COMPRUEBE.
//
// Sin él, `sb.from('lo_que_sea').select('columna_inventada')` compila
// perfectamente y falla en producción. Con él, la base deja de ser un `any`
// con buenos modales: una columna renombrada o una RPC con otro argumento
// rompen el build aquí, que es donde cuesta barato.
//
// Ver `db/tipos-generados.ts` — se regenera con `npm run tipos:generar`.
const supabase = createClient<Database>(url, key, {
  global: { fetch: fetchConLimite },
})

export = supabase
