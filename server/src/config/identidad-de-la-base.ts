// ═══════════════════════════════════════════════════════════════════════════
// EL CANDADO DE LA BASE: STAGING Y PRODUCCIÓN NO SE CRUZAN NUNCA
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde el 2026-10-01 hay un staging en INTERNET: el mismo servidor, en Railway,
// con su propia base de datos de mentira. Y eso abre dos errores de una sola
// variable mal copiada, los dos carísimos:
//
//   · un STAGING apuntando a la base de PRODUCCIÓN: sus tareas de fondo
//     procesarían los mensajes de los clientes de verdad, expirarían sus pedidos
//     y cerrarían su semana… dos veces, porque producción hace lo mismo;
//   · PRODUCCIÓN apuntando a la base del STAGING: los clientes pedirían sobre
//     locales inventados y nadie les atendería.
//
// Ninguno de los dos se nota mirando las variables —son URLs y claves largas—,
// así que no se le pregunta a quien despliega: se le pregunta a la BASE. La de
// staging lleva una marca (`server_settings.entorno = 'staging'`, la pone su
// semilla) y la de producción no. Antes de abrir el puerto, el servidor
// comprueba que la marca y su `UMBANI_ENTORNO` coinciden, y si no, NO ARRANCA.
//
// ⚠️ La marca vive FUERA de `ALLOWED_KEYS` (`services/settings.ts`): ninguna
// pantalla puede escribirla. Si se pudiera, cualquiera con sesión de
// superadmin podría marcar la base de producción como staging y tumbarla en el
// siguiente despliegue.

export const MARCA_DE_STAGING = 'staging'

export type IdentidadDeLaBase = { ok: true } | { ok: false; motivo: string }

export async function comprobarIdentidadDeLaBase(input: {
  /** ¿Este proceso es staging? (`esStaging(process.env)`) */
  staging: boolean
  /** Lo que la base dice de sí misma. LANZA si no responde. */
  leerMarca: () => Promise<string | null>
}): Promise<IdentidadDeLaBase> {
  let marca: string | null
  try {
    marca = await input.leerMarca()
  } catch (error) {
    // ⚠️ Asimétrico a propósito. Un staging que no puede comprobar su base no
    // arranca: equivocarse hacia ese lado cuesta un staging parado. Producción
    // SÍ arranca: con la base caída ya falla todo lo demás, y negarse aquí solo
    // convertiría un tropiezo de la red al desplegar en una caída entera.
    if (!input.staging) return { ok: true }
    const detalle = error instanceof Error ? error.message : String(error)
    return {
      ok: false,
      motivo: `STAGING sin poder comprobar que su base es de staging (${detalle.slice(0, 160)}). No arranca: podría estar apuntando a producción.`,
    }
  }

  const esDeStaging = String(marca || '').trim().toLowerCase() === MARCA_DE_STAGING
  if (input.staging && !esDeStaging) {
    return {
      ok: false,
      motivo: 'Este servidor es STAGING y su base NO está marcada como staging: podría ser la de PRODUCCIÓN. '
        + 'No arranca. Si es tu staging local, vuelve a sembrarlo: npm run staging:reset',
    }
  }
  if (!input.staging && esDeStaging) {
    return {
      ok: false,
      motivo: 'Este servidor es PRODUCCIÓN y su base está marcada como STAGING (datos de mentira). '
        + 'No arranca: revisa SUPABASE_URL y SUPABASE_SERVICE_KEY en Railway.',
    }
  }
  return { ok: true }
}
