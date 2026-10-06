// ═══════════════════════════════════════════════════════════════════════════
// EL TELÉFONO DE UN REPARTIDOR, COMO LO VERÁ WHATSAPP (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// El repartidor entra a su app con el código que MANDA por WhatsApp, y el
// servidor lo reconoce por el número del remitente. Si se registró escrito de
// otra forma, nunca coincide y ve «este número no es de un repartidor».
//
// ⚠️ Pasaba con dos formas normales de escribir un celular, y ninguna prueba
// lo veía porque el simulador del staging usa `000000000000`:
//   · «0991234567», como se escribe en Ecuador: WhatsApp dice 593991234567.
//   · «+593 99 123 4567»: se guardaba CON el «+», y YCloud manda el remitente
//     con «+» pero el registro del local lo dejaba sin él (o al revés).
//
// Se guarda en dígitos y con el código del país. La búsqueda acepta además
// el número con «+» (`getActiveCourierByPhone`), por los registrados antes.

/** El número en dígitos y con código de país, o `null` si no es un teléfono. */
export function telefonoDelRepartidor(texto: unknown): string | null {
  const digitos = String(texto ?? '').replace(/\D/g, '')
  // Un celular de Ecuador escrito a la manera local: 09 + 8 dígitos.
  if (/^09\d{8}$/.test(digitos)) return `593${digitos.slice(1)}`
  // Con el código del país Y el cero local («593 099…»): el cero sobra.
  if (/^5930\d{9}$/.test(digitos)) return `593${digitos.slice(4)}`
  return /^\d{8,15}$/.test(digitos) ? digitos : null
}
