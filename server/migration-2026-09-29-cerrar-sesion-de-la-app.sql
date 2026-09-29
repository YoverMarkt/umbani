-- ============================================================================
-- «CERRAR SESIÓN» DESDE WHATSAPP: LA APP DEJA DE VALER AL INSTANTE
--
-- Tercer PR del bloque de seguridad (2026-09-29). El login de la app de Umbani
-- lo prueba WhatsApp: la app enseña un código y el cliente lo manda desde SU
-- número. Es seguro contra quien no tiene el teléfono… y abierto a la estafa
-- de siempre: «te llegó un código, mándamelo». Quien lo consigue abre la app
-- con el número de otro, y su sesión dura 30 días sin forma de cortarla,
-- porque el token no se consultaba en ninguna parte.
--
-- Ahora el mensaje de «iniciaste sesión» dice cómo cortarlo —escribir CERRAR
-- SESIÓN—, y esta columna es la fecha de corte: un token de la app emitido
-- ANTES de ella ya no abre nada (`authApp`, `services/sesion-app.ts`).
--
-- Solo añade una columna nula: el código que no la conoce sigue igual, y
-- mientras esté vacía todas las sesiones valen como hasta hoy.
-- ============================================================================

alter table public.customers
  add column if not exists app_sessions_valid_after timestamptz;

comment on column public.customers.app_sessions_valid_after is
  'Las sesiones de la app emitidas antes de esta fecha ya no valen. La pone CERRAR SESIÓN desde WhatsApp.';
