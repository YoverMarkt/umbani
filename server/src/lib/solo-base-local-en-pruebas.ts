// ── LAS PRUEBAS SOLO HABLAN CON UNA BASE LOCAL ─────────────────────────────
//
// ⚠️ Nace del 2026-09-27. El registro de errores de PRODUCCIÓN tenía cinco
// fallos del 2026-09-20 —«crear el cliente», «suspender el cliente»,
// «bloqueo de plataforma»…, todos en el mismo minuto— que no eran de la app:
// eran los fallos SIMULADOS de las pruebas («detalle interno PostgreSQL»,
// «connection reset by peer»). El superadmin los veía como errores reales.
//
// Cómo llegaron: `vitest.config.ts` pone credenciales sintéticas, pero SOLO si
// Vitest se lanza desde `server/`. Lanzado desde la raíz del repositorio no
// hay configuración, las variables quedan vacías, y los dos clientes cargan
// `server/.env` —que apunta a PRODUCCIÓN— con dotenv. Cualquier prueba que
// dejara pasar una escritura sin simular la hacía en la base real.
//
// Con esto, bajo Vitest un cliente que apunte fuera de esta máquina no llega a
// crearse: la prueba revienta con un mensaje que dice cómo lanzarla bien.
// Falla CERRADO, que es lo único que sirve aquí: un aviso se lee tarde.

const HOSTS_LOCALES = new Set([
  '127.0.0.1',
  'localhost',
  '::1',
  '[::1]',
  // El staging local, visto desde un contenedor.
  'host.docker.internal',
])

/** ¿La URL es de una base de ESTA máquina? Una URL rota no lo es. */
export function esBaseLocal(url: string | undefined | null): boolean {
  try {
    return HOSTS_LOCALES.has(new URL(String(url)).hostname)
  } catch {
    return false
  }
}

/**
 * Revienta si corre bajo Vitest y la base NO es local.
 *
 * Fuera de las pruebas no hace nada: producción y staging usan su URL de
 * siempre.
 */
export function exigirBaseLocalEnPruebas(
  url: string | undefined | null,
  entorno: Record<string, string | undefined> = process.env,
): void {
  if (!entorno.VITEST) return
  if (esBaseLocal(url)) return
  throw new Error(
    '🛑 Las pruebas solo pueden conectarse a una base LOCAL, y esta apunta fuera '
    + 'de la máquina (¿server/.env, o sea PRODUCCIÓN?). Lánzalas desde el '
    + 'servidor —`npm test -w @botpanel/server` o `npx vitest` dentro de '
    + '`server/`—, donde vitest.config.ts pone credenciales sintéticas.',
  )
}
