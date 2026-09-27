-- ============================================================================
-- EL CHAT SOLO OBEDECE AL ÚLTIMO MENSAJE, Y NO REPITE LA MISMA RESPUESTA
--
-- Lo encontró el dueño en producción (2026-09-26), probando el número de
-- Umbani:
--
--   · Estando en «Panaderías», tocó «🛒 Minimarkets» en una LISTA VIEJA de más
--     arriba. Cada opción viajaba solo con su número de fila, y el servidor lo
--     aplicaba a lo que el cliente tenía delante AHORA: «3» no era ninguna
--     opción de Panaderías, así que el bot BUSCÓ el texto «3» y enseñó una
--     heladería y una taquería. Después tocó «🥤 Jugos y batidos», también
--     vieja, y su número cayó en Monster Pizza: le entregó la carta de otro
--     local.
--   · Mandó tres fotos seguidas y recibió tres respuestas idénticas. Con
--     veinte, veinte — y desde el 1 de octubre cada respuesta se paga.
--
-- Dos columnas lo resuelven, las dos en la conversación:
--
--   · `menu_mark`: la marca de la ÚLTIMA lista enviada. Viaja dentro del id de
--     cada opción («k3f9a.2»). Si llega la marca de otra lista, el toque es de
--     un mensaje anterior: no se ejecuta, se avisa y se enseñan las opciones
--     vigentes. Es lo que hace el chat de Luka (pagos de servicios, Bolivia),
--     que el dueño puso de referencia.
--   · `last_reply_hash` + `last_reply_at`: la huella de la última respuesta y
--     cuándo salió. La misma respuesta al mismo cliente dentro de 60 segundos
--     no se vuelve a mandar.
--
-- ⚠️ Van FUERA del bloqueo optimista. `version` solo la sube
-- `advance_marketplace_conversation`, y estas columnas se escriben aparte: una
-- lista enviada no es un cambio de estado de la conversación, y si subiera la
-- versión, el siguiente `guardar` del mismo turno chocaría consigo mismo.
--
-- Solo añade columnas nulas: el código que no las conoce sigue igual.
-- ============================================================================

alter table public.marketplace_conversations
  add column if not exists menu_mark text,
  add column if not exists last_reply_hash text,
  add column if not exists last_reply_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'marketplace_conversations_menu_mark_check'
  ) then
    alter table public.marketplace_conversations
      add constraint marketplace_conversations_menu_mark_check
      check (menu_mark is null or menu_mark ~ '^[a-z0-9]{4,10}$');
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'marketplace_conversations_last_reply_hash_check'
  ) then
    alter table public.marketplace_conversations
      add constraint marketplace_conversations_last_reply_hash_check
      check (last_reply_hash is null or last_reply_hash ~ '^[0-9a-f]{16,64}$');
  end if;
end $$;

comment on column public.marketplace_conversations.menu_mark is
  'Marca de la última lista enviada. Un toque con otra marca es de un mensaje anterior y no se ejecuta.';
comment on column public.marketplace_conversations.last_reply_hash is
  'Huella de la última respuesta enviada: la misma dentro de 60 s no se repite.';
