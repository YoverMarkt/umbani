/**
 * El correo como se guarda —minúsculas, sin espacios—, o `null` si no lo
 * parece (2026-10-06).
 *
 * Lo usan las cuentas de las apps y el alta de los repartidores: «Ana@Correo.com»
 * y «ana@correo.com » son la misma persona, y guardados distinto serían dos.
 * La base exige la misma forma (`customers_email_check`, `couriers_email_check`).
 */
export function correoNormalizado(texto: unknown): string | null {
  const correo = String(texto ?? '').trim().toLowerCase()
  if (correo.length < 6 || correo.length > 254) return null
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(correo) ? correo : null
}
