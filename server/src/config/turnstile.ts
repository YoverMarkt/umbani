// ═══════════════════════════════════════════════════════════════════════════
// EL CAPTCHA INVISIBLE AL PEDIR EL CÓDIGO (Cloudflare Turnstile, 2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Pedir un código por correo es la puerta que un bot puede martillar: cada
// petición manda un correo (cuesta, y quema la reputación del remitente) y
// llena el buzón de quien sea. Los topes por IP, por correo y el global
// (`services/entrar-con-correo.ts`) lo frenan; Turnstile lo PARA, porque un
// bot no consigue la ficha que da el widget a una persona.
//
// ⚠️ APAGADO hasta que existan las dos claves. Se crean en Cloudflare el día
// del dominio (DOMINIO.md §2.8) y van SOLO a las variables de Railway:
//   TURNSTILE_SITE_KEY      la clave de sitio (pública: la ve la app)
//   TURNSTILE_SECRET_KEY    el secreto (nunca sale del servidor)
// Sin ellas, la app no pinta nada y el servidor no pide ficha: todo sigue
// como hoy. Con una sola, producción NO arranca (`environment.ts`): pedir la
// ficha sin poder darla dejaría a todo el mundo fuera.
//
// ⚠️ Cloudflare publica claves de PRUEBA que pasan (o fallan) siempre
// (`1x0000…AA`): el staging las usa para que este camino corra de verdad. En
// producción `environment.ts` las rechaza: no protegerían nada.

export interface ConfiguracionTurnstile {
  claveDeSitio: string
  secreto: string
}

/** Las de prueba de Cloudflare: `1x`, `2x` o `3x`, ceros y dos letras. Las de verdad empiezan por `0x`. */
export const esClaveDePruebasDeTurnstile = (clave: string | undefined): boolean =>
  /^[1-3]x0+[a-z]{2}$/i.test(String(clave ?? '').trim())

export function leerConfiguracionTurnstile(env: NodeJS.ProcessEnv = process.env): ConfiguracionTurnstile | null {
  const claveDeSitio = String(env.TURNSTILE_SITE_KEY ?? '').trim()
  const secreto = String(env.TURNSTILE_SECRET_KEY ?? '').trim()
  return claveDeSitio && secreto ? { claveDeSitio, secreto } : null
}
