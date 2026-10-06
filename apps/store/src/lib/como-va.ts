// ── CÓMO VA, DICHO PARA QUIEN COMPRÓ ──────────────────────────────────────
//
// Las pastillas de «Mis pedidos». Vivían en `screens/Account.tsx`; se mudaron
// aquí sin cambiar una (2026-10-05) para que la app de clientes (`/u`) diga lo
// mismo que la tienda — dos listas acabarían diciendo cosas distintas.
//
// ⚠️ En su PROPIO archivo, no en `estado.ts`: aquel lo carga la tienda de
// entrada, y estas etiquetas solo las usa «Mis pedidos», que viaja aparte. En
// `estado.ts` sumaban ~0,3 kB a la primera carga de quien abre una tienda.
//
// ⚠️ Sin `dark:`. El ámbar llevaba `dark:text-amber-400` de un modo oscuro que
// esta app no tiene —`color-scheme: light` fijo—, pero la media query SÍ se
// dispara con el teléfono en oscuro: era amber-400 sobre tarjeta blanca.
export const PILL_ACTIVO = 'acento shadow-acento'
export const PILL_ATENCION = 'bg-amber-50 text-amber-700'
export const PILL_QUIETO = 'bg-black/5 texto-cuerpo'

/** Los doce estados internos, dichos como los entiende quien compró. */
export const COMO_VA: Record<string, { texto: string; tono: string }> = {
  esperando_pago: { texto: 'Falta tu pago', tono: PILL_ATENCION },
  pago_en_revision: { texto: 'Revisando tu pago', tono: PILL_QUIETO },
  pendiente: { texto: 'Recibido', tono: PILL_QUIETO },
  confirmado: { texto: 'En preparación', tono: PILL_ACTIVO },
  aceptado: { texto: 'En preparación', tono: PILL_ACTIVO },
  preparacion: { texto: 'En preparación', tono: PILL_ACTIVO },
  listo_para_retiro: { texto: 'Listo para retirar', tono: PILL_ACTIVO },
  en_camino: { texto: 'En camino', tono: PILL_ACTIVO },
  completado: { texto: 'Entregado', tono: PILL_QUIETO },
  cancelado: { texto: 'Cancelado', tono: PILL_QUIETO },
  rechazado: { texto: 'Rechazado', tono: PILL_QUIETO },
  expirado: { texto: 'Expirado', tono: PILL_QUIETO },
}
