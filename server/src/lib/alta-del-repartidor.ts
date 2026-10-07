// ═══════════════════════════════════════════════════════════════════════════
// EL CORREO EN EL ALTA DE UN REPARTIDOR (2026-10-06)
// ═══════════════════════════════════════════════════════════════════════════
//
// Desde que las apps no entran por WhatsApp, el repartidor entra a la suya con
// el CORREO que escribe quien lo da de alta: el local, la cooperativa o el
// superadmin. Los tres sitios piden y responden lo mismo; por eso vive aquí.

/** Lo que se le dice a quien da de alta si falta el correo o no lo parece. */
export const ERROR_SIN_CORREO = 'Escribe su correo: con él entra a la app de repartidor'
export const MENSAJE_CORREO_REPETIDO = 'Ese correo ya es de otro repartidor'

/** Si la base rechazó el alta por un dato repetido, cuál fue; `null` si fue otra cosa. */
export function datoRepetido(error: unknown): 'correo' | 'telefono' | null {
  const { code, message } = (error || {}) as { code?: string; message?: string }
  if (code !== '23505') return null
  return String(message || '').includes('couriers_email_unico') ? 'correo' : 'telefono'
}
