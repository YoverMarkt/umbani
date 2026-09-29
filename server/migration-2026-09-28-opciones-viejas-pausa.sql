-- ============================================================================
-- TOCAR OPCIONES VIEJAS TIENE CONSECUENCIA: ADVERTENCIA, Y LUEGO 5 MINUTOS
--
-- Lo pidió el dueño el 2026-09-28, probando el número de Umbani. Tocó
-- «Hamburguesas» en una lista vieja, recibió el aviso «Esa opción era de un
-- mensaje anterior», y volvió a tocar «Hamburguesas» en OTRA lista vieja: el
-- anti-eco calló el segundo aviso, idéntico al de hacía segundos, y el
-- «escribiendo…» se quedó colgado sin respuesta. Parecía que el bot se había
-- roto.
--
-- Su decisión: la regla de Luka se queda SIEMPRE —solo vale el último
-- mensaje—, pero saltársela tiene que tener consecuencia:
--
--   · 1.er toque viejo → advertencia: «si vuelves a tocar una vieja, no
--     podrás pedir durante 5 minutos», con las opciones vigentes.
--   · 2.º toque viejo (con la advertencia aún vigente, 30 min) → 5 minutos sin
--     menú. Un solo aviso con la hora de vuelta y después silencio. MENÚ no
--     la levanta; el comprobante de un pedido ya hecho sí se atiende.
--
-- Dos columnas en la conversación:
--
--   · `stale_tap_warned_at`: cuándo se le advirtió. Se anota DESPUÉS de mandar
--     la advertencia —como la huella de #420—: si el envío falla y el webhook
--     reintenta, el reintento no puede pausar a alguien que nunca vio el
--     aviso.
--   · `menu_paused_until`: hasta cuándo no se le atiende el menú.
--
-- ⚠️ Van FUERA del bloqueo optimista, como `menu_mark`: `version` solo la sube
-- `advance_marketplace_conversation`. Advertir o pausar no cambia en qué paso
-- del menú está el cliente, y si subiera la versión, el siguiente `guardar`
-- del mismo turno chocaría consigo mismo.
--
-- ⚠️ Los permisos no cambian: `service_role` tiene los de la TABLA entera
-- (select, insert, update, delete), que alcanzan a las columnas nuevas.
--
-- Solo añade columnas nulas: el código que no las conoce sigue igual.
-- ============================================================================

alter table public.marketplace_conversations
  add column if not exists stale_tap_warned_at timestamptz,
  add column if not exists menu_paused_until timestamptz;

comment on column public.marketplace_conversations.stale_tap_warned_at is
  'Cuándo se le advirtió por tocar una opción vieja. Otro toque viejo dentro de 30 min pausa el menú.';
comment on column public.marketplace_conversations.menu_paused_until is
  'Hasta cuándo no se atiende el menú, por tocar opciones viejas tras la advertencia. El comprobante sí.';
