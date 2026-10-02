// ═══════════════════════════════════════════════════════════════════════════
// LAS CREDENCIALES DE PAYPHONE, Y EN QUÉ MODO COBRA ESTE SERVIDOR
// ═══════════════════════════════════════════════════════════════════════════
//
// ⚠️ SOLO VARIABLES DE ENTORNO (Railway), nunca `server_settings` ni el panel.
// No es por costumbre: el token de PayPhone decide A QUÉ CUENTA va el dinero
// de cada tarjeta. Si se pudiera cambiar desde el superadmin, quien entrara a
// esa pantalla pondría el token de SU cuenta y se quedaría con los cobros sin
// tocar una línea de código. Y un respaldo de la base filtrado no lo lleva.
//
// ⚠️ FALLA CERRADO. Sin el token y el modo, o con un modo que no sea
// exactamente `pruebas` o `produccion`, no hay tarjeta: el método no se
// ofrece y ningún cobro arranca. El modo NO tiene valor por defecto a
// propósito — adivinar «pruebas» dejaría producción aprobando pagos sin
// cobrar; adivinar «produccion» cobraría de verdad creyendo probar.

import { esStaging } from './environment'

export type ModoPayphone = 'pruebas' | 'produccion'

export interface ConfiguracionPayphone {
  token: string
  /**
   * OPCIONAL (2026-09-27). PayPhone lo marca opcional al preparar el cobro:
   * sin él usa la tienda por defecto del token. Con el «Identificador» de la
   * pestaña Credenciales respondió «La tienda asociada no existe» (error 100):
   * ese campo no es el Store ID. Vacío = no se envía.
   */
  storeId: string | null
  modo: ModoPayphone
}

export const VARIABLES_PAYPHONE = {
  token: 'PAYPHONE_TOKEN',
  storeId: 'PAYPHONE_STORE_ID',
  modo: 'PAYPHONE_MODO',
} as const

export function leerConfiguracionPayphone(
  env: Record<string, string | undefined> = process.env,
): ConfiguracionPayphone | null {
  const token = String(env[VARIABLES_PAYPHONE.token] || '').trim()
  const storeId = String(env[VARIABLES_PAYPHONE.storeId] || '').trim()
  const modo = String(env[VARIABLES_PAYPHONE.modo] || '').trim().toLowerCase()
  if (!token) return null
  if (modo !== 'pruebas' && modo !== 'produccion') return null
  // ⚠️ UN STAGING NUNCA COBRA DE VERDAD (2026-10-01). Las credenciales de
  // pruebas y de producción de PayPhone son las mismas —el modo es lo único que
  // cambia—, así que copiar las variables de producción al staging bastaría
  // para cobrar tarjetas reales sobre pedidos de mentira. Sin tarjeta, antes
  // que eso.
  if (modo === 'produccion' && esStaging(env as NodeJS.ProcessEnv)) return null
  return { token, storeId: storeId || null, modo }
}

/**
 * Lo que se puede enseñar de la configuración: si está y en qué modo. Jamás
 * el token ni el Store ID.
 */
export function estadoDePayphone(
  env: Record<string, string | undefined> = process.env,
): { configurado: boolean; modo: ModoPayphone | null } {
  const config = leerConfiguracionPayphone(env)
  return { configurado: config !== null, modo: config?.modo ?? null }
}
