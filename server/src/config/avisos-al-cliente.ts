// ═══════════════════════════════════════════════════════════════════════════
// ¿SE LE ESCRIBE AL CLIENTE POR WHATSAPP? NO (2026-10-09)
// ═══════════════════════════════════════════════════════════════════════════
//
// Decisión del dueño: Umbani es SOLO APP. El cliente sigue su pedido dentro de
// la app y sube allí el comprobante; las notificaciones push vendrán después.
// Ya no le llega nada por WhatsApp: ni los avisos de estado (en preparación,
// en camino, entregado…) ni el «mándanos el comprobante».
//
// Se apaga AQUÍ y en ningún otro sitio. Los dos avisos preguntan ANTES de
// reclamar o encolar nada —así no queda trabajo que la cola reintente seis
// veces y apunte como fallo—, y la cola cierra sin enviar lo que hubiera
// quedado pendiente de antes.
//
// El código de los avisos sigue entero (WhatsApp queda en espera): se vuelve a
// encender con `AVISOS_WHATSAPP_AL_CLIENTE=si` en las variables de Railway.
// ⚠️ Los avisos al DUEÑO del local (`owner-order-notice.ts`) no pasan por aquí.

export const avisaAlClientePorWhatsApp = (env: NodeJS.ProcessEnv = process.env): boolean =>
  String(env.AVISOS_WHATSAPP_AL_CLIENTE ?? '').trim().toLowerCase() === 'si'
