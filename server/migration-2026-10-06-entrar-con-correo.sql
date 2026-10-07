-- ============================================================================
-- ENTRAR A LAS APPS CON CORREO (2026-10-06)
--
-- Decisión del dueño: las apps (`/u` clientes, `/r` repartidores, y las de
-- Flutter) dejan de entrar por WhatsApp. Se entra con el CORREO: la app pide
-- un código de 6 dígitos, llega por correo, y quien lo escribe prueba que el
-- correo es suyo.
--
-- ⚠️ LO QUE NO CAMBIA, y es a propósito. La frontera de quién es dueño de un
-- pedido sigue siendo el TELÉFONO (`orders.contact_phone`): «Mis pedidos», el
-- detalle, los reclamos y la tienda filtran por él, y el dinero no se toca.
-- Para que eso siga siendo seguro sin WhatsApp, un número solo puede ser de UNA
-- persona: la cuenta lo reclama en exclusiva (el índice único que ya existe en
-- `customers.phone`), y el servidor lo rechaza si ya hay otra persona o pedidos
-- con él. Una cuenta de correo nace SIN teléfono y lo pone antes de pedir.
--
-- ⚠️ Sin `business_id`, como `app_login_codes`: la cuenta es de la
-- PLATAFORMA. Nadie la lee salvo el servidor.
-- ============================================================================

-- ── 1. La persona puede probarse con un correo, no solo con un teléfono ─────
alter table public.customers alter column phone drop not null;
alter table public.customers add column if not exists email text;

alter table public.customers drop constraint if exists customers_email_check;
alter table public.customers add constraint customers_email_check check (
  email is null or (
    email = lower(btrim(email))
    and char_length(email) between 6 and 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);

-- Una persona sin teléfono y sin correo no es nadie: no se podría reconocer.
alter table public.customers drop constraint if exists customers_identidad_check;
alter table public.customers add constraint customers_identidad_check check (
  phone is not null or email is not null
);

create unique index if not exists uq_customers_email on public.customers (email);

comment on column public.customers.email is
  'El correo con el que entra a las apps (2026-10-06). Lo prueba un código de un solo uso.';

-- ── 2. El repartidor entra con el correo con el que lo registraron ──────────
-- Lo escriben el local, la cooperativa o Umbani al darlo de alta: es la
-- fuente de confianza, como hasta hoy su teléfono.
alter table public.couriers add column if not exists email text;

alter table public.couriers drop constraint if exists couriers_email_check;
alter table public.couriers add constraint couriers_email_check check (
  email is null or (
    email = lower(btrim(email))
    and char_length(email) between 6 and 254
    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
  )
);

create unique index if not exists couriers_email_unico on public.couriers (email);

-- ── 3. Los códigos que llegan por correo ─────────────────────────────────────
-- ⚠️ Se guarda la HUELLA del código (HMAC con el secreto del servidor), nunca
-- el código: con la base filtrada no se podría entrar, y sin el secreto no se
-- pueden probar el millón de combinaciones fuera de línea.
create table if not exists public.app_email_codes (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  code_hash  text not null,
  -- Cada intento fallido gasta uno; con cinco, el código ya no vale.
  attempts   integer not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz,

  constraint app_email_codes_datos_check check (
    email = lower(btrim(email))
    and char_length(email) between 6 and 254
    and code_hash ~ '^[0-9a-f]{64}$'
    and attempts between 0 and 5
    and expires_at > created_at
  )
);

alter table public.app_email_codes enable row level security;
revoke all on table public.app_email_codes from anon, authenticated;

-- El código vigente de un correo, y cuántos pidió en la última hora.
create index if not exists idx_app_email_codes_correo on public.app_email_codes (email, created_at desc);

comment on table public.app_email_codes is
  'Códigos de inicio de sesión de las apps que llegan por correo (2026-10-06). Se guarda su huella, no el código.';

-- ── 4. Los pedidos de una persona, en todos los locales ───────────────────────
-- «Mis pedidos» de la app y la comprobación de «ese número ya es de alguien»
-- buscan por el teléfono SIN local; el índice de siempre empieza por el local
-- y no les sirve.
create index if not exists idx_orders_contact_phone on public.orders (contact_phone);
