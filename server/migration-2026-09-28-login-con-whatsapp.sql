-- ============================================================================
-- INICIAR SESIÓN EN LA APP CON WHATSAPP
--
-- Para las apps de Flutter (cliente y, después, motorizado). En vez de un SMS
-- o una plantilla de Meta (que cuesta y hay que aprobar), la app enseña un
-- código y un botón que abre WhatsApp con el mensaje «Mi código de Umbani:
-- XXXXXX» ya escrito hacia el número de Umbani. Al llegar, el bot sabe DE QUÉ
-- NÚMERO vino —eso lo garantiza WhatsApp, no el usuario— y lo deja verificado.
-- La app pregunta y recibe su sesión.
--
--   · Gratis: el mensaje lo inicia el cliente, así que abre la ventana de 24 h.
--   · El teléfono lo prueba WhatsApp, no un código leído en voz alta.
--   · Un código vale 10 minutos y se usa UNA vez.
--
-- ⚠️ Sin `business_id` a propósito: la cuenta del cliente es de la PLATAFORMA,
-- como `marketplace_conversations`. Nadie la lee salvo el servidor.
-- ============================================================================

create table if not exists public.app_login_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null,
  -- Lo escribe el bot al recibir el mensaje: es el remitente de WhatsApp.
  phone       text,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  verified_at timestamptz,
  used_at     timestamptz,

  constraint app_login_codes_code_check check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  constraint app_login_codes_phone_check check (phone is null or phone ~ '^\+?[0-9]{8,15}$'),
  -- Verificado implica teléfono; usado implica verificado.
  constraint app_login_codes_orden_check check (
    (verified_at is null or phone is not null) and (used_at is null or verified_at is not null)
  )
);

alter table public.app_login_codes enable row level security;
revoke all on table public.app_login_codes from anon, authenticated;

create unique index if not exists app_login_codes_code_unico on public.app_login_codes (code);
create index if not exists idx_app_login_codes_expira on public.app_login_codes (expires_at);

comment on table public.app_login_codes is
  'Códigos de inicio de sesión de las apps: el cliente los manda por WhatsApp y el remitente prueba su teléfono.';
