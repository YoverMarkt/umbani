-- ============================================================
-- BOTPANEL SAAS — Schema COMPLETO y ACTUALIZADO para Supabase
--
-- Refleja el estado REAL de la base de datos (consolidado).
-- SOLO para una base nueva y vacía. NO usar como upgrade de una base existente:
-- los CREATE TABLE IF NOT EXISTS no agregan columnas faltantes y algunas
-- secciones reemplazan funciones/contratos completos.
--
-- INSTRUCCIONES:
--   Supabase → tu proyecto → SQL Editor → New query → pega TODO → RUN
--
-- ⚠️ CÓMO LEER ESTE ARCHIVO — importante, y no es obvio:
--
-- Este archivo es la SUMA de todas las migraciones, en el orden en que se
-- aplicaron. Cada una se copia literalmente (hay guardianes que lo verifican),
-- así que una función puede aparecer definida VARIAS VECES: cada migración que
-- la tocó dejó su versión.
--
-- **Manda siempre la ÚLTIMA definición del archivo**, porque `create or replace`
-- pisa a la anterior. Las de más arriba se aplican y se descartan.
--
-- Si vienes a entender cómo funciona algo, busca la ÚLTIMA aparición:
--
--     grep -n "function public.nombre_de_la_funcion" server/schema.sql
--
-- Hoy le pasa a `create_business_onboarding` (4 veces: la migración inicial, la
-- de hospedaje, la de planes y la del tiempo de preparación; manda la CUARTA,
-- al final del archivo). Se intentó dejar solo una y
-- se revirtió: borrar las anteriores rompe la garantía de que una instalación
-- nueva acabe igual que una base existente, que es justo lo que evita la deriva.
--
-- Para comprobar que este archivo y la base real coinciden:
--     npm run verify:drift -w @botpanel/server
-- ============================================================

-- Extensión para búsqueda semántica (RAG)
create extension if not exists vector;
-- Operadores GiST usados para impedir reservas solapadas por negocio.
create extension if not exists btree_gist;

-- ── TABLA 1: Negocios (cada cliente del SaaS) ──────────────
create table if not exists businesses (
  id                  uuid primary key default gen_random_uuid(),
  slug                text unique not null,
  name                text not null,
  type                text,
  slogan              text,
  description         text,
  hours               text,
  address             text,
  phone               text,
  social              text,
  payment_methods     text,
  -- WhatsApp personal del dueño: solo este número puede pedir reportes por WhatsApp
  owner_phone         text,
  whatsapp_number     text unique,
  -- Proveedor de mensajería activo: 'ycloud' | 'meta' | 'telegram' | 'marketplace'
  whatsapp_provider   text default 'ycloud'
                      -- 'marketplace' = no tiene canal propio; lo atiende el
                      -- número de la plataforma (2026-08-20).
                      constraint businesses_whatsapp_provider_check check (
                        nullif(btrim(coalesce(whatsapp_provider, '')), '') is null
                        or btrim(whatsapp_provider) in ('ycloud', 'meta', 'telegram', 'marketplace')
                      ),
  -- YCloud
  ycloud_api_key      text,
  ycloud_number       text,
  ycloud_webhook_endpoint_id text
                      constraint businesses_ycloud_webhook_endpoint_id_check check (
                        ycloud_webhook_endpoint_id is null
                        or (
                          ycloud_webhook_endpoint_id = btrim(ycloud_webhook_endpoint_id)
                          and char_length(ycloud_webhook_endpoint_id) between 1 and 255
                          and ycloud_webhook_endpoint_id !~ '[[:cntrl:]]'
                        )
                      ),
  ycloud_webhook_secret text,
  -- Meta
  meta_token          text,
  meta_phone_id       text,
  -- Telegram (token propio del negocio, opcional)
  telegram_bot_token  text,
  -- Integraciones
  calcom_link         text,          -- OBSOLETO (Cal.com retirado); columna huérfana, no se usa
  ai_provider         text,          -- override de IA por negocio (opcional)
  -- Modo venta: true = el bot cierra pedidos (##PEDIDO## + total oficial) ·
  -- false = solo informativo (asesora y deriva al asesor si quieren comprar)
  takes_orders        boolean not null default true,
  -- Cómo se pide, y desde el 2026-09-16 hay UNA sola respuesta:
  --   'miniapp' → el enlace de la tienda es donde se pide
  --
  -- Hubo tres. 'ai' se fue el 2026-08-21 con la IA conversacional; 'menu' —la
  -- máquina de estados que conducía el pedido por chat— el 2026-09-16, cuando
  -- el dueño decidió que pedir por listas de WhatsApp no es la experiencia que
  -- quiere para nadie.
  --
  -- ⚠️ Un CHECK de un solo valor no es un adorno: es un cerrojo. Impide que un
  -- script, la API o código viejo vuelvan a escribir 'menu' y dejen a un
  -- negocio sin nadie que le conteste. Quitar el campo de la pantalla evita el
  -- error de dedo; solo esta guarda evita que entre por otra puerta.
  chat_mode           text not null default 'miniapp'
                      check (chat_mode in ('miniapp')),
  -- Negocio / facturación
  plan                text default 'basic',
  monthly_rate        numeric(10,2),
  plan_expires_at     timestamptz,
  active              boolean default true,
  bot_active          boolean default true,
  suspended           boolean default false,
  suspension_reason   text,
  notes               text,
  created_at          timestamptz default now()
);

-- 'marketplace' significa «lo atiende el número de la plataforma». Si además
-- guardara un teléfono suyo habría dos respuestas a «¿de quién es este número?»
-- y el enrutado dependería de cuál se mirara primero. El estado imposible se
-- prohíbe aquí, igual que en `option_groups_destino_check`.
alter table public.businesses
  drop constraint if exists businesses_marketplace_sin_canal_check;

alter table public.businesses
  add constraint businesses_marketplace_sin_canal_check check (
    btrim(coalesce(whatsapp_provider, '')) is distinct from 'marketplace'
    or (
      nullif(btrim(coalesce(whatsapp_number, '')), '') is null
      and nullif(btrim(coalesce(ycloud_number, '')), '') is null
      and nullif(btrim(coalesce(meta_phone_id, '')), '') is null
    )
  );

-- ── Identificadores exactos de canales externos ───────────
-- Tabla derivada de businesses. La clave no incluye business_id a propósito:
-- un endpoint exacto dentro del mismo proveedor solo puede tener un dueño.
begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

create table if not exists public.business_channel_identifiers (
  id                   uuid primary key default gen_random_uuid(),
  business_id          uuid not null
                       references public.businesses(id) on delete cascade,
  provider             text not null
                       check (provider in ('meta', 'ycloud')),
  identifier_type      text not null
                       check (identifier_type in ('phone', 'account_id')),
  canonical_identifier text not null,
  created_at           timestamptz not null default now(),
  constraint business_channel_identifiers_canonical_check check (
    (
      identifier_type = 'phone'
      and canonical_identifier ~ '^[1-9][0-9]{7,14}$'
    )
    or (
      identifier_type = 'account_id'
      and canonical_identifier = btrim(canonical_identifier)
      and char_length(canonical_identifier) between 1 and 255
      and canonical_identifier !~ '[[:cntrl:]]'
    )
  )
);

create unique index if not exists uq_business_channel_identifier
  on public.business_channel_identifiers(
    provider,
    identifier_type,
    canonical_identifier
  );
create unique index if not exists uq_business_channel_phone
  on public.business_channel_identifiers(canonical_identifier)
  where identifier_type = 'phone';
create index if not exists idx_business_channel_identifiers_business
  on public.business_channel_identifiers(business_id);

alter table public.business_channel_identifiers enable row level security;
revoke all on table public.business_channel_identifiers
  from public, anon, authenticated, service_role;
grant select on table public.business_channel_identifiers to service_role;

create or replace function public.normalize_business_channel_identifier(
  p_identifier_type text,
  p_value text
)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  v_value text := btrim(p_value);
  v_canonical text;
begin
  if v_value = '' then return null; end if;

  if p_identifier_type = 'phone' then
    if v_value !~ '^\+?[0-9 ().-]+$' then
      raise exception using
        errcode = '22023',
        message = 'El teléfono del canal contiene caracteres inválidos';
    end if;
    v_canonical := regexp_replace(v_value, '[+ ().-]', '', 'g');
    if v_canonical !~ '^[1-9][0-9]{7,14}$' then
      raise exception using
        errcode = '22023',
        message = 'El teléfono del canal debe usar formato E.164 con 8 a 15 dígitos';
    end if;
    return v_canonical;
  end if;

  if p_identifier_type = 'account_id' then
    if char_length(v_value) > 255 or v_value ~ '[[:cntrl:]]' then
      raise exception using
        errcode = '22023',
        message = 'El identificador de cuenta del canal es inválido';
    end if;
    return v_value;
  end if;

  raise exception using
    errcode = '22023',
    message = 'El tipo de identificador del canal es inválido';
end;
$$;

create or replace function public.refresh_business_channel_identifiers(
  p_business_id uuid
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_candidate record;
  v_existing_business_id uuid;
  v_phone_owner_business_id uuid;
  v_whatsapp_provider text;
  v_whatsapp_phone text;
  v_ycloud_phone text;
  v_meta_account_id text;
begin
  select * into v_business
  from public.businesses
  where id = p_business_id;

  if not found then
    delete from public.business_channel_identifiers
    where business_id = p_business_id;
    return;
  end if;

  v_whatsapp_provider := coalesce(
    nullif(btrim(coalesce(v_business.whatsapp_provider, '')), ''),
    'ycloud'
  );
  -- El negocio del marketplace no tiene canal propio: lo atiende el número de
  -- la plataforma. No se le crea ningún identificador —crearlo sería declarar
  -- que un teléfono le pertenece— y se sale antes de las validaciones que
  -- exigen credenciales, que para él no aplican.
  if v_whatsapp_provider = 'marketplace' then
    delete from public.business_channel_identifiers
    where business_id = p_business_id;
    return;
  end if;

  if v_whatsapp_provider not in ('meta', 'ycloud', 'telegram', 'marketplace') then
    raise exception using
      errcode = '22023',
      message = 'El proveedor WhatsApp configurado es inválido',
      detail = format(
        'business_id=%s provider=%s', p_business_id, v_whatsapp_provider
      );
  end if;

  -- Un proveedor activo sin su identificador autoritativo dejaría el webhook
  -- sin una forma segura de determinar el tenant. Se rechaza la configuración
  -- en vez de crear un mapeo parcial o recurrir a coincidencias aproximadas.
  if v_whatsapp_provider in ('meta', 'ycloud') then
    v_whatsapp_phone := public.normalize_business_channel_identifier(
      'phone', v_business.whatsapp_number
    );
  end if;
  if v_whatsapp_provider = 'ycloud' then
    v_ycloud_phone := public.normalize_business_channel_identifier(
      'phone', v_business.ycloud_number
    );
  end if;
  if v_whatsapp_provider = 'meta' then
    v_meta_account_id := public.normalize_business_channel_identifier(
      'account_id', v_business.meta_phone_id
    );
  end if;
  if v_whatsapp_provider = 'ycloud'
    and coalesce(v_ycloud_phone, v_whatsapp_phone) is null then
    raise exception using
      errcode = '22023',
      message = 'YCloud requiere un teléfono de canal válido',
      detail = format('business_id=%s provider=ycloud', p_business_id);
  elsif v_whatsapp_provider = 'meta'
    and v_meta_account_id is null then
    raise exception using
      errcode = '22023',
      message = 'Meta requiere un Phone ID válido',
      detail = format('business_id=%s provider=meta', p_business_id);
  end if;

  -- El borrado y las inserciones viven en la misma transacción que el cambio
  -- de businesses. Una colisión revierte todo y conserva el mapeo anterior.
  delete from public.business_channel_identifiers
  where business_id = p_business_id;

  for v_candidate in
    select distinct
      candidates.provider,
      candidates.identifier_type,
      candidates.canonical_identifier
    from (
      select
        v_whatsapp_provider as provider,
        'phone'::text as identifier_type,
        v_whatsapp_phone as canonical_identifier
      where v_whatsapp_provider in ('meta', 'ycloud')

      union all

      select
        'ycloud',
        'phone',
        v_ycloud_phone
      where v_whatsapp_provider = 'ycloud'

      union all

      select
        'meta',
        'account_id',
        v_meta_account_id
      where v_whatsapp_provider = 'meta'
    ) as candidates
    where candidates.canonical_identifier is not null
    order by
      candidates.identifier_type,
      candidates.canonical_identifier,
      candidates.provider
  loop
    if v_candidate.identifier_type = 'phone' then
      -- Un teléfono completo tiene un único dueño incluso durante un cambio de
      -- proveedor. El advisory lock cierra la carrera entre dos altas paralelas.
      perform pg_advisory_xact_lock(hashtextextended(
        'business-channel-phone:' || v_candidate.canonical_identifier,
        0
      ));
      v_phone_owner_business_id := null;
      select business_id into v_phone_owner_business_id
      from public.business_channel_identifiers
      where identifier_type = 'phone'
        and canonical_identifier = v_candidate.canonical_identifier
        and business_id <> p_business_id
      limit 1;

      if v_phone_owner_business_id is not null then
        raise exception using
          errcode = '23505',
          message = 'Un teléfono de canal ya pertenece a otro negocio',
          detail = format(
            'identifier=%s existing_business_id=%s requested_business_id=%s',
            v_candidate.canonical_identifier,
            v_phone_owner_business_id,
            p_business_id
          );
      end if;
    end if;

    v_existing_business_id := null;
    select business_id into v_existing_business_id
    from public.business_channel_identifiers
    where provider = v_candidate.provider
      and identifier_type = v_candidate.identifier_type
      and canonical_identifier = v_candidate.canonical_identifier;

    if v_existing_business_id is not null
      and v_existing_business_id <> p_business_id then
      raise exception using
        errcode = '23505',
        message = 'Un identificador de canal ya pertenece a otro negocio',
        detail = format(
          'provider=%s type=%s identifier=%s existing_business_id=%s requested_business_id=%s',
          v_candidate.provider,
          v_candidate.identifier_type,
          v_candidate.canonical_identifier,
          v_existing_business_id,
          p_business_id
        );
    end if;

    if v_existing_business_id is null then
      insert into public.business_channel_identifiers (
        business_id,
        provider,
        identifier_type,
        canonical_identifier
      ) values (
        p_business_id,
        v_candidate.provider,
        v_candidate.identifier_type,
        v_candidate.canonical_identifier
      );
    end if;
  end loop;
end;
$$;

create or replace function public.sync_business_channel_identifiers()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_business_channel_identifiers(new.id);
  return new;
end;
$$;

revoke all on function public.normalize_business_channel_identifier(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.refresh_business_channel_identifiers(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.sync_business_channel_identifiers()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_sync_business_channel_identifiers
  on public.businesses;
create trigger trg_sync_business_channel_identifiers
after insert or update of
  whatsapp_number,
  whatsapp_provider,
  ycloud_number,
  meta_phone_id
on public.businesses
for each row
execute function public.sync_business_channel_identifiers();

lock table public.businesses in share row exclusive mode;

do $$
declare
  v_business_id uuid;
begin
  for v_business_id in
    select id from public.businesses order by id
  loop
    perform public.refresh_business_channel_identifiers(v_business_id);
  end loop;
end;
$$;

commit;

-- ============================================================
-- MEDICIÓN DE CONSUMO MENSUAL POR NEGOCIO
-- Migración incremental: migration-consumo-planes.sql
-- ============================================================

begin;

create extension if not exists pgcrypto;

create table if not exists public.message_usage_migration_state (
  key          text primary key,
  completed_at timestamptz not null default now()
);

do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'monthly_contact_limit'
  ) and exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'businesses'
      and column_name = 'monthly_outbound_message_limit'
  ) then
    insert into public.message_usage_migration_state (key)
    values ('limits_v1')
    on conflict (key) do nothing;
  end if;
end;
$$;

alter table public.businesses
  add column if not exists monthly_contact_limit integer,
  add column if not exists monthly_outbound_message_limit integer;

do $$
begin
  if not exists (
    select 1 from public.message_usage_migration_state
    where key = 'limits_v1'
  ) then
    update public.businesses
    set monthly_contact_limit = coalesce(monthly_contact_limit, 50),
        monthly_outbound_message_limit =
          coalesce(monthly_outbound_message_limit, 250)
    where lower(coalesce(plan, 'basic')) in ('basic', 'micro', 'founder');

    insert into public.message_usage_migration_state (key)
    values ('limits_v1');
  end if;
end;
$$;

alter table public.businesses
  alter column monthly_contact_limit set default 50,
  alter column monthly_outbound_message_limit set default 250;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'businesses_monthly_contact_limit_check'
      and conrelid = 'public.businesses'::regclass
  ) then
    alter table public.businesses
      add constraint businesses_monthly_contact_limit_check
      check (
        monthly_contact_limit is null
        or monthly_contact_limit between 1 and 1000000
      );
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'businesses_monthly_outbound_limit_check'
      and conrelid = 'public.businesses'::regclass
  ) then
    alter table public.businesses
      add constraint businesses_monthly_outbound_limit_check
      check (
        monthly_outbound_message_limit is null
        or monthly_outbound_message_limit between 1 and 10000000
      );
  end if;
end;
$$;

create table if not exists public.message_usage_events (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null
                    references public.businesses(id) on delete cascade,
  provider          text not null
                    check (provider in ('meta', 'ycloud', 'telegram', 'legacy')),
  direction         text not null check (direction in ('inbound', 'outbound')),
  message_type      text not null
                    check (message_type in (
                      'text', 'image', 'video', 'audio', 'interactive', 'other'
                    )),
  contact_key_hash  text not null
                    check (contact_key_hash ~ '^[0-9a-f]{64}$'),
  source_kind       text not null
                    check (source_kind in ('webhook', 'send', 'history')),
  source_key        text not null
                    check (char_length(source_key) between 1 and 200),
  occurred_at       timestamptz not null default now(),
  created_at        timestamptz not null default now(),
  unique (business_id, source_key)
);

create index if not exists idx_message_usage_business_period
  on public.message_usage_events (business_id, occurred_at);
create index if not exists idx_message_usage_business_direction_period
  on public.message_usage_events (business_id, direction, occurred_at);
create index if not exists idx_message_usage_contact_period
  on public.message_usage_events (business_id, contact_key_hash, occurred_at);

-- El esquema consolidado se ejecuta sobre una base vacía: no hay historial
-- anterior que reconstruir. El marcador evita un backfill accidental futuro.
insert into public.message_usage_migration_state (key)
values ('conversation_history_v1')
on conflict (key) do nothing;

-- `extensions` va en el search_path porque digest() pertenece a pgcrypto, que en
-- Supabase vive en ese esquema. Sin él la función falla con
-- "function digest(text, unknown) does not exist" y tumba TODO el ingreso de
-- WhatsApp: el trigger revienta al insertar, enqueue_webhook_event falla y el
-- webhook responde 503 hasta que el proveedor deja de entregar.
create or replace function public.record_inbound_message_usage()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_message_type text;
  v_inbound_hash text;
begin
  -- Sin `business_id` el mensaje llegó al número de la PLATAFORMA y el
  -- cliente todavía no eligió local: no es consumo de ningún negocio, así
  -- que no se le cobra a nadie. Es la misma regla que el saliente, donde
  -- `recordOutboundUsage` con negocio nulo tampoco escribe.
  --
  -- ⚠️ Sin este corte, `message_usage_events.business_id not null` abortaba
  -- la inserción ENTERA en la cola: el mensaje del marketplace ni se
  -- encolaba. Solo aparece con datos — sobre una tabla vacía el trigger no
  -- llega a dispararse.
  if new.stream_key_hash is null or new.business_id is null then
    return new;
  end if;

  v_message_type := case new.payload #>> '{content,kind}'
    when 'text' then 'text'
    when 'image' then 'image'
    when 'audio' then 'audio'
    else 'other'
  end;
  v_inbound_hash := encode(digest(
    coalesce(nullif(new.payload ->> 'inboundId', ''), new.message_id_hash),
    'sha256'
  ), 'hex');

  insert into public.message_usage_events (
    business_id, provider, direction, message_type, contact_key_hash,
    source_kind, source_key, occurred_at
  ) values (
    new.business_id,
    new.provider,
    'inbound',
    v_message_type,
    new.stream_key_hash,
    'webhook',
    'inbound:' || new.provider || ':' || v_inbound_hash,
    new.received_at
  )
  on conflict (business_id, source_key) do nothing;

  return new;
end;
$$;

create or replace function public.get_admin_monthly_usage(
  p_month date default null
)
returns table (
  business_id uuid,
  period_start date,
  period_end date,
  active_contacts bigint,
  inbound_messages bigint,
  outbound_messages bigint,
  outbound_text_messages bigint,
  outbound_image_messages bigint,
  outbound_video_messages bigint,
  outbound_interactive_messages bigint,
  contact_limit integer,
  outbound_message_limit integer,
  contact_overage bigint,
  outbound_message_overage bigint,
  includes_history_estimate boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with bounds as (
    select
      date_trunc(
        'month',
        coalesce(p_month, (now() at time zone 'America/Guayaquil')::date)
      )::date as starts_on
  ),
  period_window as (
    select
      starts_on,
      (starts_on + interval '1 month')::date as ends_before,
      starts_on::timestamp at time zone 'America/Guayaquil' as starts_at,
      (starts_on + interval '1 month')::timestamp
        at time zone 'America/Guayaquil' as ends_at
    from bounds
  )
  select
    business.id,
    period_window.starts_on,
    period_window.ends_before - 1,
    count(distinct usage.contact_key_hash)
      filter (where usage.direction = 'inbound'),
    count(usage.id) filter (where usage.direction = 'inbound'),
    count(usage.id) filter (where usage.direction = 'outbound'),
    count(usage.id) filter (
      where usage.direction = 'outbound' and usage.message_type = 'text'
    ),
    count(usage.id) filter (
      where usage.direction = 'outbound' and usage.message_type = 'image'
    ),
    count(usage.id) filter (
      where usage.direction = 'outbound' and usage.message_type = 'video'
    ),
    count(usage.id) filter (
      where usage.direction = 'outbound'
        and usage.message_type = 'interactive'
    ),
    business.monthly_contact_limit,
    business.monthly_outbound_message_limit,
    case
      when business.monthly_contact_limit is null then 0
      else greatest(
        count(distinct usage.contact_key_hash)
          filter (where usage.direction = 'inbound')
          - business.monthly_contact_limit,
        0
      )
    end,
    case
      when business.monthly_outbound_message_limit is null then 0
      else greatest(
        count(usage.id) filter (where usage.direction = 'outbound')
          - business.monthly_outbound_message_limit,
        0
      )
    end,
    coalesce(
      bool_or(usage.source_kind = 'history')
        filter (where usage.id is not null),
      false
    )
  from public.businesses as business
  cross join period_window
  left join public.message_usage_events as usage
    on usage.business_id = business.id
   and usage.occurred_at >= period_window.starts_at
   and usage.occurred_at < period_window.ends_at
  group by
    business.id,
    business.created_at,
    business.monthly_contact_limit,
    business.monthly_outbound_message_limit,
    period_window.starts_on,
    period_window.ends_before
  order by business.created_at desc;
$$;

alter table public.message_usage_events enable row level security;
alter table public.message_usage_migration_state enable row level security;

revoke all on table public.message_usage_events
  from public, anon, authenticated;
grant select, insert on table public.message_usage_events to service_role;
revoke all on table public.message_usage_migration_state
  from public, anon, authenticated;

revoke all on function public.record_inbound_message_usage()
  from public, anon, authenticated;
revoke all on function public.get_admin_monthly_usage(date)
  from public, anon, authenticated;
grant execute on function public.get_admin_monthly_usage(date)
  to service_role;

commit;

-- ── TABLA 2: Usuarios del panel del cliente (dueño + empleados) ─
create table if not exists client_users (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  email         text unique not null,
  password_hash text not null,
  name          text,
  role          text not null default 'owner',   -- 'owner' | 'employee'
  permissions   jsonb default '[]',              -- secciones permitidas al empleado
  created_at    timestamptz default now()
);

-- ── TABLA 3: Productos / servicios de cada negocio ─────────
create table if not exists products (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  name            text not null,
  brand           text,
  price           numeric(10,2) not null,
  price_sale      numeric(10,2),
  stock           text default 'disponible'
                  check (stock in ('disponible','últimas unidades','agotado')),
  description     text,
  image_url       text,
  video_url       text,                 -- URL pública del video (Cloudinary)
  image_public_id text,                 -- id del archivo de imagen en Cloudinary (para borrarlo al reemplazar)
  video_public_id text,                 -- id del archivo de video en Cloudinary
  tags            text[] default '{}',
  external_sku    text,
  duration_minutes int,                 -- para negocios de servicios/citas
  embedding       vector(1536),         -- RAG (OpenAI text-embedding-3-small)
  active          boolean default true,
  updated_at      timestamptz default now(),
  created_at      timestamptz default now()
);

-- ── Modificadores de menú (sabores de pizza, salsas, extras) ──
-- Opción que el cliente elige ADEMÁS del producto sin cambiar el precio.
-- Agrupados por category_tag (la categoría del catálogo a la que aplican).
create table if not exists public.menu_modifiers (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  category_tag  text not null check (char_length(btrim(category_tag)) between 1 and 60),
  group_label   text not null default 'Opción' check (char_length(btrim(group_label)) between 1 and 60),
  name          text not null check (char_length(btrim(name)) between 1 and 120),
  description   text,
  sort          integer not null default 0,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_menu_modifiers_business_tag
  on public.menu_modifiers (business_id, category_tag);
create unique index if not exists uq_menu_modifiers_business_tag_name
  on public.menu_modifiers (business_id, category_tag, lower(name));

-- ── TABLA 4: RETIRADA ──────────────────────────────────────
--
-- `bot_policies` (saludo del dueño + envíos, devoluciones y descuentos) se
-- retiró el 2026-09-20. Sus cuatro campos los escribía el dueño en la pantalla
-- «Bienvenida» del panel y **no los leía NADIE**: ningún servicio del bot, del
-- marketplace ni de la tienda los consultaba. Cada local se presenta desde
-- Umbani, y el saludo del marketplace es otro y vive aparte.
--
-- ⚠️ El `insert into bot_policies` que hacía `create_business_onboarding` se
-- fue con ella: dejarlo habría roto el alta de TODO negocio nuevo, que es
-- justo el fallo que ya tumbó las altas el 2026-08-02.

-- ── TABLA 5: Historial de conversaciones ───────────────────
create table if not exists conversation_history (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  contact_phone   text not null,
  role            text check (role in ('user','assistant','owner')),
  content         text not null,
  created_at      timestamptz default now()
);

-- ── TABLA 6: Sesiones (modo manual / traspaso a humano) ────
create table if not exists conversation_sessions (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references businesses(id) on delete cascade,
  contact_phone   text not null,
  contact_name    text,
  manual_mode     boolean default false,
  unread_owner    boolean default false,
  last_message    text,
  last_message_at timestamptz default now(),
  closed_sale_at  timestamptz,                 -- corte de historial al cerrar una venta
  tags            jsonb default '[]'::jsonb,   -- ids de conversation_tags asignadas
  unique (business_id, contact_phone)
);

-- Etiquetas de conversación (el dueño crea las suyas): nombre + color
create table if not exists conversation_tags (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses(id) on delete cascade,
  name        text not null,
  color       text default '#2a78d6',
  created_at  timestamptz default now()
);
create index if not exists idx_conv_tags_biz on conversation_tags(business_id);

-- ── TABLA 7: Horario de atención del negocio ───────────────
-- Decide si la tienda acepta pedidos y si el bot atiende o dice que está
-- cerrado. Nació con la agenda de citas y sobrevivió a su retirada porque
-- nunca fue suya: `slot_duration` es lo único que queda de aquello.
create table if not exists business_schedule (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  day_of_week   int not null,           -- 0=Domingo … 6=Sábado
  open_time     time not null default '09:00',
  close_time    time not null default '18:00',
  -- «Abierto 24 horas» ese día. Manda sobre open_time/close_time, que se
  -- conservan para poder volver al horario anterior sin reescribirlo.
  -- NO sustituye a is_active: un día inactivo está cerrado aunque lleve la
  -- marca. Nació porque decir «24 horas» exigía escribir «00:00 – 23:59» y
  -- confiar en un truco que nadie deduce — y cuya lectura natural,
  -- «00:00 – 00:00», dejaba el local cerrado el día entero en silencio.
  is_24h        boolean not null default false,
  slot_duration int not null default 60,
  is_active     boolean default true,
  unique (business_id, day_of_week)
);

-- Toda empresa nace con un horario editable. El trigger también cubre altas
-- realizadas fuera del panel, evitando negocios sin configuración mínima.
create or replace function public.ensure_business_default_schedule()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (new.id, 0, '09:00', '18:00', 60, false),
    (new.id, 1, '09:00', '18:00', 60, true),
    (new.id, 2, '09:00', '18:00', 60, true),
    (new.id, 3, '09:00', '18:00', 60, true),
    (new.id, 4, '09:00', '18:00', 60, true),
    (new.id, 5, '09:00', '18:00', 60, true),
    (new.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;
  return new;
end;
$$;

revoke all on function public.ensure_business_default_schedule()
  from public, anon, authenticated;

drop trigger if exists businesses_default_schedule on public.businesses;
create trigger businesses_default_schedule
after insert on public.businesses
for each row execute function public.ensure_business_default_schedule();

-- ── TABLA 9: Facturación ───────────────────────────────────
create table if not exists billing (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  amount        numeric(10,2),
  currency      text default 'USD',
  period_start  date,
  period_end    date,
  status        text default 'pending'
                check (status in ('pending','paid','overdue')),
  paid_at       timestamptz,
  notes         text,
  created_at    timestamptz default now()
);

-- ── TABLA 10: Config global del SaaS (keys de IA, etc.) ────
-- NO es por negocio: es configuración del dueño del SaaS.
create table if not exists server_settings (
  key         text primary key,
  value       text,
  updated_at  timestamptz default now()
);

-- ── Registro de migraciones aplicadas ──────────────────────
-- NO es por negocio: es el libro de cuentas de la plataforma. Dice qué .sql
-- se aplicó y cuándo, y guarda su huella para que editar una migración ya
-- aplicada no pase inadvertido. Lo lleva `npm run migrate -w @botpanel/server`.
create table if not exists schema_migrations (
  name        text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now(),
  source      text not null default 'runner'
);
create index if not exists idx_schema_migrations_applied
  on schema_migrations(applied_at desc);

-- ── TABLA 11: Ventas (cabecera) — registro manual desde el panel ──
create table if not exists sales (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  contact_phone text,
  contact_name  text,
  -- Lo que pagó el CLIENTE. No cambia de significado: es lo que se compara con
  -- un comprobante.
  total         numeric(10,2) not null default 0,
  -- ── Las dos partes que NO son del local, congeladas al vender ────────────
  --
  -- Una venta es un hecho consumado: lo que se llevó la plataforma ESE día no
  -- puede cambiar porque mañana se edite una regla. Con las dos, la venta se
  -- audita sola —total = productos + carrera + comisión— y los reportes pueden
  -- enseñar SOLO lo del local sin unir con `orders` en cada consulta.
  --
  -- ⚠️ Los reportes leen `sales` en ocho cuentas distintas; una unión en cada
  -- una serían ocho oportunidades de olvidarse de una.
  shipping        numeric(10,2) not null default 0,  -- de quien entrega
  platform_markup numeric(10,2) not null default 0,  -- de la plataforma
  status        text not null default 'completada' check (status in ('completada','anulada')),
  source        text default 'manual',
  created_by    uuid references client_users(id) on delete set null,  -- vendedor que la registró
  -- NOT NULL desde 2026-09-19: una venta sin fecha se contaba en 1970 y
  -- desaparecía de los reportes sin un solo error. Ver la migración del día.
  sold_at       timestamptz not null default now(),
  created_at    timestamptz default now()
);

-- ── TABLA 12: Ítems de cada venta (detalle, alimenta reportes) ──
create table if not exists sale_items (
  id           uuid primary key default gen_random_uuid(),
  sale_id      uuid references sales(id)      on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete set null,
  product_name text not null,
  quantity     int not null default 1,
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  created_at   timestamptz default now()
);

-- ── TABLA 13: Consultas de productos (más consultados / abandonados) ──
create table if not exists product_consultations (
  id           uuid primary key default gen_random_uuid(),
  business_id  uuid not null references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete cascade,
  created_at   timestamptz default now()
);

-- ── TABLA 14: Huecos de IA (preguntas que el bot no pudo responder) ──
create table if not exists ai_gaps (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references businesses(id) on delete cascade,
  contact_phone text,            -- quién preguntó (contexto, opcional)
  question      text not null,   -- la pregunta que el bot no supo responder
  reason        text,            -- 'handoff' | 'uncertain'
  created_at    timestamptz default now()
);

-- ── TABLA 15: Pedidos del bot (total oficial calculado por CÓDIGO) ──
-- El bot emite ##PEDIDO:producto x cantidad##; el servidor resuelve productos,
-- calcula el total server-side (la IA nunca decide montos) y envía el resumen.
create table if not exists orders (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references businesses(id) on delete cascade,
  contact_phone    text not null,
  contact_name     text,
  -- Flujo hacia adelante: pendiente → confirmado → preparacion → en_camino →
  -- completado (o cancelado desde cualquiera). Lo hace cumplir set_order_status.
  status           text not null default 'pendiente'
                   constraint orders_status_check check (status in (
                     'pendiente','esperando_pago','pago_en_revision','confirmado',
                     'aceptado','preparacion','listo_para_retiro','en_camino',
                     'completado','cancelado','rechazado','expirado'
                   )),
  subtotal         numeric(10,2) not null default 0,
  discount         numeric(10,2) not null default 0,  -- solo por código/panel, jamás la IA
  total            numeric(10,2) not null default 0,
  currency         text not null default 'USD',
  created_at       timestamptz default now(),
  updated_at       timestamptz default now()
);

-- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
-- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
-- creaban dos comandas en la cocina y un cliente pagando dos veces. La app
-- manda una clave por intento de compra
-- (migration-2026-08-05-pedidos-sin-duplicados.sql).
alter table public.orders
  add column if not exists idempotency_key text;
alter table public.orders
  add column if not exists scheduled_for timestamptz;

-- Único POR NEGOCIO y solo cuando hay clave: los pedidos del bot no la traen y
-- no pueden chocar entre sí por ser todos nulos.
create unique index if not exists uq_orders_idempotencia
  on public.orders (business_id, idempotency_key)
  where idempotency_key is not null;

-- El pedido como destino de foránea compuesta: sin el business_id dentro se
-- podría colgar el historial de un negocio sobre el pedido de otro.
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);

-- ── El historial de estados ─────────────────────────────────────────────
-- Sin esto, «¿cuándo se confirmó?» solo se responde mirando `updated_at`, que
-- se pisa con cada cambio.
create table if not exists public.order_events (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  order_id    uuid not null,
  from_status text,
  to_status   text not null,
  note        text,
  -- Quién lo hizo, cuando se sabe. Nulo para lo que mueve el sistema.
  -- ⚠️ Foránea COMPUESTA más abajo, como `prepared_by`.
  created_by  uuid,
  -- ⚠️ Si el evento es de una LÍNEA (marcarla preparada) y no del pedido
  -- entero. El seguimiento del CLIENTE los filtra: la cocina no se le enseña.
  --
  -- ⚠️ Sin `references` AQUÍ: `order_items` se crea MÁS ABAJO y un esquema
  -- aplicado desde cero fallaría. La clave foránea se añade después de esa
  -- tabla, con un `alter`.
  order_item_id uuid,
  created_at  timestamptz not null default now(),
  constraint order_events_datos_check check (
    char_length(btrim(to_status)) between 1 and 40
    and char_length(coalesce(note, '')) <= 300
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_events'::regclass
      and conname = 'fk_order_events_pedido_del_negocio'
  ) then
    alter table public.order_events
      add constraint fk_order_events_pedido_del_negocio
      foreign key (order_id, business_id)
      references public.orders (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_order_events_pedido
  on public.order_events (business_id, order_id, created_at);

alter table public.order_events enable row level security;
revoke all on table public.order_events from public, anon, authenticated;
grant select, insert, update, delete on table public.order_events to service_role;

-- ── TABLA 16: Ítems del pedido (precio congelado al momento del pedido) ──
create table if not exists order_items (
  id           uuid primary key default gen_random_uuid(),
  order_id     uuid references orders(id)     on delete cascade,
  business_id  uuid not null references businesses(id) on delete cascade,
  product_id   uuid references products(id)   on delete set null,
  product_name text not null,
  quantity     int not null default 1 check (quantity > 0),
  unit_price   numeric(10,2) not null default 0,
  line_total   numeric(10,2) not null default 0,
  -- ── LA CHECKLIST DE PREPARACIÓN (2026-09-24) ────────────────────────────
  -- Nula = todavía no está en la bolsa. Es una FECHA y no un estado porque
  -- «agregado» y «confirmado» son el mismo instante: el empleado la mete y la
  -- tilda. Dos toques para lo mismo, en una cocina con prisa, es un toque que
  -- nadie da. Y guardando cuándo y quién, la línea de tiempo sale sola.
  prepared_at  timestamptz,
  -- ⚠️ Sin `references` aquí: la foránea es COMPUESTA con `business_id` y se
  -- ata más abajo, donde ya existe `uq_client_users_id_business`.
  prepared_by  uuid,
  created_at   timestamptz default now()
);

-- Para el candado de `set_order_status`: encontrar rápido si falta algo.
create index if not exists idx_order_items_pendientes
  on public.order_items (order_id)
  where prepared_at is null;

-- La clave foránea que no cabía en `order_events`: esa tabla se declara ANTES
-- que esta, así que su `order_item_id` se ata aquí.

-- ── TABLA 17: Inbox durable de webhooks ───────────────────
-- Conserva el payload normalizado solo mientras esta pendiente, en proceso o
-- dead. Al completar se elimina inmediatamente y queda unicamente el hash para
-- deduplicar redeliveries durante 24 horas.
create table if not exists webhook_inbound_events (
  id              uuid primary key default gen_random_uuid(),
  -- Nulo mientras el cliente no ha elegido local: un mensaje al número del
  -- marketplace todavía no pertenece a ningún negocio (2026-08-21).
  business_id     uuid references businesses(id) on delete cascade,
  provider        text not null check (provider in ('meta', 'ycloud')),
  message_id_hash text not null check (message_id_hash ~ '^[0-9a-f]{64}$'),
  payload_version smallint not null default 1,
  payload          jsonb,
  stream_key_hash  text,
  status            text not null default 'completed'
                    check (status in ('pending','processing','completed','dead')),
  attempts          integer not null default 0,
  max_attempts      integer not null default 8,
  available_at      timestamptz not null default now(),
  lease_token       uuid,
  lease_owner       text,
  leased_until      timestamptz,
  last_error        text,
  completed_at      timestamptz,
  dead_at           timestamptz,
  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint webhook_inbound_events_attempts_check check (
    attempts between 0 and max_attempts and max_attempts between 1 and 100
  ),
  constraint webhook_inbound_events_payload_check check (
    (status = 'completed' and payload is null)
    or (
      status in ('pending','processing','dead')
      and payload is not null
      and jsonb_typeof(payload) = 'object'
      and pg_column_size(payload) <= 262144
      and stream_key_hash is not null
      and stream_key_hash ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint webhook_inbound_events_lease_check check (
    (
      status = 'processing'
      and lease_token is not null
      and leased_until is not null
      and nullif(btrim(lease_owner), '') is not null
      and char_length(lease_owner) <= 128
    )
    or (
      status <> 'processing'
      and lease_token is null
      and leased_until is null
      and lease_owner is null
    )
  )
);

drop trigger if exists webhook_inbound_message_usage
  on public.webhook_inbound_events;
create trigger webhook_inbound_message_usage
after insert on public.webhook_inbound_events
for each row execute function public.record_inbound_message_usage();

-- ── TABLA 18: Registro de errores de plataforma ────────────
-- Agrupa por huella: mil repeticiones del mismo fallo son UNA fila con
-- occurrences = 1000. `business_id` admite NULL para errores que no pertenecen
-- a ningún negocio (arranque, webhook sin resolver). Ver
-- migration-registro-errores.sql para las funciones que la operan.
create table if not exists public.platform_errors (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid references public.businesses(id) on delete cascade,
  category      text not null check (category in ('canal', 'ia', 'envio', 'servidor')),
  code          text,
  message       text not null,
  context       jsonb not null default '{}'::jsonb,
  fingerprint   text not null,
  occurrences   integer not null default 1,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  constraint platform_errors_tamanos_check check (
    char_length(message) between 1 and 2000
    and char_length(coalesce(code, '')) <= 120
    and fingerprint ~ '^[0-9a-f]{64}$'
    and occurrences >= 1
    and pg_column_size(context) <= 8192
  )
);

-- ── ÍNDICES ────────────────────────────────────────────────
create index if not exists idx_platform_errors_recientes
  on public.platform_errors (last_seen_at desc);
create index if not exists idx_platform_errors_negocio
  on public.platform_errors (business_id, last_seen_at desc);
-- Dos índices parciales porque en SQL NULL nunca es igual a NULL: los errores
-- sin negocio se agrupan aparte.
create unique index if not exists uq_platform_errors_negocio_huella
  on public.platform_errors (business_id, fingerprint)
  where business_id is not null;
create unique index if not exists uq_platform_errors_huella_global
  on public.platform_errors (fingerprint)
  where business_id is null;

create index if not exists idx_products_biz      on products(business_id);
create index if not exists idx_history_contact   on conversation_history(business_id, contact_phone);
create index if not exists idx_history_date      on conversation_history(business_id, created_at);
create index if not exists idx_sessions_biz      on conversation_sessions(business_id);
create index if not exists idx_schedule_biz      on business_schedule(business_id);
create index if not exists idx_biz_phone         on businesses(whatsapp_number);
create index if not exists idx_billing_biz       on billing(business_id);
create index if not exists idx_sales_biz          on sales(business_id);
create index if not exists idx_sales_biz_date     on sales(business_id, sold_at);
create index if not exists idx_sales_biz_phone    on sales(business_id, contact_phone);
create index if not exists idx_sale_items_sale    on sale_items(sale_id);
create index if not exists idx_sale_items_biz_prod on sale_items(business_id, product_id);
create index if not exists idx_pconsult_biz_date   on product_consultations(business_id, created_at);
create index if not exists idx_pconsult_biz_prod   on product_consultations(business_id, product_id);
create index if not exists idx_ai_gaps_biz_date    on ai_gaps(business_id, created_at);
create index if not exists idx_orders_biz          on orders(business_id);
create index if not exists idx_orders_biz_phone    on orders(business_id, contact_phone);
create index if not exists idx_orders_biz_date     on orders(business_id, created_at);
create index if not exists idx_order_items_order   on order_items(order_id);
create index if not exists idx_order_items_biz     on order_items(business_id);
create unique index if not exists uq_webhook_events_business_provider_hash
  on webhook_inbound_events(business_id, provider, message_id_hash);
create index if not exists idx_webhook_events_business_received
  on webhook_inbound_events(business_id, received_at);
create index if not exists idx_webhook_events_received
  on webhook_inbound_events(received_at);
create index if not exists idx_webhook_inbox_ready
  on webhook_inbound_events(available_at, received_at, id)
  where status = 'pending';
create index if not exists idx_webhook_inbox_expired_leases
  on webhook_inbound_events(leased_until)
  where status = 'processing';
create index if not exists idx_webhook_inbox_stream_order
  on webhook_inbound_events(
    business_id, provider, stream_key_hash, received_at, id
  )
  where status in ('pending', 'processing');
create unique index if not exists uq_webhook_inbox_processing_stream
  on webhook_inbound_events(business_id, provider, stream_key_hash)
  where status = 'processing';

-- Gemelos para los eventos del marketplace, que llegan sin negocio elegido.
-- ⚠️ Hacen falta porque en SQL dos NULL no son iguales: los índices únicos
-- de arriba, que empiezan por `business_id`, NO deduplican nada cuando ese
-- valor es nulo. Sin estos, el mismo mensaje reentregado —la cola es
-- at-least-once— se contestaría dos veces.
create unique index if not exists uq_webhook_events_plataforma_hash
  on webhook_inbound_events(provider, message_id_hash)
  where business_id is null;
create unique index if not exists uq_webhook_inbox_plataforma_stream
  on webhook_inbound_events(provider, stream_key_hash)
  where status = 'processing' and business_id is null;
create index if not exists idx_webhook_inbox_plataforma_orden
  on webhook_inbound_events(provider, stream_key_hash, received_at, id)
  where status in ('pending', 'processing') and business_id is null;

-- Normalización compatible con instalaciones creadas antes de que la duración
-- y el tenant de las reservas fueran obligatorios.
-- ── FUNCIÓN RAG: búsqueda de productos por significado ─────
create or replace function match_products(query_embedding vector(1536), biz_id uuid, match_count int)
returns table (
  id uuid, name text, brand text, price numeric, price_sale numeric,
  stock text, description text, tags text[], image_url text, duration_minutes int, similarity float
)
language sql stable as $$
  select p.id, p.name, p.brand, p.price, p.price_sale, p.stock,
         p.description, p.tags, p.image_url, p.duration_minutes,
         1 - (p.embedding <=> query_embedding) as similarity
  from products p
  where p.business_id = biz_id and p.active = true and p.embedding is not null
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

-- ── FUNCIÓN ATÓMICA: pedido del bot + detalles ─────────────
-- La firma cambió al añadir el origen: dejar viva la anterior haría ambigua
-- cualquier llamada.
drop function if exists public.create_order_with_items(
  uuid, text, text, text, numeric, text, jsonb
);

create or replace function public.create_order_with_items(
  p_business_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_status text,
  p_discount numeric,
  p_currency text,
  p_items jsonb,
  p_source text default 'whatsapp'
)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_order orders%rowtype;
  v_item jsonb;
  v_normalized_items jsonb := '[]'::jsonb;
  v_product_id uuid;
  v_product_name text;
  v_product_stock text;
  v_quantity integer;
  v_requested_price numeric(10,2);
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_discount numeric(10,2) := round(coalesce(p_discount, 0), 2);
  v_total numeric(10,2);
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if nullif(btrim(p_contact_phone), '') is null then
    raise exception using errcode = '22023', message = 'El contacto es obligatorio';
  end if;
  if coalesce(p_status, 'pendiente') not in (
    'pendiente', 'confirmado', 'completado', 'cancelado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;
  if coalesce(p_source, 'whatsapp') not in ('whatsapp', 'storefront', 'marketplace', 'manual') then
    raise exception using errcode = '22023', message = 'Origen de pedido inválido';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido necesita al menos un ítem';
  end if;
  if v_discount < 0 then
    raise exception using errcode = '22023', message = 'El descuento no puede ser negativo';
  end if;

  for v_item in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception using errcode = '22023', message = 'Cada ítem debe ser un objeto';
    end if;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_quantity := (v_item ->> 'quantity')::integer;
    v_requested_price := round((v_item ->> 'unit_price')::numeric, 2);
    if v_product_id is null then
      raise exception using errcode = '22023', message = 'El producto es obligatorio';
    end if;
    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;
    select
      p.name,
      round(case when p.price_sale > 0 then p.price_sale else p.price end, 2),
      p.stock
    into v_product_name, v_unit_price, v_product_stock
    from products p
    where p.id = v_product_id
      and p.business_id = p_business_id
      and p.active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product_stock = 'agotado' then
      raise exception using errcode = '22023', message = 'El producto está agotado';
    end if;
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = 'El producto no tiene un precio válido';
    end if;
    -- El precio que manda quien llama es una OPINIÓN que hay que confirmar,
    -- no un dato que se acepte: si no coincide con el catálogo, el pedido se
    -- rehace. Así el bot no puede cobrar un precio que ya cambió mientras el
    -- cliente decidía.
    --
    -- Pero ausente NO es lo mismo que distinto: significa «no tengo opinión,
    -- usa tu catálogo». Sin esta distinción, `null is distinct from 2.75` daba
    -- cierto y el pedido de MOSTRADOR —que a propósito manda solo ids y
    -- cantidades— fallaba SIEMPRE con 40001. Nunca funcionó desde que se
    -- publicó (2026-08-02), y ninguna prueba lo veía porque todas mandaban
    -- precio. El precio sigue saliendo solo del catálogo en los dos casos.
    if v_requested_price is not null and v_requested_price is distinct from v_unit_price then
      raise exception using errcode = '40001', message = 'El precio cambió; vuelve a calcular el pedido';
    end if;
    v_line_total := round(v_quantity * v_unit_price, 2);
    v_subtotal := v_subtotal + v_line_total;
    v_normalized_items := v_normalized_items || jsonb_build_array(jsonb_build_object(
      'product_id', v_product_id, 'product_name', v_product_name,
      'quantity', v_quantity, 'unit_price', v_unit_price, 'line_total', v_line_total
    ));
  end loop;

  v_subtotal := round(v_subtotal, 2);
  if v_discount > v_subtotal then
    raise exception using errcode = '22023', message = 'El descuento supera el subtotal';
  end if;
  v_total := round(v_subtotal - v_discount, 2);

  insert into orders (
    business_id, contact_phone, contact_name, status,
    subtotal, discount, total, currency, source
  ) values (
    p_business_id, btrim(p_contact_phone), nullif(btrim(p_contact_name), ''),
    coalesce(p_status, 'pendiente'), v_subtotal, v_discount, v_total,
    coalesce(nullif(btrim(p_currency), ''), 'USD'), coalesce(p_source, 'whatsapp')
  ) returning * into v_order;

  insert into order_items (
    order_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_order.id, p_business_id, nullif(item ->> 'product_id', '')::uuid,
    item ->> 'product_name', (item ->> 'quantity')::integer,
    (item ->> 'unit_price')::numeric, (item ->> 'line_total')::numeric
  from jsonb_array_elements(v_normalized_items) as item;

  -- Nace entregado (mostrador): la venta se crea aquí, no en una segunda
  -- llamada desde Node que podría no ocurrir si algo falla entre medias.
  if coalesce(p_status, 'pendiente') = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, v_order.id);
  end if;

  return to_jsonb(v_order);
end;
$$;

revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) from public;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) from anon;
revoke all on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) from authenticated;
grant execute on function public.create_order_with_items(uuid, text, text, text, numeric, text, jsonb, text) to service_role;

-- Cambia el ciclo de vida de un pedido de forma atómica. Los estados finales
-- no pueden reabrirse y repetir el mismo cambio es seguro.
-- ── PEDIDO ENTREGADO → VENTA ───────────────────────────────
-- Vive aparte para que la usen los dos caminos que cierran un pedido: marcarlo
-- entregado desde la bandeja, y el pedido de mostrador que nace ya entregado.
create or replace function public.crear_venta_desde_pedido(
  p_business_id uuid,
  p_order_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_sale_id uuid;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id;
  if not found then
    return null;
  end if;

  select id into v_sale_id
  from public.sales
  where order_id = p_order_id and business_id = p_business_id;
  if found then
    return v_sale_id;
  end if;

  -- Solo cuenta lo entregado. Un pedido pendiente o cancelado no es dinero.
  -- Hoy quien decide es `set_order_status`, que solo llama aquí al pasar a
  -- 'completado' — pero esta función es SECURITY DEFINER y está concedida a
  -- service_role, así que un `db.rpc()` distraído facturaría un pedido
  -- cancelado. La misma guardia que ya tenía `crear_venta_desde_estadia`.
  if v_order.status is distinct from 'completado' then
    return null;
  end if;

  insert into public.sales (
    business_id, order_id, contact_phone, contact_name,
    total, shipping, platform_markup, status, source, sold_at
  ) values (
    p_business_id, p_order_id,
    -- 'mostrador' no es el teléfono de nadie: la venta va sin contacto.
    nullif(v_order.contact_phone, 'mostrador'),
    v_order.contact_name,
    -- `total` NO cambia: es lo que pagó el cliente. Lo que se añade al lado es
    -- de quién es cada parte, para que los reportes enseñen solo la del local.
    v_order.total,
    coalesce(v_order.shipping, 0),
    coalesce(v_order.platform_markup, 0),
    'completada',
    case
      when v_order.source = 'storefront' then 'tienda'
      when v_order.source = 'manual' then 'mostrador'
      else 'bot'
    end,
    now()
  )
  returning id into v_sale_id;

  insert into public.sale_items (
    sale_id, business_id, product_id, product_name, quantity, unit_price, line_total
  )
  select
    v_sale_id, p_business_id, oi.product_id,
    oi.product_name || coalesce(' (' || oi.variant_name || ')', ''),
    oi.quantity, oi.unit_price, oi.line_total
  from public.order_items oi
  where oi.order_id = p_order_id and oi.business_id = p_business_id;

  return v_sale_id;
end;
$$;

revoke all on function public.crear_venta_desde_pedido(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.crear_venta_desde_pedido(uuid, uuid) to service_role;

create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_anterior text;
begin
  if p_status not in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;
  v_anterior := v_order.status;

  -- Un pedido que el cliente retira en el local (o consume en sitio) no puede
  -- salir a reparto. Los pedidos del bot no traen `fulfillment`: se asumen a
  -- domicilio, que es como funcionan hoy por WhatsApp.
  if p_status = 'en_camino'
     and coalesce(v_order.fulfillment, 'delivery') <> 'delivery' then
    return jsonb_build_object('result', 'not_deliverable', 'order', to_jsonb(v_order));
  end if;

  -- Y al revés: un pedido a domicilio no se queda «listo para retirar».
  if p_status = 'listo_para_retiro'
     and coalesce(v_order.fulfillment, 'delivery') = 'delivery' then
    return jsonb_build_object('result', 'not_pickable', 'order', to_jsonb(v_order));
  end if;

  -- El pedido avanza; nunca retrocede. `completado`, `cancelado`, `rechazado`
  -- y `expirado` son finales: de ahí no sale a ningún sitio, así que
  -- «cancelado → preparacion» o «completado → preparacion» quedan fuera por no
  -- estar listados, no por una regla aparte.
  if not (
    (v_order.status = 'pendiente'
      and p_status in ('esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
                       'preparacion', 'cancelado', 'rechazado', 'expirado'))
    or (v_order.status = 'esperando_pago'
      and p_status in ('pago_en_revision', 'confirmado', 'cancelado', 'expirado'))
    -- El comprobante está subido y el dueño lo revisa: de aquí sale aceptado o
    -- rechazado, nunca directo a la cocina.
    or (v_order.status = 'pago_en_revision'
      and p_status in ('confirmado', 'aceptado', 'rechazado', 'cancelado', 'expirado'))
    or (v_order.status = 'confirmado'
      and p_status in ('aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
                       'completado', 'cancelado', 'expirado'))
    or (v_order.status = 'aceptado'
      and p_status in ('preparacion', 'listo_para_retiro', 'en_camino', 'completado',
                       'cancelado'))
    or (v_order.status = 'preparacion'
      and p_status in ('listo_para_retiro', 'en_camino', 'completado', 'cancelado'))
    or (v_order.status = 'listo_para_retiro'
      and p_status in ('completado', 'cancelado'))
    or (v_order.status = 'en_camino'
      and p_status in ('completado', 'cancelado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  -- El historial. Sin esto, «¿cuándo se confirmó?» solo se puede responder
  -- mirando `updated_at`, que se pisa con cada cambio.
  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, v_anterior, p_status);

  -- Entregado = vendido. Si algo fallara aquí cae la transacción entera: nunca
  -- queda un pedido entregado sin su venta.
  if p_status = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, p_order_id);
  end if;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.set_order_status(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.set_order_status(uuid, uuid, text) to service_role;

-- ── FUNCIÓN ATÓMICA: reserva si el intervalo sigue libre ───
-- ── FUNCIÓN ATÓMICA: onboarding completo ───────────────────
-- Crea negocio, políticas, dueño y cuotas en una sola transacción.
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text := btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text := nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using errcode = '22023', message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using errcode = '22023', message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using errcode = '22023', message = 'La contraseña debe llegar cifrada';
  end if;
  if p_monthly_rate is not null and p_monthly_rate <= 0 then
    raise exception using errcode = '22023', message = 'La tarifa mensual debe ser mayor que cero';
  end if;

  insert into businesses (
    slug, name, type, whatsapp_number, whatsapp_provider,
    ycloud_api_key, ycloud_number,
    ycloud_webhook_endpoint_id, ycloud_webhook_secret,
    meta_token, meta_phone_id, telegram_bot_token,
    takes_orders, ai_provider, owner_phone, plan,
    plan_expires_at, active, bot_active, suspended, notes, monthly_rate
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    coalesce(nullif(p_business ->> 'plan', ''), 'basic'),
    nullif(p_business ->> 'plan_expires_at', '')::timestamptz,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    p_monthly_rate
  ) returning * into v_business;

  insert into business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into client_users (business_id, email, password_hash, role)
    values (v_business.id, v_client_email, v_password_hash, 'owner');
  end if;

  if p_monthly_rate is not null then
    insert into billing (business_id, amount, status, period_start, period_end)
    select
      v_business.id,
      p_monthly_rate,
      'pending',
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date,
      (date_trunc('month', current_date) + make_interval(months => month_offset + 1)
        - interval '1 day')::date
    from generate_series(0, 11) as month_offset;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric) from public;
revoke all on function public.create_business_onboarding(jsonb, text, text, numeric) from anon;
revoke all on function public.create_business_onboarding(jsonb, text, text, numeric) from authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric) to service_role;
-- ⚠️ Aquí vivía `create_sale_with_items`, el alta MANUAL de ventas. Se retiró
-- el 2026-08-02 (migration-2026-08-02-retirar-venta-manual.sql): desde
-- entonces toda venta nace de un pedido entregado, un pedido de mostrador o
-- una cita atendida. Un solo camino hasta el reporte.

-- ── INBOX DURABLE DE WEBHOOKS ──────────────────────────────
create or replace function public.enqueue_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text,
  p_stream_key_hash text,
  p_payload jsonb
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_event_id uuid;
  v_received_at timestamptz;
  v_quiet_until timestamptz;
  -- ⚠️ «texto LIBRE»: lo que el cliente ESCRIBIÓ, frente a lo que ELIGIÓ
  -- tocando un botón. Lo elegido llega entero y no espera la ventana.
  v_es_texto_libre boolean;
begin
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook invalido';
  end if;
  if p_message_id_hash is null
     or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje invalido';
  end if;
  if p_stream_key_hash is null
     or p_stream_key_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de conversacion invalido';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
     or pg_column_size(p_payload) > 262144
     or p_payload ? '_inboxBatch' then
    raise exception using errcode = '22023', message = 'Payload de webhook invalido';
  end if;

  v_es_texto_libre := coalesce((
    p_payload #>> '{content,kind}' = 'text'
    and jsonb_typeof(p_payload #> '{content,text}') = 'string'
    -- ⚠️ Lo elegido (botón o fila de lista) NO es texto libre. Llega entero y
    -- de una vez, así que la ventana de silencio —que existe para juntar
    -- mensajes escritos a trozos— solo le hacía lento el menú.
    and coalesce((p_payload #>> '{content,interactivo}')::boolean, false) = false
  ), false);
  -- Serializa solamente los enqueue del mismo stream. Así dos textos
  -- concurrentes observan la ventana más reciente y un duplicado nunca la
  -- prolonga. Una colisión del hash solo reduce concurrencia, no mezcla datos.
  perform pg_advisory_xact_lock(hashtextextended(
    coalesce(p_business_id::text, 'plataforma') || ':' || p_provider || ':' || p_stream_key_hash,
    0
  ));
  v_received_at := clock_timestamp();
  -- ⚠️ 300 ms, no 3 segundos (2026-09-23). Medido en producción: el hueco más
  -- corto entre dos mensajes de un mismo cliente en TODA la historia es 5,67 s
  -- —19 veces esta ventana—, y hubo 0 casos por debajo de 3 s en 128 huecos.
  -- La ventana de 3 s nunca agrupó nada y se la pagaba cada cliente.
  --
  -- No se pone a cero: la red sigue valiendo para dos webhooks casi
  -- simultáneos (un reintento de WhatsApp, un envío doble), que sí ocurre y
  -- costaría una respuesta de más — y cada saliente se paga.
  --
  -- ⚠️ El suelo ya NO es esto: el worker sondea cada 1000 ms. Ver la migración
  -- `2026-09-23-ventana-de-300ms.sql`.
  v_quiet_until := v_received_at + interval '300 milliseconds';

  insert into public.webhook_inbound_events (
    business_id,
    provider,
    message_id_hash,
    stream_key_hash,
    payload_version,
    payload,
    status,
    attempts,
    max_attempts,
    available_at,
    completed_at,
    dead_at,
    received_at,
    updated_at
  ) values (
    p_business_id,
    p_provider,
    p_message_id_hash,
    p_stream_key_hash,
    1,
    p_payload,
    'pending',
    0,
    8,
    case when v_es_texto_libre then v_quiet_until else now() end,
    null,
    null,
    v_received_at,
    v_received_at
  )
  on conflict do nothing
  returning id into v_event_id;

  if not found then
    return false;
  end if;

  if v_es_texto_libre then
    update public.webhook_inbound_events as queued
    set available_at = greatest(queued.available_at, v_quiet_until),
        updated_at = clock_timestamp()
    where queued.business_id is not distinct from p_business_id
      and queued.provider = p_provider
      and queued.stream_key_hash = p_stream_key_hash
      and queued.status = 'pending'
      and queued.payload #>> '{content,kind}' = 'text'
      and jsonb_typeof(queued.payload #> '{content,text}') = 'string'
      -- Una elección pendiente no se retrasa por un texto posterior.
      and coalesce((queued.payload #>> '{content,interactivo}')::boolean, false) = false
      and not (queued.payload ? '_inboxBatch')
      and (queued.received_at, queued.id) <= (v_received_at, v_event_id)
      -- Una imagen/audio (o un lote ya congelado) separa conversaciones
      -- textuales aunque haya más textos pendientes después de esa frontera.
      and not exists (
        select 1
        from public.webhook_inbound_events as boundary
        where boundary.business_id is not distinct from queued.business_id
          and boundary.provider = queued.provider
          and boundary.stream_key_hash = queued.stream_key_hash
          and boundary.status in ('pending', 'processing')
          and (boundary.received_at, boundary.id)
            > (queued.received_at, queued.id)
          and (boundary.received_at, boundary.id)
            < (v_received_at, v_event_id)
          and (
            boundary.payload #>> '{content,kind}' is distinct from 'text'
            -- ⚠️ Una ELECCIÓN también es frontera: lo escrito antes de tocar
            -- un botón pertenece a otra conversación.
            or coalesce((boundary.payload #>> '{content,interactivo}')::boolean, false)
            or boundary.payload ? '_inboxBatch'
          )
      );
  end if;

  return true;
end;
$$;

create or replace function public.lease_webhook_events(
  p_worker_id text,
  p_limit integer,
  p_lease_seconds integer
)
returns table (
  id uuid,
  business_id uuid,
  provider text,
  payload jsonb,
  lease_token uuid,
  attempts integer
)
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_lease_seconds integer := greatest(
    30, least(coalesce(p_lease_seconds, 180), 900)
  );
  v_head record;
  v_batch_ids uuid[];
  v_combined_text text;
  v_latest_inbound_id text;
  v_payload jsonb;
  v_lease_token uuid;
  v_attempts integer;
  v_frozen boolean;
  v_terminal_head record;
  v_terminal_ids uuid[];
  v_terminal_locked_ids uuid[];
  v_terminal_member record;
  v_terminal_distinct integer;
  v_terminal_updated integer;
  v_has_terminal_snapshot boolean;
begin
  if nullif(btrim(p_worker_id), '') is null
     or char_length(p_worker_id) > 128 then
    raise exception using errcode = '22023', message = 'Worker ID invalido';
  end if;

  -- Si venció el último lease, toda la foto congelada va a dead-letter.
  -- Dejar sus miembros pending permitiría que se procesen otra vez después de
  -- que la cabeza ya pudo haber enviado una respuesta antes de morir.
  for v_terminal_head in
    select event.*
    from public.webhook_inbound_events as event
    where event.status = 'processing'
      and event.leased_until <= now()
      and event.attempts >= event.max_attempts
    order by event.received_at, event.id
    for update of event skip locked
    limit 100
  loop
    v_terminal_ids := array[v_terminal_head.id];
    v_has_terminal_snapshot := false;

    if (v_terminal_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_terminal_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array' then
      if jsonb_array_length(
        v_terminal_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
         and not exists (
           select 1
           from jsonb_array_elements(
             v_terminal_head.payload #> '{_inboxBatch,eventIds}'
           ) as item(value)
           where jsonb_typeof(item.value) is distinct from 'string'
              or (item.value #>> '{}') !~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         ) then
        select array_agg(
          (item.value #>> '{}')::uuid
          order by item.ordinality
        )
        into v_terminal_ids
        from jsonb_array_elements(
          v_terminal_head.payload #> '{_inboxBatch,eventIds}'
        ) with ordinality as item(value, ordinality);

        select count(distinct member.id)::integer
        into v_terminal_distinct
        from unnest(v_terminal_ids) as member(id);

        v_has_terminal_snapshot :=
          v_terminal_ids[1] = v_terminal_head.id
          and v_terminal_distinct = cardinality(v_terminal_ids);
      end if;
    end if;

    if v_has_terminal_snapshot then
      v_terminal_locked_ids := array[]::uuid[];
      for v_terminal_member in
        select event.*
        from public.webhook_inbound_events as event
        where event.id = any(v_terminal_ids)
        order by event.received_at, event.id
        for update
      loop
        if v_terminal_member.business_id is distinct from v_terminal_head.business_id
           or v_terminal_member.provider is distinct from v_terminal_head.provider
           or v_terminal_member.stream_key_hash
             is distinct from v_terminal_head.stream_key_hash
           or v_terminal_member.payload #>> '{content,kind}'
             is distinct from 'text'
           or (
             v_terminal_member.id = v_terminal_head.id
             and (
               v_terminal_member.status is distinct from 'processing'
               or v_terminal_member.lease_token
                 is distinct from v_terminal_head.lease_token
             )
           )
           or (
             v_terminal_member.id <> v_terminal_head.id
             and (
               v_terminal_member.status is distinct from 'pending'
               or v_terminal_member.lease_token is not null
             )
           ) then
          raise exception using
            errcode = '40001',
            message = 'El lote expirado del webhook cambió antes de dead-letter';
        end if;
        v_terminal_locked_ids := array_append(
          v_terminal_locked_ids,
          v_terminal_member.id
        );
      end loop;

      if v_terminal_locked_ids is distinct from v_terminal_ids then
        raise exception using
          errcode = '40001',
          message = 'El lote expirado del webhook está incompleto';
      end if;
    else
      v_terminal_ids := array[v_terminal_head.id];
    end if;

    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = coalesce(
          event.last_error,
          'Lease vencido despues del ultimo intento'
        ),
        completed_at = null,
        dead_at = now(),
        updated_at = now()
    where event.id = any(v_terminal_ids)
      and event.business_id is not distinct from v_terminal_head.business_id
      and event.provider = v_terminal_head.provider
      and event.stream_key_hash = v_terminal_head.stream_key_hash
      and (
        (
          event.id = v_terminal_head.id
          and event.status = 'processing'
          and event.lease_token = v_terminal_head.lease_token
        )
        or (
          event.id <> v_terminal_head.id
          and event.status = 'pending'
          and event.lease_token is null
        )
      );

    get diagnostics v_terminal_updated = row_count;
    if v_terminal_updated <> cardinality(v_terminal_ids) then
      raise exception using
        errcode = '40001',
        message = 'El lote expirado cambió durante su terminalización';
    end if;
  end loop;

  update public.webhook_inbound_events as event
  set status = 'pending',
      available_at = least(event.available_at, now()),
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      updated_at = now()
  where event.status = 'processing'
    and event.leased_until <= now()
    and event.attempts < event.max_attempts;

  for v_head in
    select event.*
    from public.webhook_inbound_events as event
    where event.status = 'pending'
      and event.available_at <= now()
      and event.attempts < event.max_attempts
      and not exists (
        select 1
        from public.webhook_inbound_events as earlier
        where earlier.business_id is not distinct from event.business_id
          and earlier.provider = event.provider
          and earlier.stream_key_hash = event.stream_key_hash
          and earlier.status in ('pending', 'processing')
          and (earlier.received_at, earlier.id)
            < (event.received_at, event.id)
      )
    order by event.received_at, event.id
    for update of event skip locked
    limit v_limit
  loop
    v_payload := v_head.payload;
    v_batch_ids := null;
    v_combined_text := null;
    v_latest_inbound_id := null;
    v_frozen := case
      when (v_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array'
      then jsonb_array_length(
        v_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
        and (v_head.payload #>> '{_inboxBatch,eventIds,0}') = v_head.id::text
      else false
    end;

    -- Un retry conserva exactamente el snapshot anterior. Los mensajes que
    -- llegaron después quedan pendientes para el siguiente lote.
    if not v_frozen
       and v_head.payload #>> '{content,kind}' = 'text'
       and jsonb_typeof(v_head.payload #> '{content,text}') = 'string' then
      with eligible as (
        select
          member.id,
          member.payload,
          member.received_at,
          row_number() over (
            order by member.received_at, member.id
          ) as batch_position,
          sum(
            char_length(member.payload #>> '{content,text}')
            + case when member.id = v_head.id then 0 else 1 end
          ) over (
            order by member.received_at, member.id
            rows between unbounded preceding and current row
          ) as combined_length
        from public.webhook_inbound_events as member
        where member.business_id is not distinct from v_head.business_id
          and member.provider = v_head.provider
          and member.stream_key_hash = v_head.stream_key_hash
          and member.status = 'pending'
          and member.available_at <= now()
          and member.attempts < member.max_attempts
          and member.payload #>> '{content,kind}' = 'text'
          and jsonb_typeof(member.payload #> '{content,text}') = 'string'
          and not (member.payload ? '_inboxBatch')
          and (member.received_at, member.id)
            >= (v_head.received_at, v_head.id)
          -- No salta una frontera no textual, un retry congelado ni una fila
          -- todavía no disponible: solo toma un prefijo consecutivo.
          and not exists (
            select 1
            from public.webhook_inbound_events as boundary
            where boundary.business_id is not distinct from v_head.business_id
              and boundary.provider = v_head.provider
              and boundary.stream_key_hash = v_head.stream_key_hash
              and boundary.status in ('pending', 'processing')
              and (boundary.received_at, boundary.id)
                >= (v_head.received_at, v_head.id)
              and (boundary.received_at, boundary.id)
                < (member.received_at, member.id)
              and (
                boundary.payload #>> '{content,kind}' is distinct from 'text'
                or jsonb_typeof(boundary.payload #> '{content,text}')
                  is distinct from 'string'
                or boundary.payload ? '_inboxBatch'
                or boundary.available_at > now()
                or boundary.attempts >= boundary.max_attempts
              )
          )
      ), bounded as (
        select *
        from eligible
        where batch_position <= 20
          and combined_length <= 16384
      )
      select
        array_agg(bounded.id order by bounded.received_at, bounded.id),
        string_agg(
          bounded.payload #>> '{content,text}',
          E'\n'
          order by bounded.received_at, bounded.id
        ),
        (
          array_agg(
            bounded.payload ->> 'inboundId'
            order by bounded.received_at desc, bounded.id desc
          )
        )[1]
      into v_batch_ids, v_combined_text, v_latest_inbound_id
      from bounded;

      -- Los payloads normalizados válidos siempre incluyen la cabeza. Este
      -- fallback conserva el fallo/retry de una fila histórica malformada sin
      -- permitir que se apropie de otros IDs.
      if v_batch_ids is null
         or v_batch_ids[1] is distinct from v_head.id then
        v_batch_ids := array[v_head.id];
        v_combined_text := v_head.payload #>> '{content,text}';
        v_latest_inbound_id := v_head.payload ->> 'inboundId';
      end if;

      v_payload := jsonb_set(
        jsonb_set(
          v_head.payload - '_inboxBatch',
          '{content,text}',
          to_jsonb(v_combined_text),
          false
        ),
        '{inboundId}',
        to_jsonb(v_latest_inbound_id),
        false
      ) || jsonb_build_object(
        '_inboxBatch',
        jsonb_build_object(
          'version', 1,
          'eventIds', to_jsonb(v_batch_ids)
        )
      );
    elsif not v_frozen then
      -- _inboxBatch es un namespace interno reservado; nunca se confía en
      -- metadata presente en un payload histórico no textual.
      v_payload := v_head.payload - '_inboxBatch';
    end if;

    update public.webhook_inbound_events as event
    set status = 'processing',
        attempts = event.attempts + 1,
        payload = v_payload,
        lease_token = gen_random_uuid(),
        lease_owner = btrim(p_worker_id),
        leased_until = now() + make_interval(secs => v_lease_seconds),
        updated_at = now()
    where event.id = v_head.id
      and event.status = 'pending'
    returning event.lease_token, event.attempts
      into v_lease_token, v_attempts;

    if found then
      id := v_head.id;
      business_id := v_head.business_id;
      provider := v_head.provider;
      payload := v_payload;
      lease_token := v_lease_token;
      attempts := v_attempts;
      return next;
    end if;
  end loop;
end;
$$;

create or replace function public.renew_webhook_event_lease(
  p_event_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_renewed integer;
  v_lease_seconds integer := greatest(
    30, least(coalesce(p_lease_seconds, 180), 900)
  );
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  update public.webhook_inbound_events as event
  set leased_until = now() + make_interval(secs => v_lease_seconds),
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
    and event.leased_until > now();

  get diagnostics v_renewed = row_count;
  return v_renewed = 1;
end;
$$;

create or replace function public.complete_webhook_event(
  p_event_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_head record;
  v_batch jsonb;
  v_batch_ids uuid[];
  v_locked_ids uuid[] := array[]::uuid[];
  v_member record;
  v_distinct_count integer;
  v_completed integer;
begin
  if p_event_id is null or p_lease_token is null then return false; end if;

  select event.*
  into v_head
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return false; end if;

  v_batch := v_head.payload -> '_inboxBatch';
  if v_batch is null then
    update public.webhook_inbound_events as event
    set status = 'completed',
        payload = null,
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = null,
        completed_at = now(),
        dead_at = null,
        updated_at = now()
    where event.id = p_event_id
      and event.status = 'processing'
      and event.lease_token = p_lease_token;

    get diagnostics v_completed = row_count;
    return v_completed = 1;
  end if;

  if jsonb_typeof(v_batch) is distinct from 'object'
     or (v_batch ->> 'version') is distinct from '1'
     or jsonb_typeof(v_batch -> 'eventIds') is distinct from 'array' then
    return false;
  end if;

  if jsonb_array_length(v_batch -> 'eventIds') not between 1 and 20 then
    return false;
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_batch -> 'eventIds') as item(value)
    where jsonb_typeof(item.value) is distinct from 'string'
       or (item.value #>> '{}') !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
  ) then
    return false;
  end if;

  select array_agg(
    (item.value #>> '{}')::uuid
    order by item.ordinality
  )
  into v_batch_ids
  from jsonb_array_elements(v_batch -> 'eventIds')
    with ordinality as item(value, ordinality);

  if v_batch_ids[1] is distinct from p_event_id then return false; end if;

  select count(distinct member.id)::integer
  into v_distinct_count
  from unnest(v_batch_ids) as member(id);
  if v_distinct_count <> cardinality(v_batch_ids) then return false; end if;

  -- Bloquea todos los miembros antes de validar o mutar. La comparación del
  -- orden impide completar IDs ajenos o saltar una frontera FIFO.
  for v_member in
    select event.*
    from public.webhook_inbound_events as event
    where event.id = any(v_batch_ids)
    order by event.received_at, event.id
    for update
  loop
    if v_member.business_id is distinct from v_head.business_id
       or v_member.provider is distinct from v_head.provider
       or v_member.stream_key_hash is distinct from v_head.stream_key_hash
       or v_member.payload #>> '{content,kind}' is distinct from 'text'
       or (
         v_member.id = p_event_id
         and (
           v_member.status is distinct from 'processing'
           or v_member.lease_token is distinct from p_lease_token
         )
       )
       or (
         v_member.id <> p_event_id
         and (
           v_member.status is distinct from 'pending'
           or v_member.lease_token is not null
         )
       ) then
      return false;
    end if;

    v_locked_ids := array_append(v_locked_ids, v_member.id);
  end loop;

  if v_locked_ids is distinct from v_batch_ids then return false; end if;

  update public.webhook_inbound_events as event
  set status = 'completed',
      payload = null,
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      last_error = null,
      completed_at = now(),
      dead_at = null,
      updated_at = now()
  where event.id = any(v_batch_ids)
    and event.business_id is not distinct from v_head.business_id
    and event.provider = v_head.provider
    and event.stream_key_hash = v_head.stream_key_hash
    and (
      (
        event.id = p_event_id
        and event.status = 'processing'
        and event.lease_token = p_lease_token
      )
      or (
        event.id <> p_event_id
        and event.status = 'pending'
        and event.lease_token is null
      )
    );

  get diagnostics v_completed = row_count;
  if v_completed <> cardinality(v_batch_ids) then
    raise exception using
      errcode = '40001',
      message = 'El lote del webhook cambió durante su finalización';
  end if;

  return true;
end;
$$;

create or replace function public.fail_webhook_event(
  p_event_id uuid,
  p_lease_token uuid,
  p_error text,
  p_base_delay_seconds integer
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_head record;
  v_base_delay integer := greatest(
    1, least(coalesce(p_base_delay_seconds, 5), 300)
  );
  v_delay_seconds integer;
  v_error text := left(
    coalesce(nullif(btrim(p_error), ''), 'Error de procesamiento'),
    2000
  );
  v_batch_ids uuid[];
  v_locked_ids uuid[];
  v_member record;
  v_distinct_count integer;
  v_updated integer;
  v_has_snapshot boolean;
begin
  if p_event_id is null or p_lease_token is null then return 'stale'; end if;

  select event.*
  into v_head
  from public.webhook_inbound_events as event
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token
  for update;

  if not found then return 'stale'; end if;

  if v_head.attempts >= v_head.max_attempts then
    v_batch_ids := array[v_head.id];
    v_has_snapshot := false;

    if (v_head.payload #>> '{_inboxBatch,version}') = '1'
       and jsonb_typeof(
         v_head.payload #> '{_inboxBatch,eventIds}'
       ) = 'array' then
      if jsonb_array_length(
        v_head.payload #> '{_inboxBatch,eventIds}'
      ) between 1 and 20
         and not exists (
           select 1
           from jsonb_array_elements(
             v_head.payload #> '{_inboxBatch,eventIds}'
           ) as item(value)
           where jsonb_typeof(item.value) is distinct from 'string'
              or (item.value #>> '{}') !~
                '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
         ) then
        select array_agg(
          (item.value #>> '{}')::uuid
          order by item.ordinality
        )
        into v_batch_ids
        from jsonb_array_elements(
          v_head.payload #> '{_inboxBatch,eventIds}'
        ) with ordinality as item(value, ordinality);

        select count(distinct member.id)::integer
        into v_distinct_count
        from unnest(v_batch_ids) as member(id);

        v_has_snapshot := v_batch_ids[1] = v_head.id
          and v_distinct_count = cardinality(v_batch_ids);
      end if;
    end if;

    if v_has_snapshot then
      v_locked_ids := array[]::uuid[];
      for v_member in
        select event.*
        from public.webhook_inbound_events as event
        where event.id = any(v_batch_ids)
        order by event.received_at, event.id
        for update
      loop
        if v_member.business_id is distinct from v_head.business_id
           or v_member.provider is distinct from v_head.provider
           or v_member.stream_key_hash is distinct from v_head.stream_key_hash
           or v_member.payload #>> '{content,kind}' is distinct from 'text'
           or (
             v_member.id = p_event_id
             and (
               v_member.status is distinct from 'processing'
               or v_member.lease_token is distinct from p_lease_token
             )
           )
           or (
             v_member.id <> p_event_id
             and (
               v_member.status is distinct from 'pending'
               or v_member.lease_token is not null
             )
           ) then
          raise exception using
            errcode = '40001',
            message = 'El lote fallido del webhook cambió antes de dead-letter';
        end if;
        v_locked_ids := array_append(v_locked_ids, v_member.id);
      end loop;

      if v_locked_ids is distinct from v_batch_ids then
        raise exception using
          errcode = '40001',
          message = 'El lote fallido del webhook está incompleto';
      end if;
    else
      v_batch_ids := array[v_head.id];
    end if;

    update public.webhook_inbound_events as event
    set status = 'dead',
        lease_token = null,
        lease_owner = null,
        leased_until = null,
        last_error = v_error,
        completed_at = null,
        dead_at = now(),
        updated_at = now()
    where event.id = any(v_batch_ids)
      and event.business_id is not distinct from v_head.business_id
      and event.provider = v_head.provider
      and event.stream_key_hash = v_head.stream_key_hash
      and (
        (
          event.id = p_event_id
          and event.status = 'processing'
          and event.lease_token = p_lease_token
        )
        or (
          event.id <> p_event_id
          and event.status = 'pending'
          and event.lease_token is null
        )
      );

    get diagnostics v_updated = row_count;
    if v_updated <> cardinality(v_batch_ids) then
      raise exception using
        errcode = '40001',
        message = 'El lote fallido cambió durante su terminalización';
    end if;
    return 'dead';
  end if;

  -- 5s, 10s, 20s... con base configurable, jitter y tope de 15 min.
  v_delay_seconds := least(
    900,
    v_base_delay
      * power(
        2::numeric,
        least(greatest(v_head.attempts - 1, 0), 10)
      )::integer
      + floor(random() * least(v_base_delay, 30))::integer
  );

  update public.webhook_inbound_events as event
  set status = 'pending',
      available_at = now() + make_interval(secs => v_delay_seconds),
      lease_token = null,
      lease_owner = null,
      leased_until = null,
      last_error = v_error,
      dead_at = null,
      updated_at = now()
  where event.id = p_event_id
    and event.status = 'processing'
    and event.lease_token = p_lease_token;

  return 'pending';
end;
$$;

create or replace function public.cleanup_webhook_events()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
begin
  with deleted as (
    delete from public.webhook_inbound_events as event
    where (
      event.status = 'completed'
      and coalesce(event.completed_at, event.received_at)
        < now() - interval '24 hours'
    ) or (
      event.status = 'dead'
      and coalesce(event.dead_at, event.updated_at, event.received_at)
        < now() - interval '7 days'
    )
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;

  return v_deleted;
end;
$$;

-- Compatibilidad temporal con el runtime anterior.
create or replace function public.claim_webhook_event(
  p_business_id uuid,
  p_provider text,
  p_message_id_hash text
)
returns boolean
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_inserted integer;
begin
  if p_business_id is null then
    raise exception using errcode = '22023', message = 'El negocio es obligatorio';
  end if;
  if p_provider not in ('meta', 'ycloud') then
    raise exception using errcode = '22023', message = 'Proveedor de webhook inválido';
  end if;
  if p_message_id_hash is null or p_message_id_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Hash de mensaje inválido';
  end if;

  delete from public.webhook_inbound_events
  where business_id = p_business_id
    and status = 'completed'
    and coalesce(completed_at, received_at) < now() - interval '24 hours';

  insert into public.webhook_inbound_events (
    business_id, provider, message_id_hash, status, completed_at, updated_at
  ) values (
    p_business_id, p_provider, p_message_id_hash, 'completed', now(), now()
  )
  on conflict (business_id, provider, message_id_hash) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted = 1;
end;
$$;

revoke all on function public.claim_webhook_event(uuid, text, text) from public;
revoke all on function public.claim_webhook_event(uuid, text, text) from anon;
revoke all on function public.claim_webhook_event(uuid, text, text) from authenticated;
grant execute on function public.claim_webhook_event(uuid, text, text) to service_role;

revoke all on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.lease_webhook_events(text, integer, integer)
  from public, anon, authenticated;
revoke all on function public.renew_webhook_event_lease(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.complete_webhook_event(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.fail_webhook_event(uuid, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function public.cleanup_webhook_events()
  from public, anon, authenticated;

grant execute on function public.enqueue_webhook_event(uuid, text, text, text, jsonb)
  to service_role;
grant execute on function public.lease_webhook_events(text, integer, integer)
  to service_role;
grant execute on function public.renew_webhook_event_lease(uuid, uuid, integer)
  to service_role;
grant execute on function public.complete_webhook_event(uuid, uuid)
  to service_role;
grant execute on function public.fail_webhook_event(uuid, uuid, text, integer)
  to service_role;
grant execute on function public.cleanup_webhook_events()
  to service_role;

-- ── CATÁLOGO PARA LA TIENDA WEB DEL NEGOCIO ────────────────
-- La tienda que se abre desde WhatsApp necesita categorías con imagen,
-- variantes con precio propio y extras con coste. El precio sigue siendo
-- autoridad del servidor: estas tablas solo amplían de dónde sale.
alter table public.businesses
  add column if not exists storefront_enabled boolean not null default false;

create table if not exists public.product_categories (
  id              uuid primary key default gen_random_uuid(),
  business_id     uuid not null references public.businesses(id) on delete cascade,
  name            text not null,
  description     text,
  image_url       text,
  image_public_id text,
  sort            integer not null default 0,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint product_categories_textos_check check (
    char_length(btrim(name)) between 1 and 60
    and char_length(coalesce(description, '')) <= 300
    and sort between 0 and 999
  )
);
create index if not exists idx_product_categories_negocio
  on public.product_categories (business_id, sort);
create unique index if not exists uq_product_categories_nombre
  on public.product_categories (business_id, lower(btrim(name)));

alter table public.products
  add column if not exists category_id uuid references public.product_categories(id) on delete set null;
create index if not exists idx_products_categoria
  on public.products (business_id, category_id);

-- Un producto sin variantes sigue usando su propio `price`.
create table if not exists public.product_variants (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  product_id  uuid not null references public.products(id) on delete cascade,
  name        text not null,
  price       numeric(10,2) not null,
  price_sale  numeric(10,2),
  stock       text not null default 'disponible',
  sort        integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint product_variants_datos_check check (
    char_length(btrim(name)) between 1 and 60
    and price >= 0 and price <= 100000
    and (price_sale is null or (price_sale >= 0 and price_sale <= 100000))
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
  )
);
create index if not exists idx_product_variants_producto
  on public.product_variants (business_id, product_id, sort);
create unique index if not exists uq_product_variants_nombre
  on public.product_variants (product_id, lower(btrim(name)));

-- ── El catálogo de un negocio no se engancha al de otro ────
--
-- `product_variants` lleva business_id Y product_id, y `products` lleva
-- business_id Y category_id. Con una foránea de una sola columna, el negocio
-- salía del JWT pero el otro id viajaba en la petición: mandando un uuid ajeno
-- se colgaba una variante —con su precio— del catálogo de otro negocio.
--
-- La foránea COMPUESTA cambia la condición de "este producto existe" a "este
-- producto existe Y es de este negocio". El destino necesita un índice único
-- sobre el par para poder ser apuntado.
create unique index if not exists uq_products_id_business
  on public.products (id, business_id);
create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

do $$
begin
  if exists (select 1 from pg_constraint
    where conname = 'product_variants_product_id_fkey'
      and conrelid = 'public.product_variants'::regclass) then
    alter table public.product_variants drop constraint product_variants_product_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint
    where conname = 'fk_product_variants_producto_del_negocio'
      and conrelid = 'public.product_variants'::regclass) then
    alter table public.product_variants
      add constraint fk_product_variants_producto_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;

  if exists (select 1 from pg_constraint
    where conname = 'products_category_id_fkey'
      and conrelid = 'public.products'::regclass) then
    alter table public.products drop constraint products_category_id_fkey;
  end if;
  if not exists (select 1 from pg_constraint
    where conname = 'fk_products_categoria_del_negocio'
      and conrelid = 'public.products'::regclass) then
    -- `set null (category_id)` y no `set null` a secas: sin nombrar la columna
    -- PostgreSQL anularía también `business_id`, que es NOT NULL, y borrar una
    -- categoría reventaría. Necesita PostgreSQL 15 o superior.
    alter table public.products
      add constraint fk_products_categoria_del_negocio
      foreign key (category_id, business_id)
      references public.product_categories (id, business_id)
      on delete set null (category_id);
  end if;
end $$;

-- Los extras extienden menu_modifiers en vez de duplicar el concepto: esa tabla
-- ya resuelve los sabores del modo menú y el dueño los gestiona en un solo sitio.
alter table public.menu_modifiers
  add column if not exists price_delta numeric(10,2) not null default 0,
  add column if not exists product_id uuid references public.products(id) on delete cascade,
  add column if not exists max_selectable integer;
alter table public.menu_modifiers
  alter column category_tag drop not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.menu_modifiers'::regclass
      and conname = 'menu_modifiers_alcance_check'
  ) then
    alter table public.menu_modifiers
      add constraint menu_modifiers_alcance_check
      check (
        (category_tag is not null or product_id is not null)
        and price_delta >= 0 and price_delta <= 100000
        and (max_selectable is null or max_selectable between 1 and 20)
      );
  end if;
end;
$$;

create index if not exists idx_menu_modifiers_producto
  on public.menu_modifiers (business_id, product_id)
  where product_id is not null;
create unique index if not exists uq_menu_modifiers_producto_nombre
  on public.menu_modifiers (business_id, product_id, lower(btrim(name)))
  where product_id is not null;

-- Datos bancarios que ve el cliente al transferir. Los publica el negocio.
create table if not exists public.business_bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  bank_name      text not null,
  account_type   text not null default 'ahorros',
  account_number text not null,
  holder_name    text not null,
  holder_id      text,
  instructions   text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint business_bank_accounts_datos_check check (
    char_length(btrim(bank_name)) between 1 and 80
    and char_length(btrim(account_number)) between 1 and 40
    and char_length(btrim(holder_name)) between 1 and 120
    and account_type in ('ahorros', 'corriente')
    and char_length(coalesce(holder_id, '')) <= 20
    and char_length(coalesce(instructions, '')) <= 300
  )
);
create index if not exists idx_business_bank_accounts_negocio
  on public.business_bank_accounts (business_id, active);

-- ── CLIENTES DE LA TIENDA Y SESIONES ───────────────────────
-- La mini app no tiene registro: el cliente ya se identificó al escribir por
-- WhatsApp y el enlace que le manda el bot ES su sesión. El cliente se guarda
-- como identidad GLOBAL con una relación por negocio, así cada negocio ve lo
-- suyo y nunca sabe que ese teléfono también compra en otro sitio.
create table if not exists public.customers (
  id         uuid primary key default gen_random_uuid(),
  phone      text not null,
  name       text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customers_datos_check check (
    phone ~ '^[0-9]{8,15}$' and char_length(coalesce(name, '')) <= 120
  )
);
create unique index if not exists uq_customers_phone on public.customers (phone);

-- «CERRAR SESIÓN» desde WhatsApp (2026-09-29): las sesiones de la app emitidas
-- antes de esta fecha ya no valen. Ver `migration-2026-09-29-cerrar-sesion-de-la-app.sql`.
alter table public.customers
  add column if not exists app_sessions_valid_after timestamptz;

comment on column public.customers.app_sessions_valid_after is
  'Las sesiones de la app emitidas antes de esta fecha ya no valen. La pone CERRAR SESIÓN desde WhatsApp.';

create table if not exists public.business_customers (
  id                uuid primary key default gen_random_uuid(),
  business_id       uuid not null references public.businesses(id) on delete cascade,
  customer_id       uuid not null references public.customers(id) on delete cascade,
  display_name      text,
  first_order_at    timestamptz,
  last_order_at     timestamptz,
  total_orders      integer not null default 0,
  total_spent       numeric(12,2) not null default 0,
  marketing_consent boolean not null default false,
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint business_customers_datos_check check (
    total_orders >= 0 and total_spent >= 0
    and char_length(coalesce(display_name, '')) <= 120
    and char_length(coalesce(notes, '')) <= 500
  )
);
create unique index if not exists uq_business_customers
  on public.business_customers (business_id, customer_id);
create index if not exists idx_business_customers_recientes
  on public.business_customers (business_id, last_order_at desc);

-- ── Modo mini app: cuándo se le mandó el enlace a este cliente ─────────────
-- Vivía en un `Map` del proceso, así que se perdía al reiniciar y no servía
-- con dos instancias (migration-2026-08-02-miniapp-enlace-24h.sql).
alter table public.business_customers
  add column if not exists storefront_link_sent_at timestamptz;

-- ── Quien escribe por molestar: techo automático y bloqueo del dueño ───────
-- `muted_until` lo pone SOLO el techo (temporal, 24 h: un contador no puede
-- condenar a nadie). `blocked_at` lo pone el DUEÑO desde su panel, no caduca y
-- es total: el bot calla y la mini app le rechaza el pedido.
-- (migration-2026-08-13-molestias-y-bloqueo.sql)
alter table public.business_customers
  add column if not exists blocked_at         timestamptz,
  add column if not exists muted_until        timestamptz,
  add column if not exists reply_window_start timestamptz,
  add column if not exists reply_count        integer not null default 0,
  -- El último mensaje entrante que ya se contó: la entrada es at-least-once y
  -- un reintento del worker sumaba dos veces
  -- (migration-2026-08-15-reclamo-idempotente.sql).
  add column if not exists last_reply_message_id text,
  -- Cuándo se le EXPLICÓ el bloqueo. Hasta el 2026-08-27 no se le decía nunca,
  -- y el cliente bloqueado por no recoger sus pedidos no se enteraba de qué
  -- hizo mal. Se reclama UNA vez y se limpia al desbloquear
  -- (migration-2026-08-27-techo-y-aviso-de-bloqueo.sql).
  add column if not exists blocked_notified_at timestamptz;

alter table public.business_customers
  drop constraint if exists business_customers_respuestas_check;
alter table public.business_customers
  add constraint business_customers_respuestas_check
  check (reply_count >= 0);

create index if not exists idx_business_customers_bloqueados
  on public.business_customers (business_id, blocked_at)
  where blocked_at is not null;

-- ── Un cliente bloqueado no crea pedidos desde la tienda ──────────────────
-- El cinturón de la comprobación de la ruta: cierra la carrera y no falla
-- abierto. Acotado a `source = 'storefront'` — un pedido de mostrador lo
-- teclea el dueño con la persona delante.
-- (migration-2026-08-15-bloqueo-en-el-pedido.sql)
create or replace function public.storefront_customer_blocked(
  p_business_id uuid,
  p_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.business_customers
    where business_id = p_business_id
      and customer_id = p_customer_id
      and blocked_at is not null
  );
$$;

revoke all on function public.storefront_customer_blocked(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_blocked(uuid, uuid)
  to service_role;

-- ── El cinturón ────────────────────────────────────────────────────────────
--
-- Va dentro de la MISMA transacción que la inserción, así que cierra también
-- la carrera: entre la comprobación de la ruta y el `insert` caben
-- milisegundos, y el dueño puede bloquear justo ahí.
create or replace function public.orders_reject_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') = 'storefront'
     and new.customer_id is not null
     and public.storefront_customer_blocked(new.business_id, new.customer_id) then
    raise exception using
      errcode = '42501',
      message = 'Este local no esta recibiendo tus pedidos ahora mismo.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_reject_blocked on public.orders;
create trigger orders_reject_blocked
  before insert on public.orders
  for each row execute function public.orders_reject_blocked();

-- Por negocio a propósito: que una pizzería vea a dónde pidió ese cliente en
-- otro local sería filtrar datos entre negocios.
create table if not exists public.customer_addresses (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  label       text not null default 'Casa',
  address     text not null,
  reference   text,
  latitude    numeric(10,7),
  longitude   numeric(10,7),
  is_default  boolean not null default false,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint customer_addresses_datos_check check (
    char_length(btrim(label)) between 1 and 40
    and char_length(btrim(address)) between 1 and 300
    and char_length(coalesce(reference, '')) <= 300
    and (latitude is null or latitude between -90 and 90)
    and (longitude is null or longitude between -180 and 180)
  )
);
create index if not exists idx_customer_addresses_cliente
  on public.customer_addresses (business_id, customer_id, active);

-- Se guarda el HASH del token, nunca el token. `device_hash` se graba la PRIMERA
-- vez que se abre el enlace: a partir de ahí la sesión pertenece a ese navegador,
-- así que un enlace reenviado no sirve para comprar.
create table if not exists public.storefront_sessions (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,
  customer_id   uuid not null references public.customers(id) on delete cascade,
  token_hash    text not null,
  contact_phone text not null,
  device_hash   text,
  claimed_at    timestamptz,
  -- Nulo = no caduca. Es el caso normal desde el 2026-08-02
  -- (migration-2026-08-02-enlace-permanente.sql).
  expires_at    timestamptz,
  -- Cuándo se confirmó el número de WhatsApp desde este dispositivo.
  verified_at   timestamptz,
  last_seen_at  timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz not null default now(),
  constraint storefront_sessions_datos_check check (
    token_hash ~ '^[0-9a-f]{64}$' and contact_phone ~ '^[0-9]{8,15}$'
    and (device_hash is null or device_hash ~ '^[0-9a-f]{64}$')
    and (device_hash is null) = (claimed_at is null)
  )
);
create unique index if not exists uq_storefront_sessions_token
  on public.storefront_sessions (token_hash);
create index if not exists idx_storefront_sessions_vigentes
  on public.storefront_sessions (expires_at) where revoked_at is null;

alter table public.orders
  add column if not exists customer_id uuid references public.customers(id) on delete set null,
  add column if not exists source text not null default 'whatsapp',
  add column if not exists address_id uuid references public.customer_addresses(id) on delete set null,
  add column if not exists fulfillment text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_origen_check'
  ) then
    alter table public.orders add constraint orders_origen_check check (
      source in ('whatsapp', 'storefront', 'marketplace', 'manual')
      and (fulfillment is null or fulfillment in ('delivery', 'pickup', 'onsite'))
    );
  end if;
end;
$$;
create index if not exists idx_orders_cliente
  on public.orders (business_id, customer_id, created_at desc);


-- Un pedido entregado genera su venta: los reportes leen `sales`, así que sin
-- esto un pedido de la tienda se entregaba y no aparecía en ningún número
-- (migration-2026-08-02-pedido-entregado-es-venta.sql).
alter table public.sales
  add column if not exists order_id uuid references public.orders(id) on delete set null;
-- Un pedido, una venta como máximo: es lo que impide duplicar el dinero al
-- marcar «entregado» dos veces o al reintentar tras un fallo de red.
create unique index if not exists uq_sales_order
  on public.sales (order_id) where order_id is not null;
create index if not exists idx_sales_biz_order
  on public.sales (business_id, order_id);

-- Estados de reparto y de pago en instalaciones creadas antes de que
-- existieran (migration-2026-08-02-estados-pedido.sql y
-- migration-2026-08-05-pedidos-sin-duplicados.sql). Solo AÑADE valores
-- permitidos: ninguna fila existente puede quedar fuera del CHECK nuevo.
--
-- ⚠️ Esta es la definición que MANDA: va después de la del `create table`, así
-- que añadir un estado allí y olvidarlo aquí lo deja fuera igualmente.
alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders add constraint orders_status_check check (
  status in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  )
);

-- Envío, método de pago y comprobante de la tienda
-- (migration-2026-08-02-tienda-pago-envio-marca.sql).
alter table public.orders
  add column if not exists shipping numeric(10,2) not null default 0,
  add column if not exists payment_method text,
  add column if not exists payment_proof_url text,
  -- Sin el identificador no se puede firmar el acceso temporal, y el
  -- comprobante volvería a ser público para siempre
  -- (migration-2026-08-05-comprobantes-privados.sql).
  add column if not exists payment_proof_public_id text;
alter table public.businesses
  add column if not exists delivery_fee numeric(10,2) not null default 0,
  add column if not exists brand_color text,
  add column if not exists logo_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass and conname = 'orders_pago_check'
  ) then
    -- `payment_method` queda nulo en los pedidos del bot, que no preguntan cómo
    -- se paga. La tarjeta no existe: la plataforma no cobra (regla #6).
    alter table public.orders add constraint orders_pago_check check (
      shipping >= 0
      and (payment_method is null or payment_method in ('transferencia', 'efectivo'))
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_tienda_check'
  ) then
    alter table public.businesses add constraint businesses_tienda_check check (
      delivery_fee >= 0 and delivery_fee <= 999
      and (brand_color is null or brand_color ~ '^#[0-9a-fA-F]{6}$')
    );
  end if;
  -- El logo acaba en un <img> de una app pública: solo https.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_logo_check'
  ) then
    alter table public.businesses add constraint businesses_logo_check check (
      logo_url is null or logo_url ~ '^https://'
    );
  end if;
end;
$$;
-- Pedidos en curso: los pide la alarma del panel cada 12 s por negocio y los
-- listará la bandeja de Pedidos. Parcial para no encarecer los ya cerrados.
create index if not exists idx_orders_activos
  on public.orders (business_id, created_at desc)
  where status in ('pendiente', 'confirmado', 'preparacion', 'en_camino');

create or replace function public.cleanup_storefront_sessions(p_days integer default 2)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
  v_days integer := greatest(coalesce(p_days, 2), 1);
begin
  with deleted as (
    delete from public.storefront_sessions as target
    -- `is not null` primero: comparar null con una fecha da null, no false,
    -- y el borrado dejaría de funcionar del todo sin avisar.
    where target.expires_at is not null
      and target.expires_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;
revoke all on function public.cleanup_storefront_sessions(integer)
  from public, anon, authenticated;

-- ── UN ENLACE VIVO A LA VEZ ────────────────────────────────────────────────
-- migration-2026-09-03-enlace-de-un-uso.sql. `revoked_at` existía desde el
-- principio, lo miraba `checkSession`… y nadie lo escribía nunca: quien había
-- pedido en cinco locales tenía cinco enlaces vivos y podía volver a
-- cualquiera con la conversación puesta en otro sitio.
--
-- ⚠️ Dos excepciones, y las dos evitan un callejón sin salida: el local que se
-- acaba de entregar (matarlo vaciaría el carrito que la persona tiene abierto)
-- y cualquier local donde quede un pedido en `esperando_pago` (los datos
-- bancarios viven detrás de la sesión). Falla hacia NO revocar.
create or replace function public.revoke_other_storefront_sessions(
  p_customer_id     uuid,
  p_keep_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_local_vigente uuid;
  v_revocadas     integer;
begin
  if p_customer_id is null or p_keep_session_id is null then
    return 0;
  end if;

  select business_id into v_local_vigente
    from public.storefront_sessions
   where id = p_keep_session_id;

  -- Revocar de más deja a un cliente legítimo fuera de su tienda; dejar un
  -- enlace viejo vivo un rato más es recuperable.
  if v_local_vigente is null then
    return 0;
  end if;

  with revocadas as (
    update public.storefront_sessions as sesion
       set revoked_at = now()
     where sesion.customer_id = p_customer_id
       and sesion.revoked_at is null
       and sesion.id <> p_keep_session_id
       and sesion.business_id <> v_local_vigente
       and not exists (
         select 1
           from public.orders as pedido
          where pedido.customer_id  = p_customer_id
            and pedido.business_id  = sesion.business_id
            and pedido.source       = 'storefront'
            and pedido.status       = 'esperando_pago'
       )
    returning 1
  )
  select count(*)::integer into v_revocadas from revocadas;

  return coalesce(v_revocadas, 0);
end;
$$;

comment on function public.revoke_other_storefront_sessions(uuid, uuid) is
  'Un enlace vivo a la vez por persona. Conserva el del local recién entregado '
  'y el de cualquier local donde quede un pedido en esperando_pago.';

revoke all on function public.revoke_other_storefront_sessions(uuid, uuid)
  from public, anon, authenticated;

-- ── «SEGUIR MI PEDIDO» MATA TODO LO DE ATRÁS ──────────────────────────────
-- migration-2026-09-16-seguir-mi-pedido-mata-lo-de-atras.sql. Como la de
-- arriba, pero el enlace viejo del MISMO local también cae: tras «seguir mi
-- pedido» solo vale el enlace nuevo. El local que debe dinero no cede.
create or replace function public.revoke_storefront_sessions_except(
  p_customer_id     uuid,
  p_keep_session_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revocadas integer;
begin
  if p_customer_id is null or p_keep_session_id is null then
    return 0;
  end if;

  -- Falla hacia NO revocar: si la sesión que hay que conservar no existe, no
  -- se toca nada. Revocar de más deja a un cliente legítimo sin ningún enlace;
  -- un enlace viejo vivo un rato más es recuperable.
  if not exists (
    select 1 from public.storefront_sessions
     where id = p_keep_session_id
       and customer_id = p_customer_id
  ) then
    return 0;
  end if;

  with revocadas as (
    update public.storefront_sessions as sesion
       set revoked_at = now()
     where sesion.customer_id = p_customer_id
       and sesion.revoked_at is null
       and sesion.id <> p_keep_session_id
       -- ⚠️ Aquí la vieja añadía `and sesion.business_id <> v_local_vigente`.
       -- Quitarlo es la diferencia entera: el enlace viejo del MISMO local cae.
       and not exists (
         select 1
           from public.orders as pedido
          where pedido.customer_id  = p_customer_id
            and pedido.business_id  = sesion.business_id
            and pedido.source       = 'storefront'
            and pedido.status       = 'esperando_pago'
       )
    returning 1
  )
  select count(*)::integer into v_revocadas from revocadas;

  return coalesce(v_revocadas, 0);
end;
$$;

comment on function public.revoke_storefront_sessions_except(uuid, uuid) is
  'Deja vivo SOLO el enlace indicado, incluso dentro del mismo local. Conserva '
  'el de cualquier local donde quede un pedido en esperando_pago.';

revoke all on function public.revoke_storefront_sessions_except(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_other_storefront_sessions(uuid, uuid)
  to service_role;

-- Al salir con MENÚ o «Empezar de nuevo»: el enlace lo deciden los PEDIDOS,
-- no el chat (2026-09-27). Ver `migration-2026-09-27-enlaces-al-salir.sql`.
create or replace function public.revoke_storefront_sessions_on_exit(
  p_customer_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_revocadas integer;
begin
  if p_customer_id is null then
    return 0;
  end if;

  with revocadas as (
    update public.storefront_sessions as sesion
       set revoked_at = now()
     where sesion.customer_id = p_customer_id
       and sesion.revoked_at is null
       -- ⚠️ La excepción: el local donde todavía se le necesita. Se mira el
       -- pedido TAL COMO ESTÁ AHORA, después de que MENÚ cancelara el suyo.
       and not exists (
         select 1
           from public.orders as pedido
          where pedido.customer_id = p_customer_id
            and pedido.business_id = sesion.business_id
            and pedido.source      = 'storefront'
            and pedido.status in ('esperando_pago', 'pago_en_revision')
       )
    returning 1
  )
  select count(*)::integer into v_revocadas from revocadas;

  return coalesce(v_revocadas, 0);
end;
$$;

comment on function public.revoke_storefront_sessions_on_exit(uuid) is
  'MENÚ y «Empezar de nuevo»: revoca todos los enlaces del cliente salvo los de '
  'un local donde aún tenga un pedido de la tienda esperando pago o en revisión.';

revoke all on function public.revoke_storefront_sessions_on_exit(uuid)
  from public, anon, authenticated;
grant execute on function public.revoke_storefront_sessions_on_exit(uuid)
  to service_role;

create index if not exists idx_storefront_sessions_por_cliente
  on public.storefront_sessions (customer_id) where revoked_at is null;

-- ── PEDIDOS DESDE LA MINI APP ──────────────────────────────
-- create_order_with_items valida el precio contra products.price, asi que
-- rechazaria un pedido con variantes. La tienda tiene su propia RPC: la app
-- manda ids y cantidades, jamas precios.
-- ── El ítem del pedido recuerda qué eligió el cliente ───────────────────────
-- Sin esto, el negocio ve "Pizza Pepperoni" y no sabe si era Personal o
-- Familiar, ni que llevaba queso extra.
alter table public.order_items
  add column if not exists variant_id uuid references public.product_variants(id) on delete set null,
  add column if not exists variant_name text,
  add column if not exists extras_names text[] not null default '{}'::text[],
  add column if not exists item_note text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_items'::regclass
      and conname = 'order_items_detalle_check'
  ) then
    alter table public.order_items
      add constraint order_items_detalle_check
      check (
        char_length(coalesce(variant_name, '')) <= 60
        and cardinality(extras_names) <= 20
        and char_length(coalesce(item_note, '')) <= 200
      );
  end if;
end;
$$;


-- ── Pedido de la tienda ─────────────────────────────────────────────────────
-- La firma cambió al añadir el método de pago: dejar viva la anterior haría
-- ambigua cualquier llamada.
drop function if exists public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text
);

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  if p_payment_method is not null and p_payment_method not in ('transferencia', 'efectivo') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

revoke all on function public.create_storefront_order(
  uuid, uuid, text, text, uuid, text, jsonb, text, text, text, timestamptz
) from public, anon, authenticated;

-- ── COMPROBANTE DE TRANSFERENCIA DE LA TIENDA ──────────────
-- Lo sube el CLIENTE desde la mini app, que no tiene JWT: su credencial es el
-- enlace. Por eso la pertenencia se comprueba con las tres cosas a la vez
-- —negocio, pedido y teléfono de la sesión—: sin esto, cualquiera con un id de
-- pedido ajeno podría colgarle una imagen.
-- La firma cambió al añadir el identificador de Cloudinary: dejar viva la
-- anterior haría ambigua cualquier llamada.
drop function if exists public.attach_storefront_payment_proof(uuid, uuid, text, text);

create or replace function public.attach_storefront_payment_proof(
  p_business_id uuid,
  p_order_id uuid,
  p_contact_phone text,
  p_url text,
  p_public_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  if nullif(btrim(coalesce(p_url, '')), '') is null or p_url !~ '^https://' then
    raise exception using errcode = '22023', message = 'El comprobante debe ser una URL https';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and business_id = p_business_id
    and contact_phone = btrim(p_contact_phone)
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Un pedido ya cerrado no admite comprobante: o se pagó, o se anuló.
  if v_order.status in ('completado', 'cancelado', 'expirado') then
    return jsonb_build_object('result', 'invalid_state', 'status', v_order.status);
  end if;

  -- Se guarda el identificador ADEMÁS de la URL: sin él no se puede firmar el
  -- acceso temporal, y el comprobante volvería a ser público para siempre.
  --
  -- Y el pedido pasa a REVISIÓN. Antes se quedaba en «pendiente» con una
  -- imagen colgada y nada que avisara al dueño de que había un pago esperando
  -- a que alguien lo mirara. Solo se mueve desde los estados en los que aún se
  -- está esperando el pago: si el dueño ya lo confirmó a mano, mandar otro
  -- comprobante no puede echarlo atrás.
  update public.orders
  set payment_proof_url = p_url,
      payment_proof_public_id = p_public_id,
      status = case
        when v_order.status in ('pendiente', 'esperando_pago') then 'pago_en_revision'
        else v_order.status
      end,
      updated_at = now()
  where id = p_order_id and business_id = p_business_id;

  if v_order.status in ('pendiente', 'esperando_pago') then
    insert into public.order_events (business_id, order_id, from_status, to_status, note)
    values (p_business_id, p_order_id, v_order.status, 'pago_en_revision',
            'El cliente subió su comprobante');
  end if;

  return jsonb_build_object('result', 'updated');
end;
$$;

revoke all on function public.attach_storefront_payment_proof(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.attach_storefront_payment_proof(uuid, uuid, text, text, text)
  to service_role;

-- ── REGISTRO DE ERRORES DE PLATAFORMA ──────────────────────
-- La huella llega calculada desde Node y NO se genera con digest() aquí: esa
-- función fuera del search_path fue justamente lo que tumbó el canal de entrada
-- cinco días en julio de 2026.
create or replace function public.record_platform_error(
  p_business_id uuid,
  p_category text,
  p_code text,
  p_message text,
  p_context jsonb,
  p_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_message text;
  v_context jsonb;
begin
  if p_category not in ('canal', 'ia', 'envio', 'servidor') then
    raise exception using errcode = '22023', message = 'Categoria de error invalida';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella de error invalida';
  end if;

  v_message := left(coalesce(nullif(btrim(p_message), ''), 'Error sin detalle'), 2000);
  v_context := case
    when jsonb_typeof(p_context) = 'object' and pg_column_size(p_context) <= 8192
      then p_context
    else '{}'::jsonb
  end;

  -- Upsert atómico. Se resuelve con `on conflict` sobre los índices parciales en
  -- lugar de capturar excepciones: así el registro nunca deja una transacción a
  -- medias, ni siquiera si dos errores idénticos llegan a la vez.
  if p_business_id is null then
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      null, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (fingerprint) where business_id is null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  else
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      p_business_id, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (business_id, fingerprint) where business_id is not null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  end if;

  return v_id;
end;
$$;

create or replace function public.cleanup_platform_errors(p_days integer default 30)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_deleted integer;
  v_days integer := greatest(coalesce(p_days, 30), 1);
begin
  with deleted as (
    delete from public.platform_errors as target
    where target.last_seen_at < now() - make_interval(days => v_days)
    returning 1
  )
  select count(*)::integer into v_deleted from deleted;
  return coalesce(v_deleted, 0);
end;
$$;

revoke all on function public.record_platform_error(uuid, text, text, text, jsonb, text)
  from public, anon, authenticated;
revoke all on function public.cleanup_platform_errors(integer)
  from public, anon, authenticated;

-- ── ROW LEVEL SECURITY (RLS) ───────────────────────────────
-- RLS ACTIVADO en todas las tablas. El backend usa la SERVICE KEY
-- (la bypassa); el aislamiento real lo refuerza el filtrado por
-- business_id en db.js. La anon key del frontend queda BLOQUEADA
-- (no lee datos directo) → por eso el frontend usa polling vía API.
alter table businesses            enable row level security;
alter table business_channel_identifiers enable row level security;
alter table client_users          enable row level security;
alter table products              enable row level security;
alter table menu_modifiers        enable row level security;
alter table conversation_history  enable row level security;
alter table conversation_sessions enable row level security;
alter table conversation_tags     enable row level security;
alter table business_schedule     enable row level security;
alter table billing               enable row level security;
alter table server_settings       enable row level security;
alter table schema_migrations     enable row level security;
alter table sales                 enable row level security;
alter table sale_items            enable row level security;
alter table product_consultations enable row level security;
alter table ai_gaps               enable row level security;
alter table orders                enable row level security;
alter table order_items           enable row level security;
alter table webhook_inbound_events enable row level security;
alter table platform_errors       enable row level security;
alter table product_categories    enable row level security;
alter table product_variants      enable row level security;
alter table business_bank_accounts enable row level security;
alter table customers             enable row level security;
alter table business_customers    enable row level security;
alter table customer_addresses    enable row level security;
alter table storefront_sessions   enable row level security;

revoke all on table menu_modifiers
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table menu_modifiers
  to service_role;

revoke all on table webhook_inbound_events from public, anon, authenticated;
grant select, insert, update, delete on table webhook_inbound_events
  to service_role;

-- ============================================================
-- NOTA: el archivo migration-integraciones.sql quedó OBSOLETO.
-- Este schema.sql es la referencia única y actual del esquema.
-- ============================================================
-- Mantiene el onboarding completo en una sola transacción.
begin;

create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text := btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text := nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using errcode = '22023', message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using errcode = '22023', message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using errcode = '22023', message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using errcode = '22023', message = 'La contraseña debe llegar cifrada';
  end if;
  if p_monthly_rate is not null and p_monthly_rate <= 0 then
    raise exception using errcode = '22023', message = 'La tarifa mensual debe ser mayor que cero';
  end if;

  insert into public.businesses (
    slug, name, type, whatsapp_number, whatsapp_provider,
    ycloud_api_key, ycloud_number,
    ycloud_webhook_endpoint_id, ycloud_webhook_secret,
    meta_token, meta_phone_id, telegram_bot_token,
    takes_orders, ai_provider,
    owner_phone, plan, plan_expires_at,
    active, bot_active, suspended, notes, monthly_rate
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    coalesce(nullif(p_business ->> 'plan', ''), 'basic'),
    nullif(p_business ->> 'plan_expires_at', '')::timestamptz,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    p_monthly_rate
  ) returning * into v_business;

  insert into public.business_schedule (
    business_id, day_of_week, open_time, close_time, slot_duration, is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into public.client_users (business_id, email, password_hash, role)
    values (v_business.id, v_client_email, v_password_hash, 'owner');
  end if;

  if p_monthly_rate is not null then
    insert into public.billing (business_id, amount, status, period_start, period_end)
    select
      v_business.id,
      p_monthly_rate,
      'pending',
      (date_trunc('month', current_date) + make_interval(months => month_offset))::date,
      (date_trunc('month', current_date) + make_interval(months => month_offset + 1)
        - interval '1 day')::date
    from generate_series(0, 11) as month_offset;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(jsonb, text, text, numeric)
  from public, anon, authenticated;
grant execute on function public.create_business_onboarding(jsonb, text, text, numeric)
  to service_role;

commit;

-- ============================================================
-- FACTURACIÓN MENSUAL AUTOMÁTICA + CATÁLOGO DE SEIS PLANES
-- Fecha: 2026-07-27
--
-- Ejecutar en Supabase → SQL Editor antes de desplegar el backend.
--
-- Esta migración:
--   • conserva íntegramente las facturas históricas y las cuotas futuras;
--   • impide nuevas cuotas duplicadas por negocio y mes;
--   • genera únicamente la cuota del mes corriente de Ecuador;
--   • factura solo negocios activos y no suspendidos;
--   • reemplaza el onboarding de 12 cuotas por una sola cuota corriente;
--   • migra únicamente el código legado premium a scale.
--
-- No elimina la columna de vencimiento ni reescribe tarifas o cobros.
-- ============================================================

begin;

set local lock_timeout = '5s';
set local statement_timeout = '2min';

lock table public.businesses in share row exclusive mode;
lock table public.billing in share row exclusive mode;

-- Compatibilidad si migration-consumo-planes.sql todavía no se aplicó. Las
-- altas nuevas reciben límites explícitos según el plan; los negocios actuales
-- conservan exactamente sus límites y tarifas.
alter table public.businesses
  add column if not exists monthly_contact_limit integer,
  add column if not exists monthly_outbound_message_limit integer;

-- Una alta sin selección explícita empieza en Micro. ALTER DEFAULT no cambia
-- ninguna fila existente.
alter table public.businesses
  alter column plan set default 'micro',
  alter column monthly_contact_limit set default 50,
  alter column monthly_outbound_message_limit set default 250;

-- premium tenía exactamente la capacidad que ahora corresponde a scale.
-- No se toca monthly_rate, los límites ni ninguna factura existente.
update public.businesses
set plan = 'scale'
where lower(btrim(coalesce(plan, ''))) = 'premium';

-- Fuente de verdad del catálogo en PostgreSQL. Las RPC financieras consultan
-- esta función y rechazan cualquier tarifa o límite distinto.
create or replace function public.billing_plan_definition(p_plan text)
returns table (
  plan_code text,
  monthly_rate numeric,
  monthly_contact_limit integer,
  monthly_outbound_message_limit integer
)
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    catalog.plan_code,
    catalog.monthly_rate,
    catalog.monthly_contact_limit,
    catalog.monthly_outbound_message_limit
  from (
    values
      ('micro'::text,      25::numeric,  50,  250),
      ('basic'::text,      50::numeric, 200, 1000),
      ('pro'::text,        99::numeric, 400, 2000),
      ('growth'::text,    199::numeric, 800, 4000),
      ('scale'::text,     499::numeric, 2000, 10000),
      ('enterprise'::text, 899::numeric, 4000, 20000)
  ) as catalog (
    plan_code,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit
  )
  where catalog.plan_code = lower(btrim(coalesce(p_plan, '')));
$$;

revoke all on function public.billing_plan_definition(text)
  from public, anon, authenticated;
grant execute on function public.billing_plan_definition(text)
  to service_role;

-- Una tabla auxiliar reclama atómicamente cada combinación negocio/mes. Esto
-- permite conservar posibles duplicados históricos sin borrarlos, pero bloquea
-- cualquier duplicado nuevo incluso si dos servidores facturan a la vez.
create table if not exists public.billing_month_claims (
  business_id  uuid not null
               references public.businesses(id) on delete cascade,
  period_start date not null,
  billing_id   uuid
               references public.billing(id) on delete set null,
  claimed_at   timestamptz not null default now(),
  primary key (business_id, period_start)
);

-- Registra las cuotas existentes, incluidas las doce futuras creadas por la
-- versión anterior. DISTINCT ON conserva todas las facturas; solo elige una
-- como referencia de la clave mensual.
insert into public.billing_month_claims (
  business_id,
  period_start,
  billing_id,
  claimed_at
)
select distinct on (
  billing.business_id,
  date_trunc('month', billing.period_start)::date
)
  billing.business_id,
  date_trunc('month', billing.period_start)::date,
  billing.id,
  coalesce(billing.created_at, now())
from public.billing
where billing.period_start is not null
order by
  billing.business_id,
  date_trunc('month', billing.period_start)::date,
  billing.created_at nulls last,
  billing.id
on conflict (business_id, period_start) do nothing;

alter table public.billing_month_claims enable row level security;
revoke all on table public.billing_month_claims
  from public, anon, authenticated;
grant select on table public.billing_month_claims to service_role;

create or replace function public.claim_billing_month()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_claimed_business_id uuid;
begin
  -- Los registros históricos sin período se preservan, pero la automatización
  -- siempre crea períodos completos y sí queda protegida.
  if new.period_start is null then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.business_id is not distinct from old.business_id
       and date_trunc('month', new.period_start)::date
         is not distinct from date_trunc('month', old.period_start)::date then
      return new;
    end if;
  end if;

  insert into public.billing_month_claims (
    business_id,
    period_start,
    billing_id
  ) values (
    new.business_id,
    date_trunc('month', new.period_start)::date,
    new.id
  )
  on conflict (business_id, period_start) do nothing
  returning business_id into v_claimed_business_id;

  if v_claimed_business_id is null then
    raise exception using
      errcode = '23505',
      message = 'Ya existe una cuota para este negocio y mes',
      constraint = 'billing_one_charge_per_business_month';
  end if;

  return new;
end;
$$;

revoke all on function public.claim_billing_month()
  from public, anon, authenticated;

drop trigger if exists billing_claim_month on public.billing;
-- AFTER, no BEFORE: el disparador apunta con `billing_id` a la fila recién
-- creada de `billing`, y en un BEFORE esa fila todavía no existe. Fue así
-- hasta el 2026-08-02 y hacía imposible dar de alta cualquier cliente nuevo
-- (ver server/migration-arreglo-cuota-alta.sql).
create trigger billing_claim_month
after insert or update of business_id, period_start on public.billing
for each row execute function public.claim_billing_month();

-- Se invoca al arrancar el servidor y luego una vez al día. La fecha se calcula
-- siempre como calendario de Ecuador, independientemente del huso horario de
-- Railway o Supabase.
create or replace function public.ensure_current_month_billing()
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
  v_business record;
  v_created integer := 0;
begin
  for v_business in
    select business.id, business.monthly_rate
    from public.businesses as business
    where business.active is true
      and coalesce(business.suspended, false) is false
      and business.monthly_rate is not null
      and business.monthly_rate > 0
  loop
    if not exists (
      select 1
      from public.billing as charge
      where charge.business_id = v_business.id
        and charge.period_start >= v_period_start
        and charge.period_start <= v_period_end
    ) then
      begin
        insert into public.billing (
          business_id,
          amount,
          currency,
          period_start,
          period_end,
          status,
          notes
        ) values (
          v_business.id,
          v_business.monthly_rate,
          'USD',
          v_period_start,
          v_period_end,
          'pending',
          'Cuota mensual automática'
        );
        v_created := v_created + 1;
      exception
        -- Otra instancia pudo reclamar el mes entre el NOT EXISTS y el INSERT.
        -- El trigger garantiza que esa carrera termina en una sola cuota.
        when unique_violation then null;
      end;
    end if;
  end loop;

  return v_created;
end;
$$;

revoke all on function public.ensure_current_month_billing()
  from public, anon, authenticated;
grant execute on function public.ensure_current_month_billing()
  to service_role;

-- Reactivar conserva la suspensión como decisión manual y emite de inmediato
-- la cuota corriente si corresponde; nunca altera una fecha de vencimiento.
create or replace function public.reactivate_business_with_billing(
  p_business_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  update public.businesses
  set suspended = false,
      bot_active = true,
      suspension_reason = null
  where id = p_business_id
  returning * into v_business;

  if not found then
    return false;
  end if;

  if v_business.active is true
     and v_business.monthly_rate is not null
     and v_business.monthly_rate > 0
     and not exists (
       select 1
       from public.billing as charge
       where charge.business_id = v_business.id
         and charge.period_start >= v_period_start
         and charge.period_start <= v_period_end
     ) then
    begin
      insert into public.billing (
        business_id,
        amount,
        currency,
        period_start,
        period_end,
        status,
        notes
      ) values (
        v_business.id,
        v_business.monthly_rate,
        'USD',
        v_period_start,
        v_period_end,
        'pending',
        'Cuota mensual automática'
      );
    exception
      when unique_violation then null;
    end;
  end if;

  return true;
end;
$$;

revoke all on function public.reactivate_business_with_billing(uuid)
  from public, anon, authenticated;
grant execute on function public.reactivate_business_with_billing(uuid)
  to service_role;

-- Cambio de plan transaccional: negocio, tarifa y límites quedan sincronizados.
-- Solo actualiza cuotas pendientes del mes corriente o posteriores; nunca toca
-- cobros pagados ni facturas de meses anteriores.
create or replace function public.update_business_plan_billing(
  p_business_id uuid,
  p_plan text,
  p_monthly_rate numeric,
  p_monthly_contact_limit integer,
  p_monthly_outbound_message_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan text := lower(btrim(coalesce(p_plan, '')));
  v_plan_definition record;
  v_business public.businesses%rowtype;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;
  if p_monthly_rate is distinct from v_plan_definition.monthly_rate
     or p_monthly_contact_limit
       is distinct from v_plan_definition.monthly_contact_limit
     or p_monthly_outbound_message_limit
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'La tarifa o los límites no coinciden con el catálogo del plan';
  end if;

  update public.businesses
  set plan = v_plan_definition.plan_code,
      monthly_rate = v_plan_definition.monthly_rate,
      monthly_contact_limit = v_plan_definition.monthly_contact_limit,
      monthly_outbound_message_limit =
        v_plan_definition.monthly_outbound_message_limit
  where id = p_business_id
  returning * into v_business;

  if not found then
    raise exception using
      errcode = 'P0002',
      message = 'El negocio no existe';
  end if;

  update public.billing
  set amount = v_plan_definition.monthly_rate
  where business_id = p_business_id
    and status = 'pending'
    and period_start >= v_period_start;

  if v_business.active is true
     and coalesce(v_business.suspended, false) is false
     and not exists (
       select 1
       from public.billing as charge
       where charge.business_id = v_business.id
         and charge.period_start >= v_period_start
         and charge.period_start <= v_period_end
     ) then
    begin
      insert into public.billing (
        business_id,
        amount,
        currency,
        period_start,
        period_end,
        status,
        notes
      ) values (
        v_business.id,
        v_plan_definition.monthly_rate,
        'USD',
        v_period_start,
        v_period_end,
        'pending',
        'Cuota mensual automática'
      );
    exception
      when unique_violation then null;
    end;
  end if;

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.update_business_plan_billing(
  uuid,
  text,
  numeric,
  integer,
  integer
) from public, anon, authenticated;
grant execute on function public.update_business_plan_billing(
  uuid,
  text,
  numeric,
  integer,
  integer
) to service_role;

-- Alta atómica actualizada. Los códigos y capacidades oficiales son:
--   micro      $25  ·   50 contactos ·    250 mensajes
--   basic      $50  ·  200 contactos ·  1.000 mensajes (Inicial)
--   pro        $99  ·  400 contactos ·  2.000 mensajes
--   growth    $199  ·  800 contactos ·  4.000 mensajes
--   scale     $499  · 2000 contactos · 10.000 mensajes
--   enterprise $899 · 4000 contactos · 20.000 mensajes
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text :=
    btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_client_email text :=
    nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_chat_mode text :=
    coalesce(nullif(btrim(p_business ->> 'chat_mode'), ''), 'ai');
  v_plan text :=
    lower(coalesce(nullif(btrim(p_business ->> 'plan'), ''), 'micro'));
  v_plan_definition record;
  v_monthly_rate numeric;
  v_contact_limit integer;
  v_outbound_limit integer;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' or v_whatsapp_number = '' then
    raise exception using
      errcode = '22023',
      message = 'Nombre, slug y número son obligatorios';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using
      errcode = '22023',
      message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null
     and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using
      errcode = '22023',
      message = 'La contraseña debe llegar cifrada';
  end if;
  if v_chat_mode not in ('menu', 'ai', 'miniapp') then
    raise exception using
      errcode = '22023',
      message = 'El modo de conversación debe ser menu, ai o miniapp';
  end if;
  if v_chat_mode = 'miniapp' and (
    coalesce((p_business ->> 'takes_orders')::boolean, true) is not true
    or coalesce((p_business ->> 'storefront_enabled')::boolean, false) is not true
  ) then
    raise exception using
      errcode = '22023',
      message = 'El modo miniapp requiere pedidos y tienda habilitados';
  end if;

  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;

  if p_monthly_rate is not null
     and p_monthly_rate is distinct from v_plan_definition.monthly_rate then
    raise exception using
      errcode = '22023',
      message = 'La tarifa no coincide con el catálogo del plan';
  end if;
  if nullif(p_business ->> 'monthly_contact_limit', '') is not null
     and nullif(p_business ->> 'monthly_contact_limit', '')::integer
       is distinct from v_plan_definition.monthly_contact_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de contactos no coincide con el catálogo del plan';
  end if;
  if nullif(
    p_business ->> 'monthly_outbound_message_limit',
    ''
  ) is not null
     and nullif(
       p_business ->> 'monthly_outbound_message_limit',
       ''
     )::integer
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de mensajes no coincide con el catálogo del plan';
  end if;

  v_plan := v_plan_definition.plan_code;
  v_monthly_rate := v_plan_definition.monthly_rate;
  v_contact_limit := v_plan_definition.monthly_contact_limit;
  v_outbound_limit := v_plan_definition.monthly_outbound_message_limit;

  insert into public.businesses (
    slug,
    name,
    type,
    whatsapp_number,
    whatsapp_provider,
    ycloud_api_key,
    ycloud_number,
    ycloud_webhook_endpoint_id,
    ycloud_webhook_secret,
    meta_token,
    meta_phone_id,
    telegram_bot_token,
    takes_orders,
    chat_mode,
    ai_provider,
    owner_phone,
    plan,
    active,
    bot_active,
    suspended,
    notes,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    v_whatsapp_number,
    coalesce(nullif(p_business ->> 'whatsapp_provider', ''), 'ycloud'),
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    v_chat_mode,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    v_plan,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    v_monthly_rate,
    v_contact_limit,
    v_outbound_limit
  )
  returning * into v_business;

  insert into public.business_schedule (
    business_id,
    day_of_week,
    open_time,
    close_time,
    slot_duration,
    is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into public.client_users (
      business_id,
      email,
      password_hash,
      role
    ) values (
      v_business.id,
      v_client_email,
      v_password_hash,
      'owner'
    );
  end if;

  insert into public.billing (
    business_id,
    amount,
    currency,
    status,
    period_start,
    period_end,
    notes
  ) values (
    v_business.id,
    v_monthly_rate,
    'USD',
    'pending',
    v_period_start,
    v_period_end,
    'Cuota mensual automática'
  );

  return to_jsonb(v_business);
end;
$$;

revoke all on function public.create_business_onboarding(
  jsonb,
  text,
  text,
  numeric
) from public, anon, authenticated;
grant execute on function public.create_business_onboarding(
  jsonb,
  text,
  text,
  numeric
) to service_role;

commit;

-- ── FRONTERAS DE LAS VENTAS ────────────────────────────────
-- Las claves foráneas de `sales` hacia pedidos, citas y estadías son
-- COMPUESTAS sobre (id, business_id): una simple solo comprueba que la fila
-- exista, no de quién es, y dejaba que una venta apuntara a algo de otro
-- negocio (migration-2026-08-02-fronteras-de-las-ventas.sql).
-- ── 1. Los destinos necesitan su índice único (id, business_id) ───────────
create unique index if not exists uq_orders_id_business
  on public.orders (id, business_id);

create or replace function public.claim_storefront_link_send(
  p_business_id uuid,
  p_customer_id uuid,
  p_cooldown_hours integer default 24
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reclamado boolean;
begin
  if p_business_id is null or p_customer_id is null then
    return false;
  end if;

  -- La fila de la relación puede no existir todavía si el cliente nunca pidió
  -- nada: se crea aquí para poder anotar el envío.
  insert into public.business_customers (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

  -- `for update` serializa a los mensajes que lleguen a la vez del mismo
  -- cliente. Sin esto, tres «hola» seguidos mandan tres enlaces.
  update public.business_customers
  set storefront_link_sent_at = now(),
      updated_at = now()
  where business_id = p_business_id
    and customer_id = p_customer_id
    and (
      storefront_link_sent_at is null
      or storefront_link_sent_at
         < now() - make_interval(hours => greatest(coalesce(p_cooldown_hours, 24), 0))
    )
  returning true into v_reclamado;

  return coalesce(v_reclamado, false);
end;
$$;

revoke all on function public.claim_storefront_link_send(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_storefront_link_send(uuid, uuid, integer)
  to service_role;

-- ── El reclamo de una respuesta ────────────────────────────────────────────
--
-- Una sola operación atómica que hace las preguntas y deja la cuenta puesta.
-- Comprobar primero y escribir después deja una carrera en la que dos mensajes
-- simultáneos del mismo contacto leen el mismo número — que es justo lo que
-- hace quien escribe rápido para molestar.
--
-- ⚠️ Y es IDEMPOTENTE por id de mensaje: la entrada es at-least-once, así que
-- un reintento del worker volvía a sumar y podía silenciar a un cliente
-- legítimo (migration-2026-08-15-reclamo-idempotente.sql).
-- La firma cambia (un parámetro más), así que la anterior se retira: sin esto
-- PostgreSQL se queda con las dos y `db.rpc` elegiría por número de argumentos
-- sin que nadie se entere.
drop function if exists public.claim_miniapp_reply(uuid, uuid, integer, integer, integer);

create or replace function public.claim_miniapp_reply(
  p_business_id uuid,
  p_customer_id uuid,
  p_aviso_desde integer default 5,
  p_tope        integer default 10,
  p_silencio_horas integer default 24,
  -- El id del mensaje ENTRANTE que provocó esta respuesta. Nulo = no se puede
  -- identificar (el simulador, Telegram sin id): entonces se cuenta como
  -- antes, porque el riesgo de contar de más es menor que el de no contar.
  p_message_id  text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.business_customers%rowtype;
  v_ahora timestamptz := now();
  v_cuenta integer;
begin
  if p_business_id is null or p_customer_id is null then
    return jsonb_build_object('permitido', true, 'motivo', 'ok', 'respuestas', 0);
  end if;

  insert into public.business_customers (business_id, customer_id)
  values (p_business_id, p_customer_id)
  on conflict (business_id, customer_id) do nothing;

  select * into v_fila
  from public.business_customers
  where business_id = p_business_id and customer_id = p_customer_id
  for update;

  if v_fila.blocked_at is not null then
    return jsonb_build_object('permitido', false, 'motivo', 'bloqueado', 'respuestas', 0);
  end if;

  if v_fila.muted_until is not null and v_fila.muted_until > v_ahora then
    return jsonb_build_object('permitido', false, 'motivo', 'silenciado', 'respuestas', 0);
  end if;

  -- ── El mismo mensaje otra vez ────────────────────────────────────────────
  -- Se devuelve la decisión que le tocaba, recalculada del contador que ya
  -- tiene, y NO se suma. El motivo se recalcula en vez de guardarse porque
  -- depende solo de la cuenta: guardarlo sería una segunda fuente de verdad.
  if p_message_id is not null
     and v_fila.last_reply_message_id is not distinct from p_message_id then
    return jsonb_build_object(
      'permitido', true,
      'motivo', case when coalesce(v_fila.reply_count, 0) >= p_aviso_desde
                     then 'con_telefono' else 'ok' end,
      'respuestas', coalesce(v_fila.reply_count, 0),
      'repetido', true
    );
  end if;

  if v_fila.reply_window_start is null
     or v_fila.reply_window_start < v_ahora - interval '1 hour' then
    v_cuenta := 1;
    update public.business_customers
       set reply_window_start = v_ahora,
           reply_count = 1,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  else
    v_cuenta := coalesce(v_fila.reply_count, 0) + 1;
    update public.business_customers
       set reply_count = v_cuenta,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  end if;

  if v_cuenta > p_tope then
    update public.business_customers
       set muted_until = v_ahora + make_interval(hours => p_silencio_horas),
           updated_at = v_ahora
     where id = v_fila.id;
    return jsonb_build_object('permitido', false, 'motivo', 'silenciado', 'respuestas', v_cuenta);
  end if;

  return jsonb_build_object(
    'permitido', true,
    'motivo', case when v_cuenta >= p_aviso_desde then 'con_telefono' else 'ok' end,
    'respuestas', v_cuenta
  );
end;
$$;

revoke all on function public.claim_miniapp_reply(uuid, uuid, integer, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_miniapp_reply(uuid, uuid, integer, integer, integer, text)
  to service_role;

-- ════════════════════════════════════════════════════════════════════════
-- MOTOR DE GRUPOS DE OPCIONES
-- Convierte el catálogo en configuración: obligatoriedad, mínimos, selección
-- por cantidad y opciones que SON productos (los combos). Sin esto no existen
-- los almuerzos, las parrilladas ni los batidos
-- (migration-2026-08-04-motor-de-opciones.sql).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Los grupos ───────────────────────────────────────────────────────────
create table if not exists public.option_groups (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid not null references public.businesses(id) on delete cascade,
  -- El grupo cuelga de UN producto o de UNA categoría, nunca de ambos ni de
  -- ninguno (`option_groups_destino_check`, más abajo). Por categoría es como
  -- 19 sabores los comparten todas las pizzas sin repetirlos en cada una, y
  -- como una plantilla deja grupos cargados antes de que exista un solo
  -- producto (migration-2026-08-05-grupos-por-categoria.sql).
  product_id       uuid,
  category_id      uuid,
  name             text not null,
  description      text,
  -- Qué se puede hacer dentro del grupo. Son los tres selectores reales:
  --   single   → un radio. Tamaño de pizza, término de la carne.
  --   multiple → casillas con tope. Ingredientes, salsas.
  --   quantity → cada opción con su contador. Cortes de una parrillada.
  selection_type   text not null default 'single',
  required         boolean not null default false,
  min_selectable   integer not null default 0,
  max_selectable   integer not null default 1,
  sort             integer not null default 0,
  active           boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint option_groups_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and selection_type in ('single', 'multiple', 'quantity')
    and min_selectable >= 0 and min_selectable <= 100
    and max_selectable >= 1 and max_selectable <= 100
    and min_selectable <= max_selectable
    -- Un grupo obligatorio sin mínimo no obliga a nada: sería un botón de
    -- «obligatorio» que no impide seguir, que es peor que no ponerlo.
    and (required = false or min_selectable >= 1)
    -- `single` es exactamente uno. Sin esto se podría guardar un radio con
    -- max 5, y la app tendría que decidir a quién cree.
    and (selection_type <> 'single' or max_selectable = 1)
    and sort between 0 and 999
  )
);

-- El producto se referencia por PAREJA (id, business_id), no solo por id.
-- Una foránea de una sola columna comprueba «esa fila existe», no «esa fila es
-- de este negocio», y como el negocio sale del JWT mientras el otro id viaja
-- en la petición, ahí se cruza la frontera mandando un uuid ajeno. Fue lo que
-- pasó con `product_variants` y `products.category_id` el 2026-08-02.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_producto_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_producto_del_negocio
      foreign key (product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_option_groups_producto
  on public.option_groups (business_id, product_id, sort);

-- El único (id, business_id) tiene que existir ANTES que la foránea compuesta
-- que lo usa como destino: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_groups_id_business
  on public.option_groups (id, business_id);

-- ── 1 bis. El grupo también puede colgar de una categoría ───────────────────
-- Sobre una base creada con la versión anterior de esta tabla, `product_id`
-- sigue siendo NOT NULL y no existe `category_id`: estas tres sentencias la
-- ponen al día sin tocar los grupos que ya cuelgan de un producto.
alter table public.option_groups
  add column if not exists category_id uuid;
alter table public.option_groups
  alter column product_id drop not null;

-- Un grupo colgado de nada es invisible y vive igual; colgado de las dos cosas
-- obliga a la app a decidir cuál manda. Exactamente uno.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'option_groups_destino_check'
  ) then
    alter table public.option_groups
      add constraint option_groups_destino_check
      check (num_nonnulls(product_id, category_id) = 1);
  end if;
end $$;

-- La categoría se referencia por PAREJA, como el producto. Va en CASCADE y no
-- en `set null` porque el check de arriba lo exige: anular `category_id`
-- dejaría el grupo sin destino y borrar una categoría reventaría.
--
-- El único (id, business_id) que esta foránea necesita como destino ya lo crea
-- `product_categories` mucho más arriba, así que aquí no se repite.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_categoria_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_categoria_del_negocio
      foreign key (category_id, business_id)
      references public.product_categories (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_option_groups_categoria
  on public.option_groups (business_id, category_id, sort);

-- ════════════════════════════════════════════════════════════════════════
-- MOTOR UNIVERSAL DE PRODUCTOS
-- Tipos de producto, estrategias de precio y plantillas reutilizables. Es lo
-- que permite que la misma app sirva a una pizzería, una heladería y un local
-- de almuerzos sin tocar código: la diferencia sale de la CONFIGURACIÓN
-- (migration-2026-08-05-motor-de-productos.sql).
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. La clase de producto ─────────────────────────────────────────────────
alter table public.products
  add column if not exists product_type text not null default 'simple';
alter table public.products
  add column if not exists preparation_time integer;
alter table public.products
  add column if not exists featured boolean not null default false;
alter table public.products
  add column if not exists popular boolean not null default false;
alter table public.products
  add column if not exists sort integer not null default 0;
-- Stock por unidades, para quien lo lleve. `stock` (texto) sigue mandando
-- cuando esto está apagado: no se toca lo que ya funciona.
alter table public.products
  add column if not exists stock_control_enabled boolean not null default false;
alter table public.products
  add column if not exists stock_quantity integer;
alter table public.products
  add column if not exists min_quantity integer not null default 1;
alter table public.products
  add column if not exists max_quantity integer not null default 99;
-- Disponibilidad por día y hora: el almuerzo del día, el desayuno hasta las 11.
alter table public.products
  add column if not exists available_days smallint[];
alter table public.products
  add column if not exists available_from time;
alter table public.products
  add column if not exists available_until time;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.products'::regclass and conname = 'products_motor_check'
  ) then
    alter table public.products add constraint products_motor_check check (
      product_type in ('simple', 'configurable', 'combo', 'daily_menu', 'weighted')
      and (preparation_time is null or preparation_time between 0 and 1440)
      and (stock_quantity is null or stock_quantity >= 0)
      and min_quantity between 1 and 99
      and max_quantity between 1 and 99
      and min_quantity <= max_quantity
      and sort between 0 and 9999
      -- Un día fuera de 0..6 no lo entiende nadie, y dejaría el producto
      -- invisible sin decir por qué.
      and (available_days is null or (
        array_length(available_days, 1) between 1 and 7
        and available_days <@ array[0,1,2,3,4,5,6]::smallint[]
      ))
    );
  end if;
end $$;

create index if not exists idx_products_tipo
  on public.products (business_id, product_type) where active;

-- ── 2. Cómo se cobra un grupo ───────────────────────────────────────────────
alter table public.option_groups
  add column if not exists pricing_strategy text not null default 'sum';
-- Cuántas selecciones van sin recargo antes de empezar a cobrar.
alter table public.option_groups
  add column if not exists free_selections integer not null default 0;
-- Tope de porciones del grupo entero en los contadores, cuando el tope por
-- opción no basta: «4 porciones» repartidas como se quiera.
alter table public.option_groups
  add column if not exists max_total_quantity integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'option_groups_precio_check'
  ) then
    alter table public.option_groups add constraint option_groups_precio_check check (
      pricing_strategy in (
        'sum', 'fixed', 'highest_selected', 'lowest_selected', 'average',
        'included', 'included_up_to_limit', 'extra_after_limit'
      )
      and free_selections between 0 and 100
      and (max_total_quantity is null or max_total_quantity between 1 and 100)
      -- Las dos estrategias con límite necesitan saber cuál es. Sin esto, un
      -- «las primeras N gratis» con N=0 cobraría todo y nadie sabría por qué.
      and (
        pricing_strategy not in ('included_up_to_limit', 'extra_after_limit')
        or free_selections >= 1
      )
    );
  end if;
end $$;

-- ── 3. Plantillas de opciones reutilizables ─────────────────────────────────
create table if not exists public.option_templates (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  name        text not null,
  description text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint option_templates_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
  )
);

create index if not exists idx_option_templates_negocio
  on public.option_templates (business_id, name);
-- El único (id, business_id) va ANTES que cualquier foránea compuesta que lo
-- use como destino: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_templates_id_business
  on public.option_templates (id, business_id);
create unique index if not exists uq_option_templates_nombre
  on public.option_templates (business_id, lower(btrim(name)));

create table if not exists public.option_template_items (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  option_template_id    uuid not null,
  name                  text not null,
  description           text,
  image_url             text,
  image_public_id       text,
  price_adjustment      numeric(10,2) not null default 0,
  references_product_id uuid,
  default_selected      boolean not null default false,
  stock                 text not null default 'disponible',
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint option_template_items_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and price_adjustment >= -100000 and price_adjustment <= 100000
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
    and (image_url is null or image_url ~ '^https://')
  )
);

-- Las dos foráneas van por PAREJA (id, business_id). Una de una sola columna
-- comprueba «esa fila existe», no «esa fila es de este negocio», y ahí es por
-- donde se cruzó la frontera con `product_variants` el 2026-08-02.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_template_items'::regclass
      and conname = 'fk_option_template_items_plantilla_del_negocio'
  ) then
    alter table public.option_template_items
      add constraint fk_option_template_items_plantilla_del_negocio
      foreign key (option_template_id, business_id)
      references public.option_templates (id, business_id) on delete cascade;
  end if;

  -- Una plantilla de «sabores» puede apuntar a productos reales del catálogo:
  -- así los combos eligen pizzas de verdad. `set null` con la columna NOMBRADA,
  -- porque sin nombrarla PostgreSQL anularía también `business_id`, que es NOT
  -- NULL, y borrar un producto reventaría. Es el fallo del 2026-08-02.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_template_items'::regclass
      and conname = 'fk_option_template_items_producto_del_negocio'
  ) then
    alter table public.option_template_items
      add constraint fk_option_template_items_producto_del_negocio
      foreign key (references_product_id, business_id)
      references public.products (id, business_id)
      on delete set null (references_product_id);
  end if;
end $$;

create index if not exists idx_option_template_items_plantilla
  on public.option_template_items (business_id, option_template_id, sort);

-- El grupo que se sirve de una plantilla en vez de tener opciones propias.
alter table public.option_groups
  add column if not exists option_template_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.option_groups'::regclass
      and conname = 'fk_option_groups_plantilla_del_negocio'
  ) then
    alter table public.option_groups
      add constraint fk_option_groups_plantilla_del_negocio
      foreign key (option_template_id, business_id)
      references public.option_templates (id, business_id)
      on delete set null (option_template_id);
  end if;
end $$;

-- ── 4. RLS ──────────────────────────────────────────────────────────────────
alter table public.option_templates enable row level security;
alter table public.option_template_items enable row level security;
revoke all on table public.option_templates from public, anon, authenticated;
revoke all on table public.option_template_items from public, anon, authenticated;
grant select, insert, update, delete on table public.option_templates to service_role;
grant select, insert, update, delete on table public.option_template_items to service_role;

-- ── 2. Las opciones ─────────────────────────────────────────────────────────
create table if not exists public.options (
  id                    uuid primary key default gen_random_uuid(),
  business_id           uuid not null references public.businesses(id) on delete cascade,
  option_group_id       uuid not null,
  name                  text not null,
  description           text,
  image_url             text,
  image_public_id       text,
  -- Puede ser NEGATIVO: «sin sopa −$0.50» en un almuerzo es un caso real.
  -- Por eso el importe final lo calcula PostgreSQL y nunca el navegador.
  price_adjustment      numeric(10,2) not null default 0,
  -- Aquí viven los COMBOS: una opción que ES un producto del catálogo.
  -- «Elige tu 1era pizza» son opciones que apuntan a pizzas reales, en vez de
  -- columnas fijas tipo pizza_1, pizza_2.
  references_product_id uuid,
  default_selected      boolean not null default false,
  stock                 text not null default 'disponible',
  sort                  integer not null default 0,
  active                boolean not null default true,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  constraint options_datos_check check (
    char_length(btrim(name)) between 1 and 120
    and char_length(coalesce(description, '')) <= 300
    and price_adjustment >= -100000 and price_adjustment <= 100000
    and stock in ('disponible', 'agotado')
    and sort between 0 and 999
    and (image_url is null or image_url ~ '^https://')
  )
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_grupo_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_grupo_del_negocio
      foreign key (option_group_id, business_id)
      references public.option_groups (id, business_id) on delete cascade;
  end if;

  -- El producto referenciado también tiene que ser de ESTE negocio: si no, un
  -- combo podría incluir la pizza del local de al lado.
  --
  -- `on delete set null (references_product_id)` con la columna NOMBRADA: sin
  -- nombrarla PostgreSQL anularía también `business_id`, que es NOT NULL, y
  -- borrar un producto reventaría. Es exactamente el fallo del 2026-08-02.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_producto_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_producto_del_negocio
      foreign key (references_product_id, business_id)
      references public.products (id, business_id)
      on delete set null (references_product_id);
  end if;
end $$;

create index if not exists idx_options_grupo
  on public.options (business_id, option_group_id, sort);

-- ── «Agrega algo más»: los adicionales independientes ───────────────────
-- Un adicional NO es un complemento incluido: la bebida de un combo vive
-- dentro de su línea, y el pan de ajo que se suma al final es OTRO producto
-- con su propia línea del carrito. Si acabaran juntos, el dueño vería «Pizza
-- (con Coca Cola)» en vez de dos cosas que preparar
-- (migration-2026-08-05-adicionales.sql).
-- Las tres foráneas necesitan que existan los únicos (id, business_id) de sus
-- destinos. En `schema.sql` este bloque va ANTES de donde se crean, así que se
-- aseguran aquí: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_products_id_business
  on public.products (id, business_id);
create unique index if not exists uq_product_categories_id_business
  on public.product_categories (id, business_id);

create table if not exists public.product_recommendations (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  -- De dónde sale la sugerencia. Ambos nulos = de todo el negocio.
  source_product_id      uuid,
  source_category_id     uuid,
  -- Qué se ofrece. Es un producto de verdad del catálogo.
  recommended_product_id uuid not null,
  -- El título de la sección: «Agrega bebidas», «También te puede gustar».
  section                text not null default 'Agrega algo más',
  sort                   integer not null default 0,
  active                 boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint product_recommendations_datos_check check (
    char_length(btrim(section)) between 1 and 60
    and sort between 0 and 999
    and num_nonnulls(source_product_id, source_category_id) <= 1
  )
);

-- Las tres foráneas van por PAREJA (id, business_id). Sin el negocio dentro,
-- una recomendación podría ofrecer el producto de OTRO local — y ese sí que
-- acabaría en el carrito, porque un adicional es una línea de verdad.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_producto_origen'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_producto_origen
      foreign key (source_product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_categoria_origen'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_categoria_origen
      foreign key (source_category_id, business_id)
      references public.product_categories (id, business_id) on delete cascade;
  end if;

  -- Si el producto ofrecido desaparece, la recomendación se va con él: dejarla
  -- viva ofrecería algo que ya no se puede pedir.
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.product_recommendations'::regclass
      and conname = 'fk_recomendaciones_producto_ofrecido'
  ) then
    alter table public.product_recommendations
      add constraint fk_recomendaciones_producto_ofrecido
      foreign key (recommended_product_id, business_id)
      references public.products (id, business_id) on delete cascade;
  end if;
end $$;

create index if not exists idx_recomendaciones_origen
  on public.product_recommendations (business_id, source_product_id, sort);
create index if not exists idx_recomendaciones_categoria
  on public.product_recommendations (business_id, source_category_id, sort);

-- Ofrecer dos veces lo mismo en el mismo sitio es un descuido, no una
-- intención: el cliente vería el pan de ajo repetido.
create unique index if not exists uq_recomendaciones_sin_repetir
  on public.product_recommendations (
    business_id,
    coalesce(source_product_id, '00000000-0000-0000-0000-000000000000'::uuid),
    coalesce(source_category_id, '00000000-0000-0000-0000-000000000000'::uuid),
    recommended_product_id
  );

alter table public.product_recommendations enable row level security;
revoke all on table public.product_recommendations from public, anon, authenticated;
grant select, insert, update, delete on table public.product_recommendations to service_role;

-- ── 3. Qué eligió el cliente, guardado con el pedido ────────────────────────
-- Fotografía inmutable: si mañana cambia el nombre o el recargo de la opción,
-- el pedido de ayer tiene que seguir diciendo lo que se pidió y lo que costó.
create table if not exists public.order_item_options (
  id                     uuid primary key default gen_random_uuid(),
  business_id            uuid not null references public.businesses(id) on delete cascade,
  order_item_id          uuid not null references public.order_items(id) on delete cascade,
  option_group_id        uuid,
  option_id              uuid,
  option_group_name      text not null,
  option_name            text not null,
  quantity               integer not null default 1,
  unit_price_adjustment  numeric(10,2) not null default 0,
  total_price_adjustment numeric(10,2) not null default 0,
  created_at             timestamptz not null default now(),
  constraint order_item_options_datos_check check (
    char_length(btrim(option_group_name)) between 1 and 120
    and char_length(btrim(option_name)) between 1 and 120
    and quantity between 1 and 100
  )
);

create index if not exists idx_order_item_options_item
  on public.order_item_options (business_id, order_item_id);

-- `order_item_options` apunta al ítem del pedido, y ambos llevan business_id:
-- con una foránea de una sola columna se podría colgar el detalle de lo que
-- eligió un cliente sobre el ítem de OTRO negocio. Lo cazó
-- `verificar-fronteras.sql` al escribir esta migración, que es justo para lo
-- que se construyó.
create unique index if not exists uq_order_items_id_business
  on public.order_items (id, business_id);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_item_options'::regclass
      and conname = 'fk_order_item_options_item_del_negocio'
  ) then
    alter table public.order_item_options
      drop constraint if exists order_item_options_order_item_id_fkey;
    alter table public.order_item_options
      add constraint fk_order_item_options_item_del_negocio
      foreign key (order_item_id, business_id)
      references public.order_items (id, business_id) on delete cascade;
  end if;
end $$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.order_events'::regclass
      and conname = 'fk_order_events_linea'
  ) then
    -- ⚠️ COMPUESTA, con `business_id`. Una foránea a `order_items(id)` a secas
    -- deja abierta la frontera entre negocios: un evento del local A podría
    -- apuntar a una línea del local B. La RPC ya comprueba pertenencia, pero
    -- eso es una promesa del código; esto lo hace IMPOSIBLE en la base. Mismo
    -- patrón que `product_variants`, y lo exige `verificar-fronteras.sql`.
    alter table public.order_events
      add constraint fk_order_events_linea
      foreign key (order_item_id, business_id)
      references public.order_items (id, business_id) on delete cascade;
  end if;
end $$;


-- ═══════════════════════════════════════════════════════════════════════════
-- LAS PLANTILLAS DE OPCIONES FUNCIONAN (2026-09-16)
-- migration-2026-09-16-las-plantillas-funcionan.sql
--
-- Un grupo enganchado a una plantilla recibe COPIAS de sus ítems, y la base
-- las mantiene al día. La tienda, la cotización y la RPC del pedido siguen
-- leyendo `options` sin saber nada de plantillas — y por eso «2 pizzas
-- hawaianas» funciona: cada paso tiene sus propios ids.
-- ═══════════════════════════════════════════════════════════════════════════
-- ── 1. El destino de la foránea compuesta ──────────────────────────────────
--
-- ⚠️ ANTES que la foránea: PostgreSQL exige un único que case con la pareja.
create unique index if not exists uq_option_template_items_id_business
  on public.option_template_items (id, business_id);


-- ── 2. Cada copia sabe de qué ítem viene ───────────────────────────────────
alter table public.options
  add column if not exists option_template_item_id uuid;

comment on column public.options.option_template_item_id is
  'Si no es nulo, esta opción es una COPIA de un ítem de plantilla y la '
  'mantiene la base: no se edita a mano, se edita la plantilla.';

-- ⚠️ COMPUESTA sobre (id, business_id). Una de una sola columna comprueba «ese
-- ítem existe», no «ese ítem es de este negocio» — y el guardián de fronteras
-- (`verificar-fronteras.sql`) para el CI si la encuentra.
--
-- `on delete cascade`: borrar un sabor de la plantilla borra sus copias. Con la
-- columna nula (opción manual) la foránea no aplica y la opción no se toca.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.options'::regclass
      and conname = 'fk_options_item_de_plantilla_del_negocio'
  ) then
    alter table public.options
      add constraint fk_options_item_de_plantilla_del_negocio
      foreign key (option_template_item_id, business_id)
      references public.option_template_items (id, business_id)
      on delete cascade;
  end if;
end $$;

-- Una sola copia de cada ítem por grupo: sin esto, dos sincronizaciones
-- seguidas podrían duplicar un sabor.
create unique index if not exists uq_options_copia_por_grupo
  on public.options (option_group_id, option_template_item_id)
  where option_template_item_id is not null;


-- ── 3. Sincronizar un grupo con su plantilla ───────────────────────────────
--
-- Una sola función para los tres momentos —enganchar, editar la plantilla,
-- desenganchar—, y es idempotente: correrla dos veces deja lo mismo que una.
create or replace function public.sincronizar_plantilla_en_grupo(p_group_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plantilla uuid;
  v_negocio   uuid;
begin
  select option_template_id, business_id
    into v_plantilla, v_negocio
    from public.option_groups
   where id = p_group_id;

  if not found then
    return;
  end if;

  -- Sin plantilla: fuera las copias. Las opciones MANUALES se quedan.
  if v_plantilla is null then
    delete from public.options
     where option_group_id = p_group_id
       and option_template_item_id is not null;
    return;
  end if;

  -- Copias de ítems que ya no son de ESTA plantilla (se cambió de plantilla).
  delete from public.options as o
   where o.option_group_id = p_group_id
     and o.option_template_item_id is not null
     and not exists (
       select 1 from public.option_template_items i
        where i.id = o.option_template_item_id
          and i.option_template_id = v_plantilla
     );

  -- Las que ya existen se ponen al día. Todo lo que ve el cliente viaja.
  update public.options as o
     set name                  = i.name,
         description           = i.description,
         image_url             = i.image_url,
         image_public_id       = i.image_public_id,
         price_adjustment      = i.price_adjustment,
         references_product_id = i.references_product_id,
         default_selected      = i.default_selected,
         stock                 = i.stock,
         sort                  = i.sort,
         active                = i.active,
         updated_at            = now()
    from public.option_template_items as i
   where o.option_group_id = p_group_id
     and o.option_template_item_id = i.id
     and i.option_template_id = v_plantilla;

  -- Y las que faltan se crean.
  insert into public.options (
    business_id, option_group_id, option_template_item_id, name, description,
    image_url, image_public_id, price_adjustment, references_product_id,
    default_selected, stock, sort, active
  )
  select v_negocio, p_group_id, i.id, i.name, i.description,
         i.image_url, i.image_public_id, i.price_adjustment, i.references_product_id,
         i.default_selected, i.stock, i.sort, i.active
    from public.option_template_items as i
   where i.option_template_id = v_plantilla
     and i.business_id = v_negocio
     and not exists (
       select 1 from public.options o
        where o.option_group_id = p_group_id
          and o.option_template_item_id = i.id
     );
end;
$$;

revoke all on function public.sincronizar_plantilla_en_grupo(uuid)
  from public, anon, authenticated;


-- ── 4. Enganchar o desenganchar un grupo ───────────────────────────────────
create or replace function public.option_groups_sincronizar_plantilla()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sincronizar_plantilla_en_grupo(new.id);
  return null;
end;
$$;

revoke all on function public.option_groups_sincronizar_plantilla()
  from public, anon, authenticated;

-- ⚠️ `after insert` además de `update`: un grupo que NACE ya enganchado (la
-- plantilla del alta de una pizzería, por ejemplo) tiene que salir con sus
-- sabores, no vacío.
drop trigger if exists option_groups_sincronizar_plantilla on public.option_groups;
create trigger option_groups_sincronizar_plantilla
  after insert or update of option_template_id on public.option_groups
  for each row execute function public.option_groups_sincronizar_plantilla();


-- ── 5. Editar la plantilla llega a todos los grupos que la usan ────────────
create or replace function public.option_template_items_propagar()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.sincronizar_plantilla_en_grupo(g.id)
     from public.option_groups g
    where g.option_template_id = coalesce(new.option_template_id, old.option_template_id)
       -- Un ítem que cambia de plantilla tiene que desaparecer de la vieja.
       or (tg_op = 'UPDATE' and g.option_template_id = old.option_template_id);
  return null;
end;
$$;

revoke all on function public.option_template_items_propagar()
  from public, anon, authenticated;

drop trigger if exists option_template_items_propagar on public.option_template_items;
create trigger option_template_items_propagar
  after insert or update or delete on public.option_template_items
  for each row execute function public.option_template_items_propagar();


-- ── 4. RLS ──────────────────────────────────────────────────────────────────
-- El frontend nunca habla con Supabase: la anon key queda bloqueada y el
-- aislamiento real lo refuerza el filtrado por business_id en server/src/db.
alter table public.option_groups enable row level security;
alter table public.options enable row level security;
alter table public.order_item_options enable row level security;

revoke all on table public.option_groups from public, anon, authenticated;
revoke all on table public.options from public, anon, authenticated;
revoke all on table public.order_item_options from public, anon, authenticated;
grant select, insert, update, delete on table public.option_groups to service_role;
grant select, insert, update, delete on table public.options to service_role;
grant select, insert, update, delete on table public.order_item_options to service_role;

-- ── 5. La plantilla del tipo de negocio ─────────────────────────────────────
-- Deja cargado el catálogo de arranque de un negocio recién creado: sus
-- categorías, las listas reutilizables de su tipo y UN producto de ejemplo
-- armado como se arma de verdad (el almuerzo por partes, la pizza con su lista
-- de sabores). No sobrescribe (si ya hay catálogo o listas no toca nada), es
-- todo o nada, y el producto de ejemplo nace AGOTADO siempre: su precio es
-- inventado (migration-2026-08-05-plantillas-de-negocio.sql y
-- migration-2026-09-16-cada-local-nace-armado.sql).
create or replace function public.apply_business_template(
  p_business_id uuid,
  p_template jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lista jsonb;
  v_item jsonb;
  v_lista_id uuid;
  v_listas_por_nombre jsonb := '{}'::jsonb;
  v_categoria jsonb;
  v_producto jsonb;
  v_destino jsonb;
  v_destinos jsonb;
  v_grupo jsonb;
  v_opcion jsonb;
  v_categoria_id uuid;
  v_producto_id uuid;
  v_grupo_id uuid;
  v_listas integer := 0;
  v_categorias integer := 0;
  v_productos integer := 0;
  v_grupos integer := 0;
  v_opciones integer := 0;
begin
  if p_business_id is null then
    raise exception 'Falta el negocio' using errcode = '22023';
  end if;

  if not exists (select 1 from businesses where id = p_business_id) then
    raise exception 'El negocio no existe' using errcode = '42501';
  end if;

  -- El portón: un negocio con catálogo ya es un negocio con decisiones
  -- tomadas, y una plantilla encima las pisaría.
  if exists (select 1 from product_categories where business_id = p_business_id)
     or exists (select 1 from products where business_id = p_business_id)
     or exists (select 1 from option_templates where business_id = p_business_id) then
    return jsonb_build_object(
      'aplicada', false,
      'motivo', 'El negocio ya tiene catálogo',
      'categorias', 0, 'listas', 0, 'productos', 0, 'grupos', 0, 'opciones', 0
    );
  end if;

  -- ── 1. Las listas, ANTES que los grupos que se enlazan a ellas ────────────
  for v_lista in
    select * from jsonb_array_elements(coalesce(p_template->'listas', '[]'::jsonb))
  loop
    insert into option_templates (business_id, name, description)
    values (p_business_id, v_lista->>'nombre', v_lista->>'descripcion')
    returning id into v_lista_id;
    v_listas_por_nombre := v_listas_por_nombre
      || jsonb_build_object(v_lista->>'nombre', v_lista_id);
    v_listas := v_listas + 1;

    for v_item in
      select * from jsonb_array_elements(coalesce(v_lista->'opciones', '[]'::jsonb))
    loop
      insert into option_template_items (
        business_id, option_template_id, name, price_adjustment, sort
      ) values (
        p_business_id,
        v_lista_id,
        v_item->>'nombre',
        coalesce((v_item->>'recargo')::numeric, 0),
        coalesce((v_item->>'orden')::integer, 0)
      );
    end loop;
  end loop;

  -- ── 2. Categorías, sus productos de ejemplo y los grupos de cada uno ──────
  for v_categoria in
    select * from jsonb_array_elements(coalesce(p_template->'categorias', '[]'::jsonb))
  loop
    insert into product_categories (business_id, name, sort)
    values (
      p_business_id,
      v_categoria->>'nombre',
      coalesce((v_categoria->>'orden')::integer, 0)
    )
    returning id into v_categoria_id;
    v_categorias := v_categorias + 1;

    -- Un grupo cuelga de la categoría (producto nulo) o de un producto. Se
    -- juntan en una sola lista de destinos para que haya UN solo sitio donde
    -- se inserta un grupo, y no dos copias que acaben diciendo cosas distintas.
    v_destinos := jsonb_build_array(jsonb_build_object(
      'producto', null,
      'grupos', coalesce(v_categoria->'grupos', '[]'::jsonb)
    ));

    for v_producto in
      select * from jsonb_array_elements(coalesce(v_categoria->'productos', '[]'::jsonb))
    loop
      insert into products (
        business_id, category_id, name, price, description, product_type,
        active, sort, stock
      ) values (
        p_business_id,
        v_categoria_id,
        v_producto->>'nombre',
        (v_producto->>'precio')::numeric,
        v_producto->>'descripcion',
        coalesce(v_producto->>'tipo', 'simple'),
        -- ⚠️ Visible para su dueño y agotado para el cliente: ver la cabecera.
        true,
        coalesce((v_producto->>'orden')::integer, 0),
        'agotado'
      )
      returning id into v_producto_id;
      v_productos := v_productos + 1;

      v_destinos := v_destinos || jsonb_build_array(jsonb_build_object(
        'producto', v_producto_id,
        'grupos', coalesce(v_producto->'grupos', '[]'::jsonb)
      ));
    end loop;

    for v_destino in select * from jsonb_array_elements(v_destinos)
    loop
      v_producto_id := (v_destino->>'producto')::uuid;

      for v_grupo in select * from jsonb_array_elements(v_destino->'grupos')
      loop
        v_lista_id := null;
        if v_grupo ? 'lista' then
          v_lista_id := (v_listas_por_nombre->>(v_grupo->>'lista'))::uuid;
          if v_lista_id is null then
            raise exception 'La plantilla enlaza «%» a la lista «%», que no trae',
              v_grupo->>'nombre', v_grupo->>'lista'
              using errcode = '22023';
          end if;
        end if;

        insert into option_groups (
          business_id, category_id, product_id, name, description,
          selection_type, required, min_selectable, max_selectable, sort,
          pricing_strategy, free_selections, is_meal_part, loose_price,
          option_template_id
        ) values (
          p_business_id,
          case when v_producto_id is null then v_categoria_id end,
          v_producto_id,
          v_grupo->>'nombre',
          v_grupo->>'descripcion',
          coalesce(v_grupo->>'tipo', 'single'),
          coalesce((v_grupo->>'obligatorio')::boolean, false),
          coalesce((v_grupo->>'min')::integer, 0),
          coalesce((v_grupo->>'max')::integer, 1),
          coalesce((v_grupo->>'orden')::integer, 0),
          coalesce(v_grupo->>'cobro', 'sum'),
          coalesce((v_grupo->>'gratis')::integer, 0),
          coalesce((v_grupo->>'parte')::boolean, false),
          (v_grupo->>'precioSuelto')::numeric,
          v_lista_id
        )
        returning id into v_grupo_id;
        v_grupos := v_grupos + 1;

        for v_opcion in
          select * from jsonb_array_elements(coalesce(v_grupo->'opciones', '[]'::jsonb))
        loop
          insert into options (
            business_id, option_group_id, name, price_adjustment, sort
          ) values (
            p_business_id,
            v_grupo_id,
            v_opcion->>'nombre',
            coalesce((v_opcion->>'recargo')::numeric, 0),
            coalesce((v_opcion->>'orden')::integer, 0)
          );
        end loop;

        -- Se cuentan las que QUEDARON, no las que traía el JSON: un grupo
        -- enlazado a una lista no trae ninguna y la base le pone las copias.
        v_opciones := v_opciones
          + (select count(*) from options where option_group_id = v_grupo_id);
      end loop;
    end loop;
  end loop;

  return jsonb_build_object(
    'aplicada', true,
    'categorias', v_categorias,
    'listas', v_listas,
    'productos', v_productos,
    'grupos', v_grupos,
    'opciones', v_opciones
  );
end;
$$;

revoke all on function public.apply_business_template(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_business_template(uuid, jsonb)
  to service_role;

-- ── La carta del local (2026-09-24): lo que la IA leyó y una persona revisó ──
-- Usa `apply_business_template` por dentro (con su portón) y añade precios de
-- verdad y tamaños. Ver `migration-2026-09-24-carta-del-local.sql`.
create or replace function public.apply_business_menu(
  p_business_id uuid,
  p_menu jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_resultado jsonb;
  v_categoria jsonb;
  v_producto jsonb;
  v_variante jsonb;
  v_producto_id uuid;
  v_variantes integer := 0;
begin
  -- ── 0. Nombres únicos: es lo que enlaza cada tamaño con SU producto ──────
  -- Dos «Pizzas» en la carta, o dos «Hawaiana» dentro de la misma, dejarían
  -- un tamaño colgado del producto equivocado. El panel ya lo avisa; esto
  -- impide que llegue aunque alguien se salte el panel.
  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_menu->'categorias', '[]'::jsonb)) c
    group by lower(btrim(c->>'nombre'))
    having count(*) > 1
  ) then
    raise exception 'La carta repite una categoría' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_menu->'categorias', '[]'::jsonb))
           with ordinality c(categoria, n),
         jsonb_array_elements(coalesce(c.categoria->'productos', '[]'::jsonb)) p
    group by c.n, lower(btrim(p->>'nombre'))
    having count(*) > 1
  ) then
    raise exception 'La carta repite un producto dentro de una categoría'
      using errcode = '22023';
  end if;

  -- ── 1. El mismo motor que el alta, con su portón ─────────────────────────
  v_resultado := public.apply_business_template(p_business_id, p_menu);
  if (v_resultado->>'aplicada')::boolean is not true then
    return v_resultado;
  end if;

  -- ── 2. Precios de verdad: a la venta (ver la cabecera) ───────────────────
  update products set stock = 'disponible'
  where business_id = p_business_id;

  -- ── 3. Los tamaños, colgados de su producto ──────────────────────────────
  for v_categoria in
    select * from jsonb_array_elements(coalesce(p_menu->'categorias', '[]'::jsonb))
  loop
    for v_producto in
      select * from jsonb_array_elements(coalesce(v_categoria->'productos', '[]'::jsonb))
    loop
      if jsonb_array_length(coalesce(v_producto->'variantes', '[]'::jsonb)) = 0 then
        continue;
      end if;

      select p.id into strict v_producto_id
      from products p
      join product_categories c on c.id = p.category_id
      where p.business_id = p_business_id
        and c.business_id = p_business_id
        and lower(btrim(c.name)) = lower(btrim(v_categoria->>'nombre'))
        and lower(btrim(p.name)) = lower(btrim(v_producto->>'nombre'));

      for v_variante in
        select * from jsonb_array_elements(v_producto->'variantes')
      loop
        insert into product_variants (business_id, product_id, name, price, sort)
        values (
          p_business_id,
          v_producto_id,
          v_variante->>'nombre',
          (v_variante->>'precio')::numeric,
          coalesce((v_variante->>'orden')::integer, 0)
        );
        v_variantes := v_variantes + 1;
      end loop;
    end loop;
  end loop;

  return v_resultado || jsonb_build_object('variantes', v_variantes);
end;
$$;

revoke all on function public.apply_business_menu(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.apply_business_menu(uuid, jsonb)
  to service_role;

-- ── 2. Las ventas solo pueden apuntar a algo de SU negocio ────────────────
--
-- Las tres nacieron con `on delete set null` a secas y eso anulaba también
-- `business_id`, que es NOT NULL: borrar un pedido entregado o una cita
-- atendida reventaba con 23502. En una base que ya las tiene mal, el
-- `if not exists` de abajo no las arreglaría, así que primero se retiran las
-- que sigan en la forma rota (migration-2026-08-02-borrado-de-ventas.sql).
do $$
declare
  v_rota text;
begin
  for v_rota in
    select conname from pg_constraint
    where conrelid = 'public.sales'::regclass
      and contype = 'f'
      and conname in (
        'fk_sales_pedido_del_negocio',
        'fk_sales_cita_del_negocio',
        'fk_sales_estadia_del_negocio'
      )
      and pg_get_constraintdef(oid) !~ 'ON DELETE SET NULL \('
  loop
    execute format('alter table public.sales drop constraint %I', v_rota);
  end loop;
end;
$$;

do $$
begin
  -- La foránea simple se retira: dejarla viva permitiría el cruce igual.
  alter table public.sales drop constraint if exists sales_order_id_fkey;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.sales'::regclass and conname = 'fk_sales_pedido_del_negocio'
  ) then
    -- `set null (order_id)` y no `set null` a secas: sin nombrar la columna
    -- PostgreSQL anularía también `business_id`, que es NOT NULL, y borrar un
    -- pedido entregado reventaría (migration-2026-08-02-borrado-de-ventas.sql).
    alter table public.sales
      add constraint fk_sales_pedido_del_negocio
      foreign key (order_id, business_id)
      references public.orders (id, business_id)
      on delete set null (order_id);
  end if;
end;
$$;

-- ── RED DE SEGURIDAD: RLS AUTOMÁTICA EN TABLAS NUEVAS ──────
-- Existía en la base de producción pero NO en este archivo, así que una
-- instalación nueva nacía sin ella: es justo el tipo de deriva que el
-- detector de funciones huérfanas viene a evitar (encontrada 2026-08-02).
--
-- Qué hace: cada vez que se crea una tabla en `public`, le activa RLS sola.
-- La regla #1 del proyecto es que toda tabla de negocio nazca con RLS, y esto
-- la cumple aunque a alguien se le olvide escribirlo en su migración.
--
-- ⚠️ Crear disparadores de EVENTO exige superusuario. En Supabase y en el CI
-- se puede; en una base donde no, el bloque se salta sin romper el resto — el
-- esquema sigue declarando el `enable row level security` de cada tabla.
do $$
begin
  create or replace function public.rls_auto_enable()
  returns event_trigger
  language plpgsql
  security definer
  set search_path to 'pg_catalog'
  as $funcion$
  declare
    cmd record;
  begin
    for cmd in
      select *
      from pg_event_trigger_ddl_commands()
      where command_tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
        and object_type in ('table', 'partitioned table')
    loop
      if cmd.schema_name = 'public' then
        begin
          execute format('alter table if exists %s enable row level security', cmd.object_identity);
        exception when others then
          raise log 'rls_auto_enable: no se pudo activar RLS en %', cmd.object_identity;
        end;
      end if;
    end loop;
  end;
  $funcion$;

  if not exists (select 1 from pg_event_trigger where evtname = 'ensure_rls') then
    create event trigger ensure_rls on ddl_command_end
      when tag in ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      execute function public.rls_auto_enable();
  end if;
exception when insufficient_privilege then
  raise notice 'Sin permisos para el disparador de eventos ensure_rls; se omite.';
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- CUÁNTO TARDA EL NEGOCIO EN TENER EL PEDIDO LISTO
--
-- Dos tiempos por negocio, con el valor inicial recomendado por su tipo y
-- editable por el dueño. Antes estaba fijo en 30 minutos para todos, escrito
-- a mano en la ruta de la tienda: una heladería y un asadero ofrecían las
-- mismas franjas (migration-2026-08-06-tiempo-de-preparacion.sql).
--
-- ⚠️ CUARTA y última aparición de create_business_onboarding: es la que manda,
-- y por eso se construyó sobre la TERCERA (la de planes), no sobre la inicial.
-- Copiar la primera revierte los planes de facturación en silencio: la cazó
-- tests/sql/verificar-esquema.sql con «debía dejar una cuota, dejó 12».
-- Las barberías no usan nada de esto — su tiempo va por products.duration_minutes.
-- ════════════════════════════════════════════════════════════════════════

alter table public.businesses
  add column if not exists prep_time_minutes int not null default 25,
  add column if not exists delivery_extra_minutes int not null default 10;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_tiempos_check'
  ) then
    alter table public.businesses add constraint businesses_tiempos_check check (
      -- Un mínimo de 1: cero minutos prometería el pedido en el acto, y la
      -- franja «ahora mismo» no la puede cumplir ninguna cocina. El tope de
      -- 480 (ocho horas) deja sitio a un catering o a una torta por encargo
      -- sin permitir que un cero mal tecleado ofrezca horas de la semana que
      -- viene.
      prep_time_minutes between 1 and 480
      -- El envío SÍ puede ser cero: un negocio que solo atiende en su cuadra
      -- entrega en lo que tarda en cruzar la calle.
      and delivery_extra_minutes between 0 and 240
    );
  end if;
end;
$$;

comment on column public.businesses.prep_time_minutes is
  'Minutos hasta tener el pedido listo. Manda en las franjas programadas.';
comment on column public.businesses.delivery_extra_minutes is
  'Minutos que suma llevarlo a domicilio. Solo se muestra, no calcula franjas.';

-- ── 2. Un negocio nuevo nace con el tiempo de su tipo ─────────────────────
--
-- La FIRMA NO CAMBIA: los datos entran por el `p_business` jsonb que ya
-- recibía, así que este `create or replace` reemplaza de verdad la función en
-- vez de crear una segunda con otra firma —que es lo que pasa al añadir un
-- parámetro, dejando las dos vivas y ejecutándose la que decida PostgreSQL—.
-- Por lo mismo, los `revoke`/`grant` de la migración de onboarding siguen
-- siendo válidos y no hace falta repetirlos.
create or replace function public.create_business_onboarding(
  p_business jsonb,
  p_client_email text default null,
  p_password_hash text default null,
  p_monthly_rate numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business public.businesses%rowtype;
  v_name text := btrim(coalesce(p_business ->> 'name', ''));
  v_slug text := btrim(coalesce(p_business ->> 'slug', ''));
  v_whatsapp_number text :=
    btrim(coalesce(p_business ->> 'whatsapp_number', ''));
  v_whatsapp_provider text :=
    coalesce(nullif(btrim(p_business ->> 'whatsapp_provider'), ''), 'ycloud');
  v_client_email text :=
    nullif(btrim(coalesce(p_client_email, '')), '');
  v_password_hash text := nullif(p_password_hash, '');
  v_chat_mode text :=
    coalesce(nullif(btrim(p_business ->> 'chat_mode'), ''), 'miniapp');
  v_plan text :=
    lower(coalesce(nullif(btrim(p_business ->> 'plan'), ''), 'micro'));
  v_plan_definition record;
  v_monthly_rate numeric;
  v_contact_limit integer;
  v_outbound_limit integer;
  v_period_start date :=
    date_trunc('month', timezone('America/Guayaquil', now()))::date;
  v_period_end date :=
    (v_period_start + interval '1 month' - interval '1 day')::date;
begin
  if jsonb_typeof(p_business) is distinct from 'object' then
    raise exception using
      errcode = '22023',
      message = 'Los datos del negocio son inválidos';
  end if;
  if v_name = '' or v_slug = '' then
    raise exception using
      errcode = '22023',
      message = 'Nombre y slug son obligatorios';
  end if;
  -- El número deja de ser obligatorio SOLO para el negocio del marketplace,
  -- que se atiende por el número de la plataforma. Para los demás sigue
  -- siéndolo: sin él, el webhook no tendría forma de saber de quién es el
  -- mensaje que acaba de llegar.
  if v_whatsapp_provider <> 'marketplace' and v_whatsapp_number = '' then
    raise exception using
      errcode = '22023',
      message = 'Un negocio con canal propio necesita su número';
  end if;
  if (v_client_email is null) <> (v_password_hash is null) then
    raise exception using
      errcode = '22023',
      message = 'Email y contraseña deben enviarse juntos';
  end if;
  if v_password_hash is not null
     and v_password_hash !~ '^\$2[aby]\$[0-9]{2}\$' then
    raise exception using
      errcode = '22023',
      message = 'La contraseña debe llegar cifrada';
  end if;
  if v_chat_mode not in ('miniapp') then
    raise exception using
      errcode = '22023',
      message = 'El único modo de conversación es miniapp';
  end if;

  select *
  into v_plan_definition
  from public.billing_plan_definition(v_plan);

  if not found then
    raise exception using
      errcode = '22023',
      message = 'El plan seleccionado no existe';
  end if;

  if p_monthly_rate is not null
     and p_monthly_rate is distinct from v_plan_definition.monthly_rate then
    raise exception using
      errcode = '22023',
      message = 'La tarifa no coincide con el catálogo del plan';
  end if;
  if nullif(p_business ->> 'monthly_contact_limit', '') is not null
     and nullif(p_business ->> 'monthly_contact_limit', '')::integer
       is distinct from v_plan_definition.monthly_contact_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de contactos no coincide con el catálogo del plan';
  end if;
  if nullif(
    p_business ->> 'monthly_outbound_message_limit',
    ''
  ) is not null
     and nullif(
       p_business ->> 'monthly_outbound_message_limit',
       ''
     )::integer
       is distinct from v_plan_definition.monthly_outbound_message_limit then
    raise exception using
      errcode = '22023',
      message = 'El límite de mensajes no coincide con el catálogo del plan';
  end if;

  v_plan := v_plan_definition.plan_code;
  v_monthly_rate := v_plan_definition.monthly_rate;
  v_contact_limit := v_plan_definition.monthly_contact_limit;
  v_outbound_limit := v_plan_definition.monthly_outbound_message_limit;

  insert into public.businesses (
    slug,
    name,
    type,
    whatsapp_number,
    whatsapp_provider,
    ycloud_api_key,
    ycloud_number,
    ycloud_webhook_endpoint_id,
    ycloud_webhook_secret,
    meta_token,
    meta_phone_id,
    telegram_bot_token,
    takes_orders,
    storefront_enabled,
    chat_mode,
    ai_provider,
    owner_phone,
    plan,
    active,
    bot_active,
    suspended,
    notes,
    monthly_rate,
    monthly_contact_limit,
    monthly_outbound_message_limit,
    prep_time_minutes,
    delivery_extra_minutes
  ) values (
    v_slug,
    v_name,
    coalesce(nullif(p_business ->> 'type', ''), 'negocio'),
    nullif(v_whatsapp_number, ''),
    v_whatsapp_provider,
    nullif(p_business ->> 'ycloud_api_key', ''),
    nullif(p_business ->> 'ycloud_number', ''),
    nullif(btrim(p_business ->> 'ycloud_webhook_endpoint_id'), ''),
    nullif(p_business ->> 'ycloud_webhook_secret', ''),
    nullif(p_business ->> 'meta_token', ''),
    nullif(p_business ->> 'meta_phone_id', ''),
    nullif(p_business ->> 'telegram_bot_token', ''),
    coalesce((p_business ->> 'takes_orders')::boolean, true),
    coalesce((p_business ->> 'storefront_enabled')::boolean, false),
    v_chat_mode,
    nullif(p_business ->> 'ai_provider', ''),
    nullif(p_business ->> 'owner_phone', ''),
    v_plan,
    true,
    true,
    false,
    nullif(p_business ->> 'notes', ''),
    v_monthly_rate,
    v_contact_limit,
    v_outbound_limit,
    -- Sin valor, el defecto de la columna. El servidor manda el del tipo,
    -- pero un alta hecha fuera del panel no puede quedarse sin tiempo.
    coalesce((p_business ->> 'prep_time_minutes')::int, 25),
    coalesce((p_business ->> 'delivery_extra_minutes')::int, 10)
  )
  returning * into v_business;

  insert into public.business_schedule (
    business_id,
    day_of_week,
    open_time,
    close_time,
    slot_duration,
    is_active
  ) values
    (v_business.id, 0, '09:00', '18:00', 60, false),
    (v_business.id, 1, '09:00', '18:00', 60, true),
    (v_business.id, 2, '09:00', '18:00', 60, true),
    (v_business.id, 3, '09:00', '18:00', 60, true),
    (v_business.id, 4, '09:00', '18:00', 60, true),
    (v_business.id, 5, '09:00', '18:00', 60, true),
    (v_business.id, 6, '09:00', '13:00', 60, true)
  on conflict (business_id, day_of_week) do nothing;

  if v_client_email is not null then
    insert into public.client_users (
      business_id,
      email,
      password_hash,
      role
    ) values (
      v_business.id,
      v_client_email,
      v_password_hash,
      'owner'
    );
  end if;

  insert into public.billing (
    business_id,
    amount,
    currency,
    status,
    period_start,
    period_end,
    notes
  ) values (
    v_business.id,
    v_monthly_rate,
    'USD',
    'pending',
    v_period_start,
    v_period_end,
    'Cuota mensual automática'
  );

  return to_jsonb(v_business);
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- PORTADA DEL NEGOCIO — la imagen a sangre de su mini app
--
-- Va junto a logo_url y brand_color. Mismo CHECK que el logo (solo https): las
-- dos acaban en un <img> de una app pública, y dos reglas distintas para el
-- mismo riesgo se desincronizan (migration-2026-08-07-portada-negocio.sql).
-- ════════════════════════════════════════════════════════════════════════

alter table public.businesses
  add column if not exists cover_url text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass and conname = 'businesses_cover_check'
  ) then
    alter table public.businesses add constraint businesses_cover_check check (
      cover_url is null or cover_url ~ '^https://'
    );
  end if;
end;
$$;

comment on column public.businesses.cover_url is
  'Imagen de portada de la mini app, subida a Cloudinary. Solo https.';

-- ════════════════════════════════════════════════════════════════════════
-- NÚMERO DE PEDIDO — correlativo por negocio, desde 1
--
-- Lo asigna un TRIGGER y no cada función que crea pedidos: hay dos caminos hoy
-- (bot/mostrador y mini app) y el Marketplace será un tercero. El contador vive
-- en businesses y se mueve con update…returning, que es atómico: max()+1 tiene
-- una carrera y dos pedidos simultáneos se llevarían el mismo número.
--
-- ⚠️ ÚLTIMA aparición de create_storefront_order: es la que manda. Se redefine
-- aquí solo para que los DOS returns lleven el número, sin tocar la firma.
-- (migration-2026-08-07-numero-de-pedido.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. El contador de cada negocio y el número de cada pedido ─────────────
alter table public.businesses
  add column if not exists last_order_number integer not null default 0;

alter table public.orders
  add column if not exists order_number integer;

-- ── 2. Los pedidos que ya existían también reciben el suyo ───────────────
--
-- Sin esto, los pedidos anteriores quedarían sin número y el panel mostraría
-- huecos justo en el historial que el dueño ya conoce. Se numeran por orden de
-- creación, que es como los vivió.
with numerados as (
  select
    id,
    row_number() over (partition by business_id order by created_at, id) as numero
  from public.orders
  where order_number is null
)
update public.orders as pedido
   set order_number = numerados.numero
  from numerados
 where pedido.id = numerados.id;

-- Y el contador arranca donde acabó el historial, o los siguientes repetirían
-- números que ya están en uso.
update public.businesses as negocio
   set last_order_number = coalesce((
     select max(order_number) from public.orders where business_id = negocio.id
   ), 0)
 where negocio.last_order_number = 0;

-- ── 3. Dos pedidos no pueden llevar el mismo número ──────────────────────
create unique index if not exists uq_orders_numero
  on public.orders (business_id, order_number)
  where order_number is not null;

-- ── 4. Todo pedido nace numerado, venga por donde venga ──────────────────
create or replace function public.assign_order_number()
returns trigger
language plpgsql
security definer
-- El search_path explícito no es adorno: una función security definer sin él
-- se rompió durante cinco días en julio de 2026 al no encontrar `digest()`.
set search_path = public, pg_temp
as $$
begin
  -- Si viene con número puesto se respeta: así una migración de datos o el
  -- Marketplace pueden traer el suyo sin que el trigger lo pise.
  if new.order_number is not null then
    return new;
  end if;

  update public.businesses
     set last_order_number = last_order_number + 1
   where id = new.business_id
  returning last_order_number into new.order_number;

  -- Un negocio que no existe lo rechaza la foránea un instante después; aquí
  -- solo se evita insertar un pedido sin número por un update que no tocó nada.
  if new.order_number is null then
    raise exception using
      errcode = '23503',
      message = 'No se pudo numerar el pedido: el negocio no existe';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_assign_number on public.orders;
create trigger orders_assign_number
  before insert on public.orders
  for each row execute function public.assign_order_number();

comment on column public.orders.order_number is
  'Correlativo por negocio, desde 1. Lo asigna el trigger orders_assign_number.';
comment on column public.businesses.last_order_number is
  'Último número entregado. Lo mueve el trigger; no se edita a mano.';

-- ── 5. El número viaja a la app ──────────────────────────────────────────
--
-- El trigger ya numera todo pedido, pero `create_storefront_order` devuelve un
-- jsonb construido a mano —no la fila entera—, así que el número se quedaba en
-- la base sin llegar a la pantalla de confirmación. Lo cazó
-- tests/sql/verificar-esquema.sql: «un pedido nació sin número».
--
-- ⚠️ Se redefine sobre la ÚLTIMA versión de la función, que es la que manda, y
-- SIN TOCAR LA FIRMA: los dos parámetros siguen siendo los mismos, así que
-- `create or replace` reemplaza de verdad en vez de dejar dos funciones vivas,
-- y los revoke/grant existentes siguen valiendo.
--
-- Los DOS returns lo llevan. El del pedido repetido también, y eso importa: un
-- doble toque tiene que devolver el MISMO número, no ninguno.

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  if p_payment_method is not null and p_payment_method not in ('transferencia', 'efectivo') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- CHECKOUT: INSTRUCCIONES DE ENTREGA Y «PAGO AL RETIRAR»
--
-- ⚠️ El CHECK de payment_method que MANDA es este, no el del create table de
-- más arriba: hay dos y el de abajo pisa al de arriba. Misma trampa que los
-- estados del pedido — añadir un valor solo arriba lo deja fuera igualmente.
--
-- ⚠️ ÚLTIMA aparición de create_storefront_order. `p_notes` ya estaba en la
-- firma y se tiraba: ahora se guarda. La firma NO cambia.
-- (migration-2026-08-07-checkout.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ── 1. Dónde viven las instrucciones ─────────────────────────────────────
alter table public.orders
  add column if not exists delivery_notes text;

comment on column public.orders.delivery_notes is
  'Instrucciones del cliente para ESTE pedido: «llame al llegar». Las llena p_notes.';

-- ── 2. El tercer método de pago ──────────────────────────────────────────
do $$
begin
  alter table public.orders drop constraint if exists orders_pago_check;
  alter table public.orders add constraint orders_pago_check check (
    shipping >= 0
    and (
      payment_method is null
      or payment_method in ('transferencia', 'efectivo', 'pago_al_retirar')
    )
    -- Un texto larguísimo aquí acabaría en el panel del dueño y en el reporte.
    and (delivery_notes is null or char_length(delivery_notes) <= 300)
  );
end;
$$;

-- ── 3. La RPC guarda lo que ya recibía ───────────────────────────────────
--
-- Firma IDÉNTICA: `p_notes` estaba desde siempre. Solo cambia el insert.

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  if p_payment_method is not null and p_payment_method not in ('transferencia', 'efectivo') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- «PAGO AL RETIRAR» TAMBIÉN DENTRO DE LA RPC
--
-- La función lleva su propia lista de métodos válidos, aparte del CHECK de la
-- tabla, y se dispara ANTES. Un valor permitido en dos sitios y prohibido en un
-- tercero no falla al compilar: falla cuando un cliente intenta pedir.
-- (migration-2026-08-07-pago-al-retirar-rpc.sql)
-- ════════════════════════════════════════════════════════════════════════

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0, 'pendiente', 'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- EL FLUJO DEL PEDIDO, CONTADO COMO ES
--
-- ⚠️ ÚLTIMAS apariciones de set_order_status y create_storefront_order.
-- · Quien va a transferir nace en `esperando_pago`, no en `pendiente`.
-- · `pago_en_revision → preparacion` se ABRE: el botón «Aceptar y preparar»
--   es una sola decisión, no dos. Antes estaba prohibida a propósito.
-- (migration-2026-08-08-flujo-del-pedido.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ── MARCAR UNA LÍNEA COMO PREPARADA (2026-09-24) ──────────────────────────
--
-- La checklist que impide que un pedido salga incompleto. Idempotente: en una
-- cocina se toca dos veces por nervio, y un doble toque no puede dejar dos
-- eventos ni cambiar quién la marcó.
create or replace function public.marcar_linea_preparada(
  p_business_id uuid,
  p_order_id    uuid,
  p_item_id     uuid,
  p_user_id     uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item   public.order_items%rowtype;
  v_estado text;
  v_faltan integer;
begin
  select status into v_estado
  from public.orders
  where id = p_order_id and business_id = p_business_id;
  if not found then
    raise exception using errcode = '42501', message = 'El pedido no pertenece a este negocio';
  end if;

  -- Un pedido cerrado no se re-prepara: rompería la trazabilidad de lo que de
  -- verdad pasó. Se avisa en vez de escribir.
  if v_estado in ('completado', 'cancelado', 'rechazado', 'expirado') then
    return jsonb_build_object('result', 'cerrado', 'status', v_estado);
  end if;

  select * into v_item
  from public.order_items
  where id = p_item_id and order_id = p_order_id and business_id = p_business_id
  for update;
  if not found then
    raise exception using errcode = '42501', message = 'Esa línea no es de este pedido';
  end if;

  if v_item.prepared_at is null then
    update public.order_items
       set prepared_at = now(),
           prepared_by = p_user_id
     where id = p_item_id;

    insert into public.order_events (
      business_id, order_id, from_status, to_status, note, created_by, order_item_id
    ) values (
      p_business_id, p_order_id, v_estado, 'producto_agregado',
      left(v_item.product_name || ' x' || v_item.quantity, 300),
      p_user_id, p_item_id
    );
  end if;

  select count(*) into v_faltan
  from public.order_items
  where order_id = p_order_id and prepared_at is null;

  -- Cuando cae la última, se apunta que el pedido está completo: es el hito
  -- que el dueño busca en la línea de tiempo.
  if v_faltan = 0 and v_item.prepared_at is null then
    insert into public.order_events (
      business_id, order_id, from_status, to_status, created_by
    ) values (p_business_id, p_order_id, v_estado, 'pedido_completo', p_user_id);
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'faltan', v_faltan,
    'total', (select count(*) from public.order_items where order_id = p_order_id)
  );
end;
$$;

revoke all on function public.marcar_linea_preparada(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.marcar_linea_preparada(uuid, uuid, uuid, uuid)
  to service_role;


create or replace function public.set_order_status(
  p_business_id uuid,
  p_order_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
  v_anterior text;
  -- Lo que falta por meter en la bolsa, ya con nombre y cantidad.
  v_faltan text;
begin
  if p_status not in (
    'pendiente', 'esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
    'preparacion', 'listo_para_retiro', 'en_camino', 'completado',
    'cancelado', 'rechazado', 'expirado'
  ) then
    raise exception using errcode = '22023', message = 'Estado de pedido inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'order', null);
  end if;

  if v_order.status = p_status then
    return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
  end if;
  v_anterior := v_order.status;

  -- Un pedido que el cliente retira en el local (o consume en sitio) no puede
  -- salir a reparto. Los pedidos del bot no traen `fulfillment`: se asumen a
  -- domicilio, que es como funcionan hoy por WhatsApp.
  if p_status = 'en_camino'
     and coalesce(v_order.fulfillment, 'delivery') <> 'delivery' then
    return jsonb_build_object('result', 'not_deliverable', 'order', to_jsonb(v_order));
  end if;

  -- Y al revés: un pedido a domicilio no se queda «listo para retirar».
  if p_status = 'listo_para_retiro'
     and coalesce(v_order.fulfillment, 'delivery') = 'delivery' then
    return jsonb_build_object('result', 'not_pickable', 'order', to_jsonb(v_order));
  end if;

  -- ── EL CANDADO: NINGÚN PEDIDO SALE INCOMPLETO ──────────────────────────
  --
  -- ⚠️ EN LAS DOS SALIDAS, y esto corrige el encargo. El prompt pedía bloquear
  -- solo `listo_para_recoger`; aquí ese estado es `listo_para_retiro` y SOLO
  -- vale para quien pasa a recoger. Un pedido a domicilio sale por `en_camino`.
  --
  -- Medido en producción: 69 pedidos a domicilio contra 3 de retiro. Bloquear
  -- solo el retiro habría protegido 3 de 72, y habría dejado fuera justo el
  -- caso que motivó todo: la bolsa que se va en la moto sin la gaseosa.
  --
  -- ⚠️ Vive AQUÍ y no en el panel porque esta es la única puerta que cambia el
  -- estado de un pedido: así no se salta recargando ni desde el navegador.
  if p_status in ('en_camino', 'listo_para_retiro') then
    select string_agg(product_name || ' x' || quantity, ', ' order by created_at)
    into v_faltan
    from public.order_items
    where order_id = p_order_id and prepared_at is null;

    if v_faltan is not null then
      return jsonb_build_object(
        'result', 'incompleto',
        'faltan', v_faltan,
        'order', to_jsonb(v_order)
      );
    end if;
  end if;

  -- El pedido avanza; nunca retrocede. `completado`, `cancelado`, `rechazado`
  -- y `expirado` son finales: de ahí no sale a ningún sitio, así que
  -- «cancelado → preparacion» o «completado → preparacion» quedan fuera por no
  -- estar listados, no por una regla aparte.
  if not (
    (v_order.status = 'pendiente'
      and p_status in ('esperando_pago', 'pago_en_revision', 'confirmado', 'aceptado',
                       'preparacion', 'cancelado', 'rechazado', 'expirado'))
    -- Esperando el pago: si el cliente transfirió por fuera y avisó por
    -- WhatsApp, el dueño puede arrancar sin esperar a que suba nada.
    or (v_order.status = 'esperando_pago'
      and p_status in ('pago_en_revision', 'confirmado', 'aceptado', 'preparacion',
                       'rechazado', 'cancelado', 'expirado'))
    -- El comprobante está subido y el dueño lo mira.
    --
    -- ⚠️ `preparacion` se abrió el 2026-08-08. Antes estaba prohibido a
    -- propósito —«nunca directo a la cocina»— porque aceptar y empezar eran
    -- dos decisiones. Con el botón «Aceptar y preparar» son UNA: el dueño que
    -- da el pago por bueno es el mismo que manda hacerlo, y obligarle a dos
    -- toques solo añadía un estado que el cliente no entiende. Rechazar sigue
    -- siendo la otra salida.
    or (v_order.status = 'pago_en_revision'
      and p_status in ('confirmado', 'aceptado', 'preparacion', 'rechazado',
                       'cancelado', 'expirado'))
    or (v_order.status = 'confirmado'
      and p_status in ('aceptado', 'preparacion', 'listo_para_retiro', 'en_camino',
                       'completado', 'cancelado', 'expirado'))
    or (v_order.status = 'aceptado'
      and p_status in ('preparacion', 'listo_para_retiro', 'en_camino', 'completado',
                       'cancelado'))
    or (v_order.status = 'preparacion'
      and p_status in ('listo_para_retiro', 'en_camino', 'completado', 'cancelado'))
    or (v_order.status = 'listo_para_retiro'
      and p_status in ('completado', 'cancelado'))
    or (v_order.status = 'en_camino'
      and p_status in ('completado', 'cancelado'))
  ) then
    return jsonb_build_object('result', 'invalid_transition', 'order', to_jsonb(v_order));
  end if;

  update public.orders
  set status = p_status, updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  -- El historial. Sin esto, «¿cuándo se confirmó?» solo se puede responder
  -- mirando `updated_at`, que se pisa con cada cambio.
  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, v_anterior, p_status);

  -- Entregado = vendido. Si algo fallara aquí cae la transacción entera: nunca
  -- queda un pedido entregado sin su venta.
  if p_status = 'completado' then
    perform public.crear_venta_desde_pedido(p_business_id, p_order_id);
  end if;

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  if p_address_id is not null then
    if not exists (
      select 1 from public.customer_addresses
      where id = p_address_id
        and business_id = p_business_id
        and customer_id = p_customer_id
        and active = true
    ) then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0,
    -- ⚠️ Quien va a TRANSFERIR nace esperando el pago, no «pendiente».
    --
    -- El estado existía desde hace tiempo y no lo usaba nadie: todo pedido
    -- nacía igual, pagara como pagara. Eso hacía que el dueño viera lo mismo
    -- en dos situaciones distintas —uno que le va a pagar en la puerta y otro
    -- del que aún no ha visto un centavo— y que el cliente leyera «pedido
    -- confirmado» cuando su negocio ni lo había mirado.
    case when p_payment_method = 'transferencia' then 'esperando_pago' else 'pendiente' end,
    'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), '')
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- EL PAGO QUE LLEGÓ POR FUERA DE LA APP
-- (migration-2026-08-08-pago-confirmado.sql)
--
-- En Ecuador la mayoría transfiere desde la app de su banco y manda la captura
-- POR WHATSAPP, no por la mini app. A veces ni siquiera es su cuenta: paga un
-- amigo. Ese pago vale igual, pero no había dónde anotarlo: el cliente veía
-- «Esperando pago» sin saber si su plata llegó, y el dueño veía «Sin
-- comprobante» teniendo la captura en el chat.
--
-- NO es un estado nuevo: no describe dónde está el pedido, sino algo que le
-- pasó. Un pedido puede estar cobrado y todavía sin empezar. Lo marca la ruta
-- —al aceptar y al tocar «Marcar pago recibido»—, nunca las funciones del
-- dinero: recrearlas por una fecha no compensa el riesgo.
-- ════════════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists payment_confirmed_at timestamptz;

comment on column public.orders.payment_confirmed_at is
  'Cuándo el negocio dio el pago por bueno. Nulo = todavía no. Sirve para el '
  'pago que llegó por WhatsApp, que nunca pasa por payment_proof_url.';

-- ════════════════════════════════════════════════════════════════════════
-- UN AVISO POR PEDIDO, Y SOLO UNO
-- (migration-2026-08-08-aviso-al-cliente.sql)
--
-- `set_order_status` devuelve `updated` también cuando el estado ya era ese,
-- así que desde fuera no se distingue de un cambio real: tocar «Aceptar y
-- preparar» dos veces le mandaría dos mensajes al cliente, y desde el 1 de
-- octubre de 2026 Meta cobra cada uno.
--
-- ⚠️ Se RECLAMA con `update ... where customer_notified_at is null returning`,
-- que es atómico. Consultar y luego enviar deja una carrera: dos peticiones a
-- la vez leerían nulo las dos. Mismo patrón que `last_order_number`.
-- ════════════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists customer_notified_at timestamptz;

comment on column public.orders.customer_notified_at is
  'Cuándo se le avisó al cliente de que su pedido entró en preparación. Se '
  'reclama de forma atómica: quien gana el update es quien envía. Nulo = '
  'todavía no se le ha avisado.';

-- ════════════════════════════════════════════════════════════════════════
-- TRES AVISOS POR PEDIDO, UNO POR HITO — Y NINGUNO REPETIDO
-- (migration-2026-08-08-avisos-por-estado.sql)
--
-- Con un solo aviso bastaba `customer_notified_at is null`. Con tres, la
-- pregunta cambia: ya no es «¿se avisó?», es «¿se avisó DE ESTO?». Sin esta
-- columna, el primer aviso dejaría la fecha puesta y los otros dos no saldrían
-- nunca — un fallo silencioso, que no rompe nada y deja de hacer algo.
--
-- ⚠️ Se sigue reclamando dentro del propio `update`. Y basta comparar con el
-- ÚLTIMO estado avisado porque el pedido nunca retrocede: `set_order_status`
-- lo prohíbe, así que los tres hitos son siempre valores distintos en fila.
-- ════════════════════════════════════════════════════════════════════════

alter table public.orders
  add column if not exists customer_notified_status text;

comment on column public.orders.customer_notified_status is
  'El último estado del que se avisó al cliente. Se reclama de forma atómica: '
  'quien gana el update es quien envía. Nulo = todavía no se le ha avisado de '
  'nada.';

update public.orders
   set customer_notified_status = 'preparacion'
 where customer_notified_at is not null
   and customer_notified_status is null;

-- ════════════════════════════════════════════════════════════════════════
-- EL PEDIDO SE QUEDA CON LA DIRECCIÓN, NO CON UN PUNTERO
-- (migration-2026-08-10-direccion-del-pedido.sql)
--
-- `orders.address_id` es una foránea `on delete set null`, y el panel leía la
-- dirección a través de ella con un embed. O sea que el pedido no guardaba a
-- dónde iba: PREGUNTABA a dónde va hoy esa dirección. Con eso:
--
--   · el cliente corrige su dirección a media entrega y la pantalla del
--     repartidor cambia debajo de él;
--   · el cliente la borra y el pedido se queda sin dirección, para siempre.
--
-- Es exactamente lo que este proyecto ya resolvió para los productos:
-- `order_items` no apunta al catálogo, se queda con `product_name` y
-- `unit_price` congelados para que el pedido de ayer siga diciendo lo que el
-- cliente compró. La dirección se había quedado fuera de esa regla.
--
-- `address_id` NO se retira: sigue sirviendo para saber a qué casa pide más un
-- cliente. Lo que cambia es que deja de ser de donde se lee para repartir.
--
-- ⚠️ Esto obliga a recrear `create_storefront_order`, que es la autoridad del
-- dinero (regla inviolable #8). El cambio dentro de ella es el mínimo: la
-- comprobación de que la dirección es de ese cliente y ese negocio ya existía
-- —cuatro condiciones— y ahora esa MISMA consulta además trae los datos. No se
-- relaja ninguna validación; se aprovecha una lectura que ya se hacía.
--
-- ── Y los campos que el repartidor necesita ──────────────────────────────
--
-- Hoy una dirección es texto libre. Lo que hay guardado de verdad en
-- producción es «7 de agosto», «Calle Manabí» y «Gsgsvzvdvdvs»: con eso no
-- llega nadie. Se añaden las piezas que faltan para que el pedido llegue:
--
--   · `accuracy_m`     — cuántos metros de error reporta el GPS del navegador.
--                        Un pin con 2 km de error es un pin que MIENTE, y el
--                        repartidor merece saber si fiarse o solo orientarse.
--   · `building_type`  — casa, departamento, oficina… decide si hay portero,
--                        timbre o hay que llamar desde abajo.
--   · `courier_notes`  — qué hacer al llegar, y es PERMANENTE: «el timbre no
--                        sirve, toca la puerta» no cambia entre pedidos.
--
-- `latitude` y `longitude` ya existían desde hace tiempo con su CHECK de
-- rangos; lo que faltaba era que alguien las escribiera.
--
-- ⚠️ `courier_notes` (de la DIRECCIÓN) no es `orders.delivery_notes` (del
-- PEDIDO). El primero es para siempre; el segundo es «hoy déjalo con el
-- guardia». Juntarlos obligaría al cliente a reescribir lo permanente en cada
-- compra, que es justo lo que se quiere evitar.
--
-- ⚠️ Sin PostGIS a propósito. El CI aplica `schema.sql` sobre la imagen
-- `pgvector/pgvector:pg16`, que no lo trae, y no existe imagen oficial con
-- pgvector y PostGIS a la vez. Como `latitude`/`longitude` son la fuente de
-- verdad, el día que la app de repartidor pida polígonos de zona se les cuelga
-- encima una columna `geography` GENERADA sin tocar un solo dato ya guardado.
-- ════════════════════════════════════════════════════════════════════════

-- ── La dirección del cliente, con lo que hace falta para llegar ───────────
alter table public.customer_addresses
  add column if not exists accuracy_m     numeric(7,1),
  add column if not exists building_type  text,
  add column if not exists courier_notes  text;

comment on column public.customer_addresses.accuracy_m is
  'Metros de error que reportó el GPS del navegador al capturar el pin. Nulo = '
  'la dirección no tiene ubicación, o se puso a mano.';
comment on column public.customer_addresses.building_type is
  'Casa, departamento, oficina… Decide si hay portero o timbre. Nulo = no lo dijo.';
comment on column public.customer_addresses.courier_notes is
  'Qué hacer al llegar, PERMANENTE para esta dirección. No confundir con '
  'orders.delivery_notes, que es de un pedido concreto.';

-- Los rangos se comprueban en la base y no solo en la ruta: la ruta se puede
-- cambiar, y una precisión negativa o un tipo de edificio inventado dejarían
-- al repartidor con un dato que no sabe leer.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.customer_addresses'::regclass
      and conname = 'customer_addresses_reparto_check'
  ) then
    alter table public.customer_addresses
      add constraint customer_addresses_reparto_check check (
        (accuracy_m is null or (accuracy_m >= 0 and accuracy_m <= 100000))
        and (building_type is null or building_type in
             ('casa', 'departamento', 'oficina', 'hotel', 'otro'))
        and char_length(coalesce(courier_notes, '')) <= 300
      );
  end if;
end $$;

-- ── El pedido se queda con la fotografía ──────────────────────────────────
alter table public.orders
  add column if not exists delivery_label         text,
  add column if not exists delivery_address       text,
  add column if not exists delivery_reference     text,
  add column if not exists delivery_latitude      numeric(10,7),
  add column if not exists delivery_longitude     numeric(10,7),
  add column if not exists delivery_accuracy_m    numeric(7,1),
  add column if not exists delivery_building_type text,
  add column if not exists delivery_courier_notes text;

comment on column public.orders.delivery_address is
  'A dónde se llevó ESTE pedido, copiado al crearlo. Es la fuente de verdad '
  'para repartir: address_id puede cambiar o quedarse en nulo.';
comment on column public.orders.delivery_latitude is
  'El pin tal como estaba al pedir. Con delivery_longitude abre el mapa.';

-- Mismos rangos que en la dirección de origen. Un pedido con una latitud de
-- 200 no lo puede crear ni la RPC ni un update a mano.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.orders'::regclass
      and conname = 'orders_direccion_congelada_check'
  ) then
    alter table public.orders
      add constraint orders_direccion_congelada_check check (
        (delivery_latitude is null or delivery_latitude between -90 and 90)
        and (delivery_longitude is null or delivery_longitude between -180 and 180)
        and (delivery_accuracy_m is null or
             (delivery_accuracy_m >= 0 and delivery_accuracy_m <= 100000))
      );
  end if;
end $$;

-- ── Lo que ya está pedido ─────────────────────────────────────────────────
--
-- Todos los pedidos a domicilio conservan hoy su `address_id`, así que se
-- recuperan enteros. Cada día que esto espere, un cliente que edite o borre su
-- dirección quema uno — y ese no vuelve.
--
-- Solo se rellena lo que está en nulo: si esta migración se corriera dos veces,
-- no puede pisar una dirección ya congelada con la que tenga el cliente hoy.
update public.orders o
   set delivery_label         = ca.label,
       delivery_address       = ca.address,
       delivery_reference     = ca.reference,
       delivery_latitude      = ca.latitude,
       delivery_longitude     = ca.longitude,
       delivery_accuracy_m    = ca.accuracy_m,
       delivery_building_type = ca.building_type,
       delivery_courier_notes = ca.courier_notes
  from public.customer_addresses ca
 where ca.id = o.address_id
   and ca.business_id = o.business_id
   and o.delivery_address is null;

-- ── La RPC del dinero, con la copia dentro ────────────────────────────────
create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
  -- La dirección se copia al pedido, no se apunta. Van en variables sueltas y
  -- no en un record porque en PL/pgSQL un record sin asignar no se puede ni
  -- consultar, y sin dirección —retiro en local— no se asigna ninguna.
  v_dir_label text;
  v_dir_address text;
  v_dir_reference text;
  v_dir_latitude numeric(10,7);
  v_dir_longitude numeric(10,7);
  v_dir_accuracy numeric(7,1);
  v_dir_building_type text;
  v_dir_courier_notes text;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  --
  -- Antes esto solo COMPROBABA; ahora además trae los datos, porque el pedido
  -- se los queda. Es la misma consulta y las mismas cuatro condiciones: no se
  -- relaja nada, se aprovecha lo que ya se estaba leyendo.
  --
  -- `for share` bloquea la fila hasta que la transacción termine: sin él, el
  -- cliente podría borrar su dirección entre la comprobación y la copia.
  if p_address_id is not null then
    select label, address, reference, latitude, longitude, accuracy_m,
           building_type, courier_notes
    into v_dir_label, v_dir_address, v_dir_reference, v_dir_latitude,
         v_dir_longitude, v_dir_accuracy, v_dir_building_type,
         v_dir_courier_notes
    from public.customer_addresses
    where id = p_address_id
      and business_id = p_business_id
      and customer_id = p_customer_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  -- ⚠️ La dirección se CONGELA, igual que `order_items` congela el nombre y el
  -- precio del producto. `address_id` se queda como puntero —sirve para saber
  -- a qué casa pide más un cliente— pero ya no es de donde se lee para
  -- repartir: si el cliente corrige su dirección el martes, el pedido del lunes
  -- tiene que seguir diciendo a dónde se llevó.
  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes,
    delivery_label, delivery_address, delivery_reference,
    delivery_latitude, delivery_longitude, delivery_accuracy_m,
    delivery_building_type, delivery_courier_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0,
    -- ⚠️ Quien va a TRANSFERIR nace esperando el pago, no «pendiente».
    --
    -- El estado existía desde hace tiempo y no lo usaba nadie: todo pedido
    -- nacía igual, pagara como pagara. Eso hacía que el dueño viera lo mismo
    -- en dos situaciones distintas —uno que le va a pagar en la puerta y otro
    -- del que aún no ha visto un centavo— y que el cliente leyera «pedido
    -- confirmado» cuando su negocio ni lo había mirado.
    case when p_payment_method = 'transferencia' then 'esperando_pago' else 'pendiente' end,
    'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_dir_label, v_dir_address, v_dir_reference,
    v_dir_latitude, v_dir_longitude, v_dir_accuracy,
    v_dir_building_type, v_dir_courier_notes
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name', e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;

-- ════════════════════════════════════════════════════════════════════════
-- EL PEDIDO SE LEE EN EL ORDEN QUE PUSO EL DUEÑO
-- (migration-2026-08-11-orden-de-los-grupos.sql)
--
-- Una pizza se piensa en un orden: primero el sabor, luego la masa, luego el
-- borde, y al final lo que se agrega y cuesta aparte. El pedido se contaba en
-- orden ALFABÉTICO —Borde, Extras, Masa, Retira, Sabor—, que es el orden de un
-- listado, no el de una cocina.
--
-- No se podía hacer mejor porque no había de dónde sacarlo: las filas de
-- `order_item_options` se insertan todas en la misma sentencia y comparten
-- `created_at` al milisegundo, así que no existía ningún orden guardado.
--
-- ── Por qué se COPIA y no se consulta ────────────────────────────────────
--
-- `option_groups.sort` ya tiene el orden bueno. Lo obvio sería unirse a esa
-- tabla al leer el pedido. Y sería lento donde más duele: **el panel del dueño
-- pregunta por sus pedidos cada 12 segundos** (`refetchInterval: 12_000`), de
-- modo que esa unión correría sin parar durante todo el servicio, por cada
-- negocio con el panel abierto. Copiar el número al crear el pedido cuesta cero
-- al leer, para siempre.
--
-- Y encaja con lo que esta tabla ya hace: `option_group_name`, `option_name` y
-- `unit_price_adjustment` son copias congeladas por la misma razón —que el
-- pedido de ayer siga diciendo lo que el cliente compró—. El orden es una más.
--
-- ⚠️ Consecuencia deliberada: si el dueño reordena sus grupos mañana, los
-- pedidos de hoy conservan el orden de hoy. Es lo correcto para una comanda y
-- lo mismo que ya pasa con el nombre y el precio.
--
-- ── Y para que el dueño pueda ordenarlos ─────────────────────────────────
--
-- El editor de `Catálogo → Personalización` creaba TODOS los grupos con
-- `sort = 0` y no ofrecía forma de cambiarlo. Con todo empatado a cero, ordenar
-- por `sort` no habría hecho nada: los valores buenos de la pizzería de prueba
-- venían de scripts, no del panel. Por eso van también las dos funciones que
-- reordenan, que es lo que convierte esto en algo que el dueño usa.
--
-- Se hace con una función y no con N updates sueltos porque reordenar es UNA
-- decisión: a mitad de camino, media lista reordenada es peor que la lista sin
-- tocar. Y la pertenencia al negocio se comprueba en un solo sitio.
-- ════════════════════════════════════════════════════════════════════════

alter table public.order_item_options
  add column if not exists group_sort integer not null default 0;

comment on column public.order_item_options.group_sort is
  'El orden que el dueño le dio a este grupo, copiado al crear el pedido. Se '
  'copia y no se consulta porque el panel lee pedidos cada 12 segundos.';

-- Los pedidos que ya existen toman el orden que sus grupos tienen HOY. Es lo
-- mejor disponible: cuando se hicieron, ese orden no se guardaba en ningún
-- sitio. Los grupos ya borrados se quedan en 0 y caen al criterio alfabético.
update public.order_item_options oio
   set group_sort = og.sort
  from public.option_groups og
 where og.id = oio.option_group_id
   and og.business_id = oio.business_id
   and oio.group_sort = 0;

-- ── Reordenar, como una sola decisión ────────────────────────────────────

/**
 * Reordena los grupos de un negocio según la lista que se le pase.
 *
 * `p_ids` viene en el orden deseado y cada uno recibe su posición. Los grupos
 * que no aparezcan en la lista no se tocan: el panel manda solo los que el
 * dueño está viendo —los de un producto o los de una categoría— y no tiene por
 * qué conocer los demás.
 *
 * Devuelve cuántos movió. Si un id no es de este negocio simplemente no se
 * mueve: el `where` lleva `business_id`, así que no hay forma de reordenar los
 * grupos de otro local ni sabiendo sus identificadores.
 */
create or replace function public.reorder_option_groups(
  p_business_id uuid,
  p_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_movidos integer;
begin
  if p_business_id is null then
    raise exception using errcode = '42501', message = 'Falta el negocio';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 200 then
    raise exception using errcode = '22023', message = 'Demasiados grupos a la vez';
  end if;

  update public.option_groups og
     set sort = posicion.orden,
         updated_at = now()
    from (
      select id, (ordinality - 1)::integer as orden
      from unnest(p_ids) with ordinality as t(id, ordinality)
    ) posicion
   where og.id = posicion.id
     and og.business_id = p_business_id;

  get diagnostics v_movidos = row_count;
  return v_movidos;
end;
$$;

revoke all on function public.reorder_option_groups(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_option_groups(uuid, uuid[]) to service_role;

/**
 * Lo mismo para las opciones DENTRO de un grupo.
 *
 * Lleva el grupo además del negocio: sin él, un id de otro grupo del mismo
 * local se colaría en esta lista y saldría reordenado donde no toca.
 */
create or replace function public.reorder_options(
  p_business_id uuid,
  p_group_id uuid,
  p_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_movidos integer;
begin
  if p_business_id is null or p_group_id is null then
    raise exception using errcode = '42501', message = 'Falta el negocio o el grupo';
  end if;
  if p_ids is null or cardinality(p_ids) = 0 then
    return 0;
  end if;
  if cardinality(p_ids) > 200 then
    raise exception using errcode = '22023', message = 'Demasiadas opciones a la vez';
  end if;

  update public.options o
     set sort = posicion.orden,
         updated_at = now()
    from (
      select id, (ordinality - 1)::integer as orden
      from unnest(p_ids) with ordinality as t(id, ordinality)
    ) posicion
   where o.id = posicion.id
     and o.business_id = p_business_id
     and o.option_group_id = p_group_id;

  get diagnostics v_movidos = row_count;
  return v_movidos;
end;
$$;

revoke all on function public.reorder_options(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.reorder_options(uuid, uuid, uuid[]) to service_role;

-- ── La RPC del dinero, copiando el orden ─────────────────────────────────
-- ── Pedir otro comprobante ────────────────────────────────────────────────
-- La segunda oportunidad que faltaba: rechazar CIERRA el pedido, así que una
-- foto borrosa costaba una venta. No recrea `set_order_status` a propósito.
-- (migration-2026-08-15-otra-oportunidad.sql)
create or replace function public.request_new_payment_proof(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.orders%rowtype;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and business_id = p_business_id
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Solo desde «el dueño lo está mirando». Desde cualquier otro estado esto no
  -- significa nada: un pedido ya aceptado no vuelve a esperar un comprobante.
  if v_order.status <> 'pago_en_revision' then
    return jsonb_build_object(
      'result', 'invalid_transition',
      'order', to_jsonb(v_order)
    );
  end if;

  update public.orders
  set status = 'esperando_pago',
      payment_proof_url = null,
      payment_proof_public_id = null,
      payment_confirmed_at = null,
      -- El aviso se reclama por hito y este pedido vuelve atrás: sin soltar la
      -- marca, el aviso de «en preparación» no saldría cuando por fin arranque.
      customer_notified_status = null,
      updated_at = now()
  where id = p_order_id and business_id = p_business_id
  returning * into v_order;

  insert into public.order_events (business_id, order_id, from_status, to_status)
  values (p_business_id, p_order_id, 'pago_en_revision', 'esperando_pago');

  return jsonb_build_object('result', 'updated', 'order', to_jsonb(v_order));
end;
$$;

revoke all on function public.request_new_payment_proof(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_new_payment_proof(uuid, uuid)
  to service_role;

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
  -- La dirección se copia al pedido, no se apunta. Van en variables sueltas y
  -- no en un record porque en PL/pgSQL un record sin asignar no se puede ni
  -- consultar, y sin dirección —retiro en local— no se asigna ninguna.
  v_dir_label text;
  v_dir_address text;
  v_dir_reference text;
  v_dir_latitude numeric(10,7);
  v_dir_longitude numeric(10,7);
  v_dir_accuracy numeric(7,1);
  v_dir_building_type text;
  v_dir_courier_notes text;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  for share;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  --
  -- Antes esto solo COMPROBABA; ahora además trae los datos, porque el pedido
  -- se los queda. Es la misma consulta y las mismas cuatro condiciones: no se
  -- relaja nada, se aprovecha lo que ya se estaba leyendo.
  --
  -- `for share` bloquea la fila hasta que la transacción termine: sin él, el
  -- cliente podría borrar su dirección entre la comprobación y la copia.
  if p_address_id is not null then
    select label, address, reference, latitude, longitude, accuracy_m,
           building_type, courier_notes
    into v_dir_label, v_dir_address, v_dir_reference, v_dir_latitude,
         v_dir_longitude, v_dir_accuracy, v_dir_building_type,
         v_dir_courier_notes
    from public.customer_addresses
    where id = p_address_id
      and business_id = p_business_id
      and customer_id = p_customer_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  -- ⚠️ La dirección se CONGELA, igual que `order_items` congela el nombre y el
  -- precio del producto. `address_id` se queda como puntero —sirve para saber
  -- a qué casa pide más un cliente— pero ya no es de donde se lee para
  -- repartir: si el cliente corrige su dirección el martes, el pedido del lunes
  -- tiene que seguir diciendo a dónde se llevó.
  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes,
    delivery_label, delivery_address, delivery_reference,
    delivery_latitude, delivery_longitude, delivery_accuracy_m,
    delivery_building_type, delivery_courier_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0,
    -- ⚠️ Quien va a TRANSFERIR nace esperando el pago, no «pendiente».
    --
    -- El estado existía desde hace tiempo y no lo usaba nadie: todo pedido
    -- nacía igual, pagara como pagara. Eso hacía que el dueño viera lo mismo
    -- en dos situaciones distintas —uno que le va a pagar en la puerta y otro
    -- del que aún no ha visto un centavo— y que el cliente leyera «pedido
    -- confirmado» cuando su negocio ni lo había mirado.
    case when p_payment_method = 'transferencia' then 'esperando_pago' else 'pendiente' end,
    'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_dir_label, v_dir_address, v_dir_reference,
    v_dir_latitude, v_dir_longitude, v_dir_accuracy,
    v_dir_building_type, v_dir_courier_notes
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type,
               og.sort as group_sort
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          -- El ORDEN que el dueño le dio a este grupo, congelado como el
          -- nombre y el precio. Se copia al crear el pedido y no se consulta al
          -- leer: el panel del dueño pregunta por sus pedidos cada 12 segundos,
          -- y una unión más ahí correría sin parar durante todo el servicio.
          'option_group_sort', coalesce(v_option_row.group_sort, 0),
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, group_sort, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name',
           coalesce((e ->> 'option_group_sort')::integer, 0),
           e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- MOTOR DE MARGEN DE LA PLATAFORMA
-- Migración incremental: migration-2026-08-16-motor-de-margen.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Un restaurante y un supermercado no se pueden cobrar igual: el primero
-- trabaja con márgenes amplios y el segundo al 2–5 %, así que cobrarle a un
-- supermercado el 8 % de una canasta de $80 le costaría MÁS de lo que gana
-- con esa venta. Por eso el margen es una tabla configurable y no un número,
-- con tres frenos que protegen a partes distintas:
--
--   · `max_amount` (TECHO) protege al comercio de volumen.
--   · `min_amount` (PISO) protege a la PLATAFORMA: cada pedido cuesta
--     mensajes de WhatsApp y llamadas de IA, y sin piso los pedidos pequeños
--     se atienden a pérdida.
--   · `tiered` cubre lo que no alcanzan los otros dos.
--
-- `markup_mode` reconcilia los dos modelos económicos: `absorbed` (el margen
-- se absorbe del precio del comercio, invisible para el cliente) y `on_top`
-- (se suma al precio del cliente). Mismo cálculo y mismo asiento; lo único
-- que cambia es de dónde sale. Arranca en `absorbed` y el motor NO toca
-- `orders.total`: encender `on_top` exige antes pintar el precio con margen
-- en el catálogo, el carrito y el resumen.
--
-- ⚠️ El margen se calcula sobre el SUBTOTAL, una vez, no por línea. El
-- margen por producto o categoría exigiría leer `order_items` desde el
-- disparador, y en ese momento esas filas todavía no existen en uno de los
-- dos caminos de creación. Por eso `scope` admite hoy solo los tres niveles
-- resolubles sobre el subtotal, y FALLA CERRADO: no se puede guardar una
-- regla que el motor no vaya a honrar.

create table if not exists public.pricing_rules (
  id               uuid primary key default gen_random_uuid(),
  business_id      uuid references public.businesses(id) on delete cascade,
  scope            text not null,
  target_name      text,
  strategy         text not null,
  percentage       numeric(7,4),
  fixed_amount     numeric(10,2),
  tiers            jsonb,
  min_amount       numeric(10,2),
  max_amount       numeric(10,2),
  markup_mode      text not null default 'absorbed',
  version          integer not null default 1,
  effective_from   timestamptz not null default now(),
  effective_until  timestamptz,
  status           text not null default 'active',
  notes            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint pricing_rules_scope_check
    check (scope in ('global', 'business_type', 'business')),
  constraint pricing_rules_strategy_check
    check (strategy in ('percentage', 'fixed', 'tiered')),
  constraint pricing_rules_mode_check
    check (markup_mode in ('absorbed', 'on_top')),
  constraint pricing_rules_status_check
    check (status in ('active', 'draft', 'archived')),

  -- Una regla «de negocio» sin `business_id` se aplicaría a TODA la
  -- plataforma sin que nadie lo pidiera: el error más caro de esta tabla.
  constraint pricing_rules_destino_check check (
    (scope = 'global'        and business_id is null     and target_name is null)
    or
    (scope = 'business_type' and business_id is null     and target_name is not null)
    or
    (scope = 'business'      and business_id is not null and target_name is null)
  ),

  -- Una regla `percentage` sin porcentaje cobraría 0 en silencio.
  constraint pricing_rules_datos_check check (
    (strategy = 'percentage' and percentage   is not null and fixed_amount is null and tiers is null)
    or
    (strategy = 'fixed'      and fixed_amount is not null and percentage   is null and tiers is null)
    or
    (strategy = 'tiered'     and tiers        is not null and percentage   is null and fixed_amount is null)
  ),

  constraint pricing_rules_rangos_check check (
    (percentage   is null or (percentage   >= 0 and percentage   <= 100))
    and (fixed_amount is null or (fixed_amount >= 0 and fixed_amount <= 9999))
    and (min_amount   is null or (min_amount   >= 0 and min_amount   <= 9999))
    and (max_amount   is null or (max_amount   >= 0 and max_amount   <= 9999))
    and (min_amount is null or max_amount is null or min_amount <= max_amount)
    and (version >= 1)
    and (effective_until is null or effective_until > effective_from)
  ),

  constraint pricing_rules_tiers_check check (
    tiers is null or jsonb_typeof(tiers) = 'array'
  )
);

alter table public.pricing_rules enable row level security;

-- Dos reglas activas para el mismo destino dejarían el margen a merced del
-- orden de lectura: el mismo pedido cobraría distinto según cómo respondiera
-- PostgreSQL ese día.
create unique index if not exists idx_pricing_rules_activa_negocio
  on public.pricing_rules (business_id)
  where scope = 'business' and status = 'active';

create unique index if not exists idx_pricing_rules_activa_tipo
  on public.pricing_rules (target_name)
  where scope = 'business_type' and status = 'active';

create unique index if not exists idx_pricing_rules_activa_global
  on public.pricing_rules ((true))
  where scope = 'global' and status = 'active';

-- Se copian AL PEDIDO en vez de consultarse al leerlo, por lo mismo que se
-- copió la dirección: el panel pide sus pedidos cada 12 segundos. Cambiar el
-- porcentaje mañana NO reescribe el margen de los pedidos de hoy.
alter table public.orders
  add column if not exists merchant_subtotal    numeric(10,2),
  add column if not exists platform_markup      numeric(10,2),
  add column if not exists pricing_rule_id      uuid,
  add column if not exists pricing_rule_version integer;

-- Sin FK a `pricing_rules` a propósito: es un rastro histórico, no un puntero
-- vivo. Con `set null` se borraría la prueba de qué regla se aplicó.
comment on column public.orders.pricing_rule_id is
  'Regla de margen aplicada. Sin FK: es un rastro histórico, no un puntero vivo.';

-- Resuelve la regla y aplica la estrategia en UNA función, para que no exista
-- la posibilidad de resolver con una y cobrar con otra. `p_rule_id` fuerza una
-- regla ya congelada.
create or replace function public.calculate_platform_markup(
  p_business_id uuid,
  p_subtotal    numeric,
  p_rule_id     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_regla   public.pricing_rules%rowtype;
  v_base    numeric(10,2);
  v_markup  numeric(10,2) := 0;
  v_tier    jsonb;
  v_tipo    text;
begin
  v_base := round(coalesce(p_subtotal, 0), 2);

  if v_base <= 0 then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if p_rule_id is not null then
    select * into v_regla from public.pricing_rules where id = p_rule_id;
  else
    select pr.* into v_regla
    from public.pricing_rules pr
    left join public.businesses b on b.id = p_business_id
    where pr.status = 'active'
      and pr.effective_from <= now()
      and (pr.effective_until is null or pr.effective_until > now())
      and (
        (pr.scope = 'business'      and pr.business_id = p_business_id)
        or (pr.scope = 'business_type' and pr.target_name = b.type)
        or (pr.scope = 'global')
      )
    order by case pr.scope
               when 'business'      then 1
               when 'business_type' then 2
               when 'global'        then 3
             end
    limit 1;
  end if;

  -- FALLA ABIERTO: un problema de configuración de precios no puede dejar a
  -- una pizzería sin poder vender.
  if v_regla.id is null then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if v_regla.strategy = 'percentage' then
    v_markup := v_base * v_regla.percentage / 100.0;

  elsif v_regla.strategy = 'fixed' then
    v_markup := v_regla.fixed_amount;

  elsif v_regla.strategy = 'tiered' then
    -- Ordenado por `up_to` y no por el orden del array: un array mal ordenado
    -- en el panel cobraría el tramo equivocado sin avisar.
    for v_tier in
      select value
      from jsonb_array_elements(v_regla.tiers) as value
      order by coalesce((value ->> 'up_to')::numeric, 'infinity'::numeric)
    loop
      v_tipo := v_tier ->> 'up_to';
      if v_tipo is null or v_base <= v_tipo::numeric then
        v_markup := coalesce((v_tier ->> 'amount')::numeric, 0);
        exit;
      end if;
    end loop;
  end if;

  if v_regla.min_amount is not null then
    v_markup := greatest(v_markup, v_regla.min_amount);
  end if;
  if v_regla.max_amount is not null then
    v_markup := least(v_markup, v_regla.max_amount);
  end if;

  -- Raíles que no dependen de la configuración: nunca negativo, y nunca más
  -- que el subtotal. Un piso de $5 sobre un pedido de $2 no puede dejar al
  -- comercio debiendo dinero por haber vendido.
  v_markup := greatest(v_markup, 0);
  v_markup := least(v_markup, v_base);

  return jsonb_build_object(
    'markup',       round(v_markup, 2),
    'rule_id',      v_regla.id,
    'rule_version', v_regla.version,
    'markup_mode',  v_regla.markup_mode,
    'strategy',     v_regla.strategy
  );
end;
$$;

revoke all on function public.calculate_platform_markup(uuid, numeric, uuid)
  from public, anon, authenticated;
grant execute on function public.calculate_platform_markup(uuid, numeric, uuid)
  to service_role;

-- ⚠️ NO se recrean `create_storefront_order` ni `set_order_status`, mismo
-- criterio que `orders_reject_blocked`. Un disparador cubre LOS TRES caminos
-- —tienda, bot y mostrador— y cualquiera que se invente después.
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc jsonb;
begin
  -- `create_storefront_order` inserta el pedido con subtotal 0 y lo actualiza
  -- al final: sin esta condición se sellaría 0 y no volvería a mirarse.
  if coalesce(new.subtotal, 0) <= 0 then
    return new;
  end if;

  -- El panel actualiza estos pedidos muchas veces (estado, aviso,
  -- comprobante); recalcular en cada una sería trabajo tirado.
  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  -- Si el pedido ya tiene regla sellada se recalcula con ESA y no con la
  -- vigente hoy: un pedido de febrero no puede empezar a cobrar el porcentaje
  -- de marzo porque alguien le cambió el estado.
  v_calc := public.calculate_platform_markup(
    new.business_id,
    new.subtotal,
    new.pricing_rule_id
  );

  new.merchant_subtotal    := round(new.subtotal - (v_calc ->> 'markup')::numeric, 2);
  new.platform_markup      := (v_calc ->> 'markup')::numeric;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  return new;
end;
$$;

drop trigger if exists orders_stamp_pricing on public.orders;
create trigger orders_stamp_pricing
  before insert or update on public.orders
  for each row execute function public.orders_stamp_pricing();


-- ════════════════════════════════════════════════════════════════════════
-- CUÁNTO LLEVA ACUMULADO CADA COMERCIO
-- Migración incremental: migration-2026-08-16-resumen-de-margen.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Se suma sobre `sales`, NO sobre `orders`: un pedido puede estar aceptado o
-- en preparación y todavía no ser dinero. La venta nace cuando el pedido se
-- ENTREGA, que es el estándar que ya siguen todos los reportes del dueño.
--
-- Consecuencias deliberadas: un pedido cancelado nunca llega a `sales` y no
-- genera comisión —no hay que excluirlo, no está—; una venta ANULADA deja de
-- contar; y las ventas de citas y estadías entran con margen 0, porque
-- `platform_markup` vive en `orders`.
--
-- La fecha que manda es `sold_at` y no `orders.created_at`: un pedido de fin
-- de mes entregado el día 1 pertenece al mes en que se cobró. Contarlo por la
-- fecha del pedido haría que cerrar un mes cambiara números ya facturados.
--
-- ⚠️ `p_business_id` nulo devuelve TODOS los negocios y existe solo para el
-- panel del superadmin. La ruta del comercio pasa SIEMPRE su `businessId` del
-- JWT (regla inviolable #1).

-- Los locales de demostración (2026-09-30): la columna va AQUÍ, antes de la
-- primera función `language sql` que la nombra (se valida al crearla). Ver
-- `migration-2026-09-30-locales-de-demostracion.sql`.
alter table public.businesses
  add column if not exists is_demo boolean not null default false;

comment on column public.businesses.is_demo is
  'Local de demostración: su dinero es de prueba. Su liquidación no se paga y no cuenta en lo que gana Umbani.';

create or replace function public.platform_markup_summary(
  p_from        date,
  p_to          date,
  p_business_id uuid default null
)
returns table (
  business_id   uuid,
  business_name text,
  pedidos       bigint,
  bruto         numeric,
  margen        numeric,
  comercio      numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.business_id,
    max(b.name)                                    as business_name,
    count(*)                                       as pedidos,
    round(coalesce(sum(s.total), 0), 2)            as bruto,
    round(coalesce(sum(o.platform_markup), 0), 2)  as margen,
    round(coalesce(sum(s.total), 0)
        - coalesce(sum(o.platform_markup), 0), 2)  as comercio
  from public.sales s
  join public.businesses b on b.id = s.business_id
  -- `left`: una venta de cita o estadía no tiene pedido detrás y debe contar
  -- en el bruto igualmente.
  left join public.orders o on o.id = s.order_id
  where s.status = 'completada'
    and s.sold_at >= p_from
    and s.sold_at <  p_to
    and (p_business_id is null or s.business_id = p_business_id)
  group by s.business_id
  order by round(coalesce(sum(o.platform_markup), 0), 2) desc;
$$;

revoke all on function public.platform_markup_summary(date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.platform_markup_summary(date, date, uuid)
  to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- EL CIERRE DE MES: LA COMISIÓN ENTRA EN LA FACTURA
-- Migración incremental: migration-2026-08-16-cierre-de-mes.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Pensado para MUCHOS negocios, no para uno. Tres decisiones que con un local
-- son opinables y con los miles de una ciudad grande no:
--
--   1. El cierre es UNA operación por conjuntos, no un bucle. Un bucle haría
--      una consulta por local: con 5.000 locales, un cierre de minutos que se
--      cae a la mitad. Aquí es un solo `insert ... on conflict`.
--   2. Índices para el rango de fechas: `idx_sales_biz_date` empieza por
--      `business_id` y no sirve para «todas las ventas de agosto».
--   3. Idempotente por naturaleza: no suma, RECALCULA desde `sales` y escribe
--      el valor absoluto. Un reintento tras un fallo de red no cobra el doble.
--
-- ⚠️ Un mes ya PAGADO no se reescribe jamás: si una venta se anula después de
-- liquidar, se descuenta del mes SIGUIENTE. Una factura emitida es un hecho.
--
-- ⚠️ `billing.amount` sigue siendo LA CUOTA. Sumarle la comisión rompería toda
-- lectura existente y dejaría al comercio sin distinguir qué paga por el
-- servicio y qué por sus ventas.

-- ── 1. La comisión en la factura ───────────────────────────────────────────
alter table public.billing
  add column if not exists commission_amount    numeric(10,2) not null default 0,
  add column if not exists commission_orders    integer       not null default 0,
  add column if not exists commission_closed_at timestamptz;

comment on column public.billing.commission_amount is
  'Comisión de la plataforma del periodo. `amount` sigue siendo la cuota: el total es la suma.';


-- ── 2. Una factura por negocio y mes, declarado ────────────────────────────
--
-- La invariante ya existía —`billing_month_claims` tiene esa clave primaria—
-- pero `billing` no la declaraba, así que ningún camino futuro estaba
-- obligado a respetarla. Declararla permite además cerrar el mes con
-- `on conflict`, en UNA operación atómica en vez de leer-y-luego-escribir,
-- que con dos instancias del servidor es una carrera.
--
-- Verificado antes de crearlo: cero duplicados en los datos actuales.
create unique index if not exists uq_billing_negocio_periodo
  on public.billing (business_id, period_start);


-- ── 3. El índice que hace posible el cierre ────────────────────────────────
--
-- El cierre pregunta «todas las ventas completadas de este mes, de TODOS los
-- negocios». `idx_sales_biz_date` empieza por `business_id` y no sirve para
-- eso. Parcial sobre `completada` porque las anuladas no se cobran: el índice
-- queda más pequeño y más rápido.
create index if not exists idx_sales_cierre
  on public.sales (sold_at)
  where status = 'completada';

-- El cruce del cierre contra la factura del periodo.
create index if not exists idx_billing_periodo
  on public.billing (period_start);


-- ── 4. El cierre ───────────────────────────────────────────────────────────
--
-- Devuelve qué hizo, para que la tarea programada pueda registrarlo y el
-- superadmin vea el resultado sin abrir la base.
create or replace function public.settle_month_commission(
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin       date;
  v_afectadas integer;
  v_total     numeric(10,2);
  v_pagadas   integer;
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception using
      errcode = '22023',
      message = 'El cierre va sobre el primer día de un mes.';
  end if;

  v_fin := (p_period_start + interval '1 month')::date;

  -- Cuántas facturas de ese mes están pagadas y por tanto NO se tocan. Se
  -- cuenta ANTES de escribir para poder informarlo: si un mes se cierra tarde
  -- y ya se cobró, el superadmin tiene que enterarse en vez de creer que
  -- entró todo.
  select count(*) into v_pagadas
  from public.billing
  where period_start = p_period_start
    and status = 'paid'
    and exists (
      select 1 from public.platform_markup_summary(p_period_start, v_fin, business_id)
    );

  -- UNA operación: calcula, actualiza lo que existe y crea lo que falta.
  --
  -- `insert ... on conflict do update` en vez de leer-y-escribir porque con
  -- dos instancias del servidor lo segundo es una carrera: las dos leerían
  -- «no hay factura» y las dos insertarían.
  with resumen as (
    select * from public.platform_markup_summary(p_period_start, v_fin, null)
  )
  insert into public.billing (
    business_id, amount, currency, period_start, period_end,
    status, commission_amount, commission_orders, commission_closed_at
  )
  select
    r.business_id,
    -- Sin cuota conocida la factura nace en 0 y solo lleva comisión: es
    -- preferible a que la comisión de ese local no se facture nunca.
    coalesce(b.monthly_rate, 0),
    'USD',
    p_period_start,
    (v_fin - interval '1 day')::date,
    'pending',
    r.margen,
    r.pedidos,
    now()
  from resumen r
  join public.businesses b on b.id = r.business_id
  on conflict (business_id, period_start) do update
  set commission_amount    = excluded.commission_amount,
      commission_orders    = excluded.commission_orders,
      commission_closed_at = now()
  -- ⚠️ Un mes ya pagado NO se reescribe: si una venta se anula después de
  -- liquidar, se descuenta del mes siguiente. Una factura emitida es un hecho.
  where public.billing.status <> 'paid';

  get diagnostics v_afectadas = row_count;

  select coalesce(sum(commission_amount), 0) into v_total
  from public.billing
  where period_start = p_period_start;

  return jsonb_build_object(
    'periodo',            p_period_start,
    'facturas_afectadas', v_afectadas,
    'comision_total',     v_total,
    'ya_pagadas',         v_pagadas
  );
end;
$$;

revoke all on function public.settle_month_commission(date)
  from public, anon, authenticated;
grant execute on function public.settle_month_commission(date)
  to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- TRES CASOS LÍMITE DEL MOTOR DE MARGEN
-- Migración incremental: migration-2026-08-16-margen-casos-limite.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- 1. EL MES TERMINA EN ECUADOR. `sold_at` es timestamptz y las fechas del
--    cierre llegaban como `date`, comparadas en la zona de la sesión (UTC en
--    Supabase): una venta del 31 de agosto a las 20:00 en Ecuador son las
--    01:00 UTC del 1 de septiembre y se facturaba en SEPTIEMBRE. No es un
--    caso raro: son las cinco últimas horas de CADA día, la franja de más
--    ventas de un restaurante.
--
-- 2. LA COMISIÓN NO SE COBRA SOBRE UN DESCUENTO. El margen salía de
--    `subtotal`, el precio ANTES del descuento: un pedido de $100 con $20 de
--    descuento deja $80 al comercio y se le cobraba el 10% de $100.
--
-- 3. `on_top` PROMETÍA ALGO QUE NO HACE. El disparador restaba igual, así que
--    era `absorbed` con otro nombre. El CHECK lo cierra hasta que el catálogo,
--    el carrito y el resumen pinten el precio con margen. Falla CERRADO, igual
--    que `scope` con 'category'.

-- ── 1. El mes, en hora de Ecuador ──────────────────────────────────────────
-- ⚠️ LAS TRES BOLSAS NO SE MEZCLAN (2026-09-21). `comercio = bruto - margen`
-- le atribuia al local la CARRERA, que es de quien entrega: sobre un pedido de
-- $15.18 decia «se queda $13.98» cuando de su comida solo eran $11.98. Se
-- retiro esa columna —conservarla «por compatibilidad» garantizaba que alguien
-- volviera a pintarla— y se devuelven `reparto` y `productos` por separado.
-- `margen` NO cambia: de ahi salen la factura del mes y el arrastre.
--
-- ⚠️ El `drop` es obligatorio y no un adorno: `create or replace` NO admite
-- cambiar las columnas de salida, asi que sin el un esquema aplicado desde
-- cero fallaria al llegar aqui.
drop function if exists public.platform_markup_summary(date, date, uuid);

create function public.platform_markup_summary(
  p_from        date,
  p_to          date,
  p_business_id uuid default null
)
returns table (
  business_id   uuid,
  business_name text,
  pedidos       bigint,
  -- Lo que pago el cliente, entero: productos + reparto + margen.
  bruto         numeric,
  -- De la PLATAFORMA. La factura del mes sale de aqui.
  margen        numeric,
  -- De QUIEN ENTREGA. Ni del local ni de la plataforma.
  reparto       numeric,
  -- Del LOCAL, por su comida. Su venta de verdad.
  productos     numeric
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    s.business_id,
    max(b.name)                                    as business_name,
    count(*)                                       as pedidos,
    round(coalesce(sum(s.total), 0), 2)            as bruto,
    round(coalesce(sum(o.platform_markup), 0), 2)  as margen,
    -- Una venta sin pedido —cita, estadia, mostrador— no tiene carrera: ahi
    -- `reparto` es 0 y `productos` se lleva todo.
    round(coalesce(sum(o.shipping), 0), 2)         as reparto,
    round(coalesce(sum(s.total), 0)
        - coalesce(sum(o.platform_markup), 0)
        - coalesce(sum(o.shipping), 0), 2)         as productos
  from public.sales s
  join public.businesses b on b.id = s.business_id
  left join public.orders o on o.id = s.order_id
  where s.status = 'completada'
    -- El día empieza y acaba en Ecuador. Sin esto, las ventas de 19:00 a
    -- medianoche —la franja de más movimiento— caen en el día siguiente, y
    -- las del último día del mes, en el mes siguiente.
    and s.sold_at >= (p_from::timestamp at time zone 'America/Guayaquil')
    and s.sold_at <  (p_to::timestamp   at time zone 'America/Guayaquil')
    and (p_business_id is null or s.business_id = p_business_id)
    -- ⚠️ Lo que gana Umbani no cuenta los locales de DEMOSTRACIÓN (2026-09-30),
    -- salvo que se pregunte por ese local: entonces ve lo suyo.
    and (p_business_id is not null or not b.is_demo)
  group by s.business_id
  order by round(coalesce(sum(o.platform_markup), 0), 2) desc;
$$;

revoke all on function public.platform_markup_summary(date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.platform_markup_summary(date, date, uuid)
  to service_role;


-- ── 2. El descuento sale de la base antes de calcular ──────────────────────
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc jsonb;
  v_base numeric(10,2);
begin
  -- La base es lo que el comercio cobra POR LOS PRODUCTOS: el subtotal menos
  -- el descuento. No incluye el envío, que no es suyo, ni la propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  -- El panel actualiza estos pedidos muchas veces (estado, aviso,
  -- comprobante); recalcular en cada una sería trabajo tirado.
  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(
    new.business_id,
    v_base,
    new.pricing_rule_id
  );

  new.merchant_subtotal    := round(v_base - (v_calc ->> 'markup')::numeric, 2);
  new.platform_markup      := (v_calc ->> 'markup')::numeric;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  return new;
end;
$$;


-- ── 3. `on_top` no se puede guardar hasta que exista de verdad ─────────────
--
-- Falla CERRADO, igual que `scope` con 'category'. Es preferible que el
-- superadmin no pueda elegirlo a que lo elija y obtenga otra cosa.
alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (markup_mode in ('absorbed', 'on_top'));

comment on column public.pricing_rules.markup_mode is
  '`on_top`: el margen se SUMA al precio y el comercio cobra entero. `absorbed`: se le descuenta. El modelo del negocio es `on_top` desde el 2026-08-25.';


-- ════════════════════════════════════════════════════════════════════════
-- LOS MÉTODOS DE PAGO, DE VERDAD CONFIGURABLES
-- Migración incremental: migration-2026-08-16-metodos-de-pago.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- `businesses.payment_methods` era TEXTO LIBRE que solo alimentaba el prompt
-- del bot, y la tienda tenía los tres métodos escritos a mano: el dueño creía
-- que elegía cómo le pagan y no elegía nada. La prueba está en los datos —
-- 3 de 43 pedidos se pagaron en efectivo sin que nadie lo hubiera activado.
--
-- Es un CATÁLOGO y no un enum para que añadir un método sea UNA FILA y no una
-- migración. `tarjeta`, `billetera` y `pasarela` nacen con `available=false`:
-- existen en la arquitectura (§18 del prompt maestro) pero la plataforma NO
-- procesa cobros (regla #6), así que activarlos sería prometer lo que no
-- ocurre. Falla CERRADO, igual que `markup_mode` con `on_top`.
--
-- El SUPERADMIN manda sobre el catálogo; el DUEÑO decide los suyos, igual que
-- ya decide su envío, su logo y su tiempo de preparación.
--
-- ⚠️ `businesses.payment_methods` (el texto libre) NO se borra: sigue
-- alimentando el prompt del bot, que es lo único para lo que servía.
--
-- ⚠️ El cinturón NO recrea `create_storefront_order`: su lista interna queda
-- como guardia amplia de plataforma y el disparador hace cumplir lo de cada
-- negocio, cerrando además la carrera entre que la app pinta los métodos y el
-- cliente confirma.

-- ── 1. El catálogo de la plataforma ────────────────────────────────────────
--
-- Sin `business_id` a propósito: es de la plataforma, no de un negocio, igual
-- que `server_settings`. RLS activa y sin políticas — entra el servidor con la
-- service role key y nadie más.
create table if not exists public.payment_methods (
  code           text primary key,
  label          text not null,
  help_text      text,

  -- Lo que de verdad cambia el flujo, y por eso son columnas y no un `if` en
  -- el código: `is_prepaid` decide si el pedido nace esperando pago, y
  -- `requires_proof` si se le pide comprobante.
  is_prepaid     boolean not null default false,
  requires_proof boolean not null default false,

  -- ¿La plataforma puede procesarlo HOY? Lo que está en false no se puede
  -- activar en ningún negocio: falla cerrado.
  available      boolean not null default false,

  sort           integer not null default 0,
  created_at     timestamptz not null default now(),

  constraint payment_methods_code_check
    check (code ~ '^[a-z_]{3,30}$'),
  constraint payment_methods_label_check
    check (char_length(btrim(label)) between 1 and 60),
  constraint payment_methods_sort_check
    check (sort >= 0 and sort <= 999)
);

alter table public.payment_methods enable row level security;

-- Los seis del §18. Los tres primeros son los que la plataforma sabe manejar
-- hoy; los otros tres existen para que activarlos mañana sea un booleano.
insert into public.payment_methods (code, label, help_text, is_prepaid, requires_proof, available, sort)
values
  ('transferencia',   'Transferencia bancaria',
   'Transfiere y manda la captura por el mismo chat de WhatsApp.', true, true, true, 10),
  ('efectivo',        'Efectivo al recibir',
   'Paga en efectivo cuando te lo entreguen.',             false, false, true,  20),
  ('pago_al_retirar', 'Pago al retirar',
   'Pagas cuando pases a recoger tu pedido.',              false, false, true,  30),
  ('tarjeta',         'Tarjeta',                null, true,  false, false, 40),
  ('billetera',       'Billetera digital',      null, true,  false, false, 50),
  ('pasarela',        'Pasarela de pagos',      null, true,  false, false, 60)
on conflict (code) do nothing;


-- ── 2. Los que acepta cada negocio ─────────────────────────────────────────
create table if not exists public.business_payment_methods (
  business_id uuid not null references public.businesses(id) on delete cascade,
  method_code text not null references public.payment_methods(code) on delete restrict,
  enabled     boolean not null default true,
  sort        integer not null default 0,
  updated_at  timestamptz not null default now(),

  primary key (business_id, method_code),
  constraint business_payment_methods_sort_check check (sort >= 0 and sort <= 999)
);

alter table public.business_payment_methods enable row level security;

create index if not exists idx_business_payment_methods_activos
  on public.business_payment_methods (business_id)
  where enabled;

-- No se puede activar un método que la plataforma no sabe procesar. La
-- comprobación va en la BASE y no solo en la ruta porque es la única que no
-- se puede saltar: cierra también el camino del panel del superadmin.
create or replace function public.business_payment_method_disponible()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.enabled and not exists (
    select 1 from public.payment_methods
    where code = new.method_code and available
  ) then
    raise exception using
      errcode = '22023',
      message = 'Ese método de pago todavía no está disponible en la plataforma.';
  end if;
  return new;
end;
$$;

drop trigger if exists business_payment_methods_disponible on public.business_payment_methods;
create trigger business_payment_methods_disponible
  before insert or update on public.business_payment_methods
  for each row execute function public.business_payment_method_disponible();


-- ── 3. Los negocios que ya existen conservan lo que tenían ─────────────────
--
-- Hoy la tienda ofrece transferencia y efectivo a todo el mundo, así que eso
-- es exactamente lo que se les asigna: la migración NO cambia el
-- comportamiento de ningún negocio en marcha. Lo que cambia es que a partir de
-- ahora se puede tocar.
--
-- `pago_al_retirar` también, porque la app ya lo ofrecía en modo retiro.
insert into public.business_payment_methods (business_id, method_code, enabled, sort)
select b.id, m.code, true, m.sort
from public.businesses b
cross join public.payment_methods m
where m.code in ('transferencia', 'efectivo', 'pago_al_retirar')
on conflict (business_id, method_code) do nothing;


-- ── 4. El cinturón: un pedido no puede pagar con lo que el local no acepta ─
--
-- ⚠️ NO se recrea `create_storefront_order`. Su lista interna se queda como
-- guardia AMPLIA de plataforma —rechaza cualquier cosa que no sea uno de los
-- métodos conocidos— y este disparador hace cumplir lo de CADA negocio, dentro
-- de la misma transacción que la inserción.
--
-- Eso cierra además la carrera que la ruta no puede cerrar: entre que la app
-- pinta los métodos y el cliente confirma, el dueño puede haber apagado uno.
--
-- ⚠️ Acotado a `source = 'storefront'`, igual que `orders_reject_blocked`: un
-- pedido de MOSTRADOR lo teclea el dueño con la persona delante, y si decide
-- cobrarle en efectivo un día que tiene el efectivo apagado en su tienda, es
-- asunto suyo.
--
-- Sin método (los pedidos del bot no preguntan cómo se paga) no se comprueba
-- nada: no hay nada que contradecir.
create or replace function public.orders_check_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') = 'storefront'
     and new.payment_method is not null
     and not exists (
       select 1
       from public.business_payment_methods bpm
       join public.payment_methods pm on pm.code = bpm.method_code
       where bpm.business_id = new.business_id
         and bpm.method_code = new.payment_method
         and bpm.enabled
         and pm.available
     ) then
    raise exception using
      errcode = '22023',
      message = 'Ese local no acepta ese método de pago.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_check_payment_method on public.orders;
create trigger orders_check_payment_method
  before insert on public.orders
  for each row execute function public.orders_check_payment_method();


-- ── 5. Lo que la tienda necesita saber ─────────────────────────────────────
--
-- Devuelve solo lo que ese negocio acepta Y la plataforma sabe procesar. La
-- app pinta lo que reciba: deja de tener los métodos escritos a mano.
create or replace function public.storefront_payment_methods(p_business_id uuid)
returns table (
  code           text,
  label          text,
  help_text      text,
  is_prepaid     boolean,
  requires_proof boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select pm.code, pm.label, pm.help_text, pm.is_prepaid, pm.requires_proof
  from public.business_payment_methods bpm
  join public.payment_methods pm on pm.code = bpm.method_code
  where bpm.business_id = p_business_id
    and bpm.enabled
    and pm.available
  order by bpm.sort, pm.sort, pm.code;
$$;

revoke all on function public.storefront_payment_methods(uuid) from public, anon, authenticated;
grant execute on function public.storefront_payment_methods(uuid) to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- UN NEGOCIO NUEVO NACE SABIENDO CÓMO LE PAGAN
-- Migración incremental: migration-2026-08-16-metodos-al-crear.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- La migración anterior solo asignó métodos a los negocios QUE YA EXISTÍAN.
-- Uno dado de alta después nacía con CERO y su tienda no podía cobrar de
-- ninguna forma. Lo destapó el verificador del CI al primer intento; en
-- producción habría aparecido con el siguiente cliente, y con la tienda
-- publicada.
--
-- Va en un disparador y no dentro de `create_business_onboarding` porque eso
-- es recrear la función que da de alta clientes —la que estuvo rota meses por
-- un disparador mal puesto— por un añadido pequeño. Así cubre además cualquier
-- camino de creación futuro.
--
-- Solo `transferencia` nace ENCENDIDA: es el modo barato (el dinero entra
-- antes de entregar, así que no hay plantones, ni adelantos, ni efectivo que
-- controlar). El resto queda visible y apagado para que el dueño lo encienda.
--
-- ⚠️ Misma regla que las plantillas y las capacidades: solo recomienda AL
-- CREAR y jamás pisa a un negocio existente. Y no puede tumbar un alta.

create or replace function public.businesses_seed_payment_methods()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  begin
    insert into public.business_payment_methods (business_id, method_code, enabled, sort)
    select
      new.id,
      pm.code,
      -- Solo la transferencia nace encendida. El resto queda visible y
      -- apagado, para que el dueño lo encienda cuando quiera.
      pm.code = 'transferencia',
      pm.sort
    from public.payment_methods pm
    where pm.available
    on conflict (business_id, method_code) do nothing;
  exception when others then
    -- Nunca tumba el alta. Un cliente sin crear es peor que uno con los
    -- métodos por configurar.
    null;
  end;
  return new;
end;
$$;

drop trigger if exists businesses_seed_payment_methods on public.businesses;
create trigger businesses_seed_payment_methods
  after insert on public.businesses
  for each row execute function public.businesses_seed_payment_methods();


-- ════════════════════════════════════════════════════════════════════════
-- LO QUE SE ANULA DESPUÉS DE COBRAR SE DESCUENTA DEL MES SIGUIENTE
-- Migración incremental: migration-2026-08-16-arrastre-comision.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- El cierre ya respetaba la mitad de la decisión —un mes `paid` no se
-- reescribe— pero nada arrastraba la diferencia hacia adelante: si un comercio
-- pagaba agosto y en septiembre se anulaba una venta de agosto, esa comisión
-- se quedaba cobrada PARA SIEMPRE.
--
-- Reescribir hacia atrás cambiaría un número que el comercio vio y pagó, y
-- obligaría a que toda liquidación fuera reversible — cada cierre dejaría de
-- estar cerrado. Se ajusta en la siguiente, como cualquier contabilidad.
--
-- El ajuste es una resta: lo que el periodo vale HOY menos lo que se cobró.
-- Negativo = descuento por venta anulada; positivo = venta tardía.
--
-- ⚠️ Se RECLAMA por periodo: sin eso, la tarea diaria volvería a arrastrar la
-- misma diferencia cada día. Mismo patrón que `customer_notified_status`.
--
-- ⚠️ Solo meses ya PAGADOS: los `pending` se recalculan enteros en su cierre.

-- ── 1. De dónde viene el ajuste ────────────────────────────────────────────
create table if not exists public.billing_adjustments (
  id            uuid primary key default gen_random_uuid(),
  business_id   uuid not null references public.businesses(id) on delete cascade,

  -- La factura donde se aplica el descuento (el mes siguiente).
  billing_id    uuid references public.billing(id) on delete set null,

  -- El periodo que se está corrigiendo (el mes ya pagado).
  source_period date not null,

  amount        numeric(10,2) not null,
  reason        text not null,
  created_at    timestamptz not null default now(),

  -- Un periodo se salda UNA vez por negocio. Es lo que impide que el cierre
  -- diario aplique el mismo descuento treinta veces.
  constraint billing_adjustments_unicos unique (business_id, source_period),

  constraint billing_adjustments_reason_check
    check (reason in ('venta_anulada', 'venta_tardia', 'correccion_manual')),
  constraint billing_adjustments_amount_check
    check (amount <> 0 and amount between -99999 and 99999)
);

alter table public.billing_adjustments enable row level security;

create index if not exists idx_billing_adjustments_negocio
  on public.billing_adjustments (business_id, source_period);

-- Lo que la factura del mes lleva de arrastre, para poder enseñarlo aparte de
-- la comisión del propio mes. Sumarlo dentro de `commission_amount` haría
-- imposible explicarle al comercio de dónde sale su número.
alter table public.billing
  add column if not exists commission_adjustment numeric(10,2) not null default 0;

comment on column public.billing.commission_adjustment is
  'Ajuste arrastrado de meses ya pagados. Negativo = se le devuelve. El total es amount + commission_amount + commission_adjustment.';


-- ── 2. El arrastre ─────────────────────────────────────────────────────────
--
-- Mira los meses PAGADOS anteriores al que se está cerrando, compara lo
-- cobrado con lo que valen hoy, y aplica la diferencia UNA sola vez.
create or replace function public.carry_commission_adjustments(
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aplicados integer := 0;
  v_total     numeric(10,2) := 0;
  v_fila      record;
  v_vale_hoy  numeric(10,2);
  v_ajuste    numeric(10,2);
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception using
      errcode = '22023',
      message = 'El arrastre va sobre el primer día de un mes.';
  end if;

  -- Solo meses PAGADOS y anteriores, y solo los que no se hayan saldado ya.
  for v_fila in
    select b.business_id, b.period_start, b.commission_amount
    from public.billing b
    where b.status = 'paid'
      and b.period_start < p_period_start
      and not exists (
        select 1 from public.billing_adjustments a
        where a.business_id = b.business_id
          and a.source_period = b.period_start
      )
  loop
    -- Lo que ese periodo vale HOY, con las ventas tal como están ahora.
    select coalesce(sum(margen), 0) into v_vale_hoy
    from public.platform_markup_summary(
      v_fila.period_start,
      (v_fila.period_start + interval '1 month')::date,
      v_fila.business_id
    );

    v_ajuste := round(v_vale_hoy - coalesce(v_fila.commission_amount, 0), 2);

    -- Sin diferencia no se anota nada: una fila de ajuste con importe cero es
    -- ruido, y además marcaría el periodo como saldado cuando aún podría
    -- cambiar.
    continue when v_ajuste = 0;

    insert into public.billing_adjustments (
      business_id, source_period, amount, reason
    ) values (
      v_fila.business_id,
      v_fila.period_start,
      v_ajuste,
      case when v_ajuste < 0 then 'venta_anulada' else 'venta_tardia' end
    )
    on conflict (business_id, source_period) do nothing;

    v_aplicados := v_aplicados + 1;
    v_total := v_total + v_ajuste;
  end loop;

  -- Se vuelca sobre la factura del mes que se cierra. Se suma en vez de
  -- asignar porque puede arrastrar varios periodos a la vez.
  update public.billing b
  set commission_adjustment = coalesce(sub.suma, 0)
  from (
    select a.business_id, sum(a.amount) as suma
    from public.billing_adjustments a
    where a.billing_id is null
    group by a.business_id
  ) as sub
  where b.business_id = sub.business_id
    and b.period_start = p_period_start
    and b.status <> 'paid';

  -- Se marca a qué factura fueron, para que no se vuelquen otra vez mañana.
  update public.billing_adjustments a
  set billing_id = b.id
  from public.billing b
  where a.billing_id is null
    and b.business_id = a.business_id
    and b.period_start = p_period_start;

  return jsonb_build_object(
    'periodo',        p_period_start,
    'ajustes',        v_aplicados,
    'total_ajustado', v_total
  );
end;
$$;

revoke all on function public.carry_commission_adjustments(date)
  from public, anon, authenticated;
grant execute on function public.carry_commission_adjustments(date)
  to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- UN AJUSTE NO PUEDE APUNTAR A LA FACTURA DE OTRO NEGOCIO
-- Migración incremental: migration-2026-08-16-frontera-ajustes.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- `billing_adjustments.billing_id` referenciaba `billing(id)` a secas: el
-- descuento de una venta anulada en el local A podía acabar restando en la
-- factura del local B. Lo cazó `verificar-fronteras.sql` — no una prueba de
-- comportamiento, sino el guardián que busca exactamente esto.
--
-- Se cierra con foránea COMPUESTA sobre `(id, business_id)`, el mismo patrón
-- que `product_variants` y los grupos de opciones.

-- La compuesta necesita un índice único sobre las dos columnas del destino.
-- No es redundante con la clave primaria: PostgreSQL exige exactamente esta
-- pareja para poder referenciarla.
create unique index if not exists uq_billing_id_negocio
  on public.billing (id, business_id);

alter table public.billing_adjustments
  drop constraint if exists billing_adjustments_billing_id_fkey;

alter table public.billing_adjustments
  add constraint billing_adjustments_billing_fkey
  foreign key (billing_id, business_id)
  references public.billing (id, business_id)
  on delete set null;


-- ════════════════════════════════════════════════════════════════════════
-- EL MARGEN SE CALCULA POR LÍNEA, COMO SE MUESTRA
-- Migración incremental: migration-2026-08-16-margen-por-linea.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Cimiento de `on_top`: el dueño pone lo que quiere ganar por su plato, lo
-- recibe ENTERO, y el margen va encima en el precio del cliente.
--
-- Con `on_top` el cliente ve el precio de CADA producto ya con margen, así que
-- aplicar el porcentaje al subtotal diverge: tres empanadas a $3.33 al 8 %
-- suman $10.80 producto a producto y $10.79 sobre el subtotal. Un céntimo,
-- pero es «el cliente ve un número y paga otro» — la regla #8.
--
-- ⚠️ `on_top` es INCOMPATIBLE con techo, piso y estrategias que no sean
-- porcentaje, y no por decisión de producto: una canasta de $150 al 4 % suma
-- $156 producto a producto, y con techo de $3 el total sería $153 — esos $3 no
-- tienen dónde aparecer. Encaja con la realidad: el techo es para el
-- SUPERMERCADO (el cliente compara producto a producto con la tienda física) y
-- `on_top` para el RESTAURANTE (nadie sabe de memoria el precio en el local).
--
-- ⚠️ Los dos caminos de creación: la tienda actualiza el subtotal cuando los
-- ítems YA existen → por línea. El bot y el mostrador insertan con el importe
-- y los ítems después → sobre el subtotal, donde nunca se mostró un precio
-- unitario con margen.

-- ── 1. `on_top` solo con porcentaje y sin límites ──────────────────────────
alter table public.pricing_rules
  drop constraint if exists pricing_rules_mode_check;

-- Se ABRE `on_top` aquí, y en esta misma rama se completa lo que lo hace
-- honesto: que el catálogo sirva los precios con margen. Abrirlo sin eso
-- mostraría un precio y cobraría otro — la regla #8.
-- ⚠️ CERRADO a `absorbed` (migration-2026-08-16-cerrar-on-top.sql). El dueño
-- descartó `on_top` el mismo día: «lo que está en la app no tiene que subir de
-- valor» y «el cliente se quejaría» de una tarifa visible. El modelo es que el
-- COMERCIO paga la comisión de su precio, como todas las plataformas grandes.
--
-- El disparador ya sabe aplicar `on_top` y `order_markup_by_line` evita el
-- céntimo de divergencia, pero falta que el catálogo pinte los precios con
-- margen. Hasta entonces activarlo mostraría un precio y cobraría otro, así
-- que falla CERRADO — igual que `scope` con 'category'.
alter table public.pricing_rules
  add constraint pricing_rules_mode_check
  check (markup_mode in ('absorbed', 'on_top'));

comment on constraint pricing_rules_mode_check on public.pricing_rules is
  'Solo `absorbed`: el comercio paga la comisión de su precio. `on_top` exigiría que el catálogo pintara los precios con margen.';


-- ── 2. El margen de un pedido, línea por línea ─────────────────────────────
--
-- Devuelve null si el pedido todavía no tiene líneas, para que quien llama
-- sepa que tiene que caer al cálculo sobre el subtotal.
--
-- El precio unitario que se marca es `line_total / quantity`: incluye lo que
-- sumaron las opciones, que es exactamente lo que la app enseñó.
create or replace function public.order_markup_by_line(
  p_order_id   uuid,
  p_percentage numeric
)
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when count(*) = 0 then null else
    round(sum(
      -- Se redondea DONDE se redondea al mostrarlo: en el precio unitario.
      round((oi.line_total / nullif(oi.quantity, 0)) * (p_percentage / 100.0), 2)
      * oi.quantity
    ), 2)
  end
  from public.order_items oi
  where oi.order_id = p_order_id
    and oi.quantity > 0;
$$;

revoke all on function public.order_markup_by_line(uuid, numeric) from public, anon, authenticated;
grant execute on function public.order_markup_by_line(uuid, numeric) to service_role;


-- ── 3. El sello, ahora consciente del modo ─────────────────────────────────
--
-- ⚠️ Sigue sin recrear `create_storefront_order` ni `set_order_status`. Con
-- `on_top` además AJUSTA `new.total`, que es lo que hace que el cliente pague
-- el precio que vio — y se puede porque el disparador es BEFORE.
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc     jsonb;
  v_base     numeric(10,2);
  v_modo     text;
  v_pct      numeric;
  v_piso     numeric;
  v_techo    numeric;
  v_markup   numeric(10,2);
  v_porlinea numeric(10,2);
  v_envio    numeric(10,2);
begin
  -- Lo que el comercio cobra POR LOS PRODUCTOS: sin envío, sin propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(new.business_id, v_base, new.pricing_rule_id);
  v_markup := (v_calc ->> 'markup')::numeric;
  v_modo := coalesce(v_calc ->> 'markup_mode', 'absorbed');

  -- Con `on_top` el precio se muestra por producto, así que el margen se
  -- calcula por línea o el total no coincidiría con lo que el cliente sumó.
  -- Si el pedido aún no tiene líneas (bot y mostrador) se queda el del
  -- subtotal: en esos caminos nunca se mostró un precio unitario con margen.
  if v_modo = 'on_top' and (v_calc ->> 'strategy') = 'percentage' then
    select percentage, min_amount, max_amount
      into v_pct, v_piso, v_techo
    from public.pricing_rules
    where id = nullif(v_calc ->> 'rule_id', '')::uuid;

    -- ⚠️ SOLO por línea cuando la regla no tiene frenos de PEDIDO.
    --
    -- Un techo o un piso no son del producto, son del pedido entero: con un
    -- techo de $1 el reparto por línea cobraba $5 y se saltaba el freno. Y el
    -- cliente nunca vio ese número, porque ni el catálogo (`precioDeVitrina`)
    -- ni la cotización (`quoteCart`) pintan margen por producto cuando la
    -- regla lleva topes. Esta era la única capa que no hacía la excepción.
    --
    -- Con frenos se queda el margen del subtotal, que es el que YA viene
    -- recortado por `calculate_platform_markup` y el que la app le enseñó.
    if v_piso is null and v_techo is null then
      v_porlinea := public.order_markup_by_line(new.id, coalesce(v_pct, 0));
      if v_porlinea is not null then
        v_markup := v_porlinea;
      end if;
    end if;
  end if;

  new.platform_markup      := v_markup;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  if v_modo = 'on_top' then
    -- El comercio conserva su precio ENTERO: es la promesa del modo.
    new.merchant_subtotal := v_base;
    -- Y el margen se suma a lo que paga el cliente. El envío se respeta tal
    -- como lo dejó la función del dinero.
    v_envio := round(coalesce(new.total, 0) - v_base, 2);
    if v_envio < 0 then v_envio := 0; end if;
    new.total := round(v_base + v_markup + v_envio, 2);
  else
    -- `absorbed`: el margen sale del precio del comercio y el cliente paga
    -- lo mismo. El total no se toca.
    new.merchant_subtotal := round(v_base - v_markup, 2);
  end if;

  return new;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- FAMILIAS DE NEGOCIO: UNA REGLA PARA TODA LA COMIDA
-- Migración incremental: migration-2026-08-16-familias-de-negocio.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Había 52 tipos y CADA UNO era una isla: una regla para `restaurante` no
-- alcanzaba a `pizzería`, ni a `almuerzos`, ni a `batidos`. Para cobrarle lo
-- mismo a toda la comida hacían falta 24 reglas iguales, y una más por cada
-- tipo que se añadiera. Lo destapó el dueño probándolo: creó una regla para
-- `restaurante` y Monster Pizza —tipo `pizzería`— no la cogió.
--
-- La jerarquía pasa a cuatro niveles:
--     negocio  >  tipo  >  FAMILIA  >  toda la plataforma
--
-- La familia cuelga del TIPO y no del negocio: si fuera columna de
-- `businesses`, cada alta tendría que elegirla y dos pizzerías podrían acabar
-- en familias distintas.
--
-- ⚠️ Un tipo SIN familia (los personalizados que el panel deja escribir a
-- mano) cae a la regla global. Falla ABIERTO: un tipo raro no puede dejar a un
-- negocio sin poder vender.

-- ── 1. Las familias ────────────────────────────────────────────────────────
--
-- Catálogo de la plataforma, sin `business_id`, como `payment_methods`.
create table if not exists public.business_families (
  code       text primary key,
  label      text not null,
  sort       integer not null default 0,
  created_at timestamptz not null default now(),

  constraint business_families_code_check  check (code ~ '^[a-z_]{3,30}$'),
  constraint business_families_label_check check (char_length(btrim(label)) between 1 and 60),
  constraint business_families_sort_check  check (sort >= 0 and sort <= 999)
);

alter table public.business_families enable row level security;

-- Umbani reparte comida y producto a domicilio, así que sus familias son dos.
-- Hasta el 2026-08-20 había cinco: hospedaje, servicios y salud/belleza salieron
-- con los tipos que colgaban de ellas, que ya no se pueden dar de alta.
insert into public.business_families (code, label, sort) values
  ('comida',        'Comida',            10),
  ('retail',        'Tiendas y retail',  20)
on conflict (code) do nothing;


-- ── 2. A qué familia pertenece cada tipo ───────────────────────────────────
create table if not exists public.business_type_families (
  business_type text primary key,
  family_code   text not null references public.business_families(code) on delete restrict,
  updated_at    timestamptz not null default now()
);

alter table public.business_type_families enable row level security;

create index if not exists idx_business_type_families_familia
  on public.business_type_families (family_code);

-- Los 30 tipos del desplegable, clasificados. Si mañana se añade uno al panel
-- y no se clasifica aquí, cae a la regla global: no rompe nada, solo no hereda.
--
-- ⚠️ `negocio` («Otro / negocio genérico») SÍ está en el desplegable y a
-- propósito NO está aquí: un tipo genérico no puede heredar el margen de una
-- familia que nadie eligió por él. Sin mapeo cae a la global, que es lo que
-- significa «no sé qué es esto».
insert into public.business_type_families (business_type, family_code) values
  -- Comida preparada: 24 tipos que hasta hoy necesitaban 24 reglas iguales.
  ('pizzería','comida'), ('restaurante','comida'), ('cafetería','comida'),
  ('hamburguesería','comida'), ('comida rápida','comida'), ('almuerzos','comida'),
  ('menú ejecutivo','comida'), ('comida típica','comida'), ('desayunos','comida'),
  ('asadero','comida'), ('parrillada','comida'), ('pollo asado','comida'),
  ('marisquería','comida'), ('sushi','comida'), ('comida mexicana','comida'),
  ('comida china','comida'), ('comida saludable','comida'), ('heladería','comida'),
  ('pastelería','comida'), ('postres','comida'), ('batidos','comida'),
  ('jugos','comida'), ('emprendimiento de comida','comida'), ('panadería','comida'),

  -- Retail: se compra producto, no plato preparado. La carnicería va aquí
  -- porque se comporta como tienda —se venden ingredientes al peso— y no como
  -- cocina, aunque el producto sea comida.
  ('tienda','retail'), ('perfumería','retail'), ('farmacia','retail'),
  ('ferretería','retail'), ('supermercado','retail'), ('carnicería','retail')
on conflict (business_type) do nothing;


-- ── 3. Las reglas admiten ámbito de familia ────────────────────────────────
alter table public.pricing_rules
  drop constraint if exists pricing_rules_scope_check;

alter table public.pricing_rules
  add constraint pricing_rules_scope_check
  check (scope in ('global', 'family', 'business_type', 'business'));

-- Cada ámbito sigue exigiendo exactamente sus datos: una regla de familia sin
-- familia se aplicaría a toda la plataforma sin que nadie lo pidiera.
alter table public.pricing_rules
  drop constraint if exists pricing_rules_destino_check;

alter table public.pricing_rules
  add constraint pricing_rules_destino_check check (
    (scope = 'global'        and business_id is null     and target_name is null)
    or
    (scope = 'family'        and business_id is null     and target_name is not null)
    or
    (scope = 'business_type' and business_id is null     and target_name is not null)
    or
    (scope = 'business'      and business_id is not null and target_name is null)
  );

-- Una sola regla activa por familia, igual que por tipo y por negocio: dos
-- dejarían el margen a merced del orden de lectura.
create unique index if not exists idx_pricing_rules_activa_familia
  on public.pricing_rules (target_name)
  where scope = 'family' and status = 'active';


-- ── 4. La resolución, ahora con cuatro niveles ─────────────────────────────
--
-- Se recrea `calculate_platform_markup` —es una función propia del motor, no
-- una de las del dinero que no se tocan— para añadir el nivel de familia. El
-- resto del cuerpo es idéntico.
create or replace function public.calculate_platform_markup(
  p_business_id uuid,
  p_subtotal    numeric,
  p_rule_id     uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_regla   public.pricing_rules%rowtype;
  v_base    numeric(10,2);
  v_markup  numeric(10,2) := 0;
  v_tier    jsonb;
  v_tipo    text;
begin
  v_base := round(coalesce(p_subtotal, 0), 2);

  if v_base <= 0 then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if p_rule_id is not null then
    -- Regla congelada: se usa aunque hoy esté archivada o vencida.
    select * into v_regla from public.pricing_rules where id = p_rule_id;
  else
    -- Prioridad: negocio → tipo → FAMILIA → global. La primera que haya.
    select pr.* into v_regla
    from public.pricing_rules pr
    left join public.businesses b on b.id = p_business_id
    left join public.business_type_families f on f.business_type = b.type
    where pr.status = 'active'
      and pr.effective_from <= now()
      and (pr.effective_until is null or pr.effective_until > now())
      and (
        (pr.scope = 'business'      and pr.business_id = p_business_id)
        or (pr.scope = 'business_type' and pr.target_name = b.type)
        or (pr.scope = 'family'        and pr.target_name = f.family_code)
        or (pr.scope = 'global')
      )
    order by case pr.scope
               when 'business'      then 1
               when 'business_type' then 2
               when 'family'        then 3
               when 'global'        then 4
             end
    limit 1;
  end if;

  -- FALLA ABIERTO: sin regla no hay margen y el pedido sigue. Un problema de
  -- configuración de precios no puede dejar a una pizzería sin poder vender.
  if v_regla.id is null then
    return jsonb_build_object(
      'markup', 0, 'rule_id', null, 'rule_version', null,
      'markup_mode', 'absorbed', 'strategy', null
    );
  end if;

  if v_regla.strategy = 'percentage' then
    v_markup := v_base * v_regla.percentage / 100.0;

  elsif v_regla.strategy = 'fixed' then
    v_markup := v_regla.fixed_amount;

  elsif v_regla.strategy = 'tiered' then
    -- Ordenado por `up_to` y no por el orden del array: uno mal ordenado en el
    -- panel cobraría el tramo equivocado sin avisar.
    for v_tier in
      select value
      from jsonb_array_elements(v_regla.tiers) as value
      order by coalesce((value ->> 'up_to')::numeric, 'infinity'::numeric)
    loop
      v_tipo := v_tier ->> 'up_to';
      if v_tipo is null or v_base <= v_tipo::numeric then
        v_markup := coalesce((v_tier ->> 'amount')::numeric, 0);
        exit;
      end if;
    end loop;
  end if;

  -- El piso ANTES que el techo: manda el que protege al comercio.
  if v_regla.min_amount is not null then
    v_markup := greatest(v_markup, v_regla.min_amount);
  end if;
  if v_regla.max_amount is not null then
    v_markup := least(v_markup, v_regla.max_amount);
  end if;

  -- Raíles que no dependen de la configuración: nunca negativo, y nunca más
  -- que el subtotal.
  v_markup := greatest(v_markup, 0);
  v_markup := least(v_markup, v_base);

  return jsonb_build_object(
    'markup',       round(v_markup, 2),
    'rule_id',      v_regla.id,
    'rule_version', v_regla.version,
    'markup_mode',  v_regla.markup_mode,
    'strategy',     v_regla.strategy
  );
end;
$$;

revoke all on function public.calculate_platform_markup(uuid, numeric, uuid)
  from public, anon, authenticated;
grant execute on function public.calculate_platform_markup(uuid, numeric, uuid)
  to service_role;


-- ══════════════════════════════════════════════════════════════════
-- LA CONVERSACIÓN DEL MARKETPLACE (2026-08-20)
--
-- Con un solo número para toda la plataforma, el teléfono ya no dice de qué
-- negocio es un mensaje: lo dice el estado de la conversación.
--
-- ⚠️ ES LA ÚNICA TABLA SIN `business_id`, y es deliberado: la conversación
-- ABARCA varios negocios. Antes de elegir local no hay ninguno, y «¿en qué
-- local está AHORA?» es mutable — por eso es un `selected_business_id`
-- anulable, no una llave de tenant. El riesgo que eso abre (que una pizzería
-- sepa que su cliente pide en la competencia) se cierra quitando el acceso,
-- como en `customers` y `business_channel_identifiers`. Lo comprueba
-- `tests/sql/verificar-aislamiento.sql`.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. La conversación ─────────────────────────────────────────────────────
create table if not exists public.marketplace_conversations (
  id                   uuid primary key default gen_random_uuid(),
  -- Una conversación por cliente, no por negocio: hay UN número para todo.
  customer_id          uuid not null
                       references public.customers(id) on delete cascade,
  current_state        text not null default 'inicio',
  -- Nulo = el cliente aún no eligió local. De ahí se DERIVA que la búsqueda es
  -- global: guardar aparte un `search_scope` daría dos campos que pueden
  -- contradecirse, y habría que decidir cuál miente.
  selected_business_id uuid references public.businesses(id) on delete set null,
  -- Un flujo de compra a la vez: hasta terminar o cancelar, no se empieza otro.
  shopping_locked      boolean not null default false,
  -- Dónde está dentro del menú. Es lo que hoy guarda el `Map`.
  flow_state           jsonb,
  -- Bloqueo optimista: dos mensajes del mismo cliente a la vez no pueden
  -- pisarse. La cola ya los serializa por conversación (`stream_key_hash`),
  -- pero eso no cubre que escriba por WhatsApp y por la mini app a la vez.
  version              integer not null default 1,
  last_message_at      timestamptz not null default now(),
  expires_at           timestamptz,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  -- Los nombres de estado NO se enumeran todavía a propósito: el flujo del
  -- marketplace se construye en la fase 3, y fijar aquí una lista sería
  -- adivinarla. Se valida el formato, que es lo que sí se sabe hoy.
  constraint marketplace_conversations_state_check check (
    current_state ~ '^[a-z][a-z_]{2,39}$'
  ),
  -- Estar bloqueado en ningún negocio no significa nada. El estado imposible
  -- se prohíbe aquí, no se confía en que nadie lo escriba.
  constraint marketplace_conversations_bloqueo_check check (
    shopping_locked = false or selected_business_id is not null
  ),
  constraint marketplace_conversations_flow_check check (
    flow_state is null
    or (jsonb_typeof(flow_state) = 'object' and pg_column_size(flow_state) <= 65536)
  ),
  constraint marketplace_conversations_version_check check (version >= 1)
);

create unique index if not exists uq_marketplace_conversations_customer
  on public.marketplace_conversations (customer_id);

-- Para la reconciliación: conversaciones abandonadas o vencidas.
create index if not exists idx_marketplace_conversations_actividad
  on public.marketplace_conversations (last_message_at);

-- Para el disparador de borrado y para «¿quién está pidiendo aquí ahora?».
create index if not exists idx_marketplace_conversations_negocio
  on public.marketplace_conversations (selected_business_id)
  where selected_business_id is not null;

-- El chat solo obedece al ÚLTIMO mensaje, y no repite la misma respuesta
-- (2026-09-26). Ver `migration-2026-09-26-chat-solo-el-ultimo-mensaje.sql`.
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

-- Tocar opciones viejas tiene consecuencia: advertencia y, a la segunda,
-- 5 minutos sin menú (2026-09-28). Ver
-- `migration-2026-09-28-opciones-viejas-pausa.sql`.
alter table public.marketplace_conversations
  add column if not exists stale_tap_warned_at timestamptz,
  add column if not exists menu_paused_until timestamptz;

comment on column public.marketplace_conversations.stale_tap_warned_at is
  'Cuándo se le advirtió por tocar una opción vieja. Otro toque viejo dentro de 30 min pausa el menú.';
comment on column public.marketplace_conversations.menu_paused_until is
  'Hasta cuándo no se atiende el menú, por tocar opciones viejas tras la advertencia. El comprobante sí.';


-- ── 2. Blindaje ────────────────────────────────────────────────────────────
--
-- El patrón de `business_channel_identifiers`, que es el más estricto que hay
-- en el proyecto: RLS, y además se retira el acceso a TODOS —incluido
-- `service_role`— antes de devolver el mínimo imprescindible. `service_role`
-- salta la RLS, así que sin el `revoke` la RLS no le aplicaría.
alter table public.marketplace_conversations enable row level security;

revoke all on table public.marketplace_conversations
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.marketplace_conversations
  to service_role;


-- ── 3. Si el local desaparece, la conversación se reinicia ─────────────────
--
-- `on delete set null` dejaría un cliente «bloqueado comprando» en un negocio
-- que ya no existe, y eso viola el CHECK de arriba: el borrado del negocio
-- fallaría. Reiniciar la conversación ANTES es lo que de verdad se quiere —el
-- cliente vuelve al menú— y además deja el CHECK siempre cierto.
--
-- Se hace con disparador y no dentro de la ruta que borra, por lo mismo que
-- `orders_reject_blocked`: cubre cualquier camino, hoy y mañana.
create or replace function public.marketplace_conversations_reset_on_business_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.marketplace_conversations
     set selected_business_id = null,
         shopping_locked      = false,
         flow_state           = null,
         current_state        = 'inicio',
         version              = version + 1,
         updated_at           = now()
   where selected_business_id = old.id;
  return old;
end;
$$;

revoke all on function public.marketplace_conversations_reset_on_business_delete()
  from public, anon, authenticated;

drop trigger if exists businesses_reset_marketplace_conversations
  on public.businesses;
create trigger businesses_reset_marketplace_conversations
  before delete on public.businesses
  for each row
  execute function public.marketplace_conversations_reset_on_business_delete();


-- ── 4. Avanzar la conversación, en una sola operación ──────────────────────
--
-- Devuelve la conversación tras aplicar el cambio, o `conflicto: true` si otro
-- proceso la movió mientras tanto. El llamador vuelve a leer y reintenta: es
-- más barato que un lock sostenido y no deja transacciones abiertas esperando.
--
-- ⚠️ `p_expected_version` nulo = «no me importa quién la tocó», y sirve para el
-- primer mensaje. Con versión, la condición viaja DENTRO del `update`: mirarla
-- antes en un `select` aparte deja la carrera abierta entre las dos consultas.
create or replace function public.advance_marketplace_conversation(
  p_customer_id       uuid,
  p_expected_version  integer default null,
  p_state             text default null,
  p_business_id       uuid default null,
  p_clear_business    boolean default false,
  p_shopping_locked   boolean default null,
  p_flow_state        jsonb default null,
  p_clear_flow        boolean default false
)
returns jsonb
language plpgsql
-- ⚠️ `security invoker` (el defecto) A PROPÓSITO, al revés que la mayoría de
-- funciones del proyecto. Aquí no hace falta: quien la llama es `service_role`,
-- que ya tiene permisos sobre la tabla. Y así hay DOS cerrojos en vez de uno —
-- si algún día alguien concediera `execute` por error, la tabla seguiría
-- negando el acceso. En la tabla que guarda en qué local compra cada cliente,
-- ese segundo cerrojo vale la inconsistencia.
set search_path = public, pg_temp
as $$
declare
  v_fila public.marketplace_conversations%rowtype;
begin
  if p_customer_id is null then
    raise exception using
      errcode = '22023',
      message = 'Falta el cliente de la conversación';
  end if;

  -- Nace en el primer mensaje. `on conflict` en vez de comprobar antes: dos
  -- mensajes simultáneos de un cliente nuevo llegarían los dos al insert.
  insert into public.marketplace_conversations (customer_id)
  values (p_customer_id)
  on conflict (customer_id) do nothing;

  update public.marketplace_conversations as conv
     set current_state        = coalesce(p_state, conv.current_state),
         selected_business_id = case
                                  when p_clear_business then null
                                  else coalesce(p_business_id, conv.selected_business_id)
                                end,
         -- Soltar el negocio suelta el bloqueo: quedarse bloqueado en ninguna
         -- parte es justo el estado que el CHECK prohíbe.
         shopping_locked      = case
                                  when p_clear_business then false
                                  else coalesce(p_shopping_locked, conv.shopping_locked)
                                end,
         flow_state           = case
                                  when p_clear_flow then null
                                  else coalesce(p_flow_state, conv.flow_state)
                                end,
         version              = conv.version + 1,
         last_message_at      = now(),
         updated_at           = now()
   where conv.customer_id = p_customer_id
     and (p_expected_version is null or conv.version = p_expected_version)
  returning * into v_fila;

  if v_fila.id is null then
    return jsonb_build_object('conflicto', true);
  end if;

  return to_jsonb(v_fila) || jsonb_build_object('conflicto', false);
end;
$$;

revoke all on function public.advance_marketplace_conversation(
  uuid, integer, text, uuid, boolean, boolean, jsonb, boolean
) from public, anon, authenticated;
grant execute on function public.advance_marketplace_conversation(
  uuid, integer, text, uuid, boolean, boolean, jsonb, boolean
) to service_role;


-- ══════════════════════════════════════════════════════════════════
-- EL TECHO DE GASTO DEL MARKETPLACE (2026-08-24)
--
-- Desde el 1 de octubre de 2026 Meta cobra CADA mensaje saliente, y el número
-- de Umbani contesta a todo el que escribe. El techo ya existía para el canal
-- PROPIO (`claim_miniapp_reply`), pero se llama desde `bot-conversation.ts` y
-- el marketplace no pasa por ahí: el número compartido respondía SIN LÍMITE.
--
-- ⚠️ El contador va por CLIENTE, no por (negocio, cliente): antes de elegir
-- local no hay negocio al que cargárselo, y quien escribe por molestar no ha
-- elegido ninguno.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. El contador, junto a la conversación que ya existe ──────────────────
--
-- Va en `marketplace_conversations` y no en una tabla nueva porque es
-- exactamente el mismo sujeto: la conversación de un cliente con la
-- plataforma. Una tabla aparte obligaría a mantener dos filas por cliente en
-- sincronía sin ganar nada.
alter table public.marketplace_conversations
  add column if not exists reply_count integer not null default 0,
  add column if not exists reply_window_start timestamptz,
  add column if not exists muted_until timestamptz,
  -- El id del mensaje ENTRANTE que provocó la última respuesta contada. La
  -- entrada es *at-least-once*: si la confirmación a PostgreSQL no llega, el
  -- worker reintenta y el mismo mensaje se procesa otra vez. Sin esto, cinco
  -- reintentos silenciaban a un cliente legítimo — el mismo fallo que ya se
  -- corrigió en el canal propio (`migration-2026-08-15-reclamo-idempotente`).
  add column if not exists last_reply_message_id text;

alter table public.marketplace_conversations
  drop constraint if exists marketplace_conversations_reply_count_check;
alter table public.marketplace_conversations
  add constraint marketplace_conversations_reply_count_check
  check (reply_count >= 0);

-- ── 2. Reclamar una respuesta ──────────────────────────────────────────────
--
-- Copia fiel de `claim_miniapp_reply`, con tres diferencias y ninguna casual:
--
--   · La llave es el CLIENTE. No hay negocio antes de elegir local.
--   · No existe `con_telefono`: ese aviso añade el teléfono del local al mismo
--     mensaje, y aquí todavía no hay local del que sacarlo. Los estados son
--     dos: se contesta, o se calla.
--   · El silencio es más corto, por lo que dice la cabecera.
--
-- ⚠️ `security definer` con `search_path` fijo, como todas: `marketplace_conversations`
-- tiene RLS y `revoke all` incluido `service_role`.
create or replace function public.claim_marketplace_reply(
  p_customer_id uuid,
  p_tope integer default 25,
  p_silencio_horas integer default 12,
  -- Nulo = no se puede identificar el mensaje. Se cuenta igual: contar de más
  -- es menos malo que no contar.
  p_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.marketplace_conversations%rowtype;
  v_ahora timestamptz := now();
  v_cuenta integer;
begin
  -- Sin cliente no hay a quién contarle nada: se atiende. Quedarse mudo por un
  -- problema nuestro deja sin servicio a alguien de verdad, mientras que
  -- equivocarse al revés cuesta un mensaje.
  if p_customer_id is null then
    return jsonb_build_object('permitido', true, 'respuestas', 0);
  end if;

  -- La conversación puede no existir todavía: el primer mensaje de alguien que
  -- nunca escribió llega antes de que nadie la cree.
  insert into public.marketplace_conversations (customer_id)
  values (p_customer_id)
  on conflict (customer_id) do nothing;

  select * into v_fila
  from public.marketplace_conversations
  where customer_id = p_customer_id
  for update;

  if v_fila.muted_until is not null and v_fila.muted_until > v_ahora then
    return jsonb_build_object(
      'permitido', false, 'motivo', 'silenciado',
      'respuestas', coalesce(v_fila.reply_count, 0),
      -- Hasta cuándo, pero SIN aviso: ya se le dijo al silenciarlo.
      'hasta', v_fila.muted_until
    );
  end if;

  -- ── El mismo mensaje otra vez ────────────────────────────────────────────
  -- Se devuelve lo que le tocaba y NO se suma. Un reintento del worker no
  -- puede acercar a nadie al silencio.
  if p_message_id is not null
     and v_fila.last_reply_message_id is not distinct from p_message_id then
    return jsonb_build_object(
      'permitido', true,
      'respuestas', coalesce(v_fila.reply_count, 0),
      'repetido', true
    );
  end if;

  if v_fila.reply_window_start is null
     or v_fila.reply_window_start < v_ahora - interval '1 hour' then
    v_cuenta := 1;
    update public.marketplace_conversations
       set reply_window_start = v_ahora,
           reply_count = 1,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  else
    v_cuenta := coalesce(v_fila.reply_count, 0) + 1;
    update public.marketplace_conversations
       set reply_count = v_cuenta,
           last_reply_message_id = p_message_id,
           updated_at = v_ahora
     where id = v_fila.id;
  end if;

  if v_cuenta > p_tope then
    update public.marketplace_conversations
       set muted_until = v_ahora + make_interval(hours => p_silencio_horas),
           updated_at = v_ahora
     where id = v_fila.id;
    -- ⚠️ `aviso` SOLO aquí, en el mensaje que cruza el techo (2026-09-27).
    -- Es la única vez que se le explica: los siguientes caen en la rama de
    -- arriba, sin aviso. Callar siempre dejaba al cliente —y al dueño
    -- probando— escribiendo MENÚ a un chat mudo sin saber por qué ni hasta
    -- cuándo.
    return jsonb_build_object(
      'permitido', false, 'motivo', 'silenciado', 'respuestas', v_cuenta,
      'aviso', true,
      'hasta', v_ahora + make_interval(hours => p_silencio_horas)
    );
  end if;

  return jsonb_build_object('permitido', true, 'respuestas', v_cuenta);
end;
$$;

-- ⚠️ NO toca `version`. El bloqueo optimista de `advance_marketplace_conversation`
-- protege el estado del menú —dónde está el cliente, qué lleva en el carrito—,
-- y subirlo aquí haría que contar una respuesta invalidara el avance que se
-- está guardando en el mismo mensaje: el cliente elegiría un local y su
-- elección se perdería con un «conflicto».

revoke all on function public.claim_marketplace_reply(uuid, integer, integer, text)
  from public, anon, authenticated;
grant execute on function public.claim_marketplace_reply(uuid, integer, integer, text)
  to service_role;


-- ══════════════════════════════════════════════════════════════════
-- LAS CATEGORÍAS DEL MARKETPLACE (2026-08-21)
--
-- Lo primero que ve quien escribe al número de Umbani. No son los 31 tipos de
-- negocio —nadie elige entre 31 botones, y WhatsApp solo admite 10 filas por
-- lista—, sino grupos pensados para el cliente: «Hamburguesas» junta
-- hamburguesería y comida rápida porque para quien pide es lo mismo.
--
-- ⚠️ Un tipo pertenece a UNA sola categoría, o el mismo local saldría dos veces.
-- ⚠️ Catálogo de PLATAFORMA, sin `business_id`, como `business_families`.
-- ⚠️ El menú nunca ofrece una categoría vacía: sería una calle sin salida y el
--    cliente ya gastó un mensaje.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.marketplace_categories (
  id     uuid primary key default gen_random_uuid(),
  code   text not null unique,
  label  text not null,
  emoji  text,
  sort   integer not null default 0,
  active boolean not null default true,

  constraint marketplace_categories_code_check  check (code ~ '^[a-z][a-z0-9_]{2,39}$'),
  constraint marketplace_categories_label_check check (char_length(btrim(label)) between 1 and 40),
  constraint marketplace_categories_emoji_check check (emoji is null or char_length(emoji) <= 8),
  constraint marketplace_categories_sort_check  check (sort between 0 and 999)
);

alter table public.marketplace_categories enable row level security;

create table if not exists public.marketplace_category_types (
  -- La clave es el TIPO: un tipo cuelga de una categoría y solo de una.
  business_type text primary key,
  category_id   uuid not null
                references public.marketplace_categories(id) on delete cascade
);

alter table public.marketplace_category_types enable row level security;

create index if not exists idx_marketplace_category_types_categoria
  on public.marketplace_category_types (category_id);


-- ── El reparto de los 31 tipos ─────────────────────────────────────────────
--
-- Cubre los 31 exactamente una vez. Si mañana se añade un tipo al desplegable
-- y no se reparte aquí, sus locales no saldrán en ninguna categoría — lo
-- vigila `tests/categorias-marketplace.test.js`.
insert into public.marketplace_categories (code, label, emoji, sort) values
  ('pizzerias',      'Pizzerías',            '🍕', 10),
  ('hamburguesas',   'Hamburguesas',         '🍔', 20),
  ('almuerzos',      'Almuerzos',            '🍽️', 30),
  -- El menú del día es un PRODUCTO, no una hora; la carta de un restaurante o
  -- de una picantería es otro antojo y tiene su propio cajón (2026-09-17).
  ('restaurantes',   'Comida típica y restaurantes', '🍲', 35),
  ('asados',         'Asados y parrilla',    '🔥', 40),
  ('mariscos',       'Mariscos y ceviches',  '🐟', 50),
  ('internacional',  'Comida internacional', '🌎', 60),
  ('desayunos',      'Desayunos y café',     '🍳', 70),
  ('postres',        'Heladerías y postres', '🍦', 80),
  ('jugos',          'Jugos y batidos',      '🥤', 90),
  ('panaderias',     'Panaderías',           '🥖', 100),
  ('minimarkets',    'Minimarkets',          '🛒', 110),
  ('farmacias',      'Farmacias',            '💊', 120),
  ('perfumerias',    'Perfumerías',          '🧴', 130),
  ('ferreterias',    'Ferreterías',          '🔧', 140),
  ('otros',          'Otros',                '🏪', 150)
on conflict (code) do nothing;

insert into public.marketplace_category_types (business_type, category_id)
select t.business_type, c.id
from (values
  ('pizzería','pizzerias'),
  ('hamburguesería','hamburguesas'), ('comida rápida','hamburguesas'),
  ('almuerzos','almuerzos'), ('menú ejecutivo','almuerzos'),
  ('comida típica','restaurantes'), ('restaurante','restaurantes'),
  ('asadero','asados'), ('parrillada','asados'), ('pollo asado','asados'),
  ('marisquería','mariscos'),
  ('sushi','internacional'), ('comida mexicana','internacional'),
  ('comida china','internacional'), ('comida saludable','internacional'),
  ('desayunos','desayunos'), ('cafetería','desayunos'),
  ('heladería','postres'), ('postres','postres'), ('pastelería','postres'),
  ('batidos','jugos'), ('jugos','jugos'),
  ('panadería','panaderias'),
  ('tienda','minimarkets'), ('supermercado','minimarkets'), ('carnicería','minimarkets'),
  ('farmacia','farmacias'),
  ('perfumería','perfumerias'),
  ('ferretería','ferreterias'),
  ('emprendimiento de comida','otros'), ('negocio','otros')
) as t(business_type, code)
join public.marketplace_categories c on c.code = t.code
on conflict (business_type) do nothing;


-- ── Menús con reloj: la franja de un producto ─────────────────────────────
create or replace function public.producto_en_horario(
  p_days  smallint[],
  p_from  time,
  p_until time,
  p_ahora timestamptz default now()
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  with local as (
    select timezone('America/Guayaquil', p_ahora) as ahora
  ),
  momento as (
    select
      ahora::time as hora,
      extract(dow from ahora)::smallint as dia,
      -- ⚠️ La franja que CRUZA MEDIANOCHE pertenece al día que EMPEZÓ: a la
      -- 01:00 del martes, la carta «de lunes por la noche» sigue siendo del
      -- lunes. Sin esto, un local que cierra a las 02:00 perdía sus dos
      -- últimas horas de venta cada noche — y el fallo solo se vería de
      -- madrugada, que es cuando nadie mira.
      (extract(dow from ahora)::smallint + 6) % 7 as dia_anterior,
      p_from is not null and p_until is not null and p_from > p_until as cruza
    from local
  )
  select
    -- El día: sin lista, todos.
    (
      p_days is null
      or array_length(p_days, 1) is null
      or (case
            when momento.cruza and momento.hora <= p_until then momento.dia_anterior
            else momento.dia
          end) = any(p_days)
    )
    -- Y la hora: sin franja, todo el día.
    and (
      p_from is null or p_until is null
      or (case
            when momento.cruza then momento.hora >= p_from or momento.hora <= p_until
            else momento.hora between p_from and p_until
          end)
    )
  from momento;
$$;

comment on function public.producto_en_horario(smallint[], time, time, timestamptz) is
  'Si un producto con esta franja se puede pedir en ese momento, en hora de Ecuador.';

revoke all on function public.producto_en_horario(smallint[], time, time, timestamptz)
  from public, anon, authenticated;
grant execute on function public.producto_en_horario(smallint[], time, time, timestamptz)
  to service_role;


-- ── Los cajones elegidos de cada local ──────────────────────────────────
create table if not exists public.business_marketplace_categories (
  business_id uuid not null references public.businesses(id) on delete cascade,
  category_id uuid not null references public.marketplace_categories(id) on delete cascade,
  -- El cajón donde el local «vive». Hoy solo ordena la lectura del panel; se
  -- guarda desde el principio porque saber cuál es el principal es lo que
  -- permitirá más adelante ordenar por relevancia sin volver a preguntar.
  principal   boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (business_id, category_id)
);

comment on table public.business_marketplace_categories is
  'En qué cajones del menú del chat aparece un local. Sin filas manda su tipo.';

-- Un solo principal por local.
create unique index if not exists uq_business_marketplace_categories_principal
  on public.business_marketplace_categories (business_id) where principal;

create index if not exists idx_business_marketplace_categories_categoria
  on public.business_marketplace_categories (category_id);

alter table public.business_marketplace_categories enable row level security;
revoke all on table public.business_marketplace_categories from public, anon, authenticated;
grant select, insert, update, delete
  on table public.business_marketplace_categories to service_role;


-- ── Tres cajones como mucho ─────────────────────────────────────────────
--
-- ⚠️ Lo vigila la BASE y no solo la ruta: un local en ocho cajones convierte el
-- menú en ruido y el cliente deja de fiarse de los botones. El tope es de
-- producto, no técnico, pero si vive solo en el panel se salta desde cualquier
-- otro camino que escriba esta tabla.
create or replace function public.business_marketplace_categories_tope()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if (
    select count(*) from public.business_marketplace_categories
    where business_id = new.business_id
  ) > 3 then
    raise exception 'Un local aparece en 3 cajones del menú como mucho'
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists business_marketplace_categories_tope
  on public.business_marketplace_categories;
create trigger business_marketplace_categories_tope
  after insert on public.business_marketplace_categories
  for each row execute function public.business_marketplace_categories_tope();


-- ── Dónde vive cada local, en UN solo sitio ─────────────────────────────
--
-- Resuelve la regla completa: manda lo elegido, y quien no eligió nada sigue
-- saliendo por su tipo. Es una vista y no tres copias del mismo `union` porque
-- las tres funciones del menú tienen que contestar SIEMPRE lo mismo; tres
-- copias acaban divergiendo y el local aparece en la lista pero no en el
-- contador, o al revés.
--
-- `security_invoker`: la llama `service_role`, que ya lee las dos tablas.
create or replace view public.marketplace_cajones_de_negocio
with (security_invoker = true) as
  select bc.business_id, bc.category_id, bc.principal
    from public.business_marketplace_categories bc
  union all
  select b.id, t.category_id, true
    from public.businesses b
    join public.marketplace_category_types t on t.business_type = b.type
   where not exists (
     select 1 from public.business_marketplace_categories x where x.business_id = b.id
   );

comment on view public.marketplace_cajones_de_negocio is
  'Cajones de cada local: los elegidos, o los de su tipo si no eligió ninguno.';

revoke all on public.marketplace_cajones_de_negocio from public, anon, authenticated;
grant select on public.marketplace_cajones_de_negocio to service_role;

-- ── Guardar los cajones de un local, de una vez ────────────────────────────
--
-- Borrar e insertar en la MISMA transacción: si se hiciera en dos viajes y
-- fallara el segundo, el local se quedaría sin cajones y volvería a salir por
-- su tipo sin que nadie lo pidiera.
--
-- Una lista vacía es una decisión válida: «que mande su tipo otra vez».
create or replace function public.set_business_marketplace_categories(
  p_business_id uuid,
  p_codes       text[],
  p_principal   text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_codes     text[];
  v_principal text;
  v_puestos   integer;
begin
  if p_business_id is null then
    raise exception 'Falta el negocio' using errcode = '22023';
  end if;
  if not exists (select 1 from businesses where id = p_business_id) then
    raise exception 'El negocio no existe' using errcode = '42501';
  end if;

  v_codes := coalesce(
    array(select distinct btrim(x) from unnest(coalesce(p_codes, '{}'::text[])) x
          where btrim(x) <> ''),
    '{}'::text[]
  );

  if coalesce(array_length(v_codes, 1), 0) > 3 then
    raise exception 'Un local aparece en 3 cajones del menú como mucho'
      using errcode = '23514';
  end if;

  if exists (
    select 1 from unnest(v_codes) c
    where not exists (
      select 1 from marketplace_categories mc where mc.code = c and mc.active
    )
  ) then
    raise exception 'Ese cajón del menú no existe' using errcode = '22023';
  end if;

  -- Sin principal explícito manda el primero de la lista: el panel los manda
  -- en el orden en que el superadmin los eligió.
  v_principal := coalesce(nullif(btrim(coalesce(p_principal, '')), ''), v_codes[1]);
  if v_principal is not null and not (v_principal = any(v_codes)) then
    raise exception 'El cajón principal tiene que ser uno de los elegidos'
      using errcode = '22023';
  end if;

  delete from business_marketplace_categories where business_id = p_business_id;
  insert into business_marketplace_categories (business_id, category_id, principal)
  select p_business_id, mc.id, mc.code = v_principal
    from marketplace_categories mc
   where mc.code = any(v_codes);
  get diagnostics v_puestos = row_count;
  return v_puestos;
end;
$$;

revoke all on function public.set_business_marketplace_categories(uuid, text[], text)
  from public, anon, authenticated;
grant execute on function public.set_business_marketplace_categories(uuid, text[], text)
  to service_role;


-- ── Las ciudades (2026-10-05) ──────────────────────────────────────────────
--
-- Ver `migration-2026-10-05-ciudades.sql`: el porqué está allí. Un local SIN
-- ciudad no aparece a ningún cliente, y las funciones del menú sin ciudad no
-- devuelven nada (falla cerrado). Va AQUÍ, antes del menú: una función
-- `language sql` se valida al crearse y ya tiene que encontrar las columnas.
create table if not exists public.cities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  province   text,
  active     boolean not null default true,
  sort       integer not null default 0,
  created_at timestamptz not null default now()
);
create unique index if not exists idx_cities_nombre on public.cities (lower(name));
alter table public.cities enable row level security;
revoke all on public.cities from anon, authenticated;
comment on table public.cities is
  'Ciudades donde atiende Umbani. Un local sin ciudad no aparece a los clientes.';

insert into public.cities (name, province, sort)
select v.name, v.province, v.sort
from (values ('Chone', 'Manabí', 1), ('Portoviejo', 'Manabí', 2)) as v(name, province, sort)
where not exists (select 1 from public.cities c where lower(c.name) = lower(v.name));

alter table public.businesses
  add column if not exists city_id uuid references public.cities(id) on delete set null;
create index if not exists idx_businesses_ciudad on public.businesses (city_id);
comment on column public.businesses.city_id is
  'Ciudad del local. Sin ella no aparece a ningún cliente (menú, búsqueda ni app).';

alter table public.customers
  add column if not exists city_id uuid references public.cities(id) on delete set null;
comment on column public.customers.city_id is
  'La ciudad que eligió el cliente. Solo se guarda cuando él la elige.';

-- ── La ciudad por la UBICACIÓN del cliente (2026-10-05) ──────────────────────
-- Ver `migration-2026-10-05-ciudad-por-ubicacion.sql`: centro y radio de cada
-- ciudad, la ciudad de un punto, la entrega dentro de la ciudad del local y
-- quién pide desde fuera de toda ciudad.
alter table public.cities
  add column if not exists latitude  numeric(9,6),
  add column if not exists longitude numeric(9,6),
  add column if not exists radius_km numeric(5,2) not null default 6;
alter table public.cities drop constraint if exists cities_centro_check;
alter table public.cities add constraint cities_centro_check check (
  (latitude is null) = (longitude is null)
  and (latitude is null or latitude between -90 and 90)
  and (longitude is null or longitude between -180 and 180)
  and radius_km between 0.5 and 50
);
comment on column public.cities.radius_km is
  'Radio de cobertura desde el centro (km): dentro, el cliente ve los locales de la ciudad y se le puede entregar.';

-- Los centros de hoy (latitudelongitude.org). El dueño los afina en el mapa.
update public.cities set latitude = -0.698190, longitude = -80.093610, radius_km = 6
 where lower(name) = 'chone' and latitude is null;
update public.cities set latitude = -1.054580, longitude = -80.454450, radius_km = 10
 where lower(name) = 'portoviejo' and latitude is null;


-- ── La distancia entre dos puntos (haversine, km) ───────────────────────────
-- Sin PostGIS: para saber si alguien está a 3 o a 30 km de un centro sobra.
create or replace function public.distancia_km(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric
language sql
immutable
parallel safe
set search_path = pg_catalog
as $$
  select (6371 * 2 * asin(sqrt(
    power(sin(radians((lat2 - lat1)::double precision / 2)), 2)
    + cos(radians(lat1::double precision)) * cos(radians(lat2::double precision))
      * power(sin(radians((lng2 - lng1)::double precision / 2)), 2)
  )))::numeric
$$;

revoke all on function public.distancia_km(numeric, numeric, numeric, numeric) from public, anon, authenticated;
grant execute on function public.distancia_km(numeric, numeric, numeric, numeric) to service_role;


-- ── ¿En qué ciudad está este punto? ─────────────────────────────────────────
-- La activa más cercana con centro, y si cae dentro de su radio. Fuera de toda
-- ciudad devuelve igual la más cercana (`dentro = false`): la app puede decir
-- «todavía no llegamos; la más cercana es Chone, a 40 km».
create or replace function public.ciudad_de_la_ubicacion(p_lat numeric, p_lng numeric)
returns table (id uuid, name text, km numeric, dentro boolean)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.id, c.name,
         round(public.distancia_km(p_lat, p_lng, c.latitude, c.longitude), 1) as km,
         public.distancia_km(p_lat, p_lng, c.latitude, c.longitude) <= c.radius_km as dentro
  from public.cities c
  where c.active and c.latitude is not null
    and p_lat between -90 and 90 and p_lng between -180 and 180
  order by public.distancia_km(p_lat, p_lng, c.latitude, c.longitude)
  limit 1
$$;

revoke all on function public.ciudad_de_la_ubicacion(numeric, numeric) from public, anon, authenticated;
grant execute on function public.ciudad_de_la_ubicacion(numeric, numeric) to service_role;


-- ── La entrega, dentro de la ciudad del local ──────────────────────────────
-- Antes de crear el pedido, como `orders_enforce_min_amount`, y con el mismo
-- código (42501): la tienda le enseña el motivo al cliente al confirmar.
--   · Solo pedidos de la tienda a domicilio: el retiro no tiene entrega, y el
--     mostrador lo teclea el dueño con la persona delante.
--   · Falla ABIERTO sin punto de entrega o sin centro de ciudad: sin datos no
--     se puede medir, y un local sin ciudad ni siquiera aparece en el menú.
create or replace function public.orders_entrega_en_su_ciudad()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ciudad record;
  v_km numeric;
begin
  if coalesce(new.source, '') <> 'storefront'
     or coalesce(new.fulfillment, 'delivery') <> 'delivery'
     or new.delivery_latitude is null or new.delivery_longitude is null then
    return new;
  end if;

  select c.name, c.latitude, c.longitude, c.radius_km into v_ciudad
    from public.businesses b join public.cities c on c.id = b.city_id
   where b.id = new.business_id;
  if v_ciudad.latitude is null then
    return new;
  end if;

  v_km := public.distancia_km(new.delivery_latitude, new.delivery_longitude, v_ciudad.latitude, v_ciudad.longitude);
  if v_km > v_ciudad.radius_km then
    raise exception using
      errcode = '42501',
      message = format(
        'Esa dirección está fuera de la zona de reparto de %s (a %s km). Elige una dirección en %s para recibir tu pedido.',
        v_ciudad.name, to_char(round(v_km), 'FM9999990'), v_ciudad.name
      );
  end if;
  return new;
end;
$$;

revoke all on function public.orders_entrega_en_su_ciudad() from public, anon, authenticated;

drop trigger if exists orders_entrega_en_su_ciudad on public.orders;
create trigger orders_entrega_en_su_ciudad
  before insert on public.orders
  for each row execute function public.orders_entrega_en_su_ciudad();


-- ── Quién pide desde fuera de toda ciudad ──────────────────────────────────
-- ⚠️ REDONDEADO a ~1 km (dos decimales): se quiere saber DÓNDE hay demanda, no
-- la casa de nadie. Uno por día, celda y dispositivo: abrir la app diez veces
-- no son diez personas.
create table if not exists public.coverage_requests (
  id              bigint generated always as identity primary key,
  day             date not null default (now() at time zone 'America/Guayaquil')::date,
  lat_aprox       numeric(6,2) not null,
  lng_aprox       numeric(6,2) not null,
  device_hash     text not null default '',
  nearest_city_id uuid references public.cities(id) on delete set null,
  km              numeric(8,1),
  created_at      timestamptz not null default now()
);
create unique index if not exists idx_coverage_requests_unico
  on public.coverage_requests (day, lat_aprox, lng_aprox, device_hash);
create index if not exists idx_coverage_requests_dia on public.coverage_requests (day);
alter table public.coverage_requests enable row level security;
revoke all on public.coverage_requests from anon, authenticated;
comment on table public.coverage_requests is
  'Aperturas de la app fuera de toda ciudad, redondeadas a ~1 km: dónde abrir la siguiente.';

create or replace function public.registrar_sin_cobertura(p_lat numeric, p_lng numeric, p_dispositivo text)
returns void
language sql
set search_path = public, pg_temp
as $$
  insert into public.coverage_requests (lat_aprox, lng_aprox, device_hash, nearest_city_id, km)
  select round(p_lat, 2), round(p_lng, 2), coalesce(p_dispositivo, ''), u.id, u.km
  from (select 1) uno
  left join lateral (select * from public.ciudad_de_la_ubicacion(p_lat, p_lng)) u on true
  where p_lat between -90 and 90 and p_lng between -180 and 180
  on conflict (day, lat_aprox, lng_aprox, device_hash) do nothing
$$;

revoke all on function public.registrar_sin_cobertura(numeric, numeric, text) from public, anon, authenticated;
grant execute on function public.registrar_sin_cobertura(numeric, numeric, text) to service_role;

-- Para el superadmin: dónde se pide, cuántas personas y la ciudad más cercana.
create or replace function public.cobertura_pedida(p_dias integer default 30)
returns table (lat_aprox numeric, lng_aprox numeric, ciudad_cercana text, km numeric, personas bigint, ultima date)
language sql
stable
set search_path = public, pg_temp
as $$
  -- Personas = dispositivos distintos; los que no mandan dispositivo cuentan
  -- uno por día (no se pueden distinguir entre sí).
  select r.lat_aprox, r.lng_aprox, c.name, min(r.km),
         count(distinct nullif(r.device_hash, '')) + count(distinct case when r.device_hash = '' then r.day end),
         max(r.day)
  from public.coverage_requests r
  left join public.cities c on c.id = r.nearest_city_id
  where r.day >= (now() at time zone 'America/Guayaquil')::date - greatest(coalesce(p_dias, 30), 1)
  group by r.lat_aprox, r.lng_aprox, c.name
  order by 5 desc, 6 desc
  limit 100
$$;

revoke all on function public.cobertura_pedida(integer) from public, anon, authenticated;
grant execute on function public.cobertura_pedida(integer) to service_role;


-- ── Solo las categorías que tienen algo detrás, POR CIUDAD ─────────────────
--
-- Un local cuenta si puede recibir un pedido AHORA: activo, no suspendido, con
-- pedidos y tienda encendidos. Los mismos requisitos que ya exige el modo mini
-- app, porque el menú termina justo ahí — mandando el enlace de su tienda.
--
-- Una fila por ciudad y categoría: de la misma consulta salen las ciudades con
-- locales (para preguntar «¿en qué ciudad estás?») y las categorías de cada
-- una, sin una ida a la base de más.
--
-- ⚠️ `security invoker` (el defecto): quien la llama es `service_role`, que ya
-- lee las tablas. No hace falta elevar nada.
create or replace function public.marketplace_categories_disponibles()
returns table (
  city_id   uuid,
  city_name text,
  code      text,
  label     text,
  emoji     text,
  sort      integer,
  locales   bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select ci.id, ci.name, c.code, c.label, c.emoji, c.sort, count(distinct b.id) as locales
  from public.marketplace_categories c
  join public.marketplace_cajones_de_negocio v on v.category_id = c.id
  join public.businesses b on b.id = v.business_id
  join public.cities ci on ci.id = b.city_id
  where c.active
    and ci.active
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  group by ci.id, ci.name, ci.sort, c.code, c.label, c.emoji, c.sort
  having count(distinct b.id) > 0
  order by ci.sort, ci.name, c.sort, c.label;
$$;

revoke all on function public.marketplace_categories_disponibles()
  from public, anon, authenticated;
grant execute on function public.marketplace_categories_disponibles()
  to service_role;


create or replace function public.marketplace_cajones_del_negocio(p_business_id uuid)
returns table (
  code      text,
  label     text,
  emoji     text,
  principal boolean
)
language sql
stable
set search_path = public, pg_temp
as $$
  select c.code, c.label, c.emoji, v.principal
  from public.marketplace_cajones_de_negocio v
  join public.marketplace_categories c on c.id = v.category_id
  where v.business_id = p_business_id
    and c.active
  -- El principal primero y el resto por el orden del menú: es como se leen en
  -- el panel y como se vuelven a mandar al guardar.
  order by v.principal desc, c.sort;
$$;

revoke all on function public.marketplace_cajones_del_negocio(uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_cajones_del_negocio(uuid)
  to service_role;


-- ── Los locales de una categoría, EN UNA CIUDAD ────────────────────────────
create or replace function public.marketplace_negocios_de_categoria(p_code text, p_city_id uuid)
returns table (
  id          uuid,
  slug        text,
  name        text,
  type        text,
  prep_min    integer,
  -- ¿Se le puede pedir algo AHORA? Falso solo si tiene carta y ninguna parte
  -- de ella está en su franja en este momento.
  con_carta   boolean,
  -- Desde qué hora vuelve a haber algo. Nulo si no se puede saber.
  carta_desde time
)
language sql
stable
set search_path = public, pg_temp
as $$
  select distinct b.id, b.slug, b.name, b.type,
         b.prep_time_minutes + coalesce(b.delivery_extra_minutes, 0),
         (
           not exists (
             select 1 from public.products p
             where p.business_id = b.id and p.active
           )
           or exists (
             select 1 from public.products p
             where p.business_id = b.id and p.active
               and public.producto_en_horario(
                 p.available_days, p.available_from, p.available_until)
           )
         ),
         (
           select min(p.available_from) from public.products p
           where p.business_id = b.id and p.active and p.available_from is not null
         )
  from public.businesses b
  join public.marketplace_cajones_de_negocio v on v.business_id = b.id
  join public.marketplace_categories c on c.id = v.category_id
  where c.code = p_code
    and c.active
    -- ⚠️ Sin ciudad, nada: `NULL = x` nunca es cierto. Falla cerrado a propósito.
    and b.city_id = p_city_id
    and b.active
    and b.suspended is not true
    and b.takes_orders
    and b.storefront_enabled
  order by b.name;
$$;

revoke all on function public.marketplace_negocios_de_categoria(text, uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_negocios_de_categoria(text, uuid)
  to service_role;

-- ══════════════════════════════════════════════════════════════════
-- BUSCAR SIN IA (2026-08-21)
--
-- «Quiero ceviche» encuentra locales aunque «ceviche» no esté en el menú
-- principal, y sin pagar una llamada de IA. Tres capas: alias curados, texto
-- completo en español, y parecido por trigramas.
--
-- ⚠️ Las tres hacen falta, y está medido: el diccionario reduce «ceviche» a
-- 'cevich' y «cebiche» a 'cebich', así que POR TEXTO NO CASAN.
-- ⚠️ Las funciones de pg_trgm se llaman CALIFICADAS con su esquema. Depender
-- del search_path es el fallo que dejó el canal mudo cinco días.
-- ══════════════════════════════════════════════════════════════════

create extension if not exists pg_trgm with schema extensions;
-- `unaccent` normaliza lo que ESCRIBE el cliente antes de compararlo. El
-- diccionario español ya quita tildes dentro del índice de texto, pero el
-- trigrama compara cadenas crudas: sin esto, «camaron» no encontraría
-- «camarón».
create extension if not exists unaccent with schema extensions;


-- ── 1. Lo que el superadmin enseña a mano ──────────────────────────────────
--
-- La capa más barata y la más predecible. Un término que la gente usa y que no
-- aparece escrito en ningún producto —«parrillada» para un asadero, «chifa»
-- para comida china— se resuelve aquí sin depender de cómo esté redactada la
-- carta de cada local.
create table if not exists public.marketplace_search_aliases (
  term          text primary key,
  category_code text not null
                references public.marketplace_categories(code) on delete cascade,
  created_at    timestamptz not null default now(),

  -- Se guarda ya normalizado —minúsculas, sin tildes—: normalizar al leer
  -- obligaría a recorrer la tabla entera en vez de usar la clave.
  constraint marketplace_search_aliases_term_check check (
    term = btrim(lower(term)) and char_length(term) between 2 and 40
  )
);

alter table public.marketplace_search_aliases enable row level security;

create index if not exists idx_marketplace_search_aliases_categoria
  on public.marketplace_search_aliases (category_code);

-- ── ENTENDER LAS ERRATAS, SIN PEDIRLE AL CLIENTE QUE ESCRIBA MEJOR ─────────
--
-- Las apps grandes nunca le piden que corrija: escribes «pizzza» y te enseñan
-- pizzas. Pedírselo le pasa a él el trabajo, le hace sentir tonto y cuesta un
-- saliente pagado de ida y vuelta.
--
-- ⚠️ EL UMBRAL 0.40 NO SE ELIGIÓ A OJO. Medido contra el diccionario real:
--
--     BASURA                         ERRATAS DE VERDAD
--     asdfghjkl  → asado     0.14    pizzza      → pizza        0.86
--     gracias    → farmacia  0.13    hanburguesa → hamburguesa  0.60
--     hola       → helado    0.09    piza        → pizza        0.57
--     sdadskads  → seco      0.08    almuerso    → almuerzo     0.50
--     qwerty     → ceviche   0.00    seviche     → ceviche      0.45
--
-- Línea limpia en 0.40, con 3 veces de margen sobre la peor basura.
--
-- ⚠️ Lo que NO pesca, y conviene saberlo: «pissa» (0.20) y «pisa» (0.22) caen
-- en territorio de basura. Son demasiado CORTAS y a los trigramas les faltan
-- letras. Bajar el umbral metería «asdfghjkl» dentro. Esas caen al menú, que
-- educa sin sermón.
--
-- ⚠️ `search_path` incluye `extensions`: ahí vive `pg_trgm`. Es la misma
-- trampa que tumbó WhatsApp cinco días en julio de 2026 con `digest()`.
create or replace function public.marketplace_alias_parecido(
  p_palabras text[],
  p_minimo   real default 0.40
)
returns table (
  category_code text,
  term          text,
  parecido      real
)
language sql
stable
security definer
set search_path = public, pg_temp, extensions
as $$
  select a.category_code, a.term, max(similarity(a.term, p.palabra))::real as parecido
  from public.marketplace_search_aliases a
  cross join unnest(p_palabras) as p(palabra)
  -- Menos de 4 letras NO entra: es donde los trigramas fallan.
  where char_length(p.palabra) >= 4
    and similarity(a.term, p.palabra) >= p_minimo
  group by a.category_code, a.term
  order by parecido desc, a.term
  limit 1;
$$;

revoke all on function public.marketplace_alias_parecido(text[], real)
  from public, anon, authenticated;
grant execute on function public.marketplace_alias_parecido(text[], real)
  to service_role;

-- Sin este índice cada errata recorre el diccionario entero calculando
-- trigramas. Hoy son 44 filas y da igual, pero la tabla crece con cada
-- término que añade el superadmin.
create index if not exists idx_alias_trigramas
  on public.marketplace_search_aliases using gin (term extensions.gin_trgm_ops);

insert into public.marketplace_search_aliases (term, category_code) values
  -- Las tres grafías se usan en Ecuador. «sebiche» queda por debajo del
  -- umbral de parecido (0.29), así que sin el alias no se encuentra: es
  -- justo para lo que existe esta capa.
  ('ceviche','mariscos'), ('cebiche','mariscos'), ('sebiche','mariscos'),
  ('encebollado','mariscos'), ('corviche','mariscos'), ('bolon','desayunos'),
  ('camaron','mariscos'), ('pescado','mariscos'), ('marisco','mariscos'),
  ('pizza','pizzerias'),
  ('hamburguesa','hamburguesas'), ('burger','hamburguesas'), ('papas','hamburguesas'),
  ('almuerzo','almuerzos'), ('menu del dia','almuerzos'), ('seco','almuerzos'),
  ('restaurante','restaurantes'), ('restaurantes','restaurantes'),
  ('cena','restaurantes'), ('cenar','restaurantes'), ('merienda','restaurantes'),
  ('tipica','restaurantes'), ('criolla','restaurantes'),
  ('pollo','asados'), ('parrillada','asados'), ('asado','asados'), ('carne','asados'),
  ('chifa','internacional'), ('sushi','internacional'), ('tacos','internacional'),
  ('desayuno','desayunos'), ('cafe','desayunos'),
  ('helado','postres'), ('torta','postres'), ('postre','postres'),
  ('jugo','jugos'), ('batido','jugos'),
  ('pan','panaderias'),
  ('supermercado','minimarkets'), ('vivares','minimarkets'), ('abarrotes','minimarkets'),
  ('medicina','farmacias'), ('farmacia','farmacias'),
  ('perfume','perfumerias')
on conflict (term) do nothing;


-- ── 2. Los índices que hacen que esto no recorra la tabla entera ───────────
--
-- ⚠️ `to_tsvector('spanish', …)` con la configuración ESCRITA es inmutable, y
-- por eso puede indexarse. `to_tsvector(x)` sin ella no lo es —depende de un
-- ajuste de sesión— y PostgreSQL rechazaría el índice.
create index if not exists idx_products_busqueda_texto
  on public.products
  using gin (to_tsvector('spanish', coalesce(name,'') || ' ' || coalesce(description,'')));

create index if not exists idx_products_busqueda_parecido
  on public.products using gin (name extensions.gin_trgm_ops);

create index if not exists idx_businesses_busqueda_parecido
  on public.businesses using gin (name extensions.gin_trgm_ops);


-- ── 2b. Sacar la intención y quedarse con lo que se pide ───────────────────
--
-- El cliente NO escribe «ceviche»: escribe «quiero ceviche», «tienen pizza»,
-- «me das un encebollado». Sin quitar esas muletillas:
--
--   · el alias no casa —la clave es «ceviche», no «quiero ceviche»—;
--   · y `plainto_tsquery` exige TODAS las palabras, así que busca productos
--     que digan «quiero» Y «ceviche», y no existe ninguno.
--
-- Medido antes de escribir esto: «quiero ceviche» encontraba UN local de tres,
-- y por parecido de cadena, que es pura suerte.
--
-- ⚠️ `immutable`: hace falta para poder usarla dentro de la consulta sin que
-- PostgreSQL la reevalúe por fila.
create or replace function public.marketplace_normalizar_consulta(p_texto text)
returns text
language sql
immutable
set search_path = public, extensions, pg_temp
as $$
  -- Palabra por palabra, no con una regex sobre la frase.
  --
  -- ⚠️ Una regex del tipo `\s(muletilla)\s` CONSUME el espacio que separa, así
  -- que no puede casar dos muletillas seguidas: «quisiera un cebiche» dejaba
  -- «un cebiche». Filtrando la lista de palabras no existe ese problema, y
  -- además se lee.
  select btrim(array_to_string(array(
    select palabra
    from unnest(string_to_array(
      regexp_replace(
        btrim(lower(extensions.unaccent(coalesce(p_texto, '')))),
        -- Fuera la puntuación: «pizza?» no casa con el alias «pizza», y ese
        -- signo lo escribe casi todo el mundo.
        '[^a-z0-9 ]', ' ', 'g'
      ), ' '
    )) as palabra
    where palabra <> ''
      and palabra not in (
        -- Cómo pide la gente, no qué pide.
        'quiero','quisiera','queria','busco','buscar','necesito','deseo',
        'dame','damelo','das','dan','da','traes','traeme','trae','mandame',
        'manda','mandas','envias','envia','tienes','tienen','tiene','hay',
        'vendes','venden','venta','gustaria','antojo','antoja','pedir',
        'ordenar','comer','ver','favor','porfa','porfavor',
        'hola','buenas','buenos','dias','tardes','noches','gracias',
        'me','se','te','le','yo','mi',
        'un','una','unos','unas','el','la','los','las','lo',
        'de','del','para','con','sin','por','en','y','o','algo','que'
      )
  ), ' '));
$$;

-- ── 3. Buscar locales en todo el marketplace ───────────────────────────────
--
-- Devuelve LOCALES, no productos: antes de elegir negocio, lo que el cliente
-- necesita es saber a quién pedirle. Y `motivo` viaja con cada uno para que el
-- mensaje pueda decir por qué salió.
--
-- ⚠️ Los mismos requisitos de disponibilidad que el menú. Encontrar un local
-- que no puede recibir el pedido es peor que no encontrar ninguno: el cliente
-- ya eligió.
create or replace function public.marketplace_buscar_negocios(
  p_query text,
  p_limite integer default 8,
  p_city_id uuid default null
)
returns table (
  id     uuid,
  slug   text,
  name   text,
  type   text,
  motivo text,
  orden  real
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  with consulta as (
    select public.marketplace_normalizar_consulta(p_query) as texto
  ),
  disponibles as (
    select b.* from public.businesses b
    where b.active and b.suspended is not true
      and b.takes_orders and b.storefront_enabled
      -- ⚠️ Sin ciudad, nada (falla cerrado), igual que el menú (2026-10-05).
      and b.city_id = p_city_id
  ),
  -- Capa 1: el alias manda, y por eso puntúa más alto que todo lo demás.
  por_alias as (
    select distinct d.id, d.slug, d.name, d.type, 'categoria'::text as motivo, 3.0::real as orden
    from consulta c
    -- ⚠️ Palabra por palabra, además de la frase entera. La lista de
    -- muletillas nunca va a estar completa —el cliente escribe lo que quiere—,
    -- y sin esto una sola que se cuele deja la capa más barata sin casar.
    -- Con esto, «me das un encebollado» encuentra el alias «encebollado»
    -- aunque «das» sobreviva a la limpieza.
    join public.marketplace_search_aliases a
      on a.term = c.texto
      or a.term = any(string_to_array(c.texto, ' '))
    -- ⚠️ Por CAJÓN, no por tipo (2026-09-17): un local que eligió sus cajones
    -- tiene que salir por ellos, y solo por ellos. Buscar «cena» debe traer al
    -- que se puso en «Comida típica y restaurantes», no al que comparte tipo.
    join public.marketplace_categories mc on mc.code = a.category_code
    join public.marketplace_cajones_de_negocio v on v.category_id = mc.id
    join disponibles d on d.id = v.business_id
  ),
  -- Capa 2: la carta del local menciona lo que pidió.
  por_texto as (
    select distinct on (d.id)
           d.id, d.slug, d.name, d.type, 'producto'::text as motivo,
           (2.0 + ts_rank(
              to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,'')),
              plainto_tsquery('spanish', c.texto)
           ))::real as orden
    from consulta c
    join public.products p
      on p.active
     and to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,''))
         @@ plainto_tsquery('spanish', c.texto)
    join disponibles d on d.id = p.business_id
    where c.texto <> ''
    order by d.id, orden desc
  ),
  -- Capa 3: se parece. Cubre «cebiche» contra «ceviche» y el dedazo.
  --
  -- ⚠️ Compara PALABRA POR PALABRA, no la frase entera, y está medido:
  -- «cebiche» contra «ceviche de camarones» da 0.217 mirando el nombre
  -- completo —por debajo del umbral de 0.3, así que ese local NO salía— y
  -- 0.455 mirando su mejor palabra. Las dos grafías se usan en Ecuador.
  --
  -- ⚠️ Coste conocido: así no se usa el índice de trigramas sobre `name`, que
  -- solo sirve para el nombre completo. Con el catálogo de hoy es
  -- intrascendente; el día que haya decenas de miles de productos, la salida
  -- es un índice sobre las palabras, no volver a comparar la frase entera.
  por_parecido as (
    select distinct on (d.id)
           d.id, d.slug, d.name, d.type, 'parecido'::text as motivo,
           s.parecido::real as orden
    from consulta c
    join public.products p on p.active
    cross join lateral (
      select max(extensions.similarity(palabra, c.texto)) as parecido
      from unnest(string_to_array(lower(p.name), ' ')) as palabra
    ) s
    join disponibles d on d.id = p.business_id
    where c.texto <> '' and s.parecido > 0.3
    order by d.id, orden desc
  ),
  -- Y el nombre del propio local: «Don Pepe» debe encontrar a Don Pepe.
  por_nombre as (
    select d.id, d.slug, d.name, d.type, 'local'::text as motivo,
           (1.0 + extensions.similarity(lower(d.name), c.texto))::real as orden
    from consulta c
    join disponibles d
      on extensions.similarity(lower(d.name), c.texto) > 0.3
    where c.texto <> ''
  ),
  todo as (
    select * from por_alias
    union all select * from por_texto
    union all select * from por_parecido
    union all select * from por_nombre
  ),
  -- Un local aparece UNA vez, con su mejor motivo…
  mejor as (
    select distinct on (t.id) t.id, t.slug, t.name, t.type, t.motivo, t.orden
    from todo t
    order by t.id, t.orden desc
  )
  -- …y el recorte va por RELEVANCIA, no por identificador.
  --
  -- ⚠️ Hasta el 2026-09-26 el `limit` iba pegado al `distinct on`, cuyo
  -- `order by` EMPIEZA por `t.id` —así lo exige PostgreSQL—. Con más locales
  -- que el límite se quedaban los de uuid más bajo, que es un sorteo: el más
  -- parecido podía quedarse fuera, y los que salían llegaban en ese mismo
  -- orden sin sentido. El nombre desempata para que la lista no baile.
  select m.id, m.slug, m.name, m.type, m.motivo, m.orden
  from mejor m
  order by m.orden desc, m.name
  limit greatest(coalesce(p_limite, 8), 1);
$$;

revoke all on function public.marketplace_buscar_negocios(text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.marketplace_buscar_negocios(text, integer, uuid)
  to service_role;


-- ── Cómo usa la gente el menú de Umbani ────────────────────────────────────
-- El rastro del menú: qué cajones se tocan, cuáles se abandonan y qué escribe
-- la gente. Sin esto no hay forma de afinar los nombres con datos, y el día
-- que no se registra no se recupera (migration-2026-09-18-asi-usan-umbani).

create table if not exists public.marketplace_events (
  id            uuid primary key default gen_random_uuid(),
  -- Quién. Si el cliente se borra, el evento se queda sin dueño en vez de
  -- irse: el embudo de esta semana no puede cambiar porque alguien se dé de
  -- baja mañana.
  customer_id   uuid references public.customers(id) on delete set null,
  -- Qué pasó, en los cuatro pasos que tiene el menú:
  --   menu     → vio los cajones
  --   cajon    → entró en uno (y cuál)
  --   busqueda → escribió algo (y cuántos locales salieron)
  --   local    → eligió un local y recibió su enlace
  tipo          text not null,
  category_code text,
  -- ⚠️ `cascade` y no `set null`: es la regla del proyecto para toda foránea a
  -- `businesses` —borrar un local se lleva SUS datos—, y aquí además es lo
  -- correcto: los toques a un local que ya no existe no son un dato, son
  -- ruido. El cliente sí se conserva (`set null`), porque el embudo de esta
  -- semana no puede cambiar porque alguien se dé de baja mañana.
  business_id   uuid references public.businesses(id) on delete cascade,
  consulta      text,
  resultados    integer,
  created_at    timestamptz not null default now(),
  constraint marketplace_events_datos_check check (
    tipo in ('menu', 'cajon', 'busqueda', 'local')
    and char_length(coalesce(consulta, '')) <= 80
    and (resultados is null or resultados between 0 and 1000)
  )
);

comment on table public.marketplace_events is
  'Qué hace la gente en el menú de Umbani: cajones tocados, búsquedas y locales elegidos.';

-- Todas las consultas de los reportes van por fecha, y las dos más caras
-- —cajones y búsquedas— filtran además por tipo.
create index if not exists idx_marketplace_events_fecha
  on public.marketplace_events (created_at desc);
create index if not exists idx_marketplace_events_tipo
  on public.marketplace_events (tipo, created_at desc);

alter table public.marketplace_events enable row level security;
revoke all on table public.marketplace_events from public, anon, authenticated;
grant select, insert, delete on table public.marketplace_events to service_role;




-- ── 1. El embudo ───────────────────────────────────────────────────────────
--
-- Los cuatro pasos del menú más los dos que ya vivían en otras tablas: abrir
-- la tienda (`storefront_sessions.last_seen_at`) y pedir (`orders`). Es la
-- foto de dónde se cae la gente.
create or replace function public.marketplace_embudo(p_dias integer default 7)
returns table (
  paso     text,
  orden    integer,
  clientes bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with desde as (select now() - make_interval(days => greatest(coalesce(p_dias, 7), 1)) as d),
  eventos as (
    select e.tipo, e.customer_id from public.marketplace_events e, desde
    where e.created_at >= desde.d and e.customer_id is not null
  )
  select 'escribieron'::text, 1, count(distinct customer_id) from eventos
  union all
  select 'vieron el menú', 2, count(distinct customer_id) from eventos where tipo = 'menu'
  union all
  select 'entraron a un cajón', 3, count(distinct customer_id) from eventos where tipo = 'cajon'
  union all
  select 'eligieron un local', 4, count(distinct customer_id) from eventos where tipo = 'local'
  union all
  select 'abrieron su tienda', 5, count(distinct s.customer_id)
    from public.storefront_sessions s, desde
    where s.created_at >= desde.d and s.last_seen_at is not null
  union all
  select 'pidieron', 6, count(distinct o.customer_id)
    from public.orders o, desde
    where o.created_at >= desde.d
  order by 2;
$$;

revoke all on function public.marketplace_embudo(integer) from public, anon, authenticated;
grant execute on function public.marketplace_embudo(integer) to service_role;


-- ── 2. Qué cajón se toca, y cuál se abandona ───────────────────────────────
--
-- «Abandonado» es el dato que pidió el dueño para afinar los NOMBRES: gente
-- que entró al cajón y no eligió ningún local en la media hora siguiente. Un
-- cajón muy tocado y muy abandonado suele ser un nombre que promete otra cosa
-- de la que hay dentro.
create or replace function public.marketplace_cajones_tocados(p_dias integer default 7)
returns table (
  code        text,
  label       text,
  entradas    bigint,
  eligieron   bigint,
  abandonaron bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with desde as (select now() - make_interval(days => greatest(coalesce(p_dias, 7), 1)) as d),
  entradas as (
    select e.id, e.customer_id, e.category_code, e.created_at
    from public.marketplace_events e, desde
    where e.tipo = 'cajon' and e.category_code is not null and e.created_at >= desde.d
  ),
  con_eleccion as (
    select en.*, exists (
      select 1 from public.marketplace_events l
      where l.tipo = 'local'
        and l.customer_id is not distinct from en.customer_id
        and l.created_at between en.created_at and en.created_at + interval '30 minutes'
    ) as eligio
    from entradas en
  )
  select c.code, c.label,
         count(*)::bigint,
         count(*) filter (where ce.eligio)::bigint,
         count(*) filter (where not ce.eligio)::bigint
  from con_eleccion ce
  join public.marketplace_categories c on c.code = ce.category_code
  group by c.code, c.label, c.sort
  order by count(*) desc, c.sort;
$$;

revoke all on function public.marketplace_cajones_tocados(integer) from public, anon, authenticated;
grant execute on function public.marketplace_cajones_tocados(integer) to service_role;


-- ── 3. Qué escribe la gente ────────────────────────────────────────────────
--
-- ⚠️ Lo que de verdad vale son las búsquedas SIN resultado, y están partidas en
-- dos cosas muy distintas:
--   · con `entendido`  → «te entiendo y NO lo tengo»: es demanda de un tipo de
--     local que falta por dar de alta (el dueño escribió «sushi de cangrejo» y
--     el menú supo que era comida internacional).
--   · sin `entendido`  → el menú no supo ni de qué hablaba: ahí se gana con un
--     alias nuevo o con un nombre de cajón mejor.
create or replace function public.marketplace_busquedas(p_dias integer default 7)
returns table (
  consulta  text,
  veces     bigint,
  sin_nada  bigint,
  entendido text
)
language sql
stable
set search_path = public, pg_temp
as $$
  select e.consulta,
         count(*)::bigint,
         count(*) filter (where coalesce(e.resultados, 0) = 0)::bigint,
         max(c.label)
  from public.marketplace_events e
  left join public.marketplace_categories c on c.code = e.category_code
  where e.tipo = 'busqueda'
    and coalesce(btrim(e.consulta), '') <> ''
    and e.created_at >= now() - make_interval(days => greatest(coalesce(p_dias, 7), 1))
  group by e.consulta
  order by count(*) filter (where coalesce(e.resultados, 0) = 0) desc, count(*) desc
  limit 50;
$$;

revoke all on function public.marketplace_busquedas(integer) from public, anon, authenticated;
grant execute on function public.marketplace_busquedas(integer) to service_role;


-- ── 1. El camino de su cliente ─────────────────────────────────────────────
--
-- Del enlace al pedido entregado. Se cuentan PERSONAS distintas, no enlaces:
-- quien pide tres veces es un cliente, no tres.
create or replace function public.local_embudo(
  p_business_id uuid,
  p_dias        integer default 30
)
returns table (
  paso     text,
  orden    integer,
  clientes bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  with desde as (select now() - make_interval(days => greatest(coalesce(p_dias, 30), 1)) as d),
  enlaces as (
    select s.customer_id, s.last_seen_at
    from public.storefront_sessions s, desde
    where s.business_id = p_business_id and s.created_at >= desde.d
      and s.customer_id is not null
  ),
  pedidos as (
    select o.customer_id, o.status
    from public.orders o, desde
    where o.business_id = p_business_id and o.created_at >= desde.d
      and o.customer_id is not null
  )
  select 'recibieron su enlace'::text, 1, count(distinct customer_id) from enlaces
  union all
  select 'abrieron su tienda', 2, count(distinct customer_id)
    from enlaces where last_seen_at is not null
  union all
  select 'hicieron un pedido', 3, count(distinct customer_id) from pedidos
  union all
  select 'recibieron su pedido', 4, count(distinct customer_id)
    from pedidos where status in ('completado', 'entregado')
  order by 2;
$$;

revoke all on function public.local_embudo(uuid, integer) from public, anon, authenticated;
grant execute on function public.local_embudo(uuid, integer) to service_role;


-- ── 2. Por dónde lo encontraron ────────────────────────────────────────────
--
-- De qué cajón del menú de Umbani salió cada cliente que eligió este local.
-- Es lo que le dice al dueño si le llegan buscando «almuerzo» o buscando
-- «cena», y por tanto qué carta le conviene tener lista a cada hora.
create or replace function public.local_llegadas(
  p_business_id uuid,
  p_dias        integer default 30
)
returns table (
  code   text,
  label  text,
  veces  bigint
)
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(c.code, 'busqueda'), coalesce(c.label, 'Escribiendo lo que querían'),
         count(*)::bigint
  from public.marketplace_events e
  left join public.marketplace_categories c on c.code = e.category_code
  where e.tipo = 'local'
    and e.business_id = p_business_id
    and e.created_at >= now() - make_interval(days => greatest(coalesce(p_dias, 30), 1))
  group by coalesce(c.code, 'busqueda'), coalesce(c.label, 'Escribiendo lo que querían')
  order by count(*) desc;
$$;

revoke all on function public.local_llegadas(uuid, integer) from public, anon, authenticated;
grant execute on function public.local_llegadas(uuid, integer) to service_role;


-- ── 4. Buscar DENTRO del local elegido ─────────────────────────────────────
--
-- «También quiero Coca Cola» cuando ya está en El Puerto. ⚠️ El filtro por
-- `business_id` no es una comodidad: sin él, la Coca Cola de otro local
-- entraría en un carrito que solo puede tener productos de uno.
create or replace function public.marketplace_buscar_productos(
  p_business_id uuid,
  p_query       text,
  p_limite      integer default 8
)
returns table (
  id     uuid,
  name   text,
  price  numeric,
  orden  real
)
language sql
stable
set search_path = public, extensions, pg_temp
as $$
  with consulta as (
    select public.marketplace_normalizar_consulta(p_query) as texto
  )
  select distinct on (p.id) p.id, p.name, p.price,
         greatest(
           ts_rank(
             to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,'')),
             plainto_tsquery('spanish', c.texto)
           ) + 1.0,
           extensions.similarity(lower(p.name), c.texto)
         )::real as orden
  from consulta c
  join public.products p
    on p.business_id = p_business_id
   and p.active
   and (
     to_tsvector('spanish', coalesce(p.name,'') || ' ' || coalesce(p.description,''))
       @@ plainto_tsquery('spanish', c.texto)
     or extensions.similarity(lower(p.name), c.texto) > 0.3
   )
  where c.texto <> ''
  order by p.id, orden desc
  limit greatest(coalesce(p_limite, 8), 1);
$$;

revoke all on function public.marketplace_buscar_productos(uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.marketplace_buscar_productos(uuid, text, integer)
  to service_role;

revoke all on function public.marketplace_normalizar_consulta(text)
  from public, anon, authenticated;
grant execute on function public.marketplace_normalizar_consulta(text)
  to service_role;

-- ══════════════════════════════════════════════════════════════════
-- LA COLA DE AVISOS QUE FALLARON (2026-08-21)
--
-- El aviso al cliente se RECLAMA antes de enviarse, y el reclamo es atómico
-- para que dos toques no manden —ni cobren— dos mensajes. La consecuencia que
-- no se veía: si el envío falla, el reclamo ya se consumió y ese aviso no sale
-- nunca más.
--
-- ⚠️ El envío inmediato se conserva; el worker solo reintenta lo que falló.
-- Por eso el evento nace con una ventana de gracia: sin ella, el worker podría
-- tomarlo mientras el envío inmediato está en vuelo y cobrarlo dos veces.
-- ══════════════════════════════════════════════════════════════════

create table if not exists public.outbox_events (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  event_type     text not null,
  aggregate_type text not null default 'order',
  aggregate_id   uuid not null,
  payload        jsonb not null,
  status         text not null default 'pending'
                 check (status in ('pending','processing','completed','dead')),
  attempts       integer not null default 0,
  max_attempts   integer not null default 6,
  available_at   timestamptz not null default now(),
  lease_token    uuid,
  lease_owner    text,
  leased_until   timestamptz,
  last_error     text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  completed_at   timestamptz,
  dead_at        timestamptz,

  constraint outbox_events_type_check check (
    event_type ~ '^[a-z][a-z_]{2,49}$' and aggregate_type ~ '^[a-z_]{3,30}$'
  ),
  constraint outbox_events_attempts_check check (
    attempts between 0 and max_attempts and max_attempts between 1 and 50
  ),
  constraint outbox_events_payload_check check (
    jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536
  ),
  -- El lease existe entero o no existe: un token sin fecha deja un evento
  -- tomado para siempre por nadie.
  constraint outbox_events_lease_check check (
    (status = 'processing' and lease_token is not null and leased_until is not null
     and nullif(btrim(lease_owner), '') is not null and char_length(lease_owner) <= 128)
    or
    (status <> 'processing' and lease_token is null and leased_until is null
     and lease_owner is null)
  )
);

alter table public.outbox_events enable row level security;

revoke all on table public.outbox_events
  from public, anon, authenticated, service_role;
grant select, insert, update, delete on table public.outbox_events to service_role;

-- Para el worker: lo pendiente que ya toca, en orden de llegada.
create index if not exists idx_outbox_pendientes
  on public.outbox_events (available_at, created_at)
  where status = 'pending';

-- Para recuperar leases vencidos de un worker que murió a media faena.
create index if not exists idx_outbox_vencidos
  on public.outbox_events (leased_until)
  where status = 'processing';

-- Para la reconciliación y el panel: qué le pasó a los avisos de un negocio.
create index if not exists idx_outbox_negocio
  on public.outbox_events (business_id, created_at desc);

-- ⚠️ UN evento por hito de un pedido. El reclamo ya lo garantiza aguas arriba,
-- pero esto lo cierra en la base: si algún camino futuro encola sin reclamar,
-- el índice lo impide en vez de mandar dos mensajes de pago.
create unique index if not exists uq_outbox_hito
  on public.outbox_events (aggregate_id, event_type, (payload ->> 'status'))
  where aggregate_type = 'order';


-- ── Encolar ────────────────────────────────────────────────────────────────
--
-- Devuelve el id del evento, o NULL si ya estaba encolado. El `on conflict do
-- nothing` es la red del índice de arriba: encolar dos veces no crea dos.
create or replace function public.enqueue_outbox_event(
  p_business_id    uuid,
  p_event_type     text,
  p_aggregate_id   uuid,
  p_payload        jsonb,
  p_aggregate_type text default 'order',
  -- ⚠️ Nace con espera A PROPÓSITO. El envío inmediato corre justo después de
  -- encolar; sin esta ventana, el worker podría tomarlo mientras ese envío
  -- está en vuelo y mandar —y cobrar— el mismo aviso dos veces. Un minuto es
  -- de sobra para un envío que normalmente tarda menos de un segundo.
  p_espera_s       integer default 60
)
returns uuid
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  insert into public.outbox_events (
    business_id, event_type, aggregate_type, aggregate_id, payload,
    status, attempts, max_attempts, available_at
  ) values (
    p_business_id, p_event_type, coalesce(p_aggregate_type, 'order'),
    p_aggregate_id, coalesce(p_payload, '{}'::jsonb),
    'pending', 0, 6,
    now() + make_interval(secs => greatest(coalesce(p_espera_s, 60), 0))
  )
  on conflict do nothing
  returning id into v_id;

  return v_id;
end;
$$;


-- ── Tomar trabajo ──────────────────────────────────────────────────────────
--
-- `for update skip locked`: dos workers no se pelean por el mismo evento y
-- ninguno espera al otro. Recupera además los leases vencidos — un worker que
-- murió a media faena no puede dejar un aviso tomado para siempre.
create or replace function public.lease_outbox_events(
  p_owner   text,
  p_limite  integer default 10,
  p_lease_s integer default 60
)
returns setof public.outbox_events
language plpgsql
set search_path = public, pg_temp
as $$
begin
  return query
  with candidatos as (
    select e.id
    from public.outbox_events e
    where (
      (e.status = 'pending' and e.available_at <= now())
      or (e.status = 'processing' and e.leased_until < now())
    )
      and e.attempts < e.max_attempts
    order by e.available_at, e.created_at
    limit greatest(coalesce(p_limite, 10), 1)
    for update skip locked
  )
  update public.outbox_events e
     set status       = 'processing',
         lease_token  = gen_random_uuid(),
         lease_owner  = left(coalesce(nullif(btrim(p_owner), ''), 'worker'), 128),
         leased_until = now() + make_interval(secs => greatest(coalesce(p_lease_s, 60), 5)),
         attempts     = e.attempts + 1,
         updated_at   = now()
    from candidatos c
   where e.id = c.id
  returning e.*;
end;
$$;


-- ── Terminar ───────────────────────────────────────────────────────────────
create or replace function public.complete_outbox_event(p_id uuid, p_token uuid)
returns boolean
language sql
set search_path = public, pg_temp
as $$
  with hecho as (
    update public.outbox_events
       set status = 'completed', completed_at = now(), updated_at = now(),
           lease_token = null, lease_owner = null, leased_until = null,
           last_error = null
     where id = p_id
       and (
         -- El worker: completa lo que tomó, y solo con su token.
         (p_token is not null and lease_token = p_token and status = 'processing')
         -- El envío inmediato: no llegó a tomarlo, lo hizo él. Sin esto
         -- tendría que fingir un lease solo para cerrar su propio trabajo.
         or (p_token is null and status = 'pending')
       )
    returning id
  )
  select exists (select 1 from hecho);
$$;

-- Fallar: vuelve a la cola con espera creciente, o muere si se agotó.
--
-- ⚠️ La espera crece con los intentos. Reintentar cada segundo contra un canal
-- caído no lo arregla y sí gasta: 1 min, 2, 4, 8… hasta una hora.
create or replace function public.fail_outbox_event(
  p_id uuid, p_token uuid, p_error text
)
returns text
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_fila public.outbox_events%rowtype;
begin
  select * into v_fila from public.outbox_events
   where id = p_id and lease_token = p_token and status = 'processing';
  if not found then return 'sin_lease'; end if;

  if v_fila.attempts >= v_fila.max_attempts then
    update public.outbox_events
       set status = 'dead', dead_at = now(), updated_at = now(),
           lease_token = null, lease_owner = null, leased_until = null,
           last_error = left(coalesce(p_error, 'sin detalle'), 500)
     where id = p_id;
    return 'muerto';
  end if;

  update public.outbox_events
     set status = 'pending', updated_at = now(),
         lease_token = null, lease_owner = null, leased_until = null,
         last_error = left(coalesce(p_error, 'sin detalle'), 500),
         available_at = now() + make_interval(
           secs => least(3600, 60 * power(2, greatest(v_fila.attempts - 1, 0))::int)
         )
   where id = p_id;
  return 'reintentar';
end;
$$;

do $$
declare v_fn text;
begin
  foreach v_fn in array array[
    'enqueue_outbox_event(uuid, text, uuid, jsonb, text, integer)',
    'lease_outbox_events(text, integer, integer)',
    'complete_outbox_event(uuid, uuid)',
    'fail_outbox_event(uuid, uuid, text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', v_fn);
    execute format('grant execute on function public.%s to service_role', v_fn);
  end loop;
end;
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL COMPROBANTE CON HUELLA (2026-08-22)
-- ═══════════════════════════════════════════════════════════════════════════
-- `orders.payment_proof_url` guardaba UN comprobante por pedido: el segundo
-- machacaba al primero, no se podía saber si esa imagen ya se había usado en
-- otro pedido, y no había dónde guardar lo que se extrajera de ella.
--
-- ⚠️ Aditivo: las columnas de `orders` se quedan y siguen siendo lo que el
-- panel enseña. Ver `migration-2026-08-22-huella-del-comprobante.sql`.

-- ── 1. El comprobante, con su huella ─────────────────────────────────
create table if not exists public.payment_receipts (
  id             uuid primary key default gen_random_uuid(),
  -- Regla #1 del proyecto: toda tabla de datos de un negocio nace con su
  -- `business_id`. Aquí además importa para el aislamiento de la BÚSQUEDA de
  -- duplicados — ver el punto 3.
  business_id    uuid not null references public.businesses(id) on delete cascade,
  order_id       uuid not null references public.orders(id) on delete cascade,

  -- ── El archivo ──
  file_url       text not null,
  file_public_id text,
  mime_type      text,
  file_size      integer,

  -- ── Las huellas ──
  --
  -- `sha256_hash` caza el archivo IDÉNTICO: el cliente reenvía exactamente la
  -- misma foto. Es exacto, gratis y no falla nunca.
  --
  -- `perceptual_hash` caza la misma imagen RECORTADA, recomprimida o con otro
  -- brillo — que es lo que pasa cuando se reenvía por WhatsApp, porque el
  -- propio WhatsApp la recomprime y el SHA cambia. Lo calcula Cloudinary al
  -- subirla, así que no hace falta ninguna librería de imagen.
  sha256_hash      text not null check (sha256_hash ~ '^[0-9a-f]{64}$'),
  perceptual_hash  text,

  -- ── Lo que se extraiga de la imagen (lo llena el análisis) ──
  bank_name           text,
  sender_name         text,
  beneficiary_name    text,
  destination_account text,
  amount              numeric(12,2),
  currency            text,
  transaction_date    date,
  transaction_time    time,
  reference_number    text,
  transaction_number  text,
  ocr_raw_text        text,
  analysis_json       jsonb,

  -- ── El riesgo (lo llena el análisis) ──
  risk_score  integer,
  risk_level  text,

  -- ⚠️ NINGUNO de estos estados confirma un pago. El pago lo confirma el
  -- dueño desde su panel (`orders.payment_confirmed_at`) o, algún día, una
  -- conciliación bancaria. Un comprobante que «parece auténtico» sigue siendo
  -- una imagen: pudo editarse, generarse o reutilizarse.
  status text not null default 'pendiente_analisis',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_receipts_status_check check (
    status in (
      'pendiente_analisis',  -- acaba de llegar
      'analizado',           -- se le pasó el análisis y hay datos
      'requiere_revision',   -- el análisis falló o no pudo leerlo
      'descartado'           -- el dueño pidió otro comprobante
    )
  ),
  constraint payment_receipts_riesgo_check check (
    (risk_score is null or (risk_score >= 0 and risk_score <= 100))
    and (risk_level is null or risk_level in ('bajo', 'medio', 'alto', 'critico'))
  ),
  constraint payment_receipts_datos_check check (
    char_length(coalesce(bank_name, '')) <= 120
    and char_length(coalesce(sender_name, '')) <= 160
    and char_length(coalesce(beneficiary_name, '')) <= 160
    and char_length(coalesce(destination_account, '')) <= 60
    and char_length(coalesce(currency, '')) <= 8
    and char_length(coalesce(reference_number, '')) <= 80
    and char_length(coalesce(transaction_number, '')) <= 80
    -- El texto crudo se guarda para poder revisar qué leyó el análisis, pero
    -- acotado: un OCR sobre una foto ruidosa puede devolver páginas.
    and char_length(coalesce(ocr_raw_text, '')) <= 8000
    and (amount is null or (amount >= 0 and amount <= 999999))
  )
);

alter table public.payment_receipts enable row level security;

-- Mismo blindaje que `marketplace_conversations` y la cola de webhooks: la
-- tabla NO se expone a nadie salvo al servidor. Aquí importa especialmente,
-- porque la búsqueda de duplicados mira comprobantes de OTROS negocios (ver
-- el punto 3) y esa consulta no puede quedar al alcance de un cliente.
revoke all on table public.payment_receipts
  from public, anon, authenticated, service_role;
grant select, insert, update on table public.payment_receipts to service_role;

create index if not exists idx_payment_receipts_pedido
  on public.payment_receipts (business_id, order_id, created_at desc);

-- Para la búsqueda de duplicados: se consulta por hash a través de TODA la
-- plataforma, así que el índice NO empieza por `business_id`.
create index if not exists idx_payment_receipts_sha
  on public.payment_receipts (sha256_hash);
create index if not exists idx_payment_receipts_phash
  on public.payment_receipts (perceptual_hash)
  where perceptual_hash is not null;
create index if not exists idx_payment_receipts_referencia
  on public.payment_receipts (reference_number)
  where reference_number is not null;

-- ── 2. Las señales de riesgo, una fila por señal ─────────────────────
--
-- Una tabla y no un array dentro del comprobante: así el panel puede pintar
-- cada señal con su gravedad, y mañana se puede contar «cuántos comprobantes
-- dispararon monto_incorrecto este mes» sin abrir un jsonb.
create table if not exists public.payment_receipt_risk_flags (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_id  uuid not null references public.payment_receipts(id) on delete cascade,
  flag_type   text not null,
  severity    text not null default 'media',
  description text,
  -- Cuánto sumó (o restó) esta señal al total. Guardarlo aquí permite
  -- explicar el score: sin esto, un 78/100 es un número sin defensa.
  points      integer not null default 0,
  created_at  timestamptz not null default now(),

  constraint payment_receipt_risk_flags_datos_check check (
    char_length(btrim(flag_type)) between 1 and 60
    and severity in ('baja', 'media', 'alta', 'critica')
    and char_length(coalesce(description, '')) <= 300
    and points >= -100 and points <= 100
  )
);

alter table public.payment_receipt_risk_flags enable row level security;
revoke all on table public.payment_receipt_risk_flags
  from public, anon, authenticated, service_role;
grant select, insert on table public.payment_receipt_risk_flags to service_role;

create index if not exists idx_receipt_flags_comprobante
  on public.payment_receipt_risk_flags (receipt_id);

-- ── 3. La auditoría: qué pasó con cada comprobante ───────────────────
--
-- ⚠️ NUNCA se sobrescribe. Cada acción es una fila: quién lo subió, qué
-- analizó el sistema, quién lo aprobó o lo rechazó y cuándo. Es lo que
-- responde «¿por qué se aceptó este pago?» tres meses después.
create table if not exists public.payment_receipt_audit_logs (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses(id) on delete cascade,
  receipt_id  uuid not null references public.payment_receipts(id) on delete cascade,
  -- Nulo cuando lo hizo el sistema (la subida del cliente, el análisis).
  user_id     uuid references public.client_users(id) on delete set null,
  action      text not null,
  old_status  text,
  new_status  text,
  metadata    jsonb,
  created_at  timestamptz not null default now(),

  constraint payment_receipt_audit_datos_check check (
    char_length(btrim(action)) between 1 and 60
    and (metadata is null or (
      jsonb_typeof(metadata) = 'object' and pg_column_size(metadata) <= 16384
    ))
  )
);

alter table public.payment_receipt_audit_logs enable row level security;
revoke all on table public.payment_receipt_audit_logs
  from public, anon, authenticated, service_role;
grant select, insert on table public.payment_receipt_audit_logs to service_role;

create index if not exists idx_receipt_audit_comprobante
  on public.payment_receipt_audit_logs (receipt_id, created_at desc);

-- ── 5. Cerrar las fronteras entre negocios ───────────────────────────
--
-- ⚠️ Lo cazó `verificar-fronteras.sql`, y tenía razón: con foráneas simples,
-- una fila de estas tablas podía apuntar a un pedido, un comprobante o un
-- usuario de OTRO negocio. La RPC comprueba la pertenencia del pedido, pero
-- una comprobación en código no cubre los caminos que se añadan mañana; la
-- base sí.
--
-- Se cierra con foráneas COMPUESTAS sobre `(id, business_id)`, el mismo
-- patrón que `product_variants` y `option_groups`.
create unique index if not exists uq_payment_receipts_id_business
  on public.payment_receipts (id, business_id);
create unique index if not exists uq_client_users_id_business
  on public.client_users (id, business_id);

alter table public.payment_receipts
  drop constraint if exists payment_receipts_order_id_fkey,
  drop constraint if exists payment_receipts_pedido_del_negocio_fkey;
alter table public.payment_receipts
  add constraint payment_receipts_pedido_del_negocio_fkey
  foreign key (order_id, business_id)
  references public.orders (id, business_id) on delete cascade;

alter table public.payment_receipt_risk_flags
  drop constraint if exists payment_receipt_risk_flags_receipt_id_fkey,
  drop constraint if exists payment_receipt_risk_flags_del_negocio_fkey;
alter table public.payment_receipt_risk_flags
  add constraint payment_receipt_risk_flags_del_negocio_fkey
  foreign key (receipt_id, business_id)
  references public.payment_receipts (id, business_id) on delete cascade;

alter table public.payment_receipt_audit_logs
  drop constraint if exists payment_receipt_audit_logs_receipt_id_fkey,
  drop constraint if exists payment_receipt_audit_logs_del_negocio_fkey;
alter table public.payment_receipt_audit_logs
  add constraint payment_receipt_audit_logs_del_negocio_fkey
  foreign key (receipt_id, business_id)
  references public.payment_receipts (id, business_id) on delete cascade;

-- El usuario que revisó tiene que ser del mismo negocio. `set null` para no
-- perder la auditoría si ese empleado se borra: lo que hizo sigue escrito.
alter table public.payment_receipt_audit_logs
  drop constraint if exists payment_receipt_audit_logs_user_id_fkey,
  drop constraint if exists payment_receipt_audit_logs_usuario_del_negocio_fkey;
alter table public.payment_receipt_audit_logs
  add constraint payment_receipt_audit_logs_usuario_del_negocio_fkey
  foreign key (user_id, business_id)
  references public.client_users (id, business_id) on delete set null;

-- ── Quién preparó cada línea, y quién movió cada evento (2026-09-24) ───────
--
-- ⚠️ COMPUESTAS con `business_id`, y no por gusto: con una foránea de una sola
-- columna, una línea del local A podría decir que la preparó un empleado del
-- local B. Lo cazó `verificar-fronteras.sql` al escribir esto — que es
-- exactamente para lo que se construyó ese guardián.
--
-- `set null` para no perder la trazabilidad si ese empleado se borra: lo que
-- hizo sigue escrito, solo deja de tener nombre.
alter table public.order_items
  drop constraint if exists order_items_prepared_by_fkey,
  drop constraint if exists fk_order_items_preparado_por;
alter table public.order_items
  add constraint fk_order_items_preparado_por
  foreign key (prepared_by, business_id)
  references public.client_users (id, business_id) on delete set null;

alter table public.order_events
  drop constraint if exists order_events_created_by_fkey,
  drop constraint if exists fk_order_events_hecho_por;
alter table public.order_events
  add constraint fk_order_events_hecho_por
  foreign key (created_by, business_id)
  references public.client_users (id, business_id) on delete set null;

-- ── 4. Registrar un comprobante y buscar si ya se usó ────────────────
--
-- Todo en UNA operación: registrar, buscar duplicados y dejar la auditoría.
-- Separado en tres consultas, dos comprobantes llegando a la vez podrían no
-- verse el uno al otro y los dos saldrían «limpios».
--
-- ⚠️ EL AISLAMIENTO, que es la decisión delicada de esta migración:
--
-- La BÚSQUEDA es global —un comprobante reutilizado en OTRO local es el
-- fraude que más importa cazar, y limitarla al negocio lo dejaría pasar—
-- pero lo que se DEVUELVE nunca nombra al otro negocio: solo dice que ya se
-- usó y en qué pedido de ESTE negocio, si lo hubo. Es el mismo criterio que
-- `marketplace_conversations`: se quita el acceso, no se parte la tabla.
--
-- Un dueño no puede llamar a esta función: solo `service_role`.
create or replace function public.register_payment_receipt(
  p_business_id uuid,
  p_order_id uuid,
  p_file_url text,
  p_file_public_id text,
  p_sha256 text,
  p_perceptual_hash text default null,
  p_mime_type text default null,
  p_file_size integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt_id uuid;
  v_mismo_archivo integer := 0;
  v_misma_imagen integer := 0;
  v_pedido_previo bigint;
  v_order_number bigint;
begin
  if p_business_id is null or p_order_id is null then
    raise exception using errcode = '22023', message = 'Faltan el negocio o el pedido';
  end if;
  if p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella del archivo invalida';
  end if;
  if p_file_url is null or btrim(p_file_url) = '' then
    raise exception using errcode = '22023', message = 'Falta la URL del comprobante';
  end if;

  -- El pedido tiene que ser de ESTE negocio. Sin esto, un identificador de
  -- pedido ajeno colgaría un comprobante donde no debe.
  select o.order_number into v_order_number
  from public.orders o
  where o.id = p_order_id and o.business_id = p_business_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ¿Este archivo exacto ya se usó ANTES, en cualquier local?
  select count(*) into v_mismo_archivo
  from public.payment_receipts r
  where r.sha256_hash = p_sha256
    and r.order_id <> p_order_id;

  -- ¿Y la misma imagen recortada o recomprimida? WhatsApp recomprime al
  -- reenviar, así que el SHA cambia y solo el perceptual la reconoce.
  if p_perceptual_hash is not null and btrim(p_perceptual_hash) <> '' then
    select count(*) into v_misma_imagen
    from public.payment_receipts r
    where r.perceptual_hash = p_perceptual_hash
      and r.order_id <> p_order_id;
  end if;

  -- El pedido de ESTE negocio donde se usó antes, si lo hay. De otro negocio
  -- no se dice nada: que exista es información suficiente para desconfiar, y
  -- el número de pedido ajeno no es asunto de este dueño.
  select o.order_number into v_pedido_previo
  from public.payment_receipts r
  join public.orders o on o.id = r.order_id
  where (r.sha256_hash = p_sha256
      or (p_perceptual_hash is not null and r.perceptual_hash = p_perceptual_hash))
    and r.order_id <> p_order_id
    and o.business_id = p_business_id
  order by r.created_at desc
  limit 1;

  insert into public.payment_receipts (
    business_id, order_id, file_url, file_public_id,
    sha256_hash, perceptual_hash, mime_type, file_size, status
  ) values (
    p_business_id, p_order_id, p_file_url, nullif(btrim(p_file_public_id), ''),
    p_sha256, nullif(btrim(p_perceptual_hash), ''), nullif(btrim(p_mime_type), ''),
    p_file_size, 'pendiente_analisis'
  )
  returning id into v_receipt_id;

  -- La señal se deja escrita aquí mismo, no en el código: si el análisis
  -- posterior falla o está apagado, el duplicado ya quedó marcado.
  if v_mismo_archivo > 0 or v_misma_imagen > 0 then
    insert into public.payment_receipt_risk_flags (
      business_id, receipt_id, flag_type, severity, description, points
    ) values (
      p_business_id,
      v_receipt_id,
      case when v_mismo_archivo > 0 then 'archivo_duplicado' else 'imagen_duplicada' end,
      'critica',
      case
        when v_pedido_previo is not null
          then format('Este comprobante ya se usó en el pedido #%s', v_pedido_previo)
        else 'Este comprobante ya se usó en otro pedido'
      end,
      case when v_mismo_archivo > 0 then 70 else 60 end
    );
  end if;

  insert into public.payment_receipt_audit_logs (
    business_id, receipt_id, action, new_status, metadata
  ) values (
    p_business_id, v_receipt_id, 'recibido', 'pendiente_analisis',
    jsonb_build_object(
      'order_number', v_order_number,
      'duplicado_exacto', v_mismo_archivo > 0,
      'duplicado_visual', v_misma_imagen > 0
    )
  );

  return jsonb_build_object(
    'result', 'registered',
    'receipt_id', v_receipt_id,
    'duplicado', (v_mismo_archivo > 0 or v_misma_imagen > 0),
    'duplicado_exacto', v_mismo_archivo > 0,
    'duplicado_visual', v_misma_imagen > 0,
    -- Solo el pedido de este negocio. Nunca el de otro.
    'pedido_previo', v_pedido_previo
  );
end;
$$;

revoke all on function public.register_payment_receipt(
  uuid, uuid, text, text, text, text, text, integer
) from public, anon, authenticated;
grant execute on function public.register_payment_receipt(
  uuid, uuid, text, text, text, text, text, integer
) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- EL NÚMERO DE LA PLATAFORMA NO SE LO PUEDE QUEDAR UN LOCAL
-- (migration-2026-08-23-el-numero-es-de-la-plataforma.sql)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Nace de un fallo real: escribir al número de Umbani contestaba con la mini
-- app de Monster Pizza en vez de las categorías, porque ese local tenía el
-- MISMO número. `resolveBusinessChannel` corre antes que la rama del
-- marketplace, así que el local ganaba y el marketplace no se ejecutaba nunca.

create or replace function public.businesses_no_pisan_el_numero_plataforma()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plataforma text;
  v_propuesto text;
begin
  -- El número de la plataforma vive en `server_settings`, no en un negocio:
  -- no pertenece a ningún local. Si no está configurado, no hay nada que
  -- proteger todavía y el disparador no estorba.
  select nullif(btrim(s.value), '') into v_plataforma
  from public.server_settings s
  where s.key = 'platform_ycloud_number';

  if v_plataforma is null then
    return new;
  end if;

  -- Se comparan SOLO los dígitos: el mismo teléfono se escribe «+593…» en un
  -- sitio y «593…» en otro, y comparar en crudo dejaría pasar exactamente el
  -- caso que esto existe para impedir. Es el mismo criterio que
  -- `esNumeroDePlataforma` en `services/platform-channel.ts`.
  v_plataforma := regexp_replace(v_plataforma, '\D', '', 'g');

  foreach v_propuesto in array array[
    coalesce(new.whatsapp_number, ''),
    coalesce(new.ycloud_number, ''),
    coalesce(new.meta_phone_id, '')
  ] loop
    v_propuesto := regexp_replace(v_propuesto, '\D', '', 'g');
    if v_propuesto <> '' and v_propuesto = v_plataforma then
      raise exception using
        errcode = '23514',
        message = 'Ese número es el del marketplace y no puede ser de un local',
        hint = 'Los locales viven en el marketplace (whatsapp_provider = '
             || '''marketplace''), sin número propio. Si un local se queda con '
             || 'el número de la plataforma, los mensajes de TODOS los clientes '
             || 'le llegan a él y el menú del marketplace deja de responder.';
    end if;
  end loop;

  return new;
end;
$$;

-- BEFORE: tiene que abortar ANTES de que `sync_business_channel_identifiers`
-- llegue a escribir el identificador que secuestra el enrutado.
drop trigger if exists businesses_numero_de_plataforma on public.businesses;
create trigger businesses_numero_de_plataforma
  before insert or update of whatsapp_number, ycloud_number, meta_phone_id
  on public.businesses
  for each row execute function public.businesses_no_pisan_el_numero_plataforma();


-- ═══════════════════════════════════════════════════════════════════════════
-- EL COMPROBANTE SE LEE Y SE PUNTÚA
-- (migration-2026-08-22-lectura-del-comprobante.sql)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Lo que llena las columnas que dejó preparadas la huella: los campos leídos
-- de la imagen, sus señales de riesgo y el score que las suma.
--
-- ⚠️ Ninguna de las dos funciones escribe una sola columna de `orders`. El
-- análisis NO confirma un pago: eso lo decide el dueño mirando su banco.

-- ── 1. Guardar lo que se leyó de la imagen ───────────────────────────
--
-- Todo en UNA operación: los campos, las señales, el score recalculado y la
-- auditoría. Separado en cuatro consultas, un fallo a mitad dejaría un
-- comprobante con datos pero sin score, o con score pero sin las señales que
-- lo explican — que es la peor forma de enseñar un número.
--
-- ⚠️ EL SCORE SE RECALCULA SUMANDO **TODAS** LAS SEÑALES DEL COMPROBANTE, no
-- solo las que llegan en esta llamada. Es deliberado y es la razón de que se
-- calcule aquí y no en el servidor: `register_payment_receipt` ya escribió la
-- señal de duplicado —70 puntos si es el mismo archivo, 60 si es la misma
-- imagen— ANTES de que el análisis existiera, precisamente para que un
-- duplicado quede marcado aunque el análisis esté apagado o falle. Si el
-- servidor mandara un total calculado por su cuenta, esos puntos se perderían
-- y un comprobante reutilizado podría salir «bajo».
--
-- ⚠️ LOS TEXTOS SE RECORTAN EN VEZ DE RECHAZARSE. Los CHECK de la tabla
-- limitan cada campo (120 el banco, 160 los nombres, 8000 el texto crudo…), y
-- un modelo de visión sobre una foto ruidosa puede devolver cualquier cosa.
-- Abortar por un nombre de banco de 300 caracteres perdería el análisis
-- ENTERO, incluidas las señales de riesgo, que es justo lo que hay que
-- conservar. El servidor ya sanea; esto es la última red.
create or replace function public.save_receipt_analysis(
  p_business_id uuid,
  p_receipt_id uuid,
  p_status text,
  p_datos jsonb default null,
  p_flags jsonb default null,
  p_analysis jsonb default null,
  p_puntos_referencia integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existe boolean;
  v_fecha date;
  v_hora time;
  v_monto numeric(12,2);
  v_flag jsonb;
  v_score integer;
  v_nivel text;
  v_estado_previo text;
  v_referencia text;
  v_ref_repetida integer := 0;
begin
  if p_business_id is null or p_receipt_id is null then
    raise exception using errcode = '22023', message = 'Faltan el negocio o el comprobante';
  end if;

  -- Solo dos destinos posibles, y ninguno dice que el dinero llegó:
  -- `analizado` = se pudo leer; `requiere_revision` = no se pudo, lo mira una
  -- persona. Los otros dos estados de la tabla los pone otro camino
  -- (`pendiente_analisis` al recibirlo, `descartado` al pedir otro).
  if p_status is null or p_status not in ('analizado', 'requiere_revision') then
    raise exception using errcode = '22023',
      message = 'El analisis solo puede dejar el comprobante en analizado o requiere_revision';
  end if;

  -- El comprobante tiene que ser de ESTE negocio. Sin esto, un identificador
  -- ajeno dejaría escrito el análisis de otro local — y devolvería sus datos.
  select true, r.status into v_existe, v_estado_previo
  from public.payment_receipts r
  where r.id = p_receipt_id and r.business_id = p_business_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ── Las conversiones que pueden reventar ──
  --
  -- Un modelo puede devolver «32/13/2026», «ayer» o un monto con letras. Un
  -- cast directo abortaría la transacción entera y se perdería todo lo demás,
  -- incluido el texto crudo, que es lo que permite entender QUÉ leyó. Cada
  -- una va en su propio bloque: lo que no se entienda se queda nulo, que es
  -- exactamente lo que significa «no se pudo leer ese dato».
  begin
    v_fecha := nullif(btrim(p_datos->>'transaction_date'), '')::date;
  exception when others then
    v_fecha := null;
  end;
  begin
    v_hora := nullif(btrim(p_datos->>'transaction_time'), '')::time;
  exception when others then
    v_hora := null;
  end;
  begin
    v_monto := nullif(btrim(p_datos->>'amount'), '')::numeric(12,2);
    -- El CHECK de la tabla exige 0..999999. Fuera de rango es un dato mal
    -- leído, no un pago de un millón: se descarta el campo, no el análisis.
    if v_monto is not null and (v_monto < 0 or v_monto > 999999) then
      v_monto := null;
    end if;
  exception when others then
    v_monto := null;
  end;

  update public.payment_receipts r set
    bank_name           = left(nullif(btrim(p_datos->>'bank_name'), ''), 120),
    sender_name         = left(nullif(btrim(p_datos->>'sender_name'), ''), 160),
    beneficiary_name    = left(nullif(btrim(p_datos->>'beneficiary_name'), ''), 160),
    destination_account = left(nullif(btrim(p_datos->>'destination_account'), ''), 60),
    amount              = v_monto,
    currency            = left(nullif(btrim(p_datos->>'currency'), ''), 8),
    transaction_date    = v_fecha,
    transaction_time    = v_hora,
    reference_number    = left(nullif(btrim(p_datos->>'reference_number'), ''), 80),
    transaction_number  = left(nullif(btrim(p_datos->>'transaction_number'), ''), 80),
    ocr_raw_text        = left(nullif(btrim(p_datos->>'ocr_raw_text'), ''), 8000),
    analysis_json       = p_analysis,
    status              = p_status,
    updated_at          = now()
  where r.id = p_receipt_id and r.business_id = p_business_id;

  -- ── Las señales ──
  --
  -- Una fila por señal, con sus puntos, para que el score se pueda explicar:
  -- sin esto, un 78/100 es un número sin defensa delante de un dueño que está
  -- decidiendo si entrega comida sin haber cobrado.
  if p_flags is not null and jsonb_typeof(p_flags) = 'array' then
    for v_flag in select * from jsonb_array_elements(p_flags) loop
      -- Una señal mal formada se ignora en vez de tumbar el análisis: el resto
      -- de señales y los campos leídos valen más que la que vino rota.
      continue when jsonb_typeof(v_flag) <> 'object';
      continue when coalesce(btrim(v_flag->>'flag_type'), '') = '';

      insert into public.payment_receipt_risk_flags (
        business_id, receipt_id, flag_type, severity, description, points
      ) values (
        p_business_id,
        p_receipt_id,
        left(btrim(v_flag->>'flag_type'), 60),
        case
          when v_flag->>'severity' in ('baja', 'media', 'alta', 'critica')
            then v_flag->>'severity'
          else 'media'
        end,
        left(nullif(btrim(v_flag->>'description'), ''), 300),
        -- Fuera del rango del CHECK (−100..100) se acota en vez de abortar.
        greatest(-100, least(100, coalesce(
          (case when v_flag->>'points' ~ '^-?[0-9]{1,4}$'
                then (v_flag->>'points')::integer end), 0
        )))
      );
    end loop;
  end if;

  -- ── ¿Esta referencia bancaria ya se usó? ──
  --
  -- Es el duplicado que la huella NO puede ver: quien vuelve a mandar el mismo
  -- pago recorta la captura, le cambia el brillo o la reenvía por WhatsApp —y
  -- entonces el SHA cambia y hasta el perceptual puede fallar—, pero el número
  -- de transacción del banco sigue siendo el mismo. Es el mismo dinero contado
  -- dos veces.
  --
  -- ⚠️ La búsqueda es GLOBAL, como la de la huella y por lo mismo: una
  -- referencia reutilizada en OTRO local es el fraude que más pesa y limitarla
  -- a este negocio lo dejaría pasar. Y como allí, lo que se ESCRIBE no nombra
  -- al otro negocio: la señal dice que ya se usó, nunca dónde.
  select nullif(btrim(p_datos->>'reference_number'), '') into v_referencia;
  if v_referencia is not null and p_puntos_referencia <> 0 then
    select count(*) into v_ref_repetida
    from public.payment_receipts r
    where r.reference_number = v_referencia
      and r.id <> p_receipt_id
      -- Del mismo pedido no cuenta: es el cliente reenviando su propio
      -- comprobante porque el primero salió borroso, que no es fraude.
      and r.order_id <> (
        select order_id from public.payment_receipts where id = p_receipt_id
      );

    if v_ref_repetida > 0 then
      insert into public.payment_receipt_risk_flags (
        business_id, receipt_id, flag_type, severity, description, points
      ) values (
        p_business_id, p_receipt_id, 'referencia_duplicada', 'critica',
        format('La referencia %s ya se usó en otro pedido', v_referencia),
        greatest(-100, least(100, p_puntos_referencia))
      );
    end if;
  end if;

  -- ── El score, sumando TODO lo que hay escrito sobre este comprobante ──
  --
  -- Acotado a 0..100: las señales que restan (monto que coincide, cuenta que
  -- coincide) no pueden llevar el riesgo por debajo de cero, y varias señales
  -- graves juntas no pueden pasar de cien. Las bandas son las del encargo.
  select greatest(0, least(100, coalesce(sum(f.points), 0)))
  into v_score
  from public.payment_receipt_risk_flags f
  where f.receipt_id = p_receipt_id and f.business_id = p_business_id;

  v_nivel := case
    when v_score <= 20 then 'bajo'
    when v_score <= 50 then 'medio'
    when v_score <= 75 then 'alto'
    else 'critico'
  end;

  update public.payment_receipts r
     set risk_score = v_score, risk_level = v_nivel, updated_at = now()
   where r.id = p_receipt_id and r.business_id = p_business_id;

  insert into public.payment_receipt_audit_logs (
    business_id, receipt_id, action, old_status, new_status, metadata
  ) values (
    p_business_id, p_receipt_id, 'analizado', v_estado_previo, p_status,
    jsonb_build_object(
      'risk_score', v_score,
      'risk_level', v_nivel,
      'senales', (
        select count(*) from public.payment_receipt_risk_flags f
        where f.receipt_id = p_receipt_id
      )
    )
  );

  return jsonb_build_object(
    'result', 'saved',
    'receipt_id', p_receipt_id,
    'risk_score', v_score,
    'risk_level', v_nivel
  );
end;
$$;

revoke all on function public.save_receipt_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, integer
) from public, anon, authenticated;
grant execute on function public.save_receipt_analysis(
  uuid, uuid, text, jsonb, jsonb, jsonb, integer
) to service_role;

-- ── 2. Lo que ve el dueño ────────────────────────────────────────────
--
-- El comprobante MÁS RECIENTE de un pedido, con sus señales. Va en una función
-- y no en dos consultas desde el servidor por dos motivos: el filtro por
-- negocio queda dentro (un identificador de pedido viaja en la URL, y sin el
-- negocio se estaría enseñando el comprobante de otro local), y las señales
-- llegan en la misma ida y vuelta que el comprobante — el panel del dueño
-- recarga sus pedidos cada 12 segundos y no conviene duplicarle las consultas.
--
-- ⚠️ NUNCA devuelve nada de otro negocio. La detección de duplicados sí mira
-- toda la plataforma —un comprobante reutilizado en otro local es el fraude
-- que más pesa—, pero lo que sale de aquí es solo de este dueño: la señal dice
-- que esa imagen ya se usó, y el pedido que nombra es de su propio negocio o
-- de ninguno. Es el mismo criterio de `register_payment_receipt`.
create or replace function public.get_receipt_analysis(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'receipt_id', r.id,
        'status', r.status,
        'bank_name', r.bank_name,
        'sender_name', r.sender_name,
        'beneficiary_name', r.beneficiary_name,
        'destination_account', r.destination_account,
        'amount', r.amount,
        'currency', r.currency,
        'transaction_date', r.transaction_date,
        'transaction_time', r.transaction_time,
        'reference_number', r.reference_number,
        'transaction_number', r.transaction_number,
        'risk_score', r.risk_score,
        'risk_level', r.risk_level,
        'created_at', r.created_at,
        'flags', coalesce((
          select jsonb_agg(jsonb_build_object(
            'flag_type', f.flag_type,
            'severity', f.severity,
            'description', f.description,
            'points', f.points
          ) order by f.points desc, f.created_at)
          from public.payment_receipt_risk_flags f
          where f.receipt_id = r.id and f.business_id = p_business_id
        ), '[]'::jsonb)
      )
      from public.payment_receipts r
      where r.order_id = p_order_id
        and r.business_id = p_business_id
      order by r.created_at desc
      limit 1
    ),
    -- Sin comprobante registrado no es un error: son todos los pedidos
    -- anteriores a esta capa, y el panel tiene que saber pintarlos igual.
    jsonb_build_object('result', 'sin_analisis')
  );
$$;

revoke all on function public.get_receipt_analysis(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_receipt_analysis(uuid, uuid) to service_role;


-- ═══════════════════════════════════════════════════════════════════════════
-- CÓMO SE PIDE LO DECIDE EL TIPO DE LOCAL, NO CUÁNTOS PRODUCTOS TIENE
-- (migration-2026-08-23-pedir-por-tipo.sql)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Una pizzería tiene pocos productos pero pedirla es tamaño, masa, borde y dos
-- sabores; una heladería «vende un solo producto» pero lo que pesa son sus
-- veinte sabores. Las dos van a la mini app. Una almuercería son tres platos
-- del día y se piden hablando.

alter table public.marketplace_category_types
  add column if not exists pide_en_chat boolean not null default false;

comment on column public.marketplace_category_types.pide_en_chat is
  'Si el pedido se arma DENTRO del chat (true) o se manda el enlace de la '
  'tienda (false). Lo decide cuánto hay que ELEGIR para armar el pedido, no '
  'cuántos productos hay en el catálogo.';

-- ⚠️ El defecto es FALSE —el enlace— y eso es fallar hacia lo seguro: la
-- tienda atiende cualquier catálogo y cualquier cantidad de opciones,
-- mientras que un menú de chat mal elegido deja al cliente recorriendo listas
-- interminables. Un tipo nuevo cae solo en el lado que siempre funciona.
--
-- Se listan los del CHAT, que son la excepción. Es la misma lista de
-- `PEDIDO_SIMPLE`, y `tipos-que-piden-en-el-chat.test.js` comprueba que las
-- dos no se separen.
update public.marketplace_category_types
   set pide_en_chat = true
 where business_type in (
   -- Platos del día: se elige uno de tres o cuatro.
   'almuerzos', 'menú ejecutivo', 'desayunos', 'comida típica',
   -- Carta corta de platos que se piden por su nombre.
   'marisquería', 'pollo asado', 'asadero', 'parrillada', 'comida saludable',
   -- Producto suelto, sin nada que configurar.
   'postres', 'carnicería', 'cafetería', 'jugos', 'batidos',
   'emprendimiento de comida'
 );

-- Lo que el servidor pregunta al entregar el local: ¿este tipo se pide
-- hablando, o se le manda el enlace?
--
-- ⚠️ Un tipo que no esté en la tabla devuelve FALSE, no error: los negocios
-- con un tipo escrito a mano —`businesses.type` es texto libre— tienen que
-- poder pedir igual, y el enlace es el lado que siempre funciona.
create or replace function public.tipo_pide_en_chat(p_business_type text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select t.pide_en_chat
      from public.marketplace_category_types t
      where t.business_type = btrim(lower(coalesce(p_business_type, '')))
    ),
    false
  );
$$;

revoke all on function public.tipo_pide_en_chat(text) from public, anon, authenticated;
grant execute on function public.tipo_pide_en_chat(text) to service_role;


-- ══════════════════════════════════════════════════════════════════
-- DOS FRENOS DE ABUSO (2026-08-25)
--
-- ⚠️ AL FINAL DEL ARCHIVO a propósito: `idx_orders_abiertos_por_cliente` es un
-- índice PARCIAL sobre `orders.source`, y esa columna la añade un `alter table`
-- muy posterior a la creación de la tabla. Colocado más arriba, el índice falla
-- con «column source does not exist» — un cuerpo de función no se valida al
-- crearlo, pero un índice sí.
--
-- El techo del 2026-08-24 cuenta RESPUESTAS, no pedidos: diez pedidos falsos
-- en cinco minutos son diez alarmas, diez comandas y comida que nadie recoge.
-- Y bloquear era por local: a quien molesta a cinco locales había que
-- bloquearlo cinco veces.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Nadie deja diez pedidos abiertos ────────────────────────────────────
--
-- ⚠️ VA EN UN DISPARADOR, no dentro de `create_storefront_order`. Es la misma
-- regla que ya siguieron `orders_reject_blocked` y `orders_stamp_pricing`: la
-- función del dinero no se recrea por un añadido, y así el freno cubre TODOS
-- los caminos que creen pedidos, incluidos los que no existen todavía.
--
-- ⚠️ La ventana es imprescindible. Sin ella, tres pedidos abandonados en
-- `esperando_pago` de hace un mes dejarían a ese cliente sin poder volver a
-- pedir NUNCA — y hoy nadie expira los pedidos abandonados (`expirado` está en
-- las restricciones y no lo escribe nadie). Con ventana, el freno estorba seis
-- horas y se suelta solo.
--
-- ⚠️ Solo `source = 'storefront'`, igual que el bloqueo. Un pedido de MOSTRADOR
-- lo teclea el dueño con la persona delante: si quiere meter cinco seguidos,
-- es su cocina y su decisión.
--
-- ⚠️ Cuenta lo que el dueño AÚN NO HA MIRADO. En cuanto acepta —`aceptado`,
-- `preparacion`— ese pedido deja de contar: ya decidió tomarlo, y el cliente
-- puede encargar otra cosa sin que el freno se lo impida.
create or replace function public.orders_limit_open_per_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_en_el_local     integer;
  v_en_la_plataforma integer;
  v_tope constant integer := 3;
  v_ventana constant interval := interval '6 hours';
  v_abiertos constant text[] := array['esperando_pago', 'pago_en_revision', 'pendiente'];
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  -- Un solo recorrido para los dos alcances: el índice
  -- `idx_orders_abiertos_por_cliente` ya cubre (business_id, customer_id,
  -- status, created_at), y contar dos veces sería pagar dos consultas por cada
  -- pedido nuevo para responder a la misma pregunta.
  select
    count(*) filter (where previo.business_id = new.business_id),
    count(*)
  into v_en_el_local, v_en_la_plataforma
  from public.orders as previo
  where previo.customer_id = new.customer_id
    and previo.source = 'storefront'
    and previo.status = any(v_abiertos)
    and previo.created_at > now() - v_ventana;

  -- El del LOCAL primero: cuando los dos se cumplen, su mensaje es el útil
  -- —dice dónde está el problema y por tanto qué hacer—.
  if v_en_el_local >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Ya tienes pedidos sin confirmar en este local. Espera a que los revisen antes de hacer otro.';
  end if;

  -- El de PLATAFORMA. El texto nombra Umbani a propósito: quien llega aquí ha
  -- pedido en varios locales, y decirle «en este local» lo mandaría a mirar el
  -- sitio equivocado. Y nombra la salida: pagar lo que debe.
  if v_en_la_plataforma >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Tienes varios pedidos sin confirmar en Umbani. Envía el comprobante de los que faltan y podrás pedir de nuevo.';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_limit_open_per_customer on public.orders;
create trigger orders_limit_open_per_customer
  before insert on public.orders
  for each row execute function public.orders_limit_open_per_customer();

-- El disparador cuenta por (negocio, cliente, estado, fecha). Sin este índice
-- serían tres consultas secuenciales sobre `orders` en cada pedido nuevo.
create index if not exists idx_orders_abiertos_por_cliente
  on public.orders (business_id, customer_id, status, created_at)
  where source = 'storefront';


-- ── 2. El candado se suelta cuando el pedido SE RESUELVE ───────────────────
--
-- ⚠️ VA EN UN DISPARADOR, no en `marketplace-entry.ts`, y es la parte que más
-- importa de esta migración. Todos los cambios de estado pasan hoy por la
-- base —`set_order_status` y `expire_unpaid_orders`, las dos RPC—, y ninguna
-- ruta escribe `orders.status` a mano. Puesto aquí, el candado se suelta por
-- CUALQUIER camino que resuelva un pedido, incluidos los que no existen
-- todavía: cuando entren los motorizados van a mover estados por vías nuevas,
-- y nadie va a acordarse de llamar a una función de TypeScript desde ahí.
--
-- Es la misma regla que ya siguieron `orders_reject_blocked`,
-- `orders_stamp_pricing` y `orders_limit_open_per_customer`.
--
-- ⚠️ QUÉ RETIENE EL CANDADO: solo `esperando_pago`, y NO los tres estados que
-- cuenta el tope de arriba. Son dos preguntas distintas:
--
--   · El TOPE protege la COCINA del local — comandas que el dueño no ha
--     mirado. Ahí `pendiente` y `pago_en_revision` sí estorban.
--   · El CANDADO pregunta «¿esta persona DEBE algo?». En `pago_en_revision` ya
--     mandó el comprobante y en `pendiente` (efectivo) no debe nada: los dos
--     esperan al DUEÑO. Retenerlo ahí impediría pedir en otro local porque el
--     local va lento, que es castigar al cliente por algo ajeno a él.
--
-- La regla del dueño era «tiene que enviar el comprobante». `esperando_pago`
-- es ese estado y ningún otro.
--
-- ⚠️ FALLA ABIERTO. El pedido ya cambió de estado cuando esto corre: la
-- comanda está en la cocina. Si soltar el candado fallara —no hay
-- conversación, la fila desapareció—, el pedido no puede caerse por eso. Es
-- el mismo criterio de `orders_reset_marketplace_reply`.
create or replace function public.orders_release_shopping_lock()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- Los dos estados en los que el cliente ya encargó y el local aún no dijo
  -- que sí. `pendiente` (efectivo) queda fuera: no lleva comprobante.
  v_retienen constant text[] := array['esperando_pago', 'pago_en_revision'];
begin
  if new.customer_id is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    -- ── Nace sin deber nada: se suelta (2026-09-27) ───────────────────────
    --
    -- Efectivo y pago al retirar nacen en `pendiente`, sin pasar nunca por un
    -- estado que retenga, así que la rama de UPDATE de abajo no los veía y el
    -- candado se quedaba puesto PARA SIEMPRE: el chat le decía «termínalo» a
    -- un pedido hecho, y seguía preguntando después de entregado. Lo hacía a
    -- mano el checkout del chat, y se fue con él en el #360.
    --
    -- ⚠️ Solo los de la TIENDA. El de mostrador lo teclea el dueño con la
    -- persona delante: no tiene nada que ver con su conversación.
    if coalesce(new.source, '') <> 'storefront' or new.status = any(v_retienen) then
      return new;
    end if;
  else
    -- ── Sigue debiendo: el candado se queda ───────────────────────────────
    if new.status = any(v_retienen) then
      -- Pero la conversación tiene que saber en cuál de los dos está, o el
      -- bot le pedirá la foto a quien acaba de mandarla.
      if new.status = 'pago_en_revision' and old.status <> 'pago_en_revision' then
        begin
          update public.marketplace_conversations as conv
             set current_state = 'pago_en_revision',
                 version       = conv.version + 1,
                 updated_at    = now()
           where conv.customer_id = new.customer_id
             and conv.shopping_locked = true
             and conv.selected_business_id = new.business_id;
        exception when others then
          -- El pedido ya avanzó: un fallo aquí no puede tumbarlo.
          null;
        end;
      end if;
      return new;
    end if;

    -- ── Salió de los estados que retienen: se suelta ──────────────────────
    if not (old.status = any(v_retienen)) then
      return new;
    end if;
  end if;

  begin
    -- ⚠️ Solo si no le quedan OTROS pedidos reteniendo. Alguien con dos a
    -- medias que resuelve uno sigue debiendo el otro; soltarle el candado ahí
    -- sería premiar el pago parcial con vía libre.
    if exists (
      select 1
      from public.orders as otro
      where otro.customer_id = new.customer_id
        and otro.id <> new.id
        and otro.source = 'storefront'
        and otro.status = any(v_retienen)
    ) then
      return new;
    end if;

    update public.marketplace_conversations as conv
       set shopping_locked     = false,
           -- Soltar el local va JUNTO con soltar el candado: el CHECK
           -- `marketplace_conversations_bloqueo_check` prohíbe estar bloqueado
           -- en ninguna parte, y dejar el local elegido sin candado haría que
           -- el siguiente mensaje entrara en un local que la persona ya
           -- terminó.
           selected_business_id = null,
           current_state        = 'navegando',
           flow_state           = null,
           version              = conv.version + 1,
           updated_at           = now()
     where conv.customer_id = new.customer_id
       and conv.shopping_locked = true
       -- ⚠️ Al NACER, solo si está en el local de ESTE pedido. Si ya anda
       -- eligiendo en otro, ese candado es de lo que hace ahora y no se toca.
       and (tg_op = 'UPDATE' or conv.selected_business_id = new.business_id);
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_release_shopping_lock on public.orders;
create trigger orders_release_shopping_lock
  after insert or update of status on public.orders
  for each row execute function public.orders_release_shopping_lock();

comment on function public.orders_release_shopping_lock() is
  'El candado dura mientras el pedido esté en esperando_pago o pago_en_revision. '
  'Al entrar en revisión marca la conversación para que el bot no pida una foto '
  'que ya llegó. Decisión del dueño 2026-08-30: Umbani cerrado en WhatsApp.';

create or replace function public.orders_clear_customer_strikes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  -- El local lo dio por bueno. Desde `confirmado` en adelante ya hay una
  -- decisión del dueño detrás.
  v_aceptados constant text[] := array[
    'confirmado', 'aceptado', 'preparacion',
    'listo_para_retiro', 'en_camino', 'completado'
  ];
begin
  if new.customer_id is null then
    return new;
  end if;

  -- Solo al ENTRAR en el grupo: pasar de `preparacion` a `en_camino` no es una
  -- segunda demostración, es el mismo pedido avanzando.
  if not (new.status = any(v_aceptados)) or old.status = any(v_aceptados) then
    return new;
  end if;

  begin
    update public.business_customers
       set unpaid_expiries   = 0,
           rejected_receipts = 0,
           updated_at        = now()
     where business_id = new.business_id
       and customer_id = new.customer_id
       -- Sin esto se escribiría una fila en cada pedido de cada cliente bueno,
       -- que son casi todos.
       and (unpaid_expiries > 0 or rejected_receipts > 0);
  exception when others then
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_clear_customer_strikes on public.orders;
create trigger orders_clear_customer_strikes
  after update of status on public.orders
  for each row execute function public.orders_clear_customer_strikes();

comment on function public.orders_clear_customer_strikes() is
  'Cuando el local ACEPTA un pedido, la pizarra de esa persona en ese local se '
  'borra: se cuenta la racha, no el historial. Misma regla que ya seguía '
  'rejected_receipts, ahora también para unpaid_expiries.';

-- ── 1. El pedido nuevo marca la conversación ───────────────────────────────
create or replace function public.orders_mark_awaiting_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is null
     or coalesce(new.source, '') <> 'storefront'
     or new.status <> 'esperando_pago' then
    return new;
  end if;

  begin
    update public.marketplace_conversations as conv
       set current_state = 'esperando_comprobante',
           -- ⚠️ La vista se BORRA (2026-09-27). Si el cliente tenía pendiente
           -- «¿Empezamos de nuevo o sigues?», su «Empezar de nuevo» —el botón
           -- o un «1» escrito— cancelaba este pedido recién nacido, aunque ya
           -- hubiera transferido. Esa pregunta era sobre un carrito; ahora hay
           -- un pedido y manda el candado.
           flow_state    = null,
           version       = conv.version + 1,
           updated_at    = now()
     where conv.customer_id = new.customer_id
       -- Solo si está en ESE local: si la conversación anda en otro sitio,
       -- pisarle el estado la sacaría de donde está.
       and conv.selected_business_id = new.business_id
       and conv.current_state <> 'esperando_comprobante';
  exception when others then
    -- El pedido ya existe. Un fallo marcando la conversación no puede
    -- deshacerlo: lo peor que pasa es que el bot dé el mensaje de antes.
    null;
  end;

  return new;
end;
$$;

drop trigger if exists orders_mark_awaiting_receipt on public.orders;
create trigger orders_mark_awaiting_receipt
  after insert on public.orders
  for each row execute function public.orders_mark_awaiting_receipt();

comment on function public.orders_mark_awaiting_receipt() is
  'Al crear un pedido que espera transferencia, la conversación pasa a '
  'esperando_comprobante y se borra cualquier pregunta pendiente: un «Empezar '
  'de nuevo» de antes de pedir no puede cancelar el pedido recién nacido.';

-- ── 2. Abandonar a propósito CANCELA, no caduca ────────────────────────────
create or replace function public.cancel_unpaid_order_on_purpose(
  p_business_id uuid,
  p_customer_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cancelados integer;
begin
  if p_business_id is null or p_customer_id is null then
    return 0;
  end if;

  with cancelados as (
    update public.orders
       set status = 'cancelado',
           updated_at = now()
     where business_id = p_business_id
       and customer_id = p_customer_id
       and status = 'esperando_pago'
       and coalesce(source, '') = 'storefront'
       -- Con la foto ya mandada, el pedido es del dueño: el cliente no puede
       -- retirarlo por su cuenta.
       and payment_proof_url is null
       and payment_confirmed_at is null
    returning 1
  )
  select count(*)::integer into v_cancelados from cancelados;

  return coalesce(v_cancelados, 0);
end;
$$;

comment on function public.cancel_unpaid_order_on_purpose(uuid, uuid) is
  'El cliente dijo en voz alta que deja el pedido: se cancela en el momento en '
  'vez de dejarlo caducar. Avisar y desaparecer no pueden costar lo mismo.';

revoke all on function public.cancel_unpaid_order_on_purpose(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_unpaid_order_on_purpose(uuid, uuid)
  to service_role;

create index if not exists idx_orders_abiertos_por_persona
  on public.orders (customer_id, status, created_at)
  where source = 'storefront';

comment on function public.orders_release_shopping_lock() is
  'Suelta `shopping_locked` cuando un pedido deja de estar abierto —o nace sin '
  'deber nada, como el de efectivo— y a la persona no le quedan otros. Va en '
  'disparador para cubrir todos los caminos, incluidos los que no existen todavía.';


-- ── 2. El bloqueo de PLATAFORMA ────────────────────────────────────────────
--
-- Distinto del bloqueo del dueño, y los dos hacen falta:
--
--   · `business_customers.blocked_at` lo pone EL DUEÑO y vale para SU local.
--     Que El Puerto te expulse no puede dejarte fuera de Umbani entero.
--   · `customers.blocked_at` lo pone el SUPERADMIN y vale para toda la
--     plataforma: el bot no contesta y ningún local acepta el pedido.
--
-- ⚠️ Vive en `customers` y no en `marketplace_conversations` porque es de la
-- PERSONA, no de una conversación: reiniciar el chat no puede levantar un
-- bloqueo, y borrar la conversación tampoco.
alter table public.customers
  add column if not exists blocked_at timestamptz,
  add column if not exists blocked_reason text;

alter table public.customers
  drop constraint if exists customers_blocked_reason_check;
alter table public.customers
  add constraint customers_blocked_reason_check
  check (blocked_reason is null or char_length(btrim(blocked_reason)) between 3 and 200);

-- Insultos en el chat: bloqueo de 15 días que caduca solo (2026-09-27).
-- Ver `migration-2026-09-27-insultos-bloqueo-15-dias.sql`.
-- ── 1. Hasta cuándo, por qué, y las dos marcas ─────────────────────────────
--
-- `blocked_until` sigue la convención de `business_customers` (2026-09-01):
-- nulo con `blocked_at` puesto = permanente, con fecha = caduca solo.
alter table public.customers
  add column if not exists blocked_until timestamptz,
  add column if not exists blocked_kind text,
  -- La advertencia se da UNA vez en la vida: después, directo al bloqueo.
  add column if not exists insult_warned_at timestamptz,
  -- Se levantó a mano un bloqueo por insultos: su próximo mensaje lo sabrá.
  add column if not exists unblock_notice_pending boolean not null default false;

alter table public.customers
  drop constraint if exists customers_blocked_kind_check;
alter table public.customers
  add constraint customers_blocked_kind_check
  check (blocked_kind is null or blocked_kind in ('manual', 'insultos'));

-- Se consulta en CADA mensaje al número de la plataforma, así que el índice no
-- es opcional. Parcial: los bloqueados son un puñado entre todos los clientes.
create index if not exists idx_customers_bloqueados
  on public.customers (id) where blocked_at is not null;

-- ⚠️ Disparador APARTE de `orders_reject_blocked`, no una condición más dentro.
-- Son dos decisiones de personas distintas —el dueño y el superadmin— con dos
-- motivos distintos, y mezclarlas haría que el día que una falle nadie sepa
-- cuál de las dos actuó.
--
-- ⚠️ Aquí NO se acota a `storefront`. Un bloqueo de plataforma alcanza también
-- al mostrador: si el superadmin expulsó a alguien de Umbani, un local no puede
-- colarlo tecleándole el pedido a mano.
create or replace function public.orders_reject_platform_blocked()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is not null
     and exists (
       select 1 from public.customers
       where id = new.customer_id
         and blocked_at is not null
         -- Un bloqueo de 15 días que ya pasó no rechaza nada, aunque nadie
         -- haya limpiado todavía la fila.
         and (blocked_until is null or blocked_until > now())
     ) then
    raise exception using
      errcode = '42501',
      message = 'No podemos procesar este pedido.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_reject_platform_blocked on public.orders;
create trigger orders_reject_platform_blocked
  before insert on public.orders
  for each row execute function public.orders_reject_platform_blocked();

/**
 * Bloquea o desbloquea a alguien en TODA la plataforma, por teléfono.
 *
 * ⚠️ Por dígitos, como todo lo que toca teléfonos aquí: el mismo número llega
 * como `+593…` por un canal y `593…` por otro, y dos formas de escribirlo
 * serían dos personas — una bloqueada y la otra no.
 *
 * ⚠️ CREA al cliente si no existía. Quien escribe para molestar puede no haber
 * pedido nunca, y es justo a ese al que hay que poder bloquear antes de que lo
 * intente. Es la misma razón que ya tiene `set_contact_blocked` del dueño.
 */
create or replace function public.set_platform_blocked(
  p_phone  text,
  p_blocked boolean,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_digitos text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  v_id uuid;
begin
  if char_length(v_digitos) < 8 or char_length(v_digitos) > 15 then
    raise exception using
      errcode = '22023',
      message = 'El teléfono debe tener entre 8 y 15 dígitos';
  end if;

  insert into public.customers (phone) values (v_digitos)
  on conflict (phone) do nothing;

  -- ⚠️ En un UPDATE, las columnas de la derecha son las de ANTES: por eso
  -- `blocked_kind = 'insultos'` pregunta cómo estaba, no cómo queda.
  update public.customers
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then nullif(btrim(coalesce(p_reason, '')), '') else null end,
         -- El del superadmin es permanente: lo levanta él.
         blocked_until = null,
         blocked_kind = case when p_blocked then 'manual' else null end,
         -- Levantar a mano un bloqueo por INSULTOS deja el aviso pendiente.
         unblock_notice_pending = case
           when p_blocked then false
           when blocked_at is not null and blocked_kind = 'insultos' then true
           else unblock_notice_pending
         end
   where phone = v_digitos
   returning id into v_id;

  return jsonb_build_object('phone', v_digitos, 'blocked', p_blocked, 'customer_id', v_id);
end;
$$;

revoke all on function public.set_platform_blocked(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.set_platform_blocked(text, boolean, text)
  to service_role;

-- ── 4. Un insulto: advertencia, o bloqueo ──────────────────────────────────
--
-- Devuelve `accion`: 'advertido' la primera vez, 'bloqueado' (con `hasta`) la
-- siguiente, 'ya_bloqueado' si ya lo estaba. Todo en la MISMA fila bloqueada
-- (`for update`): dos insultos a la vez no pueden dar dos advertencias.
create or replace function public.register_insult(
  p_customer_id uuid,
  p_dias integer default 15
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila public.customers%rowtype;
  v_hasta timestamptz;
begin
  if p_customer_id is null then
    return jsonb_build_object('accion', 'nada');
  end if;

  select * into v_fila from public.customers where id = p_customer_id for update;
  if not found then
    return jsonb_build_object('accion', 'nada');
  end if;

  if v_fila.blocked_at is not null
     and (v_fila.blocked_until is null or v_fila.blocked_until > now()) then
    return jsonb_build_object('accion', 'ya_bloqueado', 'hasta', v_fila.blocked_until);
  end if;

  if v_fila.insult_warned_at is null then
    update public.customers
       set insult_warned_at = now(), updated_at = now()
     where id = p_customer_id;
    return jsonb_build_object('accion', 'advertido');
  end if;

  v_hasta := now() + make_interval(days => greatest(1, least(coalesce(p_dias, 15), 365)));
  update public.customers
     set blocked_at = now(),
         blocked_until = v_hasta,
         blocked_kind = 'insultos',
         blocked_reason = 'Insultos en el chat',
         unblock_notice_pending = false,
         updated_at = now()
   where id = p_customer_id;
  return jsonb_build_object('accion', 'bloqueado', 'hasta', v_hasta);
end;
$$;

revoke all on function public.register_insult(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.register_insult(uuid, integer)
  to service_role;

-- ── 5. ¿Está bloqueado? Y si le toca, el aviso de vuelta ───────────────────
--
-- Lo pregunta cada mensaje del marketplace. Devuelve `bloqueado` y, cuando le
-- toca, `avisar_desbloqueo`: su bloqueo por insultos caducó (y aquí mismo se
-- limpia) o el superadmin lo levantó. El aviso se RECLAMA en la misma
-- consulta, así que sale una sola vez aunque lleguen dos mensajes seguidos.
--
-- ⚠️ Primero se mira SIN bloquear la fila: es el camino de casi todos los
-- mensajes, y la inmensa mayoría no tiene nada que cambiar.
create or replace function public.claim_platform_block_state(
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_at timestamptz;
  v_hasta timestamptz;
  v_tipo text;
  v_pendiente boolean;
begin
  if p_customer_id is null then
    return jsonb_build_object('bloqueado', false);
  end if;

  select blocked_at, blocked_until, blocked_kind, unblock_notice_pending
    into v_at, v_hasta, v_tipo, v_pendiente
    from public.customers where id = p_customer_id;

  if v_at is null and not coalesce(v_pendiente, false) then
    return jsonb_build_object('bloqueado', false);
  end if;
  if v_at is not null and (v_hasta is null or v_hasta > now()) then
    return jsonb_build_object('bloqueado', true, 'tipo', v_tipo, 'hasta', v_hasta);
  end if;

  -- Hay algo que cambiar: ahora sí, con la fila bloqueada, y se vuelve a mirar
  -- por si otro mensaje se adelantó.
  select blocked_at, blocked_until, blocked_kind, unblock_notice_pending
    into v_at, v_hasta, v_tipo, v_pendiente
    from public.customers where id = p_customer_id for update;

  if v_at is not null and v_hasta is not null and v_hasta <= now() then
    update public.customers
       set blocked_at = null, blocked_until = null, blocked_kind = null,
           blocked_reason = null, unblock_notice_pending = false, updated_at = now()
     where id = p_customer_id;
    return jsonb_build_object('bloqueado', false, 'avisar_desbloqueo', v_tipo = 'insultos');
  end if;
  if v_at is null and v_pendiente then
    update public.customers
       set unblock_notice_pending = false, updated_at = now()
     where id = p_customer_id;
    return jsonb_build_object('bloqueado', false, 'avisar_desbloqueo', true);
  end if;
  return jsonb_build_object(
    'bloqueado', v_at is not null and (v_hasta is null or v_hasta > now()),
    'tipo', v_tipo, 'hasta', v_hasta
  );
end;
$$;

revoke all on function public.claim_platform_block_state(uuid)
  from public, anon, authenticated;
grant execute on function public.claim_platform_block_state(uuid)
  to service_role;


-- ══════════════════════════════════════════════════════════════════
-- MÍNIMO DE COMPRA Y TOPE DE PEDIDOS POR HORA (2026-08-26)
--
-- El freno del 2026-08-25 cuenta pedidos POR CLIENTE. No cubre a cuarenta
-- personas distintas pidiendo una gaseosa cada una: ninguna pasa de tres, y a
-- la cocina le entran cuarenta comandas de $1,50 a la vez.
--
-- ⚠️ AL FINAL, como los frenos anteriores: los índices parciales filtran por
-- `orders.source`, columna que añade un `alter table` muy posterior.
-- ══════════════════════════════════════════════════════════════════

alter table public.businesses
  -- 0 = sin mínimo, y es un cero natural, no un valor mágico.
  add column if not exists min_order_amount numeric(10,2) not null default 0,
  -- Sin «sin límite» a propósito: un campo que se puede dejar en infinito se
  -- queda en infinito, y entonces no protege a nadie. Quien necesite más, sube
  -- el número — está en su panel.
  add column if not exists max_orders_per_hour integer not null default 30;

alter table public.businesses
  drop constraint if exists businesses_frenos_check;
alter table public.businesses
  add constraint businesses_frenos_check check (
    min_order_amount >= 0 and min_order_amount <= 999
    and max_orders_per_hour >= 1 and max_orders_per_hour <= 500
  );


-- ── El mínimo de compra ────────────────────────────────────────────────────
--
-- ⚠️ Disparador, no dentro de `create_storefront_order`: la misma regla que ya
-- siguieron `orders_reject_blocked`, `orders_stamp_pricing` y
-- `orders_limit_open_per_customer`. La función del dinero no se recrea por un
-- añadido, y así cubre todos los caminos que creen pedidos.
--
-- ⚠️ `before insert` y DESPUÉS de que el importe esté puesto. `orders_stamp_pricing`
-- sella el margen en otro disparador `before insert`; PostgreSQL los ejecuta en
-- orden alfabético del nombre, y `orders_min_amount` va después de
-- `orders_limit_open_per_customer` y antes de `orders_reject_*`. Ninguno
-- depende del otro: este solo lee `new.subtotal`, que ya viene de la RPC.
create or replace function public.orders_enforce_min_amount()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_minimo numeric(10,2);
  v_base numeric(10,2);
begin
  -- Mostrador exento, igual que en los demás frenos: lo teclea el dueño con la
  -- persona delante, y si quiere venderle un chicle es su decisión.
  if coalesce(new.source, '') <> 'storefront' then
    return new;
  end if;

  select min_order_amount into v_minimo
  from public.businesses where id = new.business_id;

  if coalesce(v_minimo, 0) <= 0 then
    return new;
  end if;

  -- Sin el envío: lo que el local decide es cuánto vale la pena COCINAR.
  v_base := coalesce(new.subtotal, 0) - coalesce(new.discount, 0);

  if v_base < v_minimo then
    raise exception using
      errcode = '42501',
      message = format(
        'El pedido mínimo de este local es $%s y tu pedido suma $%s. Agrega algo más para completarlo.',
        to_char(v_minimo, 'FM999999990.00'),
        to_char(v_base, 'FM999999990.00')
      );
  end if;

  return new;
end;
$$;

drop trigger if exists orders_enforce_min_amount on public.orders;
create trigger orders_enforce_min_amount
  before insert on public.orders
  for each row execute function public.orders_enforce_min_amount();


-- ── El tope de pedidos por hora ────────────────────────────────────────────
--
-- ⚠️ Protege al LOCAL, no a la plataforma, y el texto lo dice: quien se topa
-- con esto es un cliente legítimo al que el local no puede atender ahora
-- mismo. Decirle «vuelve en unos minutos» es la verdad; decirle «error» sería
-- echarle a él la culpa de que el local esté lleno.
--
-- ⚠️ Cuenta TODOS los pedidos de la tienda de la última hora, en cualquier
-- estado. Un pedido cancelado también ocupó a alguien, y contarlos solo
-- «abiertos» dejaría el freno inútil justo cuando el dueño va cancelando la
-- avalancha a mano.
create or replace function public.orders_limit_per_hour()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tope integer;
  v_ultima_hora integer;
begin
  if coalesce(new.source, '') <> 'storefront' then
    return new;
  end if;

  select max_orders_per_hour into v_tope
  from public.businesses where id = new.business_id;

  -- Falla ABIERTO: un negocio sin el campo puesto —una fila de antes de esta
  -- migración, un `update` a mano— vende como siempre. Un problema de
  -- configuración no puede dejar a un local sin poder recibir pedidos.
  if v_tope is null or v_tope <= 0 then
    return new;
  end if;

  select count(*) into v_ultima_hora
  from public.orders as previo
  where previo.business_id = new.business_id
    and previo.source = 'storefront'
    and previo.created_at > now() - interval '1 hour';

  if v_ultima_hora >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Este local está recibiendo muchos pedidos ahora mismo. Intenta de nuevo en unos minutos.';
  end if;

  return new;
end;
$$;

drop trigger if exists orders_limit_per_hour on public.orders;
create trigger orders_limit_per_hour
  before insert on public.orders
  for each row execute function public.orders_limit_per_hour();

-- El disparador cuenta por (negocio, fecha) sobre los de la tienda. El índice
-- de `orders_limit_open_per_customer` empieza por (business_id, customer_id),
-- así que no sirve para contar sin cliente.
create index if not exists idx_orders_por_hora
  on public.orders (business_id, created_at)
  where source = 'storefront';

-- ── Pedir suelta el techo de respuestas del marketplace ───────────────────
--
-- `claim_marketplace_reply` cuenta 25 respuestas por hora, y armar un pedido
-- DENTRO del chat son 15-25 mensajes: quien pide dos veces en la misma hora se
-- comía el techo entero y quedaba mudo 12 h. Se suelta al CREAR el pedido, que
-- es el único momento en que el cliente demuestra con hechos que no es quien
-- molesta — el mismo criterio con el que ya se suelta `shopping_locked`.
--
-- ⚠️ NO levanta un silencio ya activo: si bastara con pedir para recuperar la
-- voz, el silenciado haría un pedido falso. Solo evita ACUMULAR mientras compra.
-- ⚠️ AFTER insert y falla ABIERTO: el pedido ya está en la cocina.
-- ⚠️ Solo `storefront`: el de mostrador lo teclea el dueño
-- (migration-2026-08-27-techo-y-aviso-de-bloqueo.sql).
create or replace function public.orders_reset_marketplace_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  update public.marketplace_conversations
     set reply_count = 0,
         reply_window_start = null,
         updated_at = now()
   where customer_id = new.customer_id
     and coalesce(reply_count, 0) > 0;

  return new;
exception when others then
  return new;
end;
$$;

drop trigger if exists orders_reset_marketplace_reply on public.orders;
create trigger orders_reset_marketplace_reply
  after insert on public.orders
  for each row execute function public.orders_reset_marketplace_reply();

-- ── Al bloqueado se le explica UNA vez ────────────────────────────────────
--
-- Antes no se le decía nunca: quien molesta busca una reacción y cada aviso
-- cuesta el mensaje que el bloqueo ahorra. Pero callando siempre, el cliente
-- bloqueado por no recoger sus pedidos no se entera de qué hizo mal. El punto
-- medio es el RECLAMO: se explica en su primer intento y a partir del segundo
-- vuelve el mensaje neutro, así el bloqueado nunca cuesta más que un cliente
-- normal.
--
-- ⚠️ El reclamo va DENTRO del `update`: entre un `select` previo y la
-- escritura caben dos mensajes del mismo cliente, y el aviso saldría dos veces
-- (migration-2026-08-27-techo-y-aviso-de-bloqueo.sql).
create or replace function public.claim_blocked_notice(
  p_business_id uuid,
  p_customer_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reclamado boolean;
begin
  if p_business_id is null or p_customer_id is null then
    return false;
  end if;

  update public.business_customers
     set blocked_notified_at = now(),
         updated_at = now()
   where business_id = p_business_id
     and customer_id = p_customer_id
     and blocked_at is not null
     and blocked_notified_at is null
  returning true into v_reclamado;

  return coalesce(v_reclamado, false);
end;
$$;

revoke all on function public.claim_blocked_notice(uuid, uuid) from public;
grant execute on function public.claim_blocked_notice(uuid, uuid) to service_role;

-- ═══════════════════════════════════════════════════════════════════════════
-- EL PEDIDO SIN PAGAR CADUCA SOLO (2026-08-28)
--
-- 20 de las 40 cancelaciones de producción murieron en `esperando_pago`: gente
-- que pidió y nunca mandó el comprobante, y que el dueño cancelaba a mano.
-- `expirado` existía en las restricciones desde el 2026-08-05 y nadie lo
-- escribía nunca.
--
-- ⚠️ Rompe a propósito la invariante «no hay tarea que expire pedidos». Los
-- frenos que la sustituyen: tope por tanda, ventana superior de 24 h para no
-- barrer el histórico, interruptor por negocio, y que el aviso SUSTITUYE al de
-- la cancelación manual en vez de añadirse. Ver la migración.
--
-- ⚠️ NUNCA expira `pago_en_revision`: ahí el cliente ya pagó.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── Cuánto espera cada local su comprobante ─────────────────────────────────
--
-- Lo pone el DUEÑO: dos horas sobran en una pizzería y se quedan cortas en un
-- local que reparte al día siguiente. Nace en 120 minutos.
--
-- ⚠️ Aquí el 0 SÍ vale como «no expirar nunca», al revés que
-- `max_orders_per_hour`. Ese freno protege al local de una avalancha y por eso
-- no admite infinito; este CANCELA pedidos, que es una decisión de dinero del
-- dueño — y quien cobra contra entrega o coordina por teléfono tiene motivos
-- legítimos para no querer que nada caduque.
alter table public.businesses
  add column if not exists payment_window_minutes integer not null default 120;

alter table public.businesses
  drop constraint if exists businesses_payment_window_check;
alter table public.businesses
  add constraint businesses_payment_window_check
  check (payment_window_minutes = 0
         or (payment_window_minutes >= 15 and payment_window_minutes <= 1440));

comment on column public.businesses.payment_window_minutes is
  'Minutos que el local espera el comprobante antes de expirar el pedido. 0 = no expira nunca.';

-- ── El barrido ──────────────────────────────────────────────────────────────
--
-- Devuelve lo que expiró para que el servidor mande los avisos. No los manda
-- él: la base no habla WhatsApp, y mezclarlo dejaría el envío dentro de una
-- transacción que puede tardar.
create or replace function public.expire_unpaid_orders(
  p_limite integer default 20
)
returns table (
  order_id uuid,
  business_id uuid,
  order_number integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila record;
  v_hechos integer := 0;
begin
  for v_fila in
    select o.id, o.business_id, o.order_number
    from public.orders o
    join public.businesses b on b.id = o.business_id
    where o.status = 'esperando_pago'
      and coalesce(o.source, '') = 'storefront'
      -- Mandó su comprobante: eso ya no es un pedido sin pagar, aunque el
      -- estado no haya avanzado todavía.
      and o.payment_proof_url is null
      and b.payment_window_minutes > 0
      and o.created_at < now() - make_interval(mins => b.payment_window_minutes)
      -- ⚠️ La ventana superior. Lo más viejo se queda como está: es histórico
      -- que el dueño ya gestionó o abandonó, y barrerlo de golpe es justo lo
      -- que la nota de `order-notify.ts` temía.
      and o.created_at > now() - interval '24 hours'
    order by o.created_at
    limit greatest(1, least(coalesce(p_limite, 20), 100))
  loop
    -- Si otro proceso lo movió entre el select y aquí, `set_order_status`
    -- rechaza la transición y este pedido se salta sin romper la tanda.
    begin
      perform public.set_order_status(v_fila.business_id, v_fila.id, 'expirado');
      order_id := v_fila.id;
      business_id := v_fila.business_id;
      order_number := v_fila.order_number;
      v_hechos := v_hechos + 1;
      return next;
    exception when others then
      -- Un pedido que no se pudo expirar no puede tumbar la tanda entera.
      null;
    end;
  end loop;

  return;
end;
$$;

revoke all on function public.expire_unpaid_orders(integer) from public;
grant execute on function public.expire_unpaid_orders(integer) to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- QUÉ MARGEN PINTAR EN EL CATÁLOGO
-- Migración incremental: migration-2026-08-29-margen-sobre-el-precio.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- El catálogo tiene que enseñar el precio que el cliente va a pagar, y para eso
-- necesita el porcentaje vigente ANTES de que exista un pedido. Se devuelve la
-- regla entera —no un número suelto— para que el servidor aplique la MISMA
-- jerarquía (negocio → tipo → global) sin reimplementarla.
--
-- ⚠️ Devuelve `null` si no hay regla vigente: entonces no se pinta margen y el
-- cliente ve el precio del comercio. Falla hacia NO cobrar de más, que es el
-- lado seguro del error.
create or replace function public.business_pricing_view(
  p_business_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_regla public.pricing_rules%rowtype;
begin
  if p_business_id is null then
    return null;
  end if;

  select pr.* into v_regla
  from public.pricing_rules pr
  join public.businesses b on b.id = p_business_id
  where pr.status = 'active'
    and pr.effective_from <= now()
    and (pr.effective_until is null or pr.effective_until > now())
    and (
      (pr.scope = 'business'      and pr.business_id = p_business_id)
      or (pr.scope = 'business_type' and pr.target_name = b.type)
      or (pr.scope = 'global')
    )
  order by case pr.scope
             when 'business'      then 1
             when 'business_type' then 2
             when 'global'        then 3
           end,
           pr.effective_from desc
  limit 1;

  if v_regla.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'rule_id',      v_regla.id,
    'version',      v_regla.version,
    'mode',         v_regla.markup_mode,
    'strategy',     v_regla.strategy,
    'percentage',   v_regla.percentage,
    'fixed_amount', v_regla.fixed_amount,
    'tiers',        v_regla.tiers,
    'min_amount',   v_regla.min_amount,
    'max_amount',   v_regla.max_amount
  );
end;
$$;

revoke all on function public.business_pricing_view(uuid) from public, anon, authenticated;
grant execute on function public.business_pricing_view(uuid) to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- QUIEN PIDE TRES VECES Y NUNCA PAGA, DEJA DE PODER PEDIR EN ESE LOCAL
-- Migración incremental: migration-2026-08-31-tres-avisos-y-bloqueo.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- El 2026-08-28 un mismo teléfono dejó SEIS pedidos sin pagar en Monster
-- Pizza (#62 a #68). Ninguno era fraude sofisticado: pedía, no transfería, el
-- pedido caducaba, el candado se soltaba y volvía a pedir. El local preparaba
-- expectativas y liberaba stock una y otra vez.
--
-- El freno que faltaba no es impedir pedir —eso ya lo hace el candado de «un
-- pedido a la vez»—, es que ABANDONAR tenga consecuencia.
--
-- ⚠️ Se cuenta por CLIENTE y NEGOCIO, no global: quien abandona en una
-- pizzería puede ser un cliente impecable en la heladería de al lado, y
-- castigarlo en toda la plataforma por lo que hizo en un local sería un
-- bloqueo que él no puede ni entender ni resolver. `business_customers` ya es
-- la fila por (negocio, cliente), así que el contador vive ahí.
--
-- ⚠️ Y NO se toca `expire_unpaid_orders`. Esa función barre y devuelve lo que
-- expiró; quien registra la falta es el servidor, en el mismo bucle donde ya
-- manda el aviso. Cambiarle la firma de retorno para colar un dato obligaría a
-- recrearla entera, que es justo lo que este proyecto evita con las funciones
-- que ya funcionan.

-- ── 1. El contador de pedidos abandonados ──────────────────────────────────
alter table public.business_customers
  add column if not exists unpaid_expiries integer not null default 0;

comment on column public.business_customers.unpaid_expiries is
  'Pedidos que este cliente dejó caducar sin comprobante EN ESTE NEGOCIO. Al tercero se bloquea solo. No se reinicia al bloquear: el dueño lo desbloquea a mano y el historial se conserva.';

-- ── 2. Registrar la falta, y bloquear al tercero ───────────────────────────
--
-- Devuelve `{strikes, blocked, limit}` para que el aviso pueda decir la
-- verdad: cuántas van, y si esta fue la última.
--
-- ⚠️ El incremento y el bloqueo van en UNA sentencia. Comprobar primero y
-- actualizar después deja una carrera en la que dos barridos simultáneos leen
-- el mismo 2 y ninguno bloquea. Es el mismo patrón que `last_order_number`.
--
-- ⚠️ `blocked_at` solo se pone si estaba en nulo: si el dueño ya lo había
-- bloqueado a mano, la fecha es la SUYA y no se pisa.
create or replace function public.register_unpaid_expiry(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite  constant integer := 3;
  v_cliente uuid;
  v_fila    record;
begin
  -- El cliente sale del PEDIDO, no de un parámetro: así no hay forma de sumarle
  -- una falta a un tercero, y el negocio se comprueba en la misma consulta.
  select customer_id into v_cliente
  from public.orders
  where id = p_order_id
    and business_id = p_business_id;

  -- Un pedido del bot o de mostrador puede no tener cliente asociado. Sin
  -- cliente no hay a quién contarle nada, y eso no es un error.
  if v_cliente is null then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  update public.business_customers
  set unpaid_expiries = unpaid_expiries + 1,
      blocked_at = case
        when blocked_at is not null then blocked_at
        when unpaid_expiries + 1 >= v_limite then now()
        else null
      end,
      updated_at = now()
  where business_id = p_business_id
    and customer_id = v_cliente
  returning unpaid_expiries, blocked_at into v_fila;

  if not found then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  return jsonb_build_object(
    'strikes', v_fila.unpaid_expiries,
    'blocked', v_fila.blocked_at is not null,
    'limit', v_limite
  );
end;
$$;

revoke all on function public.register_unpaid_expiry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_unpaid_expiry(uuid, uuid) to service_role;

-- ── 3. La ventana de pago baja de 120 minutos a 15 ─────────────────────────
--
-- Dos horas es tiempo de sobra para transferir, y mientras tanto el pedido
-- ocupa el candado del cliente y la cabeza del dueño. Medido contra lo que
-- tarda de verdad una transferencia —abrir el banco, buscar la cuenta, el
-- código de un solo uso, volver y mandar la foto— son unos 8 minutos: 15 deja
-- margen sin premiar al que nunca pensó pagar.
--
-- ⚠️ Solo se mueve a quien tenía el valor por defecto. Un dueño que lo haya
-- ajustado a mano decidió su número, y esta migración no es quién para pisarlo.
alter table public.businesses
  alter column payment_window_minutes set default 15;


-- ════════════════════════════════════════════════════════════════════════
-- EL BLOQUEO AHORA CADUCA SOLO
-- Migración incremental: migration-2026-09-01-bloqueo-que-caduca.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Hasta hoy `blocked_at` era para siempre: lo ponía el sistema o el dueño, y
-- solo el dueño lo levantaba. Por eso el aviso al cliente bloqueado NUNCA
-- prometía un plazo — prometer una espera que nadie va a cumplir es cómo nació
-- el fallo del número del 2026-08-23.
--
-- El dueño lo pidió temporal el 2026-08-31: quien deja pedidos sin pagar o
-- manda comprobantes que no lo son se queda fuera de ESE local un rato, y
-- vuelve solo. Con plazo real, el mensaje ya puede decirlo.
--
-- ⚠️ `blocked_at` NO se retira ni cambia de significado. Sigue siendo «desde
-- cuándo está bloqueado», y es lo que el dueño pone a mano cuando quiere un
-- bloqueo definitivo. Lo que se añade es HASTA cuándo:
--
--   · `blocked_until` NULO + `blocked_at` puesto  → bloqueo permanente (el del
--     dueño, el de siempre). No cambia nada para quien ya lo tenía.
--   · `blocked_until` con fecha                   → bloqueo temporal: caduca
--     solo, sin que nadie lo levante.
--
-- Distinguirlos importa: si el temporal reutilizara `blocked_at` a secas, al
-- caducar habría que borrarlo y se perdería el historial de que ese cliente ya
-- estuvo bloqueado una vez.

-- ── 1. Hasta cuándo ────────────────────────────────────────────────────────
alter table public.business_customers
  add column if not exists blocked_until timestamptz;

comment on column public.business_customers.blocked_until is
  'Fin de un bloqueo TEMPORAL. Nulo con blocked_at puesto = bloqueo permanente del dueño. Al pasar la fecha el cliente vuelve solo, sin que nadie lo levante.';

-- El índice de bloqueados mira ahora las dos formas.
create index if not exists business_customers_blocked_until_idx
  on public.business_customers (business_id, blocked_until)
  where blocked_until is not null;

-- ── 2. Cuánto dura, por local ──────────────────────────────────────────────
--
-- ⚠️ Configurable y no fijo: los 2 minutos que el dueño quería para probar no
-- frenan a nadie de verdad, y 24 h castigan a quien mandó una foto borrosa.
-- 30 es el punto donde el que abusa pierde el impulso y el cliente honesto
-- vuelve a cenar esa misma noche.
alter table public.businesses
  add column if not exists block_minutes integer not null default 30;

alter table public.businesses
  drop constraint if exists businesses_block_minutes_check;
alter table public.businesses
  add constraint businesses_block_minutes_check
  check (block_minutes between 1 and 10080);

comment on column public.businesses.block_minutes is
  'Cuánto dura un bloqueo temporal en este local, en minutos (1 min a 7 días). Lo ajusta el dueño en Ajustes.';

-- ── EL PUNTO DEL LOCAL EN EL MAPA ──────────────────────────────────────────
-- migration-2026-09-10-ubicacion-del-local.sql. `address` es TEXTO: sirve para
-- leerlo, no para llegar — y en Ecuador media ciudad se ubica con «frente a
-- Portocentro», que ningún geocoder resuelve. El sistema tenía el punto de UNA
-- sola punta del reparto: el del CLIENTE (lo capturan la mini app y el chat, y
-- el pedido lo congela en `delivery_latitude`/`delivery_longitude`). El del
-- LOCAL no existía, así que no se podía decir a dónde ir a retirar ni dar un
-- punto de recogida a un repartidor.
--
-- ⚠️ Mismo tipo y mismo CHECK que `customer_addresses`, no otro: dos formas de
-- guardar una coordenada en la misma base acaban redondeando distinto.
-- ⚠️ Las DOS o NINGUNA: media coordenada apunta al ecuador, no a medias.
alter table public.businesses
  add column if not exists latitude  numeric(10,7),
  add column if not exists longitude numeric(10,7);

comment on column public.businesses.latitude is
  'Latitud del local. Con `longitude`, el punto de RECOGIDA de un pedido: lo usa quien retira y lo usará la app del repartidor.';
comment on column public.businesses.longitude is
  'Longitud del local. Va siempre junto a `latitude` (las dos o ninguna).';

-- ── EL AVISO DE PEDIDO NUEVO AL WHATSAPP DEL DUEÑO ─────────────────────────
-- migration-2026-09-10-aviso-al-dueno.sql. NACE APAGADO: el dueño ya se entera
-- por la alarma del panel, que es gratis, y encender esto son DOS mensajes
-- pagados por pedido (resumen + mapa del cliente) desde el 1 de octubre de
-- 2026. Un interruptor que nace encendido convierte una mejora en una factura
-- que nadie decidió. Es POR LOCAL porque un almuercería con dos pedidos al día
-- lo quiere y una pizzería con cincuenta, seguramente no.
alter table public.businesses
  add column if not exists notify_owner_whatsapp boolean not null default false;

comment on column public.businesses.notify_owner_whatsapp is
  'Si el dueño recibe por WhatsApp el aviso de pedido nuevo (resumen + ubicación del cliente). APAGADO por defecto: son dos mensajes pagados por pedido, y la alarma del panel ya avisa gratis.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.businesses'::regclass
      and conname = 'businesses_ubicacion_check'
  ) then
    alter table public.businesses add constraint businesses_ubicacion_check check (
      (latitude is null or latitude between -90 and 90)
      and (longitude is null or longitude between -180 and 180)
      and ((latitude is null) = (longitude is null))
    );
  end if;
end $$;

-- ── LA ÚNICA RESPUESTA A «¿ESTÁ BLOQUEADO?» ────────────────────────────────
-- migration-2026-08-29-un-solo-bloqueo.sql. Había DOS reglas —el chat miraba
-- `blocked_at` a secas, la base miraba la regla completa— y con un bloqueo
-- temporal ya vencido se contradecían: el chat negaba el local y el disparador
-- dejaba insertar el pedido. Por esa grieta entró el pedido #74 el 2026-08-29.
--
-- ⚠️ Devuelve el ESTADO y no un booleano porque las pantallas tienen que decir
-- hasta cuándo: «no puedes pedir» sin plazo es lo que hace que la gente
-- escriba al local. El permanente no lleva plazo a propósito — prometer uno
-- que no se cumple es cómo nació el fallo del número del 2026-08-23.
create or replace function public.storefront_customer_block_state(
  p_business_id uuid,
  p_customer_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select jsonb_build_object(
        'blocked',    (bc.blocked_at is not null and bc.blocked_until is null)
                   or (bc.blocked_until is not null and bc.blocked_until > now()),
        'permanent',  bc.blocked_at is not null and bc.blocked_until is null,
        'until',      case
                        when bc.blocked_until is not null and bc.blocked_until > now()
                        then bc.blocked_until
                      end
      )
      from public.business_customers as bc
      where bc.business_id = p_business_id
        and bc.customer_id = p_customer_id
    ),
    jsonb_build_object('blocked', false, 'permanent', false, 'until', null)
  );
$$;

comment on function public.storefront_customer_block_state(uuid, uuid) is
  'La ÚNICA respuesta a «¿está bloqueado?». El chat, la mini app y el '
  'disparador de pedidos la comparten para no poder contradecirse.';

revoke all on function public.storefront_customer_block_state(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_block_state(uuid, uuid)
  to service_role;

-- ── 3. Quién está bloqueado AHORA ──────────────────────────────────────────
--
-- ⚠️ Se recrea la función que ya usaban el disparador y la ruta, en vez de
-- añadir otra: dos funciones que responden a la misma pregunta acaban
-- contestando distinto, y esta decide si un cliente puede comprar.
create or replace function public.storefront_customer_blocked(
  p_business_id uuid,
  p_customer_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (public.storefront_customer_block_state(p_business_id, p_customer_id) ->> 'blocked')::boolean,
    false
  );
$$;

revoke all on function public.storefront_customer_blocked(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.storefront_customer_blocked(uuid, uuid)
  to service_role;

-- ── LOS BLOQUEADOS QUE VE EL DUEÑO EN SU PANEL ────────────────────────────
-- migration-2026-08-29-el-panel-y-los-botones.sql. El panel listaba
-- `blocked_at is not null` a secas, y el bloqueo temporal también pone
-- `blocked_at`: a los 30 minutos el cliente ya podía pedir y el panel seguía
-- diciendo «Bloqueado» para siempre. Cuarta copia de la regla en aparecer.
--
-- ⚠️ Llama a `storefront_customer_block_state` fila por fila en vez de repetir
-- la condición: no se sincronizan cuatro reglas, se deja una.
create or replace function public.business_blocked_contacts(
  p_business_id uuid
)
returns table (
  phone     text,
  until     timestamptz,
  permanent boolean
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    c.phone,
    -- Del ESTADO, no de la columna: un `blocked_until` vencido no es un plazo.
    nullif(estado.value ->> 'until', '')::timestamptz as until,
    (estado.value ->> 'permanent')::boolean           as permanent
  from public.business_customers as bc
  join public.customers as c on c.id = bc.customer_id
  cross join lateral (
    select public.storefront_customer_block_state(bc.business_id, bc.customer_id) as value
  ) as estado
  where bc.business_id = p_business_id
    and (estado.value ->> 'blocked')::boolean
  order by c.phone;
$$;

comment on function public.business_blocked_contacts(uuid) is
  'Los contactos bloqueados AHORA de un negocio, con su plazo. Usa la misma '
  'regla que el disparador de pedidos: un temporal cumplido desaparece solo.';

revoke all on function public.business_blocked_contacts(uuid)
  from public, anon, authenticated;
grant execute on function public.business_blocked_contacts(uuid) to service_role;

-- ── 4. Bloquear un rato, y decir hasta cuándo ──────────────────────────────
--
-- Devuelve `{blocked_until, minutes}` para que el aviso pueda prometer el
-- plazo — ahora sí, porque el plazo se cumple solo.
--
-- ⚠️ Un bloqueo temporal NO pisa uno permanente. Si el dueño ya lo echó a
-- mano, un rechazo automático no puede convertir su decisión en 30 minutos.
create or replace function public.block_customer_temporarily(
  p_business_id uuid,
  p_customer_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_minutos integer;
  v_hasta   timestamptz;
  v_permanente boolean;
begin
  select coalesce(block_minutes, 30) into v_minutos
  from public.businesses where id = p_business_id;

  if v_minutos is null then
    return jsonb_build_object('blocked_until', null, 'minutes', null);
  end if;

  select (blocked_at is not null and blocked_until is null) into v_permanente
  from public.business_customers
  where business_id = p_business_id and customer_id = p_customer_id;

  if coalesce(v_permanente, false) then
    return jsonb_build_object('blocked_until', null, 'minutes', null, 'permanente', true);
  end if;

  v_hasta := now() + make_interval(mins => v_minutos);

  update public.business_customers
  set blocked_at = coalesce(blocked_at, now()),
      blocked_until = v_hasta,
      -- Se vuelve a poder avisar: es un bloqueo NUEVO, y el cliente tiene que
      -- enterarse de este aunque ya se le explicara uno anterior.
      blocked_notified_at = null,
      notes = case
        when p_motivo is null then notes
        else trim(both from coalesce(notes, '') || ' · ' || p_motivo)
      end,
      updated_at = now()
  where business_id = p_business_id and customer_id = p_customer_id;

  if not found then
    return jsonb_build_object('blocked_until', null, 'minutes', null);
  end if;

  return jsonb_build_object(
    'blocked_until', v_hasta,
    'minutes', v_minutos
  );
end;
$$;

revoke all on function public.block_customer_temporarily(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.block_customer_temporarily(uuid, uuid, text)
  to service_role;

-- ── 5. Dos pedidos sin pagar, no tres ──────────────────────────────────────
--
-- Decisión del dueño el 2026-08-31, después de ver que un mismo teléfono dejó
-- SEIS pedidos sin pagar en un día. Y el bloqueo pasa a ser TEMPORAL: al
-- segundo abandono se cierra el local un rato, no para siempre.
create or replace function public.register_unpaid_expiry(
  p_business_id uuid,
  p_order_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite  constant integer := 2;
  v_cliente uuid;
  v_faltas  integer;
  v_bloqueo jsonb;
begin
  select customer_id into v_cliente
  from public.orders
  where id = p_order_id and business_id = p_business_id;

  if v_cliente is null then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  update public.business_customers
  set unpaid_expiries = unpaid_expiries + 1,
      updated_at = now()
  where business_id = p_business_id and customer_id = v_cliente
  returning unpaid_expiries into v_faltas;

  if not found then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  if v_faltas < v_limite then
    return jsonb_build_object('strikes', v_faltas, 'blocked', false, 'limit', v_limite);
  end if;

  v_bloqueo := public.block_customer_temporarily(
    p_business_id, v_cliente, 'pedidos sin pagar'
  );

  return jsonb_build_object(
    'strikes', v_faltas,
    'blocked', true,
    'limit', v_limite,
    'blocked_until', v_bloqueo -> 'blocked_until',
    'minutes', v_bloqueo -> 'minutes'
  );
end;
$$;

revoke all on function public.register_unpaid_expiry(uuid, uuid) from public, anon, authenticated;
grant execute on function public.register_unpaid_expiry(uuid, uuid) to service_role;

-- ── 6. Los comprobantes que NO son comprobantes también cuentan ────────────
--
-- La compuerta ya rechazaba la foto de un perro y le pedía al cliente la
-- captura buena. Lo que faltaba es que insistir tuviera consecuencia: quien
-- manda dos seguidas está probando, no equivocándose.
--
-- ⚠️ Se cuenta por CLIENTE y NEGOCIO, igual que los pedidos sin pagar, y por
-- el mismo motivo: el local sale del PEDIDO que espera pago, nunca del número
-- por el que llegó la foto.
alter table public.business_customers
  add column if not exists rejected_receipts integer not null default 0;

comment on column public.business_customers.rejected_receipts is
  'Imágenes seguidas que no eran un comprobante. Se pone a cero en cuanto llega uno bueno: cuenta la INSISTENCIA, no el historial.';

-- ⚠️ Devuelve `{strikes, blocked, limit, minutes}` como su gemela de los
-- pedidos, para que el aviso pueda decir la verdad en los dos casos.
create or replace function public.register_rejected_receipt(
  p_business_id uuid,
  p_customer_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limite  constant integer := 2;
  v_faltas  integer;
  v_bloqueo jsonb;
  v_muertos integer := 0;
begin
  update public.business_customers
  set rejected_receipts = rejected_receipts + 1,
      updated_at = now()
  where business_id = p_business_id and customer_id = p_customer_id
  returning rejected_receipts into v_faltas;

  if not found then
    return jsonb_build_object('strikes', 0, 'blocked', false, 'limit', v_limite);
  end if;

  if v_faltas < v_limite then
    return jsonb_build_object('strikes', v_faltas, 'blocked', false, 'limit', v_limite);
  end if;

  v_bloqueo := public.block_customer_temporarily(
    p_business_id, p_customer_id, 'comprobantes que no lo eran'
  );

  -- ── El pedido muere con el bloqueo ──────────────────────────────────────
  --
  -- ⚠️ Va DESPUÉS de bloquear y en la misma transacción: si el bloqueo falla,
  -- el pedido no se toca. Lo contrario —matar el pedido y no bloquear— dejaría
  -- al cliente sin comanda y con vía libre para abrir otra.
  --
  -- `orders_release_shopping_lock` se encarga del resto: al salir de
  -- `esperando_pago` suelta el candado y el local, así que el siguiente
  -- mensaje de esta persona cae en el menú y ve las categorías. Esa es la
  -- tercera cosa que pedía el dueño, y sale sola de esta.
  with muertos as (
    update public.orders
       set status = 'expirado',
           updated_at = now()
     where business_id = p_business_id
       and customer_id = p_customer_id
       and status = 'esperando_pago'
       and coalesce(source, '') = 'storefront'
       -- Sin comprobante bueno adjunto: si lo hubiera, estaría en
       -- `pago_en_revision` y le tocaría mirarlo al dueño.
       and payment_proof_url is null
       and payment_confirmed_at is null
    returning 1
  )
  select count(*)::integer into v_muertos from muertos;

  return jsonb_build_object(
    'strikes', v_faltas,
    'blocked', true,
    'limit', v_limite,
    'blocked_until', v_bloqueo -> 'blocked_until',
    'minutes', v_bloqueo -> 'minutes',
    -- Cuántas comandas se cerraron. Sirve para decírselo al cliente sin
    -- volver a consultar la base donde se responde.
    'expired', v_muertos
  );
end;
$$;

comment on function public.register_rejected_receipt(uuid, uuid) is
  'Cuenta comprobantes que no lo eran. Al segundo bloquea el local un rato Y '
  'deja EXPIRADOS sus pedidos sin pagar ahí: la comanda no puede sobrevivir a '
  'quien ya no puede pagarla. No cuenta como impago — sería castigar dos veces.';

revoke all on function public.register_rejected_receipt(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.register_rejected_receipt(uuid, uuid) to service_role;

-- ⚠️ Y el contador se PONE A CERO cuando llega uno bueno.
--
-- Cuenta la insistencia, no el historial: quien mandó una foto borrosa, luego
-- la buena, y dentro de tres semanas otra borrosa, no es el que está probando
-- a ver si cuela algo. Sin esto, un cliente fiel acabaría bloqueado por dos
-- despistes separados por meses.
create or replace function public.clear_rejected_receipts(
  p_business_id uuid,
  p_customer_id uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.business_customers
  set rejected_receipts = 0, updated_at = now()
  where business_id = p_business_id
    and customer_id = p_customer_id
    and rejected_receipts > 0;
$$;

revoke all on function public.clear_rejected_receipts(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.clear_rejected_receipts(uuid, uuid) to service_role;


-- ════════════════════════════════════════════════════════════════════════
-- UN SOLO PEDIDO SIN PAGAR A LA VEZ
-- Migración incremental: migration-2026-09-02-un-pedido-sin-pagar.sql
-- ════════════════════════════════════════════════════════════════════════
--
-- Lo encontró el dueño probando, el 2026-09-01, y es el hueco más caro que
-- quedaba: pidió, no pagó, volvió al chat, le dieron un enlace NUEVO y creó
-- otro pedido. El primero se quedó en el limbo hasta caducar.
--
-- Con el tope actual eso se puede hacer TRES veces: el dueño ve tres comandas
-- de la misma persona por un solo pedido real, prepara expectativas y aparta
-- stock para dos que nadie va a pagar.
--
-- ⚠️ Los dos frenos que ya existían NO cubrían este caso, y conviene entender
-- por qué antes de tocarlos:
--
--   · El TOPE (3 abiertos en 6 h) protege la COCINA: cuenta comandas que el
--     dueño no ha mirado. Tres es un número pensado para «no me llenes la
--     bandeja», no para «no debas dinero».
--   · El CANDADO de `esperando_pago` responde «¿esta persona debe algo?», pero
--     solo lo usa el bot para preguntar al escribir MENÚ. Nunca impidió
--     insertar nada.
--
-- Falta la regla que el dueño creía tener: **si debes un comprobante, no
-- puedes encargar otra cosa hasta resolverlo.**
--
-- ⚠️ Se cuenta en TODA LA PLATAFORMA, no por local. Quien debe un comprobante
-- en la pizzería y se va a la heladería a repetir la jugada está haciendo
-- exactamente lo mismo; y el número es único para todo Umbani, así que el
-- local nuevo no tiene forma de saberlo. Es la misma razón por la que el tope
-- ya mira los dos alcances.
--
-- ⚠️ `esperando_pago` y NADA MÁS. En `pago_en_revision` ya mandó su
-- comprobante y en `pendiente` (efectivo) no debe nada: los dos esperan al
-- DUEÑO. Retener ahí sería impedirle pedir porque el local va lento —
-- castigar al cliente por algo que no depende de él. Es la misma frontera que
-- ya eligió `orders_release_shopping_lock`, y las dos tienen que contar la
-- misma historia.
--
-- ⚠️ Solo `source = 'storefront'`. Un pedido de MOSTRADOR lo teclea el dueño
-- con la persona delante.
--
-- ⚠️ Y la VENTANA de 6 horas se mantiene, igual que en el tope: un pedido de
-- anteayer que nadie tocó no puede dejar a alguien sin poder comprar para
-- siempre. Lo normal es que caduque solo mucho antes.
create or replace function public.orders_limit_open_per_customer()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_en_el_local      integer;
  v_en_la_plataforma integer;
  v_sin_pagar        integer;
  v_sin_pagar_tarjeta integer;
  v_tope constant integer := 3;
  v_ventana constant interval := interval '6 hours';
  v_abiertos constant text[] := array['esperando_pago', 'pago_en_revision', 'pendiente'];
begin
  if coalesce(new.source, '') <> 'storefront' or new.customer_id is null then
    return new;
  end if;

  -- Un solo recorrido para los tres alcances: el índice
  -- `idx_orders_abiertos_por_cliente` ya cubre (business_id, customer_id,
  -- status, created_at), y contar tres veces sería pagar tres consultas por
  -- cada pedido nuevo para responder a preguntas que salen de la misma fila.
  select
    count(*) filter (where previo.business_id = new.business_id),
    count(*),
    count(*) filter (where previo.status = 'esperando_pago'),
    count(*) filter (where previo.status = 'esperando_pago' and previo.payment_method = 'tarjeta')
  into v_en_el_local, v_en_la_plataforma, v_sin_pagar, v_sin_pagar_tarjeta
  from public.orders as previo
  where previo.customer_id = new.customer_id
    and previo.source = 'storefront'
    and previo.status = any(v_abiertos)
    and previo.created_at > now() - v_ventana;

  -- ── EL QUE FALTABA, y va PRIMERO ────────────────────────────────────────
  --
  -- Va antes que los otros dos porque es el más específico y el que mejor
  -- explica qué hacer: los topes dicen «tienes varios sin confirmar», que a
  -- quien debe UN comprobante no le dice nada útil.
  --
  -- El texto nombra la salida —mandar el comprobante— y no acusa: la mayoría
  -- de las veces es alguien que se distrajo, no alguien que está probando.
  --
  -- ⚠️ Con TARJETA no hay comprobante (2026-09-30): a quien dejó un pago con
  -- tarjeta a medias se le decía «envía tu comprobante», que no existe. Se le
  -- dan las dos salidas de verdad: pagarlo, o MENÚ, que cancela el pedido sin
  -- pagar (si PayPhone lo aprobara después, no se confirma y lo devuelve solo).
  if v_sin_pagar >= 1 and v_sin_pagar = v_sin_pagar_tarjeta then
    raise exception using
      errcode = '42501',
      message = 'Tienes un pedido esperando su pago con tarjeta. Vuelve a él para pagarlo, '
        || 'o escribe MENÚ en el chat de Umbani para cancelarlo y pedir de nuevo.';
  end if;
  if v_sin_pagar >= 1 then
    raise exception using
      errcode = '42501',
      message = 'Tienes un pedido esperando tu comprobante. Envíalo y podrás hacer otro.';
  end if;

  -- El del LOCAL: cuando los dos se cumplen, su mensaje es el útil —dice dónde
  -- está el problema y por tanto qué hacer—.
  if v_en_el_local >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Ya tienes pedidos sin confirmar en este local. Espera a que los revisen antes de hacer otro.';
  end if;

  -- El de PLATAFORMA. El texto nombra Umbani a propósito: quien llega aquí ha
  -- pedido en varios locales, y decirle «en este local» lo mandaría a mirar el
  -- sitio equivocado.
  if v_en_la_plataforma >= v_tope then
    raise exception using
      errcode = '42501',
      message = 'Tienes varios pedidos sin confirmar en Umbani. Envía el comprobante de los que faltan y podrás pedir de nuevo.';
  end if;

  return new;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- EL PLATO POR PARTES — el almuerzo de una familia
-- Migración incremental: migration-2026-09-14-almuerzo-por-partes.sql
-- ════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- EL PLATO POR PARTES — el almuerzo de una familia


-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pedido del dueño del SaaS (2026-09-14): «un almuerzo vale 3 dólares, y al
-- pedirlo que me salga para elegir qué sopa quiero y qué segundo; si en la
-- familia son más, en ese mismo almuerzo me permita sumar más sopas y más
-- segundos; la suma de una sopa y un segundo es un almuerzo completo, y si
-- alguien pide solo segundo o solo sopa se cobra el plato por su valor
-- individual». Y sobre los precios: «si el dueño pone sopas a 50 centavos es su
-- problema; nosotros respetamos lo que el dueño suba y ponemos solo el
-- porcentaje para ganar».
--
-- Hasta hoy eso no se podía expresar. Un grupo `quantity` cuenta porciones POR
-- UNIDAD —los cortes de UNA parrillada—, así que «4 almuerzos con 3 caldos y 1
-- crema» se leía como cuatro almuerzos con cuatro sopas cada uno. El chat lo
-- repartía a su manera y solo cuadraba porque La Abuelita tenía todo en
-- `included`; con un recargo, el reparto se cobraba cuatro veces.
--
-- La regla, y es UNA:
--
--   · una porción de CADA parte (`is_meal_part`) forma un plato completo, al
--     precio del producto — aunque las partes sueltas sumen menos;
--   · lo que sobra de una parte se cobra a su `loose_price`; sin él, esa parte
--     no se vende sola y el pedido se rechaza diciendo qué completar;
--   · un acompañante con precio va en su PROPIA línea;
--   · un acompañante gratis va con el plato y no suma, sin tope: el dueño sabe
--     que cinco almuerzos llevan cinco jugos.
--
-- ⚠️ SALEN LÍNEAS, no un total. «2 × Almuerzo a 3.00» y «1 × Solo segundo a
-- 2.50» tienen cada una un precio unitario exacto, así que:
--   · `order_markup_by_line` sigue calculando el margen línea por línea, como
--     en cualquier otro plato, sin redondeos nuevos;
--   · la comanda dice cuántos almuerzos son, no «1 × mesa»;
--   · el reporte de lo vendido cuenta almuerzos de verdad.
--
-- ⚠️ EL PLATO VA EN UNA SOLA LÍNEA del pedido, y la base lo exige. Si se
-- aceptaran dos —la sopa en una, el segundo en otra— no se juntarían y el
-- almuerzo saldría por lo que suman sueltos: la puerta para pagar menos que el
-- precio del dueño. La app siempre manda la mesa entera en una.
--
-- ⚠️ Una parte es un CONTADOR colgado de un PRODUCTO, y lo impide la base: un
-- radio no deja pedir tres sopas, y en una categoría no hay un precio de
-- almuerzo al que referirse.
--
-- ⚠️ Una parte con TODAS sus opciones agotadas deja de contar: si hoy se acabó
-- la sopa, el segundo solo forma el plato. Es lo mismo que ya hace el catálogo,
-- que retira el grupo vacío; si la base siguiera contándola, la app pintaría un
-- almuerzo y la base cobraría un segundo suelto.
--
-- ⚠️ `create_storefront_order` se copió de la versión VIVA de `schema.sql` y
-- solo gana la rama del plato por partes: sus declaraciones y un bloque antes
-- de las comprobaciones de grupos. Cualquier producto sin partes recorre
-- exactamente el camino de antes. La firma no cambia, así que `create or
-- replace` la sustituye y conserva sus permisos.
--
-- ⚠️ Lo mismo, línea por línea, lo calcula `buildMealLines` en
-- `services/pricing.ts` para cotizar. `tests/plato-por-partes.test.js` y
-- `tests/sql/verificar-esquema.sql` los contrastan con los mismos casos.

alter table public.option_groups
  add column if not exists is_meal_part boolean not null default false,
  add column if not exists loose_price numeric(10,2);

alter table public.option_groups
  drop constraint if exists option_groups_parte_del_plato_check;
alter table public.option_groups
  add constraint option_groups_parte_del_plato_check check (
    (is_meal_part = false and loose_price is null)
    or (
      is_meal_part = true
      and selection_type = 'quantity'
      and product_id is not null
      and (loose_price is null or (loose_price > 0 and loose_price <= 100000))
    )
  );

comment on column public.option_groups.is_meal_part is
  'Parte del plato por partes (sopa, segundo): una porción de cada parte forma un plato completo al precio del producto.';
comment on column public.option_groups.loose_price is
  'Lo que cuesta una porción de esta parte que no completa un plato. Nulo: no se vende sola.';


-- ── Las líneas de un plato por partes ─────────────────────────────────────
--
-- Recibe lo elegido YA VALIDADO por `create_storefront_order` —pertenencia,
-- stock y cantidades— y devuelve las líneas del pedido, cada una con su precio
-- unitario de la base. No escribe nada: la inserción la hace quien la llama.
create or replace function public.lineas_del_plato_por_partes(
  p_business_id uuid,
  p_product_id uuid,
  p_product_name text,
  p_precio numeric,
  p_elegidas jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_completos integer;
  v_hay_partes boolean;
  v_parte record;
  v_eleccion record;
  v_sobran integer;
  v_para_completar integer;
  v_toma integer;
  v_del_completo jsonb := '[]'::jsonb;
  v_sueltas jsonb := '[]'::jsonb;
  v_opciones_sueltas jsonb;
  v_sueltos_total integer := 0;
  v_platos integer;
  v_grupo_pasado text;
  v_marcadas integer;
  v_gratis jsonb := '[]'::jsonb;
  v_con_precio jsonb := '[]'::jsonb;
  v_lineas jsonb := '[]'::jsonb;
begin
  -- Tantos platos completos como porciones tenga la parte MÁS CORTA. Cuentan
  -- las partes activas que tienen algo que se pueda pedir hoy.
  with porciones as (
    select (e ->> 'option_group_id')::uuid as grupo,
           sum((e ->> 'quantity')::integer) as total
    from jsonb_array_elements(p_elegidas) e
    group by 1
  )
  select coalesce(min(coalesce(p.total, 0)), 0)::integer,
         coalesce(bool_or(coalesce(p.total, 0) > 0), false)
  into v_completos, v_hay_partes
  from public.option_groups og
  left join porciones p on p.grupo = og.id
  where og.business_id = p_business_id
    and og.product_id = p_product_id
    and og.active = true
    and og.is_meal_part = true
    and exists (
      select 1 from public.options o
      where o.option_group_id = og.id
        and o.business_id = p_business_id
        and o.active = true
        and o.stock <> 'agotado'
    );

  if not v_hay_partes then
    raise exception using errcode = '22023',
      message = format('Elige qué quieres en %s', p_product_name);
  end if;
  if v_completos > 99 then
    raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
  end if;

  for v_parte in
    select og.id, og.name, og.loose_price,
           coalesce((
             select sum((e ->> 'quantity')::integer)
             from jsonb_array_elements(p_elegidas) e
             where (e ->> 'option_group_id')::uuid = og.id
           ), 0)::integer as total
    from public.option_groups og
    where og.business_id = p_business_id
      and og.product_id = p_product_id
      and og.active = true
      and og.is_meal_part = true
      and exists (
        select 1 from public.options o
        where o.option_group_id = og.id
          and o.business_id = p_business_id
          and o.active = true
          and o.stock <> 'agotado'
      )
    order by og.sort, og.id
  loop
    v_sobran := v_parte.total - v_completos;
    if v_sobran > 0 and v_parte.loose_price is null then
      raise exception using errcode = '22023',
        message = format(
          'En %s no se vende %s por separado: completa el plato',
          p_product_name, lower(v_parte.name)
        );
    end if;
    if v_sobran > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    -- Las porciones llenan primero los platos completos siguiendo la carta del
    -- dueño; las que sobran son las ÚLTIMAS. No cambia un centavo, pero así la
    -- comanda sale igual se marque en el orden que se marque.
    v_para_completar := v_completos;
    v_opciones_sueltas := '[]'::jsonb;
    for v_eleccion in
      select e as dato, (e ->> 'quantity')::integer as cantidad
      from jsonb_array_elements(p_elegidas) e
      join public.options o on o.id = (e ->> 'option_id')::uuid
      where (e ->> 'option_group_id')::uuid = v_parte.id
        and (e ->> 'quantity')::integer > 0
      order by o.sort, o.id
    loop
      v_toma := least(v_eleccion.cantidad, v_para_completar);
      v_para_completar := v_para_completar - v_toma;
      -- Una porción de una parte no tiene recargo: dentro del plato vale lo que
      -- dice el plato, y suelta, lo que dice su grupo.
      if v_toma > 0 then
        v_del_completo := v_del_completo || jsonb_build_array(
          v_eleccion.dato || jsonb_build_object('quantity', v_toma, 'unit_price_adjustment', 0)
        );
      end if;
      if v_eleccion.cantidad - v_toma > 0 then
        v_opciones_sueltas := v_opciones_sueltas || jsonb_build_array(
          v_eleccion.dato || jsonb_build_object(
            'quantity', v_eleccion.cantidad - v_toma, 'unit_price_adjustment', 0
          )
        );
      end if;
    end loop;

    if v_sobran > 0 then
      v_sueltos_total := v_sueltos_total + v_sobran;
      v_sueltas := v_sueltas || jsonb_build_array(jsonb_build_object(
        'name', 'Solo ' || lower(v_parte.name),
        'quantity', v_sobran,
        'unit_price', round(v_parte.loose_price, 2),
        'options', v_opciones_sueltas
      ));
    end if;
  end loop;

  -- ── LO GRATIS VA POR PLATO ───────────────────────────────────────────────
  --
  -- Un plato completo o una parte suelta llevan cada uno lo suyo: 2 almuerzos
  -- y un segundo suelto son TRES platos y tres jugos.
  --
  -- ⚠️ Añadido el 2026-09-16, y hasta entonces no lo contaba NADIE: ni la app,
  -- ni `pricing.ts`, ni esta función. El único tope era `max_selectable` del
  -- grupo, que en un local real valía 100 — un almuerzo de $3.50 se llevaba
  -- cien jugos gratis. Lo vio el dueño, no una prueba.
  --
  -- ⚠️ Solo topa lo GRATIS. Quien quiera cinco porciones de carne las paga, y
  -- ahí no hay nada que proteger: cada una suma a su precio.
  v_platos := v_completos + v_sueltos_total;

  select og.name, sum((e ->> 'quantity')::integer)
    into v_grupo_pasado, v_marcadas
    from jsonb_array_elements(p_elegidas) e
    join public.option_groups og on og.id = (e ->> 'option_group_id')::uuid
   where og.is_meal_part = false
     and coalesce((e ->> 'unit_price_adjustment')::numeric, 0) = 0
     and (e ->> 'quantity')::integer > 0
   group by og.id, og.name, og.sort
  having sum((e ->> 'quantity')::integer) > v_platos
   order by og.sort, og.id
   limit 1;

  if v_grupo_pasado is not null then
    raise exception using errcode = '22023',
      message = format(
        'En %s, %s va con cada plato: llevas %s y marcaste %s',
        p_product_name, lower(v_grupo_pasado), v_platos, v_marcadas
      );
  end if;

  -- ── Lo que acompaña: gratis con el plato, o su propia línea ───────────────
  for v_eleccion in
    select e as dato,
           (e ->> 'quantity')::integer as cantidad,
           (e ->> 'unit_price_adjustment')::numeric as precio,
           e ->> 'option_name' as nombre
    from jsonb_array_elements(p_elegidas) e
    join public.option_groups og on og.id = (e ->> 'option_group_id')::uuid
    join public.options o on o.id = (e ->> 'option_id')::uuid
    where og.is_meal_part = false
      and (e ->> 'quantity')::integer > 0
    order by og.sort, og.id, o.sort, o.id
  loop
    if v_eleccion.precio < 0 then
      raise exception using errcode = '22023',
        message = format('%s tiene un precio no válido en %s', v_eleccion.nombre, p_product_name);
    elsif v_eleccion.precio = 0 then
      v_gratis := v_gratis || jsonb_build_array(v_eleccion.dato);
    else
      if v_eleccion.cantidad > 99 then
        raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
      end if;
      v_con_precio := v_con_precio || jsonb_build_array(jsonb_build_object(
        'name', v_eleccion.nombre,
        'quantity', v_eleccion.cantidad,
        'unit_price', round(v_eleccion.precio, 2),
        'options', '[]'::jsonb
      ));
    end if;
  end loop;

  if v_completos > 0 then
    v_lineas := jsonb_build_array(jsonb_build_object(
      'name', p_product_name,
      'quantity', v_completos,
      'unit_price', round(p_precio, 2),
      'options', v_del_completo || v_gratis
    ));
  elsif jsonb_array_length(v_sueltas) > 0 then
    -- Sin plato completo, lo gratis acompaña a lo primero que se sirve suelto.
    v_sueltas := jsonb_set(v_sueltas, '{0,options}', (v_sueltas -> 0 -> 'options') || v_gratis);
  end if;

  return v_lineas || v_sueltas || v_con_precio;
end;
$$;

revoke all on function public.lineas_del_plato_por_partes(uuid, uuid, text, numeric, jsonb)
  from public, anon, authenticated;


-- ── El pedido, con la rama del plato por partes ───────────────────────────
create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
  -- La dirección se copia al pedido, no se apunta. Van en variables sueltas y
  -- no en un record porque en PL/pgSQL un record sin asignar no se puede ni
  -- consultar, y sin dirección —retiro en local— no se asigna ninguna.
  v_dir_label text;
  v_dir_address text;
  v_dir_reference text;
  v_dir_latitude numeric(10,7);
  v_dir_longitude numeric(10,7);
  v_dir_accuracy numeric(7,1);
  v_dir_building_type text;
  v_dir_courier_notes text;
  -- El plato por partes: cada línea que devuelve, qué platos ya salieron en
  -- este pedido y si la nota del cliente ya se puso.
  v_linea jsonb;
  v_platos_por_partes uuid[] := '{}';
  v_nota_puesta boolean;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  -- ⚠️ FOR NO KEY UPDATE, no FOR SHARE (2026-09-27). El disparador que
  -- numera el pedido (`assign_order_number`) ESCRIBE en esta misma fila
  -- (`last_order_number + 1`). Con FOR SHARE, dos pedidos a la vez en el
  -- mismo local tomaban los dos el bloqueo compartido, luego cada uno
  -- esperaba al otro para escribir, y PostgreSQL mataba uno con «deadlock
  -- detected»: el cliente veía fallar su pedido. Tomando desde el principio
  -- el bloqueo que igual se iba a necesitar, el segundo ESPERA unos
  -- milisegundos a que el primero termine, en vez de chocar. No choca con
  -- las foráneas (FOR KEY SHARE), así que nada más se frena.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  --
  -- Antes esto solo COMPROBABA; ahora además trae los datos, porque el pedido
  -- se los queda. Es la misma consulta y las mismas cuatro condiciones: no se
  -- relaja nada, se aprovecha lo que ya se estaba leyendo.
  --
  -- `for share` bloquea la fila hasta que la transacción termine: sin él, el
  -- cliente podría borrar su dirección entre la comprobación y la copia.
  if p_address_id is not null then
    select label, address, reference, latitude, longitude, accuracy_m,
           building_type, courier_notes
    into v_dir_label, v_dir_address, v_dir_reference, v_dir_latitude,
         v_dir_longitude, v_dir_accuracy, v_dir_building_type,
         v_dir_courier_notes
    from public.customer_addresses
    where id = p_address_id
      and business_id = p_business_id
      and customer_id = p_customer_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  -- ⚠️ La dirección se CONGELA, igual que `order_items` congela el nombre y el
  -- precio del producto. `address_id` se queda como puntero —sirve para saber
  -- a qué casa pide más un cliente— pero ya no es de donde se lee para
  -- repartir: si el cliente corrige su dirección el martes, el pedido del lunes
  -- tiene que seguir diciendo a dónde se llevó.
  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes,
    delivery_label, delivery_address, delivery_reference,
    delivery_latitude, delivery_longitude, delivery_accuracy_m,
    delivery_building_type, delivery_courier_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0,
    -- ⚠️ Quien va a TRANSFERIR nace esperando el pago, no «pendiente».
    --
    -- El estado existía desde hace tiempo y no lo usaba nadie: todo pedido
    -- nacía igual, pagara como pagara. Eso hacía que el dueño viera lo mismo
    -- en dos situaciones distintas —uno que le va a pagar en la puerta y otro
    -- del que aún no ha visto un centavo— y que el cliente leyera «pedido
    -- confirmado» cuando su negocio ni lo había mirado.
    case when p_payment_method = 'transferencia' then 'esperando_pago' else 'pendiente' end,
    'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_dir_label, v_dir_address, v_dir_reference,
    v_dir_latitude, v_dir_longitude, v_dir_accuracy,
    v_dir_building_type, v_dir_courier_notes
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id,
           available_days, available_from, available_until
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;
    -- Menús con reloj (2026-09-17): fuera de su franja no se vende, lo pinte
    -- como lo pinte el teléfono.
    if not public.producto_en_horario(
         v_product.available_days, v_product.available_from, v_product.available_until
       ) then
      raise exception using errcode = '22023',
        message = format('%s no se puede pedir a esta hora', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type,
               og.sort as group_sort
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          -- El ORDEN que el dueño le dio a este grupo, congelado como el
          -- nombre y el precio. Se copia al crear el pedido y no se consulta al
          -- leer: el panel del dueño pregunta por sus pedidos cada 12 segundos,
          -- y una unión más ahí correría sin parar durante todo el servicio.
          'option_group_sort', coalesce(v_option_row.group_sort, 0),
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── El plato POR PARTES: la mesa entera, partida en sus líneas ────────
    --
    -- Va DESPUÉS de validar cada opción —pertenencia, stock y cantidades— y
    -- ANTES de las comprobaciones de grupos, que en este plato no aplican: aquí
    -- las porciones son de toda la mesa, no de una unidad. Un producto sin
    -- partes no entra y sigue exactamente el camino de siempre.
    if exists (
      select 1 from public.option_groups og
      where og.business_id = p_business_id
        and og.product_id = v_product_id
        and og.active = true
        and og.is_meal_part = true
    ) then
      if v_quantity <> 1 or v_has_variant or coalesce(cardinality(v_extras_names), 0) > 0 then
        raise exception using errcode = '22023',
          message = format('%s se arma en una sola línea', v_product.name);
      end if;
      -- Dos líneas del mismo plato no se juntarían: la sopa en una y el segundo
      -- en otra saldrían sueltos, por menos que el precio del dueño.
      if v_product_id = any(v_platos_por_partes) then
        raise exception using errcode = '22023',
          message = format('%s va una sola vez en el pedido', v_product.name);
      end if;
      v_platos_por_partes := v_platos_por_partes || v_product_id;

      v_nota_puesta := false;
      for v_linea in
        select value from jsonb_array_elements(
          public.lineas_del_plato_por_partes(
            p_business_id, v_product_id, v_product.name, v_unit_price, v_chosen
          )
        )
      loop
        v_line_total := round(
          (v_linea ->> 'unit_price')::numeric * (v_linea ->> 'quantity')::integer, 2
        );
        v_subtotal := v_subtotal + v_line_total;

        -- Lo elegido entra también en `extras_names`, igual que en cualquier
        -- plato: es lo que el dueño lee en su panel de pedidos.
        insert into public.order_items (
          order_id, business_id, product_id, product_name,
          variant_id, variant_name, extras_names, item_note,
          quantity, unit_price, line_total
        ) values (
          v_order_id, p_business_id, v_product.id, v_linea ->> 'name',
          null, null,
          coalesce((
            select array_agg(
              case when (t.o ->> 'quantity')::integer > 1
                then format('%s x%s', t.o ->> 'option_name', t.o ->> 'quantity')
                else t.o ->> 'option_name'
              end
              order by t.orden
            )
            from jsonb_array_elements(v_linea -> 'options') with ordinality as t(o, orden)
          ), '{}'),
          -- La nota del cliente va en la PRIMERA línea, no repetida en todas.
          case when v_nota_puesta then null else v_note end,
          (v_linea ->> 'quantity')::integer,
          (v_linea ->> 'unit_price')::numeric,
          v_line_total
        )
        returning id into v_order_item_id;
        v_nota_puesta := true;

        insert into public.order_item_options (
          business_id, order_item_id, option_group_id, option_id,
          option_group_name, group_sort, option_name, quantity,
          unit_price_adjustment, total_price_adjustment
        )
        select p_business_id, v_order_item_id,
               (o ->> 'option_group_id')::uuid, (o ->> 'option_id')::uuid,
               o ->> 'option_group_name',
               coalesce((o ->> 'option_group_sort')::integer, 0),
               o ->> 'option_name',
               (o ->> 'quantity')::integer,
               (o ->> 'unit_price_adjustment')::numeric,
               round((o ->> 'unit_price_adjustment')::numeric * (o ->> 'quantity')::integer, 2)
        from jsonb_array_elements(v_linea -> 'options') o;
      end loop;
      continue;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, group_sort, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name',
           coalesce((e ->> 'option_group_sort')::integer, 0),
           e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- TODO LOCAL PIDE POR SU MINI APP
-- Migración incremental: migration-2026-09-16-todo-local-es-mini-app.sql
-- ════════════════════════════════════════════════════════════════════════

-- ═══════════════════════════════════════════════════════════════════════════
-- TODO LOCAL PIDE POR SU MINI APP
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Decisión del dueño (2026-09-14), después de probar el chat con un pedido de
-- verdad: «la experiencia es mala — un pedido familiar cuesta ~14 mensajes de
-- ida y vuelta, y cada saliente se paga». A eso se suma lo que WhatsApp no deja
-- hacer: los títulos de lista se cortan a 24 caracteres y los grupos de casillas
-- no se pueden expresar. Eran DOS motores para lo mismo, y esa duplicidad ya
-- costó un fallo de cuatro días que dejó al chat sin poder vender (#343).
--
-- Lo que SIGUE por WhatsApp, igual que hoy: la bienvenida, las categorías,
-- elegir local, el enlace de la mini app, los comprobantes, los avisos de estado
-- del pedido, la ubicación y MENÚ. Lo único que desaparece es ARMAR EL CARRITO
-- por chat.
--
-- ⚠️ EL ORDEN IMPORTA y ya se cumplió: La Abuelita —el único local que pedía por
-- chat— se pasó a la mini app el 2026-09-16 cambiando `pide_en_chat` a false, y
-- se comprobó vendiendo antes de retirar una sola línea de código.

-- ── 1. La función que decidía el camino ───────────────────────────────────
--
-- Ya no la llama nadie: el camino es uno solo. Una función que existe y nadie
-- usa es código muerto que alguien puede invocar por error años después, y hay
-- un guardián (`funciones-huerfanas`) que lo exige.
drop function if exists public.tipo_pide_en_chat(text);

-- ── 2. La columna que la alimentaba ───────────────────────────────────────
--
-- `marketplace_category_types` SE QUEDA: es el reparto de tipos en categorías,
-- que es lo que arma el menú del marketplace. Lo que se va es la bandera que
-- decidía chat o enlace, porque ya no hay dos caminos que elegir.
--
-- ⚠️ Su contenido no se pierde: los 15 tipos que la tenían en `true` están
-- escritos en `migration-2026-08-23-pedir-por-tipo.sql`, que es de donde
-- salieron.
alter table public.marketplace_category_types
  drop column if exists pide_en_chat;

-- ── 3. Quien estaba a media compra POR CHAT ───────────────────────────────
--
-- Al aplicar esto había UNA conversación en `pidiendo`. Su carrito vivía en
-- `flow_state.menu` y lo armaba un motor que ya no existe, así que se la trata
-- como a quien tiene su enlace abierto: `en_local`, sin carrito y con su local
-- y su candado intactos. El siguiente mensaje le recuerda dónde está y le
-- devuelve su enlace; MENÚ sigue siendo la salida.
--
-- ⚠️ El candado NO se suelta aquí. Soltarlo dejaría a esa persona empezando otro
-- pedido en otro local con el anterior a medias, que es justo lo que ese candado
-- existe para impedir.
update public.marketplace_conversations
   set current_state = 'en_local',
       flow_state = case
         when flow_state ? 'vista' then jsonb_build_object('vista', flow_state -> 'vista')
         else '{}'::jsonb
       end,
       updated_at = now()
 where current_state in (
   'pidiendo', 'esperando_entrega', 'esperando_ubicacion', 'esperando_metodo_pago'
 );


-- ════════════════════════════════════════════════════════════════════════
-- PAGO CON TARJETA (PAYPHONE)
-- (migration-2026-09-27-tarjeta-payphone.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- PAGO CON TARJETA (PAYPHONE) — EL COBRO, LA CONFIRMACIÓN Y LA DEVOLUCIÓN
--
-- Decisión del dueño (2026-09-27): la tarjeta entra en la cuenta PayPhone de
-- UMBANI, y Umbani liquida después a cada local. Es lo que hacen las grandes
-- y lo que deja cobrar la comisión en el acto, sin «Nos debe». Este archivo
-- es la PRIMERA pieza: cobrar, confirmar y devolver. La liquidación al local
-- (y el split) llega en su propio PR.
--
-- ── Lo que obliga el diseño: PayPhone NO avisa ────────────────────────────
--
-- No hay webhook. PayPhone redirige al TELÉFONO del cliente a nuestra URL de
-- respuesta, y es NUESTRO servidor quien tiene que llamar a su `Confirm`. Si
-- nadie confirma en 5 minutos, PayPhone DEVUELVE el dinero solo. Por eso:
--
--   · Cada intento se registra ANTES de mandar al cliente a pagar, con una
--     referencia nuestra (`client_transaction_id`) que PayPhone devuelve.
--   · Una tarea del servidor confirma cada intento pase lo que pase con el
--     teléfono. La redirección solo enseña el resultado antes.
--   · La base decide si se confirma: si el pedido ya no está para cobrarse
--     —lo canceló el local, ya se pagó con otro intento— NO se confirma, y
--     PayPhone lo devuelve solo. Ningún dinero se queda donde no debe.
--
-- ── Cada centavo cuadra, o no se confirma ─────────────────────────────────
--
-- Todo en CENTAVOS ENTEROS, como trabaja PayPhone. El monto del intento sale
-- de `orders.total` en la base —nunca del teléfono— y al asentar se exige que
-- lo cobrado sea IGUAL a ese monto y al total vigente del pedido. Si no, el
-- pago no marca nada y pasa a devolverse.
--
-- ── El modo PRUEBAS en producción ─────────────────────────────────────────
--
-- En pruebas PayPhone aprueba TODO sin cobrar. Si ese modo alcanzara a un
-- local real, un cliente se llevaría comida gratis. Por eso cada local lleva
-- `card_mode` y cada pago su `environment`, y la base exige que coincidan al
-- iniciar Y al asentar: un pago de prueba jamás confirma un pedido de un
-- local en producción.
-- ============================================================================


-- ── 1. Qué locales cobran con tarjeta, y en qué modo ──────────────────────
--
-- NULO = sin tarjeta (todos, hoy). Lo pone SOLO el superadmin: el dinero entra
-- en la cuenta de Umbani, así que no puede encenderlo el dueño desde su panel
-- (por eso NO vive en `business_payment_methods`, que sí edita él).
alter table public.businesses
  add column if not exists card_mode text;

alter table public.businesses
  drop constraint if exists businesses_card_mode_check;
alter table public.businesses
  add constraint businesses_card_mode_check
  check (card_mode is null or card_mode in ('pruebas', 'produccion'));

comment on column public.businesses.card_mode is
  'Cobro con tarjeta (PayPhone): NULL = no; pruebas = solo local de pruebas '
  'con PayPhone en modo pruebas; produccion = cobro real. Lo decide el superadmin.';


-- ── 2. El CHECK de método de pago admite la tarjeta ───────────────────────
--
-- ⚠️ Es ESTE el que manda (el de `migration-2026-08-07-checkout.sql`, que pisó
-- al del create table). Se reescribe entero, igual que entonces.
do $$
begin
  alter table public.orders drop constraint if exists orders_pago_check;
  alter table public.orders add constraint orders_pago_check check (
    shipping >= 0
    and (
      payment_method is null
      or payment_method in ('transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta')
    )
    and (delivery_notes is null or char_length(delivery_notes) <= 300)
  );
end;
$$;


-- ── 3. Los pagos ──────────────────────────────────────────────────────────
--
-- Genérica a propósito: PayPhone hoy, Deuna mañana. Un intento de cobro por
-- fila; un pedido puede tener varios (el cliente cerró la página y volvió a
-- intentarlo), pero solo UNO aprobado.
create table if not exists public.payments (
  id                      uuid primary key default gen_random_uuid(),
  business_id             uuid not null references public.businesses(id) on delete cascade,
  order_id                uuid not null,
  provider                text not null default 'payphone',
  method                  text not null default 'tarjeta',
  environment             text not null,
  -- La referencia NUESTRA que viaja a PayPhone y vuelve en la redirección.
  client_transaction_id   text not null,
  -- El id que asigna PayPhone. Llega con la redirección o con la consulta.
  provider_transaction_id text,
  -- Lo que se pidió cobrar (el total del pedido al iniciar) y lo que PayPhone
  -- dice que cobró. Centavos enteros.
  amount_cents            integer not null,
  captured_cents          integer,
  currency                text not null default 'USD',
  status                  text not null default 'iniciado',
  status_detail           text,
  -- Lo que el dueño ve y lo que pide un reclamo. NUNCA el número de tarjeta.
  authorization_code      text,
  card_brand              text,
  card_last_digits        text,
  confirm_attempts        integer not null default 0,
  -- Cuándo vuelve a mirarlo la tarea del servidor.
  next_check_at           timestamptz not null default now(),
  approved_at             timestamptz,
  reversed_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  -- ⚠️ Por PAREJA (id, business_id): un pago no puede apuntar al pedido de
  -- OTRO negocio. Lo exige `verificar-fronteras.sql`.
  constraint payments_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  constraint payments_provider_check    check (provider in ('payphone')),
  constraint payments_method_check      check (method in ('tarjeta')),
  constraint payments_environment_check check (environment in ('pruebas', 'produccion')),
  constraint payments_currency_check    check (currency = 'USD'),
  -- Un pedido de $100.000 no existe aquí; un monto así es un error de cálculo.
  constraint payments_amount_check      check (amount_cents > 0 and amount_cents <= 10000000),
  constraint payments_captured_check    check (captured_cents is null or captured_cents >= 0),
  constraint payments_client_tx_check   check (client_transaction_id ~ '^[A-Za-z0-9-]{8,50}$'),
  constraint payments_last_digits_check check (card_last_digits is null or card_last_digits ~ '^[0-9]{2,4}$'),
  constraint payments_status_check check (status in (
    'iniciado',          -- se preparó el cobro y el cliente fue a pagar
    'confirmando',       -- la base aceptó que se confirme; falta la respuesta
    'aprobado',          -- cobrado, cuadrado y aplicado al pedido
    'rechazado',         -- PayPhone lo canceló o la tarjeta no pasó
    'caducado',          -- nadie pagó dentro del plazo de PayPhone
    'no_confirmado',     -- se pagó, pero el pedido ya no se podía cobrar:
                         -- no se confirmó y PayPhone lo devuelve solo
    'por_devolver',      -- cobrado y hay que devolverlo (pedido cancelado o descuadre)
    'devuelto',          -- devuelto por la API de PayPhone
    'devolucion_manual'  -- PayPhone no dejó revertirlo: hay que devolverlo a mano
  ))
);

alter table public.payments enable row level security;
-- ⚠️ Sin políticas y sin permisos para anon/authenticated: aquí hay códigos
-- de autorización y los últimos dígitos de tarjetas. Solo el servidor.
revoke all on table public.payments from anon, authenticated;

create unique index if not exists payments_client_tx_unico
  on public.payments (client_transaction_id);
-- El mismo cobro de PayPhone no puede aplicarse a dos intentos.
create unique index if not exists payments_provider_tx_unico
  on public.payments (provider, provider_transaction_id)
  where provider_transaction_id is not null;
-- ⚠️ LA GARANTÍA CONTRA EL DOBLE COBRO: un pedido, un pago aprobado.
create unique index if not exists payments_un_aprobado_por_pedido
  on public.payments (order_id)
  where status = 'aprobado';
create index if not exists idx_payments_biz_created
  on public.payments (business_id, created_at desc);
create index if not exists idx_payments_order
  on public.payments (order_id);
-- La cola de la tarea del servidor: solo lo que sigue vivo.
create index if not exists idx_payments_pendientes
  on public.payments (next_check_at)
  where status in ('iniciado', 'confirmando', 'por_devolver');

comment on table public.payments is
  'Intentos de cobro por pasarela (PayPhone). Centavos enteros; un solo aprobado por pedido.';


-- ── 3b. La RPC que crea el pedido admite la tarjeta ───────────────────────
--
-- Copiada ENTERA de migration-2026-09-27-pedidos-a-la-vez.sql (la vigente).
-- Cambian DOS cosas y nada más: la lista de métodos admite «tarjeta», y la
-- tarjeta nace en `esperando_pago` igual que la transferencia. Las
-- comprobaciones de dinero, stock, precio y bloqueo son las mismas.

create or replace function public.create_storefront_order(
  p_business_id uuid,
  p_customer_id uuid,
  p_contact_phone text,
  p_contact_name text,
  p_address_id uuid,
  p_fulfillment text,
  p_items jsonb,
  p_notes text default null,
  p_payment_method text default null,
  p_idempotency_key text default null,
  p_scheduled_for timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_business record;
  v_order_id uuid;
  v_item jsonb;
  v_product record;
  v_variant record;
  v_has_variant boolean;
  v_variant_ref uuid;
  v_variant_label text;
  v_product_id uuid;
  v_variant_id uuid;
  v_quantity integer;
  v_note text;
  v_extra_ids uuid[];
  v_extras_total numeric(10,2);
  v_extras_names text[];
  -- Lo elegido de los grupos de opciones, ya validado y con su precio de la
  -- base. Se acumula EN MEMORIA y por línea: una tabla auxiliar la pisarían
  -- dos pedidos simultáneos del mismo negocio.
  v_chosen jsonb;
  v_option jsonb;
  v_option_row record;
  v_options_total numeric(10,2);
  v_options_names text[];
  v_option_qty integer;
  v_group record;
  v_group_count integer;
  v_grupo_total numeric(10,2);
  v_product_category uuid;
  v_order_item_id uuid;
  v_unit_price numeric(10,2);
  v_line_total numeric(10,2);
  v_subtotal numeric(10,2) := 0;
  v_shipping numeric(10,2) := 0;
  v_count integer := 0;
  v_clave text;
  v_existente public.orders%rowtype;
  -- La dirección se copia al pedido, no se apunta. Van en variables sueltas y
  -- no en un record porque en PL/pgSQL un record sin asignar no se puede ni
  -- consultar, y sin dirección —retiro en local— no se asigna ninguna.
  v_dir_label text;
  v_dir_address text;
  v_dir_reference text;
  v_dir_latitude numeric(10,7);
  v_dir_longitude numeric(10,7);
  v_dir_accuracy numeric(7,1);
  v_dir_building_type text;
  v_dir_courier_notes text;
  -- El plato por partes: cada línea que devuelve, qué platos ya salieron en
  -- este pedido y si la nota del cliente ya se puso.
  v_linea jsonb;
  v_platos_por_partes uuid[] := '{}';
  v_nota_puesta boolean;
begin
  -- ── El negocio debe poder recibir pedidos por la tienda ──────────────────
  select id, active, suspended, storefront_enabled, takes_orders, delivery_fee
  into v_business
  from public.businesses
  where id = p_business_id
  -- ⚠️ FOR NO KEY UPDATE, no FOR SHARE (2026-09-27). El disparador que
  -- numera el pedido (`assign_order_number`) ESCRIBE en esta misma fila
  -- (`last_order_number + 1`). Con FOR SHARE, dos pedidos a la vez en el
  -- mismo local tomaban los dos el bloqueo compartido, luego cada uno
  -- esperaba al otro para escribir, y PostgreSQL mataba uno con «deadlock
  -- detected»: el cliente veía fallar su pedido. Tomando desde el principio
  -- el bloqueo que igual se iba a necesitar, el segundo ESPERA unos
  -- milisegundos a que el primero termine, en vez de chocar. No choca con
  -- las foráneas (FOR KEY SHARE), así que nada más se frena.
  for no key update;
  if not found then
    raise exception using errcode = '42501', message = 'El negocio no existe';
  end if;
  if v_business.active is false or v_business.suspended is true then
    raise exception using errcode = '42501', message = 'El negocio no esta disponible';
  end if;
  if v_business.storefront_enabled is not true then
    raise exception using errcode = '42501', message = 'Este negocio no tiene tienda activada';
  end if;
  if v_business.takes_orders is not true then
    raise exception using errcode = '42501', message = 'Este negocio no recibe pedidos';
  end if;

  -- ── El mismo pedido dos veces es UN pedido ──────────────────────────────
  --
  -- Un doble toque en «Confirmar», o la app reintentando tras un corte de red,
  -- creaban dos pedidos idénticos: dos comandas en la cocina y un cliente que
  -- paga dos veces. La app manda una clave por intento de compra; si ya existe
  -- un pedido con ella, se DEVUELVE ese en vez de crear otro.
  v_clave := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  if v_clave is not null then
    if char_length(v_clave) > 100 then
      raise exception using errcode = '22023', message = 'Clave de pedido invalida';
    end if;
    select * into v_existente
    from public.orders
    where business_id = p_business_id and idempotency_key = v_clave;
    if found then
      return jsonb_build_object(
        'id', v_existente.id,
        -- El mismo pedido devuelve el MISMO número: un doble toque no puede
        -- dejar al cliente con dos números para una sola comanda.
        'order_number', v_existente.order_number,
        'subtotal', v_existente.subtotal,
        'shipping', v_existente.shipping,
        'total', v_existente.total,
        'items', (select count(*) from public.order_items oi where oi.order_id = v_existente.id),
        'repetido', true
      );
    end if;
  end if;

  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception using errcode = '22023', message = 'El pedido no tiene productos';
  end if;
  if jsonb_array_length(p_items) > 50 then
    raise exception using errcode = '22023', message = 'El pedido tiene demasiados productos';
  end if;

  if p_fulfillment is not null and p_fulfillment not in ('delivery', 'pickup', 'onsite') then
    raise exception using errcode = '22023', message = 'Tipo de entrega invalido';
  end if;

  -- «pago_al_retirar» es el tercer método del diagrama: no es cómo paga, es
  -- CUÁNDO — al pasar por el local. La ruta ya impide ofrecerlo a domicilio;
  -- aquí solo se comprueba que sea un valor válido, igual que el CHECK.
  if p_payment_method is not null
     and p_payment_method not in ('transferencia', 'efectivo', 'pago_al_retirar', 'tarjeta') then
    raise exception using errcode = '22023', message = 'Metodo de pago invalido';
  end if;

  -- La dirección, si viene, debe ser de ESE cliente y ESE negocio.
  --
  -- Antes esto solo COMPROBABA; ahora además trae los datos, porque el pedido
  -- se los queda. Es la misma consulta y las mismas cuatro condiciones: no se
  -- relaja nada, se aprovecha lo que ya se estaba leyendo.
  --
  -- `for share` bloquea la fila hasta que la transacción termine: sin él, el
  -- cliente podría borrar su dirección entre la comprobación y la copia.
  if p_address_id is not null then
    select label, address, reference, latitude, longitude, accuracy_m,
           building_type, courier_notes
    into v_dir_label, v_dir_address, v_dir_reference, v_dir_latitude,
         v_dir_longitude, v_dir_accuracy, v_dir_building_type,
         v_dir_courier_notes
    from public.customer_addresses
    where id = p_address_id
      and business_id = p_business_id
      and customer_id = p_customer_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'La direccion no pertenece a este cliente';
    end if;
  end if;

  -- ⚠️ La dirección se CONGELA, igual que `order_items` congela el nombre y el
  -- precio del producto. `address_id` se queda como puntero —sirve para saber
  -- a qué casa pide más un cliente— pero ya no es de donde se lee para
  -- repartir: si el cliente corrige su dirección el martes, el pedido del lunes
  -- tiene que seguir diciendo a dónde se llevó.
  insert into public.orders (
    business_id, customer_id, contact_phone, contact_name,
    subtotal, discount, total, status, source, address_id, fulfillment,
    payment_method, idempotency_key, scheduled_for, delivery_notes,
    delivery_label, delivery_address, delivery_reference,
    delivery_latitude, delivery_longitude, delivery_accuracy_m,
    delivery_building_type, delivery_courier_notes
  ) values (
    p_business_id, p_customer_id, btrim(p_contact_phone), nullif(btrim(coalesce(p_contact_name, '')), ''),
    0, 0, 0,
    -- ⚠️ Quien va a TRANSFERIR nace esperando el pago, no «pendiente».
    --
    -- El estado existía desde hace tiempo y no lo usaba nadie: todo pedido
    -- nacía igual, pagara como pagara. Eso hacía que el dueño viera lo mismo
    -- en dos situaciones distintas —uno que le va a pagar en la puerta y otro
    -- del que aún no ha visto un centavo— y que el cliente leyera «pedido
    -- confirmado» cuando su negocio ni lo había mirado.
    -- La tarjeta también nace DEBIENDO: el pedido existe, pero el local no lo
    -- ve como nuevo hasta que PayPhone confirma el cobro (`settle_card_payment`).
    case when p_payment_method in ('transferencia', 'tarjeta') then 'esperando_pago' else 'pendiente' end,
    'storefront', p_address_id, p_fulfillment,
    p_payment_method, v_clave, p_scheduled_for,
    nullif(btrim(coalesce(p_notes, '')), ''),
    v_dir_label, v_dir_address, v_dir_reference,
    v_dir_latitude, v_dir_longitude, v_dir_accuracy,
    v_dir_building_type, v_dir_courier_notes
  )
  returning id into v_order_id;

  -- ── Cada línea, con su precio resuelto en la base ────────────────────────
  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_count := v_count + 1;
    v_product_id := nullif(v_item ->> 'product_id', '')::uuid;
    v_variant_id := nullif(v_item ->> 'variant_id', '')::uuid;
    v_quantity := coalesce((v_item ->> 'quantity')::integer, 0);
    v_note := left(nullif(btrim(coalesce(v_item ->> 'note', '')), ''), 200);

    if v_quantity < 1 or v_quantity > 99 then
      raise exception using errcode = '22023', message = 'La cantidad debe estar entre 1 y 99';
    end if;

    select id, name, price, price_sale, stock, category_id,
           available_days, available_from, available_until
    into v_product
    from public.products
    where id = v_product_id
      and business_id = p_business_id
      and active = true
    for share;
    if not found then
      raise exception using errcode = '42501', message = 'El producto no pertenece al negocio';
    end if;
    if v_product.stock = 'agotado' then
      raise exception using errcode = '22023', message = format('%s esta agotado', v_product.name);
    end if;
    -- Menús con reloj (2026-09-17): fuera de su franja no se vende, lo pinte
    -- como lo pinte el teléfono.
    if not public.producto_en_horario(
         v_product.available_days, v_product.available_from, v_product.available_until
       ) then
      raise exception using errcode = '22023',
        message = format('%s no se puede pedir a esta hora', v_product.name);
    end if;

    -- El precio sale de la variante si la hay; si no, del producto.
    -- Se usa una bandera y no `v_variant is null`: en PL/pgSQL un record sin
    -- asignar no se puede consultar, ni siquiera para comprobar si es nulo.
    v_has_variant := v_variant_id is not null;
    if v_has_variant then
      select id, name, price, price_sale, stock
      into v_variant
      from public.product_variants
      where id = v_variant_id
        and product_id = v_product_id
        and business_id = p_business_id
        and active = true
      for share;
      if not found then
        raise exception using errcode = '42501', message = 'La variante no pertenece a este producto';
      end if;
      if v_variant.stock = 'agotado' then
        raise exception using errcode = '22023', message = format('%s (%s) esta agotado', v_product.name, v_variant.name);
      end if;
      v_variant_ref := v_variant.id;
      v_variant_label := v_variant.name;
      v_unit_price := round(
        case when v_variant.price_sale > 0 then v_variant.price_sale else v_variant.price end, 2
      );
    else
      v_variant_ref := null;
      v_variant_label := null;
      v_unit_price := round(
        case when v_product.price_sale > 0 then v_product.price_sale else v_product.price end, 2
      );
    end if;

    if not (v_unit_price > 0) then
      raise exception using errcode = '22023', message = format('%s no tiene un precio valido', v_product.name);
    end if;

    -- ── Extras: pertenencia comprobada, precio de la base ──────────────────
    v_extras_total := 0;
    v_extras_names := '{}'::text[];
    if jsonb_typeof(v_item -> 'extra_ids') = 'array' then
      if jsonb_array_length(v_item -> 'extra_ids') > 20 then
        raise exception using errcode = '22023', message = 'Demasiados extras en un producto';
      end if;
      select array_agg(value::uuid) into v_extra_ids
      from jsonb_array_elements_text(v_item -> 'extra_ids');

      if v_extra_ids is not null and cardinality(v_extra_ids) > 0 then
        select coalesce(sum(m.price_delta), 0), coalesce(array_agg(m.name order by m.name), '{}')
        into v_extras_total, v_extras_names
        from public.menu_modifiers m
        where m.id = any(v_extra_ids)
          and m.business_id = p_business_id
          and m.active = true
          -- Del producto, o de una etiqueta que ese producto tenga.
          and (
            m.product_id = v_product_id
            or (m.product_id is null and m.category_tag is not null and exists (
              select 1 from public.products p2
              where p2.id = v_product_id
                and lower(m.category_tag) = any(select lower(unnest(coalesce(p2.tags, '{}'))))
            ))
          );

        if coalesce(cardinality(v_extras_names), 0) <> cardinality(v_extra_ids) then
          raise exception using errcode = '42501', message = 'Algun extra no corresponde a este producto';
        end if;
      end if;
    end if;

    -- ── Grupos de opciones: el motor con el que se arma un plato ──────────
    --
    -- Aquí se decide el dinero de verdad. La app manda id y cantidad; el
    -- recargo, el nombre y el derecho a estar en este producto salen de la
    -- base (regla inviolable #8).
    v_options_total := 0;
    v_options_names := '{}'::text[];
    v_chosen := '[]'::jsonb;
    v_product_category := v_product.category_id;

    if jsonb_typeof(v_item -> 'options') = 'array' then
      if jsonb_array_length(v_item -> 'options') > 30 then
        raise exception using errcode = '22023', message = 'Demasiadas opciones en un producto';
      end if;

      for v_option in select * from jsonb_array_elements(v_item -> 'options')
      loop
        v_option_qty := greatest(1, least(100, coalesce((v_option ->> 'quantity')::integer, 1)));

        -- La opción tiene que ser de este negocio Y de un grupo que aplique a
        -- ESTE producto: del producto, o de su categoría. Sin esto se podría
        -- abaratar una pizza mandando el id de una opción de otro plato.
        select o.id, o.name, o.price_adjustment, o.stock,
               og.id as group_id, og.name as group_name, og.selection_type,
               og.sort as group_sort
        into v_option_row
        from public.options o
        join public.option_groups og on og.id = o.option_group_id
        where o.id = nullif(v_option ->> 'option_id', '')::uuid
          and o.business_id = p_business_id
          and o.active = true
          and og.business_id = p_business_id
          and og.active = true
          and (
            og.product_id = v_product_id
            or (og.category_id is not null and og.category_id = v_product_category)
          );
        if not found then
          raise exception using errcode = '42501',
            message = format('Una opcion no corresponde a %s', v_product.name);
        end if;
        if v_option_row.stock = 'agotado' then
          raise exception using errcode = '22023',
            message = format('%s ya no esta disponible', v_option_row.name);
        end if;

        -- Fuera de los contadores, pedir tres veces la misma opción no
        -- significa nada y multiplicaría su recargo.
        if v_option_row.selection_type <> 'quantity' and v_option_qty <> 1 then
          raise exception using errcode = '22023',
            message = format('%s no se elige por cantidad', v_option_row.group_name);
        end if;
        -- Ni mandarla dos veces, que sería el mismo truco por otra puerta.
        if exists (
          select 1 from jsonb_array_elements(v_chosen) e
          where (e ->> 'option_id')::uuid = v_option_row.id
        ) then
          raise exception using errcode = '22023',
            message = format('%s viene repetida', v_option_row.name);
        end if;

        -- El importe ya NO se suma aquí: cada grupo se cobra según SU
        -- estrategia, y para eso hace falta ver todo lo elegido junto.
        v_options_names := v_options_names || (
          case when v_option_qty > 1
            then format('%s x%s', v_option_row.name, v_option_qty)
            else v_option_row.name
          end
        );
        v_chosen := v_chosen || jsonb_build_object(
          'option_id', v_option_row.id,
          'option_group_id', v_option_row.group_id,
          'option_group_name', v_option_row.group_name,
          -- El ORDEN que el dueño le dio a este grupo, congelado como el
          -- nombre y el precio. Se copia al crear el pedido y no se consulta al
          -- leer: el panel del dueño pregunta por sus pedidos cada 12 segundos,
          -- y una unión más ahí correría sin parar durante todo el servicio.
          'option_group_sort', coalesce(v_option_row.group_sort, 0),
          'option_name', v_option_row.name,
          'quantity', v_option_qty,
          'unit_price_adjustment', v_option_row.price_adjustment
        );
      end loop;
    end if;

    -- ── El plato POR PARTES: la mesa entera, partida en sus líneas ────────
    --
    -- Va DESPUÉS de validar cada opción —pertenencia, stock y cantidades— y
    -- ANTES de las comprobaciones de grupos, que en este plato no aplican: aquí
    -- las porciones son de toda la mesa, no de una unidad. Un producto sin
    -- partes no entra y sigue exactamente el camino de siempre.
    if exists (
      select 1 from public.option_groups og
      where og.business_id = p_business_id
        and og.product_id = v_product_id
        and og.active = true
        and og.is_meal_part = true
    ) then
      if v_quantity <> 1 or v_has_variant or coalesce(cardinality(v_extras_names), 0) > 0 then
        raise exception using errcode = '22023',
          message = format('%s se arma en una sola línea', v_product.name);
      end if;
      -- Dos líneas del mismo plato no se juntarían: la sopa en una y el segundo
      -- en otra saldrían sueltos, por menos que el precio del dueño.
      if v_product_id = any(v_platos_por_partes) then
        raise exception using errcode = '22023',
          message = format('%s va una sola vez en el pedido', v_product.name);
      end if;
      v_platos_por_partes := v_platos_por_partes || v_product_id;

      v_nota_puesta := false;
      for v_linea in
        select value from jsonb_array_elements(
          public.lineas_del_plato_por_partes(
            p_business_id, v_product_id, v_product.name, v_unit_price, v_chosen
          )
        )
      loop
        v_line_total := round(
          (v_linea ->> 'unit_price')::numeric * (v_linea ->> 'quantity')::integer, 2
        );
        v_subtotal := v_subtotal + v_line_total;

        -- Lo elegido entra también en `extras_names`, igual que en cualquier
        -- plato: es lo que el dueño lee en su panel de pedidos.
        insert into public.order_items (
          order_id, business_id, product_id, product_name,
          variant_id, variant_name, extras_names, item_note,
          quantity, unit_price, line_total
        ) values (
          v_order_id, p_business_id, v_product.id, v_linea ->> 'name',
          null, null,
          coalesce((
            select array_agg(
              case when (t.o ->> 'quantity')::integer > 1
                then format('%s x%s', t.o ->> 'option_name', t.o ->> 'quantity')
                else t.o ->> 'option_name'
              end
              order by t.orden
            )
            from jsonb_array_elements(v_linea -> 'options') with ordinality as t(o, orden)
          ), '{}'),
          -- La nota del cliente va en la PRIMERA línea, no repetida en todas.
          case when v_nota_puesta then null else v_note end,
          (v_linea ->> 'quantity')::integer,
          (v_linea ->> 'unit_price')::numeric,
          v_line_total
        )
        returning id into v_order_item_id;
        v_nota_puesta := true;

        insert into public.order_item_options (
          business_id, order_item_id, option_group_id, option_id,
          option_group_name, group_sort, option_name, quantity,
          unit_price_adjustment, total_price_adjustment
        )
        select p_business_id, v_order_item_id,
               (o ->> 'option_group_id')::uuid, (o ->> 'option_id')::uuid,
               o ->> 'option_group_name',
               coalesce((o ->> 'option_group_sort')::integer, 0),
               o ->> 'option_name',
               (o ->> 'quantity')::integer,
               (o ->> 'unit_price_adjustment')::numeric,
               round((o ->> 'unit_price_adjustment')::numeric * (o ->> 'quantity')::integer, 2)
        from jsonb_array_elements(v_linea -> 'options') o;
      end loop;
      continue;
    end if;

    -- ── Lo OBLIGATORIO se comprueba aquí, no en el navegador ──────────────
    --
    -- Un pedido sin el término de la carne llega a la cocina sin poder
    -- prepararse. La app ya lo impide, pero la app se puede saltar: esto es
    -- lo único que de verdad manda.
    for v_group in
      select og.id, og.name, og.selection_type, og.required,
             og.min_selectable, og.max_selectable,
             og.pricing_strategy, og.free_selections
      from public.option_groups og
      where og.business_id = p_business_id
        and og.active = true
        and (
          og.product_id = v_product_id
          or (og.category_id is not null and og.category_id = v_product_category)
        )
    loop
      -- En los contadores cuentan las PORCIONES; en el resto, cuántas se
      -- marcaron. Una parrillada de 4 se cumple con un corte pedido 4 veces.
      select coalesce(sum(
        case when v_group.selection_type = 'quantity'
          then (e ->> 'quantity')::integer else 1 end
      ), 0)
      into v_group_count
      from jsonb_array_elements(v_chosen) e
      where (e ->> 'option_group_id')::uuid = v_group.id;

      -- ── Lo que suma ESTE grupo, según cómo lo cobre el negocio ────────
      --
      -- Aquí vive la pizza mitad y mitad. Con `sum`, media Suprema ($10) y
      -- media Hawaiana ($9) costarían $19 —el doble de una pizza—; con
      -- `highest_selected` se cobra $10, que es como lo cobra el negocio.
      --
      -- Las estrategias con límite descuentan siempre las opciones MÁS CARAS,
      -- y nunca por orden de llegada: el mismo carrito tiene que costar lo
      -- mismo aunque se arme al revés.
      v_grupo_total := 0;
      if v_group_count > 0 then
        case coalesce(v_group.pricing_strategy, 'sum')
          when 'fixed' then v_grupo_total := 0;
          when 'included' then v_grupo_total := 0;
          when 'highest_selected' then
            -- El precio UNITARIO, sin multiplicar: dos medias pizzas son una.
            select max((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'lowest_selected' then
            select min((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'average' then
            select avg((e ->> 'unit_price_adjustment')::numeric) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
          when 'included_up_to_limit' then
            -- Las N más caras van incluidas; el resto suma entero.
            select coalesce(sum(precio * cantidad), 0) into v_grupo_total
            from (
              select (e ->> 'unit_price_adjustment')::numeric as precio,
                     (e ->> 'quantity')::integer as cantidad,
                     row_number() over (
                       order by (e ->> 'unit_price_adjustment')::numeric desc
                     ) as puesto
              from jsonb_array_elements(v_chosen) e
              where (e ->> 'option_group_id')::uuid = v_group.id
            ) ordenadas
            where puesto > coalesce(v_group.free_selections, 0);
          when 'extra_after_limit' then
            -- Igual, pero el cupo se gasta en PORCIONES: una opción puede
            -- quedar a medias —dos bolas incluidas y la tercera cobrada—.
            select coalesce(sum(precio * greatest(0, cantidad - gratis)), 0)
            into v_grupo_total
            from (
              select precio, cantidad,
                     greatest(0, least(
                       cantidad,
                       coalesce(v_group.free_selections, 0) - coalesce(previas, 0)
                     )) as gratis
              from (
                select (e ->> 'unit_price_adjustment')::numeric as precio,
                       (e ->> 'quantity')::integer as cantidad,
                       sum((e ->> 'quantity')::integer) over (
                         order by (e ->> 'unit_price_adjustment')::numeric desc
                         rows between unbounded preceding and 1 preceding
                       ) as previas
                from jsonb_array_elements(v_chosen) e
                where (e ->> 'option_group_id')::uuid = v_group.id
              ) con_previas
            ) repartido;
          else
            -- `sum`: cada opción suma su recargo por sus porciones.
            select coalesce(sum(
              (e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer
            ), 0) into v_grupo_total
            from jsonb_array_elements(v_chosen) e
            where (e ->> 'option_group_id')::uuid = v_group.id;
        end case;
        v_options_total := v_options_total + round(coalesce(v_grupo_total, 0), 2);
      end if;

      if v_group_count < greatest(
        case when v_group.required then 1 else 0 end,
        coalesce(v_group.min_selectable, 0)
      ) then
        raise exception using errcode = '22023',
          message = format('Falta elegir %s en %s', v_group.name, v_product.name);
      end if;
      if v_group_count > coalesce(v_group.max_selectable, 1) then
        raise exception using errcode = '22023',
          message = format('Demasiadas opciones en %s', v_group.name);
      end if;
    end loop;

    -- Los recargos pueden ser NEGATIVOS («sin sopa −0.50»). Acumulados podrían
    -- dejar la línea en cero o por debajo, que es un plato regalado.
    v_unit_price := round(
      v_unit_price + coalesce(v_extras_total, 0) + coalesce(v_options_total, 0), 2
    );
    if not (v_unit_price > 0) then
      raise exception using errcode = '22023',
        message = format('%s quedaria sin precio valido con esas opciones', v_product.name);
    end if;

    v_line_total := round(v_unit_price * v_quantity, 2);
    v_subtotal := v_subtotal + v_line_total;

    -- `extras_names` es lo que el DUEÑO ve en su panel de pedidos. Las opciones
    -- entran ahí ADEMÁS de en `order_item_options`: si solo fueran a la tabla
    -- nueva, el pedido se vería sin lo que el cliente pidió.
    insert into public.order_items (
      order_id, business_id, product_id, product_name,
      variant_id, variant_name, extras_names, item_note,
      quantity, unit_price, line_total
    ) values (
      v_order_id, p_business_id, v_product.id, v_product.name,
      v_variant_ref, v_variant_label,
      coalesce(v_extras_names, '{}') || coalesce(v_options_names, '{}'), v_note,
      v_quantity, v_unit_price, v_line_total
    )
    returning id into v_order_item_id;

    -- La fotografía inmutable de lo elegido, con su precio congelado: si
    -- mañana cambia el recargo, el pedido de ayer sigue diciendo lo que costó.
    insert into public.order_item_options (
      business_id, order_item_id, option_group_id, option_id,
      option_group_name, group_sort, option_name, quantity,
      unit_price_adjustment, total_price_adjustment
    )
    select p_business_id, v_order_item_id,
           (e ->> 'option_group_id')::uuid, (e ->> 'option_id')::uuid,
           e ->> 'option_group_name',
           coalesce((e ->> 'option_group_sort')::integer, 0),
           e ->> 'option_name',
           (e ->> 'quantity')::integer,
           (e ->> 'unit_price_adjustment')::numeric,
           round((e ->> 'unit_price_adjustment')::numeric * (e ->> 'quantity')::integer, 2)
    from jsonb_array_elements(v_chosen) e;
  end loop;

  -- ── El envío: fijo del negocio, y SOLO si se lleva a domicilio ───────────
  -- Quien retira en el local no paga envío. El importe sale de la ficha del
  -- negocio, nunca del teléfono del cliente (regla inviolable #8).
  v_subtotal := round(v_subtotal, 2);
  if p_fulfillment = 'delivery' then
    v_shipping := round(coalesce(v_business.delivery_fee, 0), 2);
  end if;

  update public.orders
  set subtotal = v_subtotal,
      shipping = v_shipping,
      total = round(v_subtotal + v_shipping, 2)
  where id = v_order_id;

  return jsonb_build_object(
    'id', v_order_id,
    -- Lo puso el trigger al insertar. Es lo que ve el cliente en la pantalla
    -- de confirmación y lo que canta el dueño en la cocina.
    'order_number', (select order_number from public.orders where id = v_order_id),
    'subtotal', v_subtotal,
    'shipping', v_shipping,
    'total', round(v_subtotal + v_shipping, 2),
    'items', v_count
  );
end;
$$;


-- ── 4. El local acepta la tarjeta si el SUPERADMIN la encendió ────────────
--
-- `orders_check_payment_method` exigía una fila en `business_payment_methods`,
-- que edita el dueño. La tarjeta se decide en `businesses.card_mode`: el resto
-- de métodos sigue exactamente igual.
create or replace function public.orders_check_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.source, '') = 'storefront'
     and new.payment_method = 'tarjeta' then
    if not exists (
      select 1 from public.businesses
      where id = new.business_id and card_mode is not null
    ) then
      raise exception using
        errcode = '22023',
        message = 'Ese local no acepta ese método de pago.';
    end if;
    return new;
  end if;

  if coalesce(new.source, '') = 'storefront'
     and new.payment_method is not null
     and not exists (
       select 1
       from public.business_payment_methods bpm
       join public.payment_methods pm on pm.code = bpm.method_code
       where bpm.business_id = new.business_id
         and bpm.method_code = new.payment_method
         and bpm.enabled
         and pm.available
     ) then
    raise exception using
      errcode = '22023',
      message = 'Ese local no acepta ese método de pago.';
  end if;
  return new;
end;
$$;


-- ── 5. Con tarjeta NO se pide comprobante ─────────────────────────────────
--
-- Al nacer en `esperando_pago`, este disparador ponía la conversación en
-- `esperando_comprobante` y el chat le pedía al cliente una FOTO de una
-- transferencia que nunca va a hacer. Con tarjeta se conserva lo que hacía de
-- paso —borrar la pregunta pendiente, para que un «Empezar de nuevo» de antes
-- no cancele el pedido recién nacido— y NO se toca el estado.
create or replace function public.orders_mark_awaiting_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.customer_id is null
     or coalesce(new.source, '') <> 'storefront'
     or new.status <> 'esperando_pago' then
    return new;
  end if;

  begin
    update public.marketplace_conversations as conv
       set current_state = case
             when new.payment_method = 'tarjeta' then conv.current_state
             else 'esperando_comprobante'
           end,
           -- ⚠️ La vista se BORRA (2026-09-27). Si el cliente tenía pendiente
           -- «¿Empezamos de nuevo o sigues?», su «Empezar de nuevo» —el botón
           -- o un «1» escrito— cancelaba este pedido recién nacido, aunque ya
           -- hubiera transferido. Esa pregunta era sobre un carrito; ahora hay
           -- un pedido y manda el candado.
           flow_state    = null,
           version       = conv.version + 1,
           updated_at    = now()
     where conv.customer_id = new.customer_id
       -- Solo si está en ESE local: si la conversación anda en otro sitio,
       -- pisarle el estado la sacaría de donde está.
       and conv.selected_business_id = new.business_id
       and case
             -- Tarjeta: solo hay algo que hacer si queda una pregunta pendiente.
             when new.payment_method = 'tarjeta' then conv.flow_state is not null
             else conv.current_state <> 'esperando_comprobante'
           end;
  exception when others then
    -- El pedido ya existe. Un fallo marcando la conversación no puede
    -- deshacerlo: lo peor que pasa es que el bot dé el mensaje de antes.
    null;
  end;

  return new;
end;
$$;

comment on function public.orders_mark_awaiting_receipt() is
  'Al crear un pedido que espera transferencia, la conversación pasa a '
  'esperando_comprobante y se borra cualquier pregunta pendiente: un «Empezar '
  'de nuevo» de antes de pedir no puede cancelar el pedido recién nacido. '
  'Con tarjeta solo se borra la pregunta: no hay comprobante que pedir.';


-- ── 6. Un pedido con tarjeta NO avanza sin el cobro confirmado ────────────
--
-- `set_order_status` permite `esperando_pago → preparacion` para quien
-- transfirió por fuera y avisó por WhatsApp. Con tarjeta eso es regalar la
-- comida: el dinero solo existe si PayPhone lo confirmó. Vive aquí, en la
-- base, porque es la única puerta que no se salta desde ningún panel.
--
-- Sin cobro solo se puede: seguir esperando, o morir (cancelar, rechazar,
-- caducar).
create or replace function public.orders_card_requires_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_method = 'tarjeta'
     and new.status is distinct from old.status
     and new.payment_confirmed_at is null
     and new.status not in ('esperando_pago', 'cancelado', 'rechazado', 'expirado') then
    raise exception using
      errcode = '22023',
      message = 'Este pedido se paga con tarjeta y el cobro aún no está confirmado.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_card_requires_payment on public.orders;
create trigger orders_card_requires_payment
  before update of status on public.orders
  for each row execute function public.orders_card_requires_payment();


-- ── 7. Pedido pagado y luego cancelado → se devuelve ──────────────────────
--
-- Si el local rechaza o cancela un pedido YA cobrado, el dinero es del
-- cliente. El pago pasa a `por_devolver` y la tarea del servidor lo revierte
-- en PayPhone. Por disparador, para que ninguna puerta (panel, caducidad,
-- superadmin) pueda cancelar sin dejar la devolución en marcha.
create or replace function public.orders_card_refund_on_cancel()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.payment_method = 'tarjeta'
     and new.status is distinct from old.status
     and new.status in ('cancelado', 'rechazado', 'expirado') then
    update public.payments
       set status = 'por_devolver',
           status_detail = 'El pedido pasó a ' || new.status,
           next_check_at = now(),
           updated_at = now()
     where order_id = new.id
       and status = 'aprobado';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_card_refund_on_cancel on public.orders;
create trigger orders_card_refund_on_cancel
  after update of status on public.orders
  for each row execute function public.orders_card_refund_on_cancel();


-- ── 8. La caducidad no toca un cobro en curso ─────────────────────────────
--
-- Lo mismo de antes, con dos frenos más:
--   · Un pedido con un intento de tarjeta VIVO (el cliente está en la página
--     de PayPhone o se está confirmando) no caduca: caducarlo a mitad dejaría
--     el cobro sin pedido.
--   · Con tarjeta, la ventana es como mucho de 30 minutos: pagar con tarjeta
--     tarda un minuto, y quien lo abandona no tiene por qué quedarse con el
--     candado puesto dos horas.
create or replace function public.expire_unpaid_orders(
  p_limite integer default 20
)
returns table (
  order_id uuid,
  business_id uuid,
  order_number integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fila record;
  v_hechos integer := 0;
begin
  for v_fila in
    select o.id, o.business_id, o.order_number
    from public.orders o
    join public.businesses b on b.id = o.business_id
    where o.status = 'esperando_pago'
      and coalesce(o.source, '') = 'storefront'
      and o.payment_proof_url is null
      and o.payment_confirmed_at is null
      and b.payment_window_minutes > 0
      and o.created_at < now() - make_interval(mins => case
            when o.payment_method = 'tarjeta' then least(b.payment_window_minutes, 30)
            else b.payment_window_minutes
          end)
      and o.created_at > now() - interval '24 hours'
      and not exists (
        select 1 from public.payments p
        where p.order_id = o.id
          and p.status in ('iniciado', 'confirmando')
      )
    order by o.created_at
    limit greatest(1, least(coalesce(p_limite, 20), 100))
  loop
    begin
      perform public.set_order_status(v_fila.business_id, v_fila.id, 'expirado');
      order_id := v_fila.id;
      business_id := v_fila.business_id;
      order_number := v_fila.order_number;
      v_hechos := v_hechos + 1;
      return next;
    exception when others then
      null;
    end;
  end loop;

  return;
end;
$$;

revoke all on function public.expire_unpaid_orders(integer) from public, anon, authenticated;
grant execute on function public.expire_unpaid_orders(integer) to service_role;


-- ── 9. Iniciar un cobro ───────────────────────────────────────────────────
--
-- La mini app pide pagar un pedido; la base comprueba que es de ESA persona
-- (negocio + pedido + teléfono de la sesión, igual que el comprobante), que
-- se paga con tarjeta, que sigue esperando el pago y que el local cobra en el
-- MISMO modo que el servidor. El monto sale del pedido, en centavos.
-- Frenos contra tarjetas robadas (2026-09-29): ver
-- `migration-2026-09-29-frenos-de-tarjeta.sql`.
-- Los números del freno, en un solo sitio. Cambiarlos es una migración.
create or replace function public.frenos_de_tarjeta()
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'intentos_por_hora', 5,
    'rechazos_por_dia', 3,
    'tope_por_pedido_cents', 15000
  )
$$;

revoke all on function public.frenos_de_tarjeta() from public, anon, authenticated;
grant execute on function public.frenos_de_tarjeta() to service_role;

-- ¿Tiene este cliente la tarjeta apagada por rechazos recientes?
create or replace function public.tarjeta_apagada_para(p_customer_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p_customer_id is not null and (
    select count(*)
      from public.payments p
      join public.orders o on o.id = p.order_id and o.business_id = p.business_id
     where o.customer_id = p_customer_id
       and p.status = 'rechazado'
       and p.updated_at > now() - interval '24 hours'
  ) >= (public.frenos_de_tarjeta() ->> 'rechazos_por_dia')::integer
$$;

revoke all on function public.tarjeta_apagada_para(uuid) from public, anon, authenticated;
grant execute on function public.tarjeta_apagada_para(uuid) to service_role;

-- El pedido con tarjeta: ni por encima del tope, ni de un cliente con la
-- tarjeta apagada. El mensaje llega tal cual a la tienda.
create or replace function public.orders_tope_de_tarjeta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tope integer := (public.frenos_de_tarjeta() ->> 'tope_por_pedido_cents')::integer;
begin
  if tg_op = 'INSERT' and public.tarjeta_apagada_para(new.customer_id) then
    raise exception using
      errcode = 'P0001',
      message = 'Por seguridad, el pago con tarjeta está desactivado 24 horas para tu número '
        || 'tras varios intentos rechazados. Puedes pagar en efectivo o por transferencia.';
  end if;
  if round(coalesce(new.total, 0) * 100) > v_tope then
    raise exception using
      errcode = 'P0001',
      message = format(
        'Con tarjeta el máximo por pedido es $%s y tu pedido suma $%s. Paga en efectivo o por transferencia.',
        to_char(v_tope / 100.0, 'FM999999990.00'),
        to_char(coalesce(new.total, 0), 'FM999999990.00')
      );
  end if;
  return new;
end;
$$;

revoke all on function public.orders_tope_de_tarjeta() from public, anon, authenticated;

drop trigger if exists orders_tope_de_tarjeta on public.orders;
create trigger orders_tope_de_tarjeta
  before insert or update of total, payment_method on public.orders
  for each row when (new.payment_method = 'tarjeta' and new.payment_confirmed_at is null)
  execute function public.orders_tope_de_tarjeta();

-- Y el inicio del cobro, con el freno POR CLIENTE, la tarjeta apagada y el tope.
create or replace function public.start_card_payment(
  p_business_id uuid,
  p_order_id uuid,
  p_contact_phone text,
  p_environment text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order     public.orders%rowtype;
  v_modo      text;
  v_centavos  integer;
  v_intentos  integer;
  v_referencia text;
  v_pago_id   uuid;
  v_frenos    jsonb := public.frenos_de_tarjeta();
begin
  if p_environment is null or p_environment not in ('pruebas', 'produccion') then
    raise exception using errcode = '22023', message = 'Modo de cobro inválido';
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
    and business_id = p_business_id
    and contact_phone = btrim(coalesce(p_contact_phone, ''))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if coalesce(v_order.payment_method, '') <> 'tarjeta' then
    return jsonb_build_object('result', 'not_card');
  end if;

  if v_order.payment_confirmed_at is not null
     or exists (select 1 from public.payments where order_id = p_order_id and status = 'aprobado') then
    return jsonb_build_object('result', 'already_paid');
  end if;

  if v_order.status <> 'esperando_pago' then
    return jsonb_build_object('result', 'not_payable', 'status', v_order.status);
  end if;

  select card_mode into v_modo from public.businesses where id = p_business_id;
  if v_modo is distinct from p_environment then
    return jsonb_build_object('result', 'card_unavailable');
  end if;

  -- Freno contra quien prueba tarjetas robadas: 5 intentos por pedido y hora.
  select count(*) into v_intentos
  from public.payments
  where order_id = p_order_id
    and created_at > now() - interval '1 hour';
  if v_intentos >= 5 then
    return jsonb_build_object('result', 'too_many_attempts');
  end if;

  -- ⚠️ Y POR CLIENTE, entre todos sus pedidos (2026-09-29): el freno por pedido
  -- se esquivaba creando pedidos nuevos, que es justo lo que hace quien prueba
  -- tarjetas robadas.
  if v_order.customer_id is not null then
    select count(*) into v_intentos
    from public.payments p
    join public.orders o on o.id = p.order_id and o.business_id = p.business_id
    where o.customer_id = v_order.customer_id
      and p.created_at > now() - interval '1 hour';
    if v_intentos >= (v_frenos ->> 'intentos_por_hora')::integer then
      return jsonb_build_object('result', 'too_many_attempts');
    end if;
  end if;

  -- Tarjeta apagada para este cliente por rechazos recientes.
  if public.tarjeta_apagada_para(v_order.customer_id) then
    return jsonb_build_object('result', 'card_blocked');
  end if;

  v_centavos := round(coalesce(v_order.total, 0) * 100)::integer;
  if v_centavos <= 0 then
    return jsonb_build_object('result', 'not_payable', 'status', v_order.status);
  end if;

  -- El tope por pedido, otra vez aquí: el disparador lo impide al crear el
  -- pedido, y esto es el cinturón para uno que llegara por otro camino.
  if v_centavos > (v_frenos ->> 'tope_por_pedido_cents')::integer then
    return jsonb_build_object('result', 'over_card_limit');
  end if;

  v_referencia := replace(gen_random_uuid()::text, '-', '');

  insert into public.payments (
    business_id, order_id, provider, method, environment,
    client_transaction_id, amount_cents, currency, status,
    -- La primera consulta de la tarea llega en un minuto: si el teléfono no
    -- vuelve con la redirección, el cobro se busca igual.
    next_check_at
  ) values (
    p_business_id, p_order_id, 'payphone', 'tarjeta', p_environment,
    v_referencia, v_centavos, 'USD', 'iniciado',
    now() + interval '60 seconds'
  )
  returning id into v_pago_id;

  return jsonb_build_object(
    'result', 'ok',
    'payment_id', v_pago_id,
    'client_transaction_id', v_referencia,
    'amount_cents', v_centavos,
    'currency', 'USD',
    'order_number', v_order.order_number
  );
end;
$$;

revoke all on function public.start_card_payment(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.start_card_payment(uuid, uuid, text, text)
  to service_role;


-- ── 10. ¿Se confirma? — lo decide la base ANTES de llamar a PayPhone ──────
--
-- `Confirm` es lo que CAPTURA el dinero. Por eso se pregunta primero: si el
-- pedido ya no se puede cobrar, el intento pasa a `no_confirmado`, nadie
-- llama a PayPhone y PayPhone devuelve el dinero solo a los 5 minutos.
--
-- Idempotente: si el intento ya está resuelto, devuelve su estado y no toca
-- nada. La redirección y la tarea del servidor pueden llegar a la vez.
create or replace function public.claim_card_payment(
  p_client_transaction_id text,
  p_provider_transaction_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pago  public.payments%rowtype;
  v_order public.orders%rowtype;
  v_modo  text;
  v_id    text := nullif(btrim(coalesce(p_provider_transaction_id, '')), '');
  v_motivo text;
begin
  select * into v_pago
  from public.payments
  where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_pago.status not in ('iniciado', 'confirmando') then
    return jsonb_build_object('result', 'final', 'status', v_pago.status,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  -- Un id de PayPhone que no es el que ya teníamos: alguien armó la URL a
  -- mano. No se confirma nada con él.
  if v_id is not null and v_pago.provider_transaction_id is not null
     and v_pago.provider_transaction_id <> v_id then
    return jsonb_build_object('result', 'mismatch', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  select * into v_order from public.orders where id = v_pago.order_id for update;
  select card_mode into v_modo from public.businesses where id = v_pago.business_id;

  v_motivo := case
    when v_order.id is null then 'El pedido ya no existe'
    when v_order.status <> 'esperando_pago' then 'El pedido pasó a ' || v_order.status
    when v_order.payment_confirmed_at is not null then 'El pedido ya estaba pagado'
    when exists (select 1 from public.payments
                 where order_id = v_pago.order_id and status = 'aprobado') then 'Ya se pagó con otro intento'
    when v_modo is distinct from v_pago.environment then 'El local cambió de modo de cobro'
    when round(coalesce(v_order.total, 0) * 100)::integer <> v_pago.amount_cents then 'El total del pedido cambió'
    else null
  end;

  if v_motivo is not null then
    update public.payments
       set status = 'no_confirmado',
           status_detail = v_motivo,
           provider_transaction_id = coalesce(provider_transaction_id, v_id),
           updated_at = now()
     where id = v_pago.id;
    return jsonb_build_object('result', 'dont_confirm', 'reason', v_motivo,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  update public.payments
     set status = 'confirmando',
         provider_transaction_id = coalesce(provider_transaction_id, v_id),
         confirm_attempts = confirm_attempts + 1,
         -- Si la respuesta no llega (se cayó el proceso), la tarea lo retoma.
         next_check_at = now() + interval '30 seconds',
         updated_at = now()
   where id = v_pago.id
  returning * into v_pago;

  return jsonb_build_object(
    'result', 'confirm',
    'order_id', v_pago.order_id,
    'business_id', v_pago.business_id,
    'environment', v_pago.environment,
    'client_transaction_id', v_pago.client_transaction_id,
    'provider_transaction_id', v_pago.provider_transaction_id,
    'amount_cents', v_pago.amount_cents
  );
end;
$$;

revoke all on function public.claim_card_payment(text, text)
  from public, anon, authenticated;
grant execute on function public.claim_card_payment(text, text)
  to service_role;


-- ── 11. Asentar la respuesta de PayPhone ──────────────────────────────────
--
-- Aquí se decide si el dinero cuadra. Aprobado + cobrado == pedido == intento
-- (en centavos) + moneda USD → el pedido queda pagado y pasa a `pendiente`,
-- que es cuando el local lo ve como pedido nuevo y le suena la alarma. Si
-- algo no cuadra, NO se toca el pedido: el pago pasa a `por_devolver`.
--
-- ⚠️ Mueve el estado con un UPDATE propio + su fila en `order_events`, igual
-- que `attach_storefront_payment_proof`. `set_order_status` no permite
-- `esperando_pago → pendiente`, y abrir esa transición para todos dejaría
-- que un pedido por transferencia saltara el pago.
create or replace function public.settle_card_payment(
  p_client_transaction_id text,
  p_provider_transaction_id text,
  p_status_code integer,
  p_captured_cents integer,
  p_currency text,
  p_authorization_code text default null,
  p_card_brand text default null,
  p_last_digits text default null,
  p_detail text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pago    public.payments%rowtype;
  v_order   public.orders%rowtype;
  v_modo    text;
  v_id      text := nullif(btrim(coalesce(p_provider_transaction_id, '')), '');
  v_ultimos text := nullif(regexp_replace(coalesce(p_last_digits, ''), '[^0-9]', '', 'g'), '');
  v_marca   text := left(nullif(btrim(coalesce(p_card_brand, '')), ''), 30);
  v_detalle text := left(nullif(btrim(coalesce(p_detail, '')), ''), 300);
  v_motivo  text;
begin
  select * into v_pago
  from public.payments
  where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
  for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- Ya resuelto: se contesta lo que hay, sin tocar nada.
  if v_pago.status not in ('iniciado', 'confirmando') then
    return jsonb_build_object('result', 'final', 'status', v_pago.status,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  if v_id is not null and v_pago.provider_transaction_id is not null
     and v_pago.provider_transaction_id <> v_id then
    return jsonb_build_object('result', 'mismatch', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  if v_ultimos is not null then
    v_ultimos := right(v_ultimos, 4);
  end if;

  -- ── Sin respuesta firme (1 = pendiente en PayPhone): no se toca nada ────
  -- La tarea del servidor volverá a preguntar. Marcarlo rechazado dejaría
  -- reintentar al cliente con el primer cobro todavía vivo.
  if coalesce(p_status_code, 0) not in (2, 3) then
    return jsonb_build_object('result', 'pending', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  -- ── No aprobado: el pedido sigue esperando, el cliente puede reintentar ──
  if p_status_code = 2 then
    update public.payments
       set status = 'rechazado',
           status_detail = coalesce(v_detalle, 'PayPhone no aprobó el cobro'),
           provider_transaction_id = coalesce(provider_transaction_id, v_id),
           card_brand = coalesce(v_marca, card_brand),
           card_last_digits = coalesce(v_ultimos, card_last_digits),
           updated_at = now()
     where id = v_pago.id;
    return jsonb_build_object('result', 'rejected', 'order_id', v_pago.order_id,
                              'business_id', v_pago.business_id);
  end if;

  -- ── Aprobado: ¿cuadra al centavo y el pedido sigue para cobrarse? ────────
  select * into v_order from public.orders where id = v_pago.order_id for update;
  select card_mode into v_modo from public.businesses where id = v_pago.business_id;

  v_motivo := case
    when p_captured_cents is null or p_captured_cents <> v_pago.amount_cents
      then format('Descuadre: PayPhone cobró %s centavos y se esperaban %s',
                  coalesce(p_captured_cents::text, '?'), v_pago.amount_cents)
    when upper(coalesce(p_currency, '')) <> v_pago.currency
      then 'Descuadre: moneda ' || coalesce(p_currency, '?')
    when v_order.id is null then 'El pedido ya no existe'
    when round(coalesce(v_order.total, 0) * 100)::integer <> v_pago.amount_cents
      then format('Descuadre: el pedido vale %s centavos y el cobro %s',
                  round(coalesce(v_order.total, 0) * 100)::integer, v_pago.amount_cents)
    when v_order.status <> 'esperando_pago' then 'El pedido pasó a ' || v_order.status
    when v_order.payment_confirmed_at is not null then 'El pedido ya estaba pagado'
    when exists (select 1 from public.payments
                 where order_id = v_pago.order_id and status = 'aprobado') then 'Ya se pagó con otro intento'
    when v_modo is distinct from v_pago.environment then 'El local cambió de modo de cobro'
    else null
  end;

  if v_motivo is not null then
    update public.payments
       set status = 'por_devolver',
           status_detail = v_motivo,
           provider_transaction_id = coalesce(provider_transaction_id, v_id),
           captured_cents = p_captured_cents,
           authorization_code = left(nullif(btrim(coalesce(p_authorization_code, '')), ''), 60),
           card_brand = v_marca,
           card_last_digits = v_ultimos,
           next_check_at = now(),
           updated_at = now()
     where id = v_pago.id;
    return jsonb_build_object('result', 'refund', 'reason', v_motivo,
                              'order_id', v_pago.order_id, 'business_id', v_pago.business_id);
  end if;

  update public.payments
     set status = 'aprobado',
         status_detail = null,
         provider_transaction_id = coalesce(provider_transaction_id, v_id),
         captured_cents = p_captured_cents,
         authorization_code = left(nullif(btrim(coalesce(p_authorization_code, '')), ''), 60),
         card_brand = v_marca,
         card_last_digits = v_ultimos,
         approved_at = now(),
         updated_at = now()
   where id = v_pago.id;

  update public.orders
     set payment_confirmed_at = now(),
         status = 'pendiente',
         updated_at = now()
   where id = v_order.id;

  insert into public.order_events (business_id, order_id, from_status, to_status, note)
  values (v_order.business_id, v_order.id, 'esperando_pago', 'pendiente',
          left('Pagado con tarjeta' || coalesce(' · ' || v_marca, '')
               || coalesce(' ···' || v_ultimos, ''), 200));

  return jsonb_build_object(
    'result', 'approved',
    'order_id', v_order.id,
    'business_id', v_order.business_id,
    'order_number', v_order.order_number
  );
end;
$$;

revoke all on function public.settle_card_payment(text, text, integer, integer, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.settle_card_payment(text, text, integer, integer, text, text, text, text, text)
  to service_role;


-- ── 12. La cola de la tarea del servidor ──────────────────────────────────
--
-- Reserva los intentos que toca mirar y los aparta un rato (`p_lease_s`) para
-- que dos instancias del servidor no trabajen el mismo. `skip locked`: lo que
-- ya está cogiendo otro, se salta.
create or replace function public.lease_card_payments(
  p_limite integer default 10,
  p_lease_s integer default 45
)
returns table (
  id uuid,
  business_id uuid,
  order_id uuid,
  environment text,
  client_transaction_id text,
  provider_transaction_id text,
  status text,
  amount_cents integer,
  confirm_attempts integer,
  created_at timestamptz
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  return query
  with toca as (
    select p.id
    from public.payments p
    where p.status in ('iniciado', 'confirmando', 'por_devolver')
      and p.next_check_at <= now()
    order by p.next_check_at
    limit greatest(1, least(coalesce(p_limite, 10), 50))
    for update skip locked
  )
  update public.payments p
     set next_check_at = now() + make_interval(secs => greatest(10, least(coalesce(p_lease_s, 45), 600))),
         updated_at = now()
    from toca
   where p.id = toca.id
  returning p.id, p.business_id, p.order_id, p.environment, p.client_transaction_id,
            p.provider_transaction_id, p.status, p.amount_cents, p.confirm_attempts,
            p.created_at;
end;
$$;

revoke all on function public.lease_card_payments(integer, integer)
  from public, anon, authenticated;
grant execute on function public.lease_card_payments(integer, integer)
  to service_role;


-- ── 13. Cerrar lo que no llegó a cobrarse ─────────────────────────────────
--
-- Un intento que nadie pagó (la página de PayPhone vale 10 minutos) caduca.
-- Solo desde `iniciado`: uno en `confirmando` puede tener el dinero ya
-- capturado, y ese se resuelve preguntándole a PayPhone, no por el reloj.
create or replace function public.expire_card_payment(
  p_client_transaction_id text,
  p_detail text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_filas integer;
begin
  update public.payments
     set status = 'caducado',
         status_detail = left(coalesce(nullif(btrim(p_detail), ''), 'Nadie pagó dentro del plazo'), 300),
         updated_at = now()
   where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
     and status = 'iniciado'
     and created_at < now() - interval '10 minutes';
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;

revoke all on function public.expire_card_payment(text, text)
  from public, anon, authenticated;
grant execute on function public.expire_card_payment(text, text)
  to service_role;


-- ── 14. La devolución, resuelta ───────────────────────────────────────────
--
-- `devuelto` si la API de PayPhone lo revirtió; `devolucion_manual` si no se
-- pudo (PayPhone solo revierte el mismo día y antes de las 20:00): entonces
-- lo devuelve una persona y el superadmin lo ve pendiente.
create or replace function public.finish_card_refund(
  p_client_transaction_id text,
  p_reversed boolean,
  p_detail text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_filas integer;
begin
  update public.payments
     set status = case when p_reversed then 'devuelto' else 'devolucion_manual' end,
         reversed_at = case when p_reversed then now() else reversed_at end,
         status_detail = left(coalesce(
           nullif(btrim(coalesce(p_detail, '')), ''),
           status_detail
         ), 300),
         updated_at = now()
   where client_transaction_id = btrim(coalesce(p_client_transaction_id, ''))
     and status = 'por_devolver';
  get diagnostics v_filas = row_count;
  return v_filas > 0;
end;
$$;

revoke all on function public.finish_card_refund(text, boolean, text)
  from public, anon, authenticated;
grant execute on function public.finish_card_refund(text, boolean, text)
  to service_role;


-- ── 15. Las alertas de DINERO tienen categoría propia ─────────────────────
--
-- Un descuadre o una devolución que PayPhone no dejó hacer no puede perderse
-- entre los avisos del servidor: el superadmin los filtra por «Pagos».
-- La función se copia ENTERA de `schema.sql` (la vigente) y solo cambia la
-- lista de categorías.
alter table public.platform_errors
  drop constraint if exists platform_errors_category_check;
alter table public.platform_errors
  add constraint platform_errors_category_check
  check (category in ('canal', 'ia', 'envio', 'servidor', 'pagos'));

create or replace function public.record_platform_error(
  p_business_id uuid,
  p_category text,
  p_code text,
  p_message text,
  p_context jsonb,
  p_fingerprint text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_message text;
  v_context jsonb;
begin
  if p_category not in ('canal', 'ia', 'envio', 'servidor', 'pagos') then
    raise exception using errcode = '22023', message = 'Categoria de error invalida';
  end if;
  if p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'Huella de error invalida';
  end if;

  v_message := left(coalesce(nullif(btrim(p_message), ''), 'Error sin detalle'), 2000);
  v_context := case
    when jsonb_typeof(p_context) = 'object' and pg_column_size(p_context) <= 8192
      then p_context
    else '{}'::jsonb
  end;

  -- Upsert atómico. Se resuelve con `on conflict` sobre los índices parciales en
  -- lugar de capturar excepciones: así el registro nunca deja una transacción a
  -- medias, ni siquiera si dos errores idénticos llegan a la vez.
  if p_business_id is null then
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      null, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (fingerprint) where business_id is null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  else
    insert into public.platform_errors (
      business_id, category, code, message, context, fingerprint
    ) values (
      p_business_id, p_category, left(p_code, 120), v_message, v_context, p_fingerprint
    )
    on conflict (business_id, fingerprint) where business_id is not null do update
    set occurrences = public.platform_errors.occurrences + 1,
        last_seen_at = now(),
        code = excluded.code,
        message = excluded.message,
        context = excluded.context
    returning id into v_id;
  end if;

  return v_id;
end;
$$;



-- ════════════════════════════════════════════════════════════════════════
-- CUENTAS Y LIQUIDACIÓN SEMANAL
-- (migration-2026-09-28-cuentas-y-liquidacion-semanal.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- LAS CUENTAS DE CADA UNO Y EL CIERRE SEMANAL (como las grandes)
--
-- Decisión del dueño (2026-09-27). Con la tarjeta, el dinero entra en la
-- cuenta de Umbani y hay que LIQUIDAR a cada local; con el efectivo y la
-- transferencia, el dinero lo tiene el local y es él quien debe la comisión.
-- Un solo mecanismo para los dos, y para el motorizado cuando exista:
--
--   Cada pedido ENTREGADO registra a qué tiene DERECHO cada uno (el local, sus
--   productos; quien reparte, la carrera; Umbani, su comisión) y QUIÉN TIENE
--   EL DINERO EN LA MANO (tarjeta → Umbani; efectivo o transferencia → el
--   local). Saldo = derecho − en mano. Cada lunes se cierra la semana: al que
--   tiene saldo a favor se le paga; al que debe, se le descuenta de lo
--   siguiente o se le cobra.
--
--   Invariante, que la base comprueba en CADA pedido:
--     local + reparto + Umbani = lo que pagó el cliente.
--
-- ⚠️ EL CORTE: lunes 2026-09-28, hora de Ecuador. Lo vendido ANTES se sigue
-- cobrando en la factura mensual de septiembre, como siempre; lo vendido
-- DESDE el corte va al libro y a la liquidación semanal. `settle_month_commission`
-- se detiene en el corte: sin ese tope, la comisión se cobraría dos veces.
--
-- ⚠️ Facturación queda para la CUOTA mensual ($25 por estar en Umbani). Si el
-- local tiene saldo a favor, la cuota pendiente se descuenta del depósito,
-- como hacen las grandes; si no, se cobra aparte.
-- ============================================================================


-- ── 1. El corte, escrito en un solo sitio ─────────────────────────────────
create or replace function public.liquidacion_semanal_desde()
returns date
-- `stable` y no `immutable`: una inmutable se evalúa al PLANIFICAR y quedaría
-- congelada dentro de los planes guardados de las funciones que la usan.
language sql
stable
set search_path = public, pg_temp
as $$
  select date '2026-09-28'
$$;

comment on function public.liquidacion_semanal_desde() is
  'Desde este lunes (hora EC) la comisión se liquida por semana; antes, en la factura mensual.';


-- ── 2. Lo que cobra PayPhone, en puntos básicos (575 = 5,75 %) ────────────
--
-- Es una ESTIMACIÓN para enseñarle a Umbani lo que le queda: PayPhone no la
-- manda al confirmar. Se negocia con PayPhone, así que vive en
-- `server_settings` (`payphone_fee_bps`) y no en el código.
create or replace function public.comision_payphone_bps()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select btrim(value)::integer
    from public.server_settings
    where key = 'payphone_fee_bps' and btrim(value) ~ '^[0-9]{1,4}$'
  ), 575)
$$;

revoke all on function public.comision_payphone_bps() from public, anon, authenticated;
grant execute on function public.comision_payphone_bps() to service_role;


-- ── 3. Las liquidaciones de cada semana ───────────────────────────────────
--
-- Una por local y semana (lunes a domingo, hora EC). `party` y `courier_id`
-- existen desde hoy para el motorizado: su liquidación será otra fila igual.
create table if not exists public.settlements (
  id             uuid primary key default gen_random_uuid(),
  business_id    uuid not null references public.businesses(id) on delete cascade,
  party          text not null default 'local',
  courier_id     uuid,
  period_start   date not null,
  period_end     date not null,
  orders_count   integer not null default 0,
  -- Lo que le correspondía (sus productos, y la carrera si reparte él).
  derecho_cents  integer not null default 0,
  -- Lo que ya tenía en la mano (efectivo y transferencias que cobró él).
  en_mano_cents  integer not null default 0,
  -- Lo que debía de semanas anteriores y no pagó: se compensa aquí.
  arrastre_cents integer not null default 0,
  -- La factura mensual pendiente que se descontó de este depósito.
  cuota_cents    integer not null default 0,
  billing_id     uuid,
  -- > 0: Umbani le paga · < 0: el local le debe a Umbani.
  neto_cents     integer not null,
  status         text not null,
  paid_at        timestamptz,
  reference      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint settlements_party_check check (party in ('local', 'motorizado')),
  constraint settlements_status_check check (status in (
    'por_pagar', 'por_cobrar', 'en_cero', 'pagada', 'cobrada', 'compensada'
  )),
  constraint settlements_semana_check check (
    extract(isodow from period_start) = 1 and period_end = period_start + 6
  ),
  -- El neto no se escribe: se deduce. Si alguien lo tocara a mano, no cuadra.
  constraint settlements_cuadra check (
    neto_cents = derecho_cents - en_mano_cents + arrastre_cents - cuota_cents
  ),
  constraint settlements_reference_check check (
    reference is null or char_length(btrim(reference)) between 3 and 120
  )
);

alter table public.settlements enable row level security;
revoke all on table public.settlements from anon, authenticated;

-- Una liquidación por local y semana: cerrar dos veces no duplica nada.
create unique index if not exists settlements_una_por_semana
  on public.settlements (business_id, party, period_start)
  where courier_id is null;
-- Destino de foránea compuesta: el libro no puede colgarse de la liquidación
-- de OTRO negocio.
create unique index if not exists uq_settlements_id_business
  on public.settlements (id, business_id);
create index if not exists idx_settlements_pendientes
  on public.settlements (status, period_start)
  where status in ('por_pagar', 'por_cobrar');


-- ── 4. El libro de cada pedido ────────────────────────────────────────────
--
-- Nace cuando el pedido se ENTREGA (con su venta): un pedido cancelado nunca
-- es dinero de nadie. Todo en centavos enteros, y el del local se deduce
-- RESTANDO del total (`total − Umbani − reparto`), como en las tres bolsas:
-- así cuadra sin preguntar el modo de margen.
create table if not exists public.order_ledger (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  order_id           uuid not null,
  sale_id            uuid,
  -- `reverso`: la venta se anuló DESPUÉS de liquidarla; resta en la siguiente.
  kind               text not null default 'venta',
  sold_at            timestamptz not null,
  payment_method     text,
  total_cents        integer not null,
  local_cents        integer not null,
  reparto_cents      integer not null,
  umbani_cents       integer not null,
  -- Lo que se estima que cobra PayPhone (solo tarjeta). Es costo de Umbani:
  -- NO se le descuenta al local, y por eso no entra en el invariante.
  provider_fee_cents integer not null default 0,
  -- Hoy reparte el local. Con motorizados de Umbani: 'motorizado' + courier_id.
  reparto_para       text not null default 'local',
  courier_id         uuid,
  en_mano            text not null,
  settlement_id      uuid,
  created_at         timestamptz not null default now(),

  constraint order_ledger_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  constraint order_ledger_settlement_fk foreign key (settlement_id, business_id)
    references public.settlements (id, business_id) on delete set null (settlement_id),
  constraint order_ledger_kind_check check (kind in ('venta', 'reverso')),
  constraint order_ledger_reparto_para_check check (reparto_para in ('local', 'motorizado')),
  constraint order_ledger_en_mano_check check (en_mano in ('umbani', 'local', 'motorizado')),
  -- ⚠️ EL INVARIANTE. Si algún día no cuadra, la venta no se registra.
  constraint order_ledger_cuadra check (local_cents + reparto_cents + umbani_cents = total_cents),
  constraint order_ledger_signo check (
    (kind = 'venta'   and total_cents >= 0 and local_cents >= 0 and reparto_cents >= 0 and umbani_cents >= 0)
    or (kind = 'reverso' and total_cents <= 0 and local_cents <= 0 and reparto_cents <= 0 and umbani_cents <= 0)
  )
);

alter table public.order_ledger enable row level security;
revoke all on table public.order_ledger from anon, authenticated;

create unique index if not exists order_ledger_uno_por_pedido
  on public.order_ledger (order_id, kind);
create index if not exists idx_order_ledger_biz_sold
  on public.order_ledger (business_id, sold_at desc);
create index if not exists idx_order_ledger_sin_liquidar
  on public.order_ledger (business_id, sold_at)
  where settlement_id is null;

comment on table public.order_ledger is
  'A qué tiene derecho cada uno por pedido entregado y quién tiene el dinero. Centavos; cuadra siempre.';


-- ── 5. Al ENTREGARSE, el pedido escribe su libro ──────────────────────────
--
-- Se engancha a `sales` (la venta nace al entregar, en
-- `crear_venta_desde_pedido`) con un disparador, sin recrear las funciones del
-- dinero: el mismo criterio que `orders_stamp_pricing`. Cubre cualquier camino
-- que cree una venta desde un pedido.
--
-- ⚠️ Falla CERRADO a propósito: si el reparto no cuadra, la venta no se
-- registra y el dueño ve el error. Un pedido entregado sin su libro sería
-- dinero que nadie liquida nunca.
create or replace function public.sales_write_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metodo  text;
  v_total   integer;
  v_umbani  integer;
  v_reparto integer;
begin
  if new.order_id is null
     or new.status <> 'completada'
     or new.sold_at < (public.liquidacion_semanal_desde()::timestamp at time zone 'America/Guayaquil') then
    return new;
  end if;

  select payment_method into v_metodo
  from public.orders
  where id = new.order_id and business_id = new.business_id;

  v_total   := round(coalesce(new.total, 0) * 100)::integer;
  v_umbani  := round(coalesce(new.platform_markup, 0) * 100)::integer;
  v_reparto := round(coalesce(new.shipping, 0) * 100)::integer;

  insert into public.order_ledger (
    business_id, order_id, sale_id, kind, sold_at, payment_method,
    total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
    reparto_para, en_mano
  ) values (
    new.business_id, new.order_id, new.id, 'venta', new.sold_at, v_metodo,
    v_total, v_total - v_umbani - v_reparto, v_reparto, v_umbani,
    case when v_metodo = 'tarjeta'
      then round(v_total * public.comision_payphone_bps() / 10000.0)::integer
      else 0 end,
    'local',
    case when v_metodo = 'tarjeta' then 'umbani' else 'local' end
  )
  on conflict (order_id, kind) do nothing;

  return new;
end;
$$;

drop trigger if exists sales_write_ledger on public.sales;
create trigger sales_write_ledger
  after insert on public.sales
  for each row execute function public.sales_write_ledger();


-- ── 6. Venta anulada: fuera del libro, o restada en la siguiente ──────────
--
-- Sin liquidar todavía: la fila se borra y ese pedido no cuenta. Ya
-- liquidada: una semana cerrada no se reescribe jamás (el mismo criterio que
-- el mes `paid`), así que se escribe un REVERSO que resta en la próxima.
create or replace function public.sales_void_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.order_id is null
     or old.status is not distinct from new.status
     or old.status <> 'completada' or new.status <> 'anulada' then
    return new;
  end if;

  delete from public.order_ledger
  where order_id = new.order_id and kind = 'venta' and settlement_id is null;

  if not found then
    insert into public.order_ledger (
      business_id, order_id, sale_id, kind, sold_at, payment_method,
      total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
      reparto_para, courier_id, en_mano
    )
    select business_id, order_id, sale_id, 'reverso', now(), payment_method,
           -total_cents, -local_cents, -reparto_cents, -umbani_cents, -provider_fee_cents,
           reparto_para, courier_id, en_mano
    from public.order_ledger
    where order_id = new.order_id and kind = 'venta'
    on conflict (order_id, kind) do nothing;
  end if;

  return new;
end;
$$;

drop trigger if exists sales_void_ledger on public.sales;
create trigger sales_void_ledger
  after update of status on public.sales
  for each row execute function public.sales_void_ledger();


-- ── 7. El cierre de la semana ─────────────────────────────────────────────
--
-- Una operación por CONJUNTOS (ver «Pensado para ciudades grandes»): nada de
-- un bucle por local. Idempotente: cerrar otra vez la misma semana no crea
-- nada, y dos servidores a la vez no chocan (candado de transacción).
--
-- Entra TODO lo sin liquidar hasta el domingo de esa semana, no solo lo de
-- esa semana: nada puede quedarse fuera por haber llegado tarde.
create or replace function public.close_weekly_settlements(
  p_week_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin    date;
  v_hoy    date := (now() at time zone 'America/Guayaquil')::date;
  v_hasta  timestamptz;
  v_creadas integer;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'La semana empieza en lunes.';
  end if;
  v_fin := p_week_start + 7;
  if v_fin > v_hoy then
    raise exception using errcode = '22023', message = 'Esa semana todavía no terminó.';
  end if;
  if p_week_start < public.liquidacion_semanal_desde() then
    return jsonb_build_object('semana', p_week_start, 'creadas', 0, 'motivo', 'antes_del_corte');
  end if;

  perform pg_advisory_xact_lock(hashtext('close_weekly_settlements'));
  v_hasta := v_fin::timestamp at time zone 'America/Guayaquil';

  create temp table if not exists tmp_cierre (
    business_id uuid primary key,
    pedidos integer, derecho integer, en_mano integer,
    arrastre integer, cuota integer, billing_id uuid
  ) on commit drop;
  truncate pg_temp.tmp_cierre;

  insert into pg_temp.tmp_cierre (business_id, pedidos, derecho, en_mano, arrastre, cuota, billing_id)
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           coalesce(sum(case when l.en_mano = 'local' then l.total_cents else 0 end), 0)::integer as en_mano
    from public.order_ledger l
    where l.settlement_id is null and l.sold_at < v_hasta
    group by l.business_id
  ),
  deuda as (
    select s.business_id, sum(s.neto_cents)::integer as arrastre
    from public.settlements s
    where s.party = 'local' and s.courier_id is null
      and s.status = 'por_cobrar' and s.period_start < p_week_start
    group by s.business_id
  ),
  base as (
    select coalesce(l.business_id, d.business_id) as business_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre
    from libro l
    full join deuda d on d.business_id = l.business_id
  ),
  -- La factura más vieja pendiente de cada local (cuota + la comisión de los
  -- meses anteriores al corte). Solo se descuenta si el saldo la cubre ENTERA.
  factura as (
    select distinct on (b.business_id)
           b.business_id, b.id as billing_id,
           round((coalesce(b.amount, 0) + coalesce(b.commission_amount, 0)) * 100)::integer as cents
    from public.billing b
    where b.status in ('pending', 'overdue') and b.period_start <= p_week_start
    order by b.business_id, b.period_start
  )
  select x.business_id, x.pedidos, x.derecho, x.en_mano, x.arrastre,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre >= f.cents
              then f.cents else 0 end,
         case when f.cents > 0 and x.derecho - x.en_mano + x.arrastre >= f.cents
              then f.billing_id end
  from base x
  left join factura f on f.business_id = x.business_id
  -- Ya liquidado esa semana: no se toca (idempotencia).
  where not exists (
    select 1 from public.settlements s
    where s.business_id = x.business_id and s.party = 'local'
      and s.courier_id is null and s.period_start = p_week_start
  );

  insert into public.settlements (
    business_id, party, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, cuota_cents, billing_id,
    neto_cents, status
  )
  select t.business_id, 'local', p_week_start, p_week_start + 6, t.pedidos,
         t.derecho, t.en_mano, t.arrastre, t.cuota, t.billing_id,
         t.derecho - t.en_mano + t.arrastre - t.cuota,
         case
           when t.derecho - t.en_mano + t.arrastre - t.cuota > 0 then 'por_pagar'
           when t.derecho - t.en_mano + t.arrastre - t.cuota < 0 then 'por_cobrar'
           else 'en_cero'
         end
  from pg_temp.tmp_cierre t
  on conflict do nothing;
  get diagnostics v_creadas = row_count;

  -- Cada pedido se liquida UNA vez.
  update public.order_ledger l
     set settlement_id = s.id
    from public.settlements s
   where s.business_id = l.business_id and s.party = 'local' and s.courier_id is null
     and s.period_start = p_week_start
     and l.settlement_id is null and l.sold_at < v_hasta
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = l.business_id);

  -- La deuda anterior ya viaja en el arrastre de esta semana.
  update public.settlements s
     set status = 'compensada', updated_at = now()
   where s.party = 'local' and s.courier_id is null
     and s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from pg_temp.tmp_cierre t where t.business_id = s.business_id);

  -- La factura descontada queda pagada, con su rastro.
  update public.billing b
     set status = 'paid', paid_at = now(),
         notes = left(coalesce(nullif(btrim(b.notes), '') || ' · ', '')
           || 'Descontada de la liquidación de la semana del ' || to_char(p_week_start, 'DD/MM/YYYY'), 500)
   where b.id in (select billing_id from pg_temp.tmp_cierre where billing_id is not null);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;

revoke all on function public.close_weekly_settlements(date) from public, anon, authenticated;
grant execute on function public.close_weekly_settlements(date) to service_role;


-- ── 8. Marcar pagada (Umbani al local) o cobrada (el local a Umbani) ──────
create or replace function public.mark_settlement_paid(
  p_settlement_id uuid,
  p_reference text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_fila public.settlements%rowtype;
begin
  -- ⚠️ Un local de DEMOSTRACIÓN no se paga (2026-09-30): su dinero es de
  -- prueba. Su liquidación existe para que «Mis pagos» se vea como uno real.
  if exists (
    select 1 from public.settlements s join public.businesses b on b.id = s.business_id
     where s.id = p_settlement_id and b.is_demo
  ) then
    return jsonb_build_object('result', 'demo');
  end if;

  if v_ref is null or char_length(v_ref) < 3 then
    raise exception using errcode = '22023',
      message = 'Escribe la referencia de la transferencia.';
  end if;

  update public.settlements
     set status = case status when 'por_pagar' then 'pagada' else 'cobrada' end,
         paid_at = now(), reference = left(v_ref, 120), updated_at = now()
   where id = p_settlement_id and status in ('por_pagar', 'por_cobrar')
  returning * into v_fila;

  if not found then
    return jsonb_build_object('result', 'not_pending');
  end if;
  return jsonb_build_object('result', 'updated', 'status', v_fila.status);
end;
$$;

revoke all on function public.mark_settlement_paid(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_settlement_paid(uuid, text) to service_role;


-- ── 9. El saldo EN CURSO de cada local (lo aún sin liquidar) ──────────────
create or replace function public.settlement_balances(
  p_business_id uuid default null
)
returns table (
  business_id      uuid,
  business_name    text,
  pedidos          integer,
  pedidos_tarjeta  integer,
  derecho_cents    integer,
  en_mano_cents    integer,
  arrastre_cents   integer,
  neto_cents       integer,
  umbani_cents     integer,
  payphone_cents   integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with libro as (
    select l.business_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           count(*) filter (where l.kind = 'venta' and l.payment_method = 'tarjeta')::integer as pedidos_tarjeta,
           coalesce(sum(l.local_cents
             + case when l.reparto_para = 'local' then l.reparto_cents else 0 end), 0)::integer as derecho,
           coalesce(sum(case when l.en_mano = 'local' then l.total_cents else 0 end), 0)::integer as en_mano,
           coalesce(sum(l.umbani_cents), 0)::integer as umbani,
           coalesce(sum(l.provider_fee_cents), 0)::integer as payphone
    from public.order_ledger l
    where l.settlement_id is null
      and (p_business_id is null or l.business_id = p_business_id)
    group by l.business_id
  ),
  deuda as (
    select s.business_id, sum(s.neto_cents)::integer as arrastre
    from public.settlements s
    where s.party = 'local' and s.courier_id is null and s.status = 'por_cobrar'
      and (p_business_id is null or s.business_id = p_business_id)
    group by s.business_id
  )
  select coalesce(l.business_id, d.business_id), b.name,
         coalesce(l.pedidos, 0), coalesce(l.pedidos_tarjeta, 0),
         coalesce(l.derecho, 0), coalesce(l.en_mano, 0), coalesce(d.arrastre, 0),
         coalesce(l.derecho, 0) - coalesce(l.en_mano, 0) + coalesce(d.arrastre, 0),
         coalesce(l.umbani, 0), coalesce(l.payphone, 0)
  from libro l
  full join deuda d on d.business_id = l.business_id
  join public.businesses b on b.id = coalesce(l.business_id, d.business_id)
  order by 8 desc;
$$;

revoke all on function public.settlement_balances(uuid) from public, anon, authenticated;
grant execute on function public.settlement_balances(uuid) to service_role;


-- ── 10. La factura mensual deja de cobrar la comisión desde el corte ──────
--
-- Copiada ENTERA de la vigente (`schema.sql`). Cambia una cosa: el resumen
-- se pide hasta `least(fin de mes, corte)`. La cuota (`amount`) no se toca.
create or replace function public.settle_month_commission(
  p_period_start date
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin       date;
  -- Hasta dónde cobra el MES: desde el corte, la comisión se liquida por
  -- semana (`order_ledger`). Sin este tope se cobraría dos veces.
  v_hasta     date;
  v_afectadas integer;
  v_total     numeric(10,2);
  v_pagadas   integer;
begin
  if p_period_start is null or p_period_start <> date_trunc('month', p_period_start)::date then
    raise exception using
      errcode = '22023',
      message = 'El cierre va sobre el primer día de un mes.';
  end if;

  v_fin := (p_period_start + interval '1 month')::date;
  v_hasta := least(v_fin, public.liquidacion_semanal_desde());

  -- Cuántas facturas de ese mes están pagadas y por tanto NO se tocan. Se
  -- cuenta ANTES de escribir para poder informarlo: si un mes se cierra tarde
  -- y ya se cobró, el superadmin tiene que enterarse en vez de creer que
  -- entró todo.
  select count(*) into v_pagadas
  from public.billing
  where period_start = p_period_start
    and status = 'paid'
    and exists (
      select 1 from public.platform_markup_summary(p_period_start, v_hasta, business_id)
    );

  -- UNA operación: calcula, actualiza lo que existe y crea lo que falta.
  --
  -- `insert ... on conflict do update` en vez de leer-y-escribir porque con
  -- dos instancias del servidor lo segundo es una carrera: las dos leerían
  -- «no hay factura» y las dos insertarían.
  with resumen as (
    select * from public.platform_markup_summary(p_period_start, v_hasta, null)
  )
  insert into public.billing (
    business_id, amount, currency, period_start, period_end,
    status, commission_amount, commission_orders, commission_closed_at
  )
  select
    r.business_id,
    -- Sin cuota conocida la factura nace en 0 y solo lleva comisión: es
    -- preferible a que la comisión de ese local no se facture nunca.
    coalesce(b.monthly_rate, 0),
    'USD',
    p_period_start,
    (v_fin - interval '1 day')::date,
    'pending',
    r.margen,
    r.pedidos,
    now()
  from resumen r
  join public.businesses b on b.id = r.business_id
  on conflict (business_id, period_start) do update
  set commission_amount    = excluded.commission_amount,
      commission_orders    = excluded.commission_orders,
      commission_closed_at = now()
  -- ⚠️ Un mes ya pagado NO se reescribe: si una venta se anula después de
  -- liquidar, se descuenta del mes siguiente. Una factura emitida es un hecho.
  where public.billing.status <> 'paid';

  get diagnostics v_afectadas = row_count;

  select coalesce(sum(commission_amount), 0) into v_total
  from public.billing
  where period_start = p_period_start;

  return jsonb_build_object(
    'periodo',            p_period_start,
    'facturas_afectadas', v_afectadas,
    'comision_total',     v_total,
    'ya_pagadas',         v_pagadas
  );
end;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- LA TARIFA DE SERVICIO
-- (migration-2026-09-28-tarifa-de-servicio.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- LA TARIFA DE SERVICIO (como las grandes)
--
-- Decisión del dueño (2026-09-27): una tarifa fija por pedido, IGUAL para todo
-- método de pago (en Ecuador es ilegal cobrar más por pagar con tarjeta), que
-- se ve en el carrito ANTES de confirmar y es entera de Umbani. Cubre la
-- comisión de la tarjeta y los mensajes de WhatsApp en los pedidos pequeños.
--
-- Nace en $0 (apagada): se enciende en Superadmin → Configuración
-- (`server_settings.service_fee`). La lee la BASE, que es la que cobra; la
-- app la pide aquí mismo para enseñarla, así el número que ve el cliente y el
-- que se cobra salen del mismo sitio.
-- ============================================================================

alter table public.orders
  add column if not exists service_fee numeric(10,2) not null default 0;

alter table public.orders drop constraint if exists orders_service_fee_check;
alter table public.orders add constraint orders_service_fee_check
  check (service_fee >= 0 and service_fee <= 5);

comment on column public.orders.service_fee is
  'Tarifa de servicio congelada en el pedido. Va DENTRO de platform_markup (es de Umbani); aparte solo para desglosarla.';

-- Tope de $5: una tarifa mayor es un error de tecleo, no una decisión.
create or replace function public.tarifa_de_servicio()
returns numeric
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select least(btrim(value)::numeric(10,2), 5)
    from public.server_settings
    where key = 'service_fee' and btrim(value) ~ '^[0-9]{1,2}([.][0-9]{1,2})?$'
  ), 0)
$$;

revoke all on function public.tarifa_de_servicio() from public, anon, authenticated;
grant execute on function public.tarifa_de_servicio() to service_role;

-- ── El sello del pedido suma la tarifa ────────────────────────────────────
-- Copiada ENTERA de la vigente (migration-2026-09-20-margen-respeta-los-frenos).
-- Cambia SOLO lo marcado: la tarifa entra en la parte de Umbani y en el total.
create or replace function public.orders_stamp_pricing()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_calc     jsonb;
  v_base     numeric(10,2);
  v_modo     text;
  v_pct      numeric;
  v_piso     numeric;
  v_techo    numeric;
  v_markup   numeric(10,2);
  v_porlinea numeric(10,2);
  v_envio    numeric(10,2);
  -- La tarifa de servicio (2026-09-28): la paga el cliente, es de Umbani.
  v_tarifa   numeric(10,2);
begin
  -- Lo que el comercio cobra POR LOS PRODUCTOS: sin envío, sin propina.
  v_base := round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0), 2);

  if v_base <= 0 then
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.subtotal is not distinct from old.subtotal
     and new.discount is not distinct from old.discount
     and new.pricing_rule_id is not distinct from old.pricing_rule_id then
    return new;
  end if;

  v_calc := public.calculate_platform_markup(new.business_id, v_base, new.pricing_rule_id);
  v_markup := (v_calc ->> 'markup')::numeric;
  v_modo := coalesce(v_calc ->> 'markup_mode', 'absorbed');

  -- Con `on_top` el precio se muestra por producto, así que el margen se
  -- calcula por línea o el total no coincidiría con lo que el cliente sumó.
  -- Si el pedido aún no tiene líneas (bot y mostrador) se queda el del
  -- subtotal: en esos caminos nunca se mostró un precio unitario con margen.
  if v_modo = 'on_top' and (v_calc ->> 'strategy') = 'percentage' then
    select percentage, min_amount, max_amount
      into v_pct, v_piso, v_techo
    from public.pricing_rules
    where id = nullif(v_calc ->> 'rule_id', '')::uuid;

    -- ⚠️ SOLO por línea cuando la regla no tiene frenos de PEDIDO.
    --
    -- Un techo o un piso no son del producto, son del pedido entero: con un
    -- techo de $1 el reparto por línea cobraba $5 y se saltaba el freno. Y el
    -- cliente nunca vio ese número, porque ni el catálogo (`precioDeVitrina`)
    -- ni la cotización (`quoteCart`) pintan margen por producto cuando la
    -- regla lleva topes. Esta era la única capa que no hacía la excepción.
    --
    -- Con frenos se queda el margen del subtotal, que es el que YA viene
    -- recortado por `calculate_platform_markup` y el que la app le enseñó.
    if v_piso is null and v_techo is null then
      v_porlinea := public.order_markup_by_line(new.id, coalesce(v_pct, 0));
      if v_porlinea is not null then
        v_markup := v_porlinea;
      end if;
    end if;
  end if;

  -- ── La tarifa de servicio ─────────────────────────────────────────────
  --
  -- Solo en los pedidos de la TIENDA (el mostrador lo teclea el dueño con la
  -- persona delante). Se CONGELA en el pedido: si ya tenía una, se respeta;
  -- cambiar la tarifa mañana no reescribe lo vendido hoy.
  --
  -- ⚠️ Va DENTRO de `platform_markup` (la parte de Umbani) y además aparte en
  -- `service_fee`, solo para enseñarla desglosada. Así los reportes, el libro,
  -- las liquidaciones y la validación del comprobante ya la tratan como de
  -- Umbani sin tocarlos: el local nunca se queda con ella.
  v_tarifa := case
    when tg_op = 'UPDATE' and coalesce(old.service_fee, 0) > 0 then old.service_fee
    when coalesce(new.source, '') = 'storefront' then public.tarifa_de_servicio()
    else 0
  end;
  new.service_fee := v_tarifa;

  new.platform_markup      := v_markup + v_tarifa;
  new.pricing_rule_id      := nullif(v_calc ->> 'rule_id', '')::uuid;
  new.pricing_rule_version := nullif(v_calc ->> 'rule_version', '')::integer;

  if v_modo = 'on_top' then
    -- El comercio conserva su precio ENTERO: es la promesa del modo.
    new.merchant_subtotal := v_base;
    -- Y el margen se suma a lo que paga el cliente. El envío se respeta tal
    -- como lo dejó la función del dinero.
    v_envio := round(coalesce(new.total, 0) - v_base, 2);
    if v_envio < 0 then v_envio := 0; end if;
    new.total := round(v_base + v_markup + v_envio + v_tarifa, 2);
  else
    -- `absorbed`: el margen sale del precio del comercio y el cliente paga
    -- lo mismo. El total solo sube por la tarifa, que paga el cliente: la
    -- comisión se le quita al comercio, la tarifa NUNCA.
    new.merchant_subtotal := round(v_base - v_markup, 2);
    new.total := round(coalesce(new.total, 0) + v_tarifa, 2);
  end if;

  return new;
end;
$$;


-- ════════════════════════════════════════════════════════════════════════
-- INICIAR SESIÓN EN LA APP CON WHATSAPP
-- (migration-2026-09-28-login-con-whatsapp.sql)
-- ════════════════════════════════════════════════════════════════════════

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


-- ════════════════════════════════════════════════════════════════════════
-- LOS MOTORIZADOS
-- (migration-2026-09-28-motorizados.sql)
-- ════════════════════════════════════════════════════════════════════════

-- ============================================================================
-- LOS MOTORIZADOS: QUIÉN REPARTE, CUÁNTO EFECTIVO LLEVA Y SU LIQUIDACIÓN
--
-- Decisiones del dueño (2026-09-27, «como las grandes»):
--   · El motorizado de Umbani GUARDA el efectivo que cobra y liquida los lunes;
--     Umbani le paga al local. Su carrera es suya.
--   · Tope de efectivo: $150. Por encima, no toma pedidos en efectivo hasta
--     liquidar (así nadie acumula una deuda que no puede pagar).
--   · Si se le cae la comida, se le RETIENE la carrera de ese pedido; el local
--     cobra igual su comida.
--   · Si el local tiene su propia flota, sus repartidores se registran como
--     del local: la carrera es del local y Umbani solo liquida con él.
--
-- ⚠️ CONSTRUIDO Y APAGADO. `businesses.delivery_by` nace en 'local' para todos:
-- ningún pedido se le ofrece a un motorizado de Umbani hasta que el
-- superadmin lo cambie a 'umbani' en un local.
--
-- ⚠️ Los repartidores de Umbani no son de ningún local, así que NO llevan
-- `business_id` (llevan `fleet_business_id`, nulo = flota de Umbani) y su
-- liquidación va en `courier_settlements`, no en `settlements`. Mezclarlos
-- obligaría a un `business_id` nulo justo en las foráneas compuestas que
-- impiden cruzar dinero entre negocios.
-- ============================================================================

-- ── 1. Quién reparte en cada local ────────────────────────────────────────
alter table public.businesses
  add column if not exists delivery_by text not null default 'local';
alter table public.businesses drop constraint if exists businesses_delivery_by_check;
alter table public.businesses add constraint businesses_delivery_by_check
  check (delivery_by in ('local', 'umbani', 'cooperativa'));
comment on column public.businesses.delivery_by is
  'Quién lleva los pedidos: local (su gente), umbani (motorizados de la plataforma) o cooperativa (los de cooperative_id).';

-- Repartidores propios, local por local (2026-10-04, ver
-- `migration-2026-10-04-flota-propia-por-local.sql`). Las tres puertas de
-- abajo lo exigen a la flota de un local: apagado, sus repartidores no ven ni
-- toman sus pedidos. Solo cuenta con `delivery_by = 'local'`.
alter table public.businesses
  add column if not exists own_fleet boolean not null default false;
comment on column public.businesses.own_fleet is
  'Repartidores propios: el local registra a los suyos y solo ellos llevan sus pedidos. Solo cuenta con delivery_by = local. Lo enciende el superadmin.';

-- ── 2. Los motorizados ────────────────────────────────────────────────────
create table if not exists public.couriers (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null,
  name              text not null,
  vehicle           text,
  -- NULO = motorizado de Umbani. Con valor = de la flota propia de ese local.
  fleet_business_id uuid references public.businesses(id) on delete cascade,
  active            boolean not null default true,
  -- «Estoy disponible»: lo cambia él desde su app.
  available         boolean not null default false,
  cash_limit_cents  integer not null default 15000,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint couriers_phone_check check (phone ~ '^\+?[0-9]{8,15}$'),
  constraint couriers_name_check check (char_length(btrim(name)) between 2 and 80),
  constraint couriers_cash_limit_check check (cash_limit_cents between 0 and 100000)
);

alter table public.couriers enable row level security;
revoke all on table public.couriers from anon, authenticated;
create unique index if not exists couriers_phone_unico on public.couriers (phone);
create index if not exists idx_couriers_flota on public.couriers (fleet_business_id);
-- Su ciudad (2026-10-05): el de Umbani solo ve y toma pedidos de los locales
-- de ella. El de la flota de un local no la necesita: lleva solo los suyos.
alter table public.couriers
  add column if not exists city_id uuid references public.cities(id) on delete set null;
create index if not exists idx_couriers_ciudad on public.couriers (city_id);
comment on column public.couriers.city_id is
  'Ciudad del motorizado de Umbani: solo ve y toma pedidos de los locales de ella.';

-- ════════════════════════════════════════════════════════════════════════════
-- LAS COOPERATIVAS DE REPARTO — la tercera flota (2026-10-06)
-- Ver `migration-2026-10-06-cooperativas.sql`: el porqué está allí. Va aquí,
-- antes de las tres puertas del reparto, porque `repartidor_puede_llevar` las
-- sirve a las tres y `courier_orders` (en SQL) la necesita ya creada.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. La cooperativa ───────────────────────────────────────────────────────
create table if not exists public.cooperatives (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  -- Reparte en UNA ciudad: sus motorizados son de ella.
  city_id       uuid not null references public.cities(id) on delete restrict,
  contact_phone text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint cooperatives_name_check check (char_length(btrim(name)) between 2 and 80),
  constraint cooperatives_contact_phone_check check (contact_phone is null or contact_phone ~ '^\+?[0-9]{8,15}$')
);

create unique index if not exists cooperatives_nombre_unico on public.cooperatives (lower(btrim(name)));
create index if not exists idx_cooperatives_ciudad on public.cooperatives (city_id);
alter table public.cooperatives enable row level security;
revoke all on table public.cooperatives from anon, authenticated;
comment on table public.cooperatives is
  'Cooperativas de reparto: registran a sus motorizados y ven sus carreras. Umbani les paga la carrera a ellos.';


-- ── 2. Quién entra a su panel (`/cooperativa`) ──────────────────────────────
-- Como el dueño de un local: correo y contraseña con bcrypt, nunca en claro.
create table if not exists public.cooperative_users (
  id             uuid primary key default gen_random_uuid(),
  cooperative_id uuid not null references public.cooperatives(id) on delete cascade,
  email          text not null,
  password_hash  text not null,
  name           text,
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint cooperative_users_email_check check (email = lower(btrim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  constraint cooperative_users_name_check check (name is null or char_length(btrim(name)) between 2 and 80)
);

create unique index if not exists cooperative_users_email_unico on public.cooperative_users (email);
create index if not exists idx_cooperative_users_cooperativa on public.cooperative_users (cooperative_id);
alter table public.cooperative_users enable row level security;
revoke all on table public.cooperative_users from anon, authenticated;


-- ── 3. El motorizado: su flota y sus datos ──────────────────────────────────
alter table public.couriers
  add column if not exists cooperative_id uuid references public.cooperatives(id) on delete restrict,
  -- Cédula o pasaporte: en Chone reparten también personas de otros países.
  add column if not exists id_number text,
  add column if not exists plate text,
  add column if not exists license_number text;

alter table public.couriers drop constraint if exists couriers_una_flota_check;
alter table public.couriers add constraint couriers_una_flota_check
  check (fleet_business_id is null or cooperative_id is null);
alter table public.couriers drop constraint if exists couriers_documentos_check;
alter table public.couriers add constraint couriers_documentos_check check (
  (id_number is null or char_length(btrim(id_number)) between 5 and 20)
  and (plate is null or char_length(btrim(plate)) between 3 and 12)
  and (license_number is null or char_length(btrim(license_number)) between 3 and 30)
);
-- Lo que la cooperativa responde por cada uno (decidido 2026-10-05): nombre,
-- WhatsApp, cédula, placa y vehículo. La licencia, opcional.
alter table public.couriers drop constraint if exists couriers_de_cooperativa_check;
alter table public.couriers add constraint couriers_de_cooperativa_check check (
  cooperative_id is null
  or (id_number is not null and plate is not null and char_length(btrim(coalesce(vehicle, ''))) >= 2)
);

create index if not exists idx_couriers_cooperativa on public.couriers (cooperative_id) where cooperative_id is not null;
comment on column public.couriers.cooperative_id is
  'Cooperativa del motorizado: lleva los locales de ella en su ciudad, y Umbani le paga la carrera como a uno suyo.';

-- Su ciudad es la de su cooperativa, siempre: si pudiera ser otra, vería una
-- lista vacía sin que nadie entendiera por qué.
create or replace function public.couriers_ciudad_de_su_cooperativa()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select c.city_id into new.city_id from public.cooperatives c where c.id = new.cooperative_id;
  return new;
end;
$$;

revoke all on function public.couriers_ciudad_de_su_cooperativa() from public, anon, authenticated;

drop trigger if exists couriers_ciudad_de_su_cooperativa on public.couriers;
create trigger couriers_ciudad_de_su_cooperativa
  before insert or update of cooperative_id, city_id on public.couriers
  for each row when (new.cooperative_id is not null)
  execute function public.couriers_ciudad_de_su_cooperativa();


-- ── 4. Quién reparte: el local, Umbani o UNA cooperativa ───────────────────
alter table public.businesses
  add column if not exists cooperative_id uuid references public.cooperatives(id) on delete restrict;
-- «La cooperativa» siempre dice CUÁL, y solo entonces.
alter table public.businesses drop constraint if exists businesses_cooperativa_check;
alter table public.businesses add constraint businesses_cooperativa_check
  check ((delivery_by = 'cooperativa') = (cooperative_id is not null));

create index if not exists idx_businesses_cooperativa on public.businesses (cooperative_id) where cooperative_id is not null;

-- Y de SU ciudad: con una de otra, sus motorizados nunca verían los pedidos y
-- el local se quedaría sin reparto en silencio.
create or replace function public.businesses_cooperativa_de_su_ciudad()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.cooperatives c
     where c.id = new.cooperative_id and c.city_id = new.city_id
  ) then
    raise exception using errcode = '23514',
      message = 'La cooperativa tiene que ser de la ciudad del local.';
  end if;
  return new;
end;
$$;

revoke all on function public.businesses_cooperativa_de_su_ciudad() from public, anon, authenticated;

drop trigger if exists businesses_cooperativa_de_su_ciudad on public.businesses;
create trigger businesses_cooperativa_de_su_ciudad
  before insert or update of delivery_by, cooperative_id, city_id on public.businesses
  for each row when (new.delivery_by = 'cooperativa')
  execute function public.businesses_cooperativa_de_su_ciudad();


-- ── 5. La regla de quién lleva qué, en UN solo sitio ───────────────────────
--
-- ⚠️ `coalesce(…, false)` sobre todo: con NULL en una comparación (un local
-- sin ciudad, un motorizado sin cooperativa) la rama da NULL, y un NULL que
-- llega a un `if not (…)` se lee como «no rechazar». Falla CERRADO.
create or replace function public.repartidor_puede_llevar(p_courier_id uuid, p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select c.active and (
      -- De Umbani: ni de un local ni de una cooperativa, y en SU ciudad.
      (c.fleet_business_id is null and c.cooperative_id is null
        and b.delivery_by = 'umbani' and b.city_id = c.city_id)
      -- De una cooperativa ACTIVA: los locales de ELLA, en su ciudad.
      or (c.cooperative_id is not null and coop.active
        and b.delivery_by = 'cooperativa' and b.cooperative_id = c.cooperative_id
        and b.city_id = c.city_id)
      -- De la flota de un local: solo ese local, con sus repartidores
      -- encendidos y repartiendo él mismo.
      or (c.fleet_business_id = b.id and b.own_fleet and b.delivery_by = 'local')
    )
    from public.couriers c
    join public.businesses b on b.id = p_business_id
    left join public.cooperatives coop on coop.id = c.cooperative_id
    where c.id = p_courier_id
  ), false)
$$;

revoke all on function public.repartidor_puede_llevar(uuid, uuid) from public, anon, authenticated;
grant execute on function public.repartidor_puede_llevar(uuid, uuid) to service_role;


-- ── 3. El pedido sabe quién lo lleva ──────────────────────────────────────
alter table public.orders
  add column if not exists courier_id uuid references public.couriers(id) on delete set null,
  add column if not exists courier_assigned_at timestamptz;
create index if not exists idx_orders_courier on public.orders (courier_id) where courier_id is not null;

-- ── 4. La liquidación de los motorizados ──────────────────────────────────
create table if not exists public.courier_settlements (
  id             uuid primary key default gen_random_uuid(),
  courier_id     uuid not null references public.couriers(id) on delete cascade,
  period_start   date not null,
  period_end     date not null,
  orders_count   integer not null default 0,
  -- Sus carreras (sin las retenidas).
  derecho_cents  integer not null default 0,
  -- El efectivo que cobró en la puerta y tiene él.
  en_mano_cents  integer not null default 0,
  arrastre_cents integer not null default 0,
  -- > 0: Umbani le paga · < 0: él le debe a Umbani (el efectivo de otros).
  neto_cents     integer not null,
  status         text not null,
  paid_at        timestamptz,
  reference      text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint courier_settlements_status_check check (status in (
    'por_pagar', 'por_cobrar', 'en_cero', 'pagada', 'cobrada', 'compensada'
  )),
  constraint courier_settlements_semana_check check (
    extract(isodow from period_start) = 1 and period_end = period_start + 6
  ),
  constraint courier_settlements_cuadra check (neto_cents = derecho_cents - en_mano_cents + arrastre_cents),
  constraint courier_settlements_reference_check check (
    reference is null or char_length(btrim(reference)) between 3 and 120
  )
);

alter table public.courier_settlements enable row level security;
revoke all on table public.courier_settlements from anon, authenticated;
create unique index if not exists courier_settlements_una_por_semana
  on public.courier_settlements (courier_id, period_start);

-- ── 5. El libro sabe de la carrera retenida y de su liquidación ────────────
alter table public.order_ledger
  add column if not exists retenido boolean not null default false,
  add column if not exists retenido_motivo text,
  add column if not exists courier_settlement_id uuid references public.courier_settlements(id) on delete set null;
alter table public.order_ledger drop constraint if exists order_ledger_courier_fk;
alter table public.order_ledger add constraint order_ledger_courier_fk
  foreign key (courier_id) references public.couriers(id) on delete set null;
create index if not exists idx_order_ledger_courier_sin_liquidar
  on public.order_ledger (courier_id, sold_at)
  where courier_id is not null and courier_settlement_id is null;


-- ── 6. Ningún repartidor lleva el pedido de un local que no le toca ────────
--
-- En la base y no solo en la ruta: es la única puerta que no se salta. Uno de
-- Umbani solo lleva pedidos de locales que reparten con Umbani; uno de la
-- flota de un local, solo los de ese local, y solo si ese local tiene sus
-- repartidores propios encendidos (`own_fleet`) y reparte él mismo. Y tiene
-- que estar activo.
create or replace function public.orders_courier_permitido()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.courier_id is null or new.courier_id is not distinct from old.courier_id then
    return new;
  end if;
  if not public.repartidor_puede_llevar(new.courier_id, new.business_id) then
    raise exception using errcode = '42501',
      message = 'Ese repartidor no puede llevar pedidos de este local.';
  end if;
  return new;
end;
$$;

drop trigger if exists orders_courier_permitido on public.orders;
create trigger orders_courier_permitido
  before update of courier_id on public.orders
  for each row execute function public.orders_courier_permitido();


-- ── 7. El libro reconoce quién repartió ───────────────────────────────────
--
-- Recreada desde la de `migration-2026-09-28-cuentas-y-liquidacion-semanal`.
-- Lo nuevo: si lo llevó un motorizado de UMBANI, la carrera es suya
-- (`reparto_para = 'motorizado'`) y el efectivo lo tiene él
-- (`en_mano = 'motorizado'`). La transferencia sigue yendo al local y la
-- tarjeta a Umbani. Un repartidor de la flota del LOCAL no cambia nada: para
-- Umbani, lo llevó el local.
create or replace function public.sales_write_ledger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_metodo  text;
  v_courier uuid;
  v_umbani_reparte boolean := false;
  v_total   integer;
  v_umbani  integer;
  v_reparto integer;
begin
  if new.order_id is null
     or new.status <> 'completada'
     or new.sold_at < (public.liquidacion_semanal_desde()::timestamp at time zone 'America/Guayaquil') then
    return new;
  end if;

  select o.payment_method, o.courier_id, (c.id is not null and c.fleet_business_id is null)
    into v_metodo, v_courier, v_umbani_reparte
  from public.orders o
  left join public.couriers c on c.id = o.courier_id
  where o.id = new.order_id and o.business_id = new.business_id;

  v_total   := round(coalesce(new.total, 0) * 100)::integer;
  v_umbani  := round(coalesce(new.platform_markup, 0) * 100)::integer;
  v_reparto := round(coalesce(new.shipping, 0) * 100)::integer;

  insert into public.order_ledger (
    business_id, order_id, sale_id, kind, sold_at, payment_method,
    total_cents, local_cents, reparto_cents, umbani_cents, provider_fee_cents,
    reparto_para, courier_id, en_mano
  ) values (
    new.business_id, new.order_id, new.id, 'venta', new.sold_at, v_metodo,
    v_total, v_total - v_umbani - v_reparto, v_reparto, v_umbani,
    case when v_metodo = 'tarjeta'
      then round(v_total * public.comision_payphone_bps() / 10000.0)::integer
      else 0 end,
    case when v_umbani_reparte then 'motorizado' else 'local' end,
    case when v_umbani_reparte then v_courier end,
    case
      when v_metodo = 'tarjeta' then 'umbani'
      when v_metodo = 'transferencia' then 'local'
      when v_umbani_reparte then 'motorizado'
      else 'local'
    end
  )
  on conflict (order_id, kind) do nothing;

  return new;
end;
$$;


-- ── 8. El efectivo que lleva encima ───────────────────────────────────────
--
-- Lo cobrado y aún sin liquidar, MÁS lo que va a cobrar en los pedidos en
-- efectivo que ya tomó y no ha entregado.
create or replace function public.courier_cash_in_hand(p_courier_id uuid)
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select (
    coalesce((
      select sum(total_cents) from public.order_ledger
      where courier_id = p_courier_id and en_mano = 'motorizado' and courier_settlement_id is null
    ), 0)
    + coalesce((
      select sum(round(o.total * 100)) from public.orders o
      where o.courier_id = p_courier_id
        and coalesce(o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar')
        and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado')
    ), 0)
  )::integer
$$;

revoke all on function public.courier_cash_in_hand(uuid) from public, anon, authenticated;
grant execute on function public.courier_cash_in_hand(uuid) to service_role;


-- ── 9. Tomar un pedido ────────────────────────────────────────────────────
--
-- Atómico: dos motorizados tocando a la vez, uno se lo lleva y el otro lee
-- «ya lo tomó otro». Con efectivo, respeta el tope.
create or replace function public.courier_take_order(p_courier_id uuid, p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_c public.couriers%rowtype;
  v_o public.orders%rowtype;
  v_centavos integer;
begin
  select * into v_c from public.couriers where id = p_courier_id;
  if v_c.id is null or not v_c.active then
    return jsonb_build_object('result', 'inactivo');
  end if;

  select * into v_o from public.orders where id = p_order_id for update;
  if v_o.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_o.courier_id is not null then
    return jsonb_build_object('result', case when v_o.courier_id = p_courier_id then 'ya_es_tuyo' else 'ya_tomado' end);
  end if;
  if coalesce(v_o.fulfillment, 'delivery') <> 'delivery'
     -- Solo lo que el local YA ACEPTÓ: como en las grandes, nadie sale a por
     -- un pedido que el local todavía puede rechazar.
     or v_o.status not in ('confirmado', 'aceptado', 'preparacion')
     or not public.repartidor_puede_llevar(p_courier_id, v_o.business_id) then
    return jsonb_build_object('result', 'no_disponible');
  end if;
  -- Con tarjeta ya pagado; sin pagar no sale (lo exige también la base).
  if v_o.payment_method = 'tarjeta' and v_o.payment_confirmed_at is null then
    return jsonb_build_object('result', 'no_disponible');
  end if;

  if coalesce(v_o.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar') then
    v_centavos := round(v_o.total * 100)::integer;
    if public.courier_cash_in_hand(p_courier_id) + v_centavos > v_c.cash_limit_cents then
      return jsonb_build_object('result', 'tope_de_efectivo',
        'tope_cents', v_c.cash_limit_cents, 'en_mano_cents', public.courier_cash_in_hand(p_courier_id));
    end if;
  end if;

  update public.orders
     set courier_id = p_courier_id, courier_assigned_at = now(), updated_at = now()
   where id = p_order_id;
  return jsonb_build_object('result', 'ok', 'order_id', p_order_id, 'business_id', v_o.business_id);
end;
$$;

revoke all on function public.courier_take_order(uuid, uuid) from public, anon, authenticated;
grant execute on function public.courier_take_order(uuid, uuid) to service_role;


-- ── 10. Recogido y entregado: por la máquina de estados de siempre ─────────
--
-- `set_order_status` sigue siendo la única puerta: respeta el candado de la
-- checklist (no sale nada incompleto) y al entregar crea la venta —y con ella
-- el libro—. Aquí solo se comprueba que el pedido es DE ESTE motorizado.
create or replace function public.courier_advance_order(
  p_courier_id uuid, p_order_id uuid, p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
begin
  if p_status not in ('en_camino', 'completado') then
    raise exception using errcode = '22023', message = 'El motorizado solo marca «en camino» o «entregado».';
  end if;
  select * into v_o from public.orders where id = p_order_id;
  if v_o.id is null or v_o.courier_id is distinct from p_courier_id then
    return jsonb_build_object('result', 'not_found');
  end if;
  return public.set_order_status(v_o.business_id, p_order_id, p_status);
end;
$$;

revoke all on function public.courier_advance_order(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.courier_advance_order(uuid, uuid, text) to service_role;


-- ── 11. Se le cayó la comida: se le retiene la carrera ─────────────────────
--
-- Decisión del dueño: responde quien la dejó caer. La carrera sale de su
-- liquidación; el local cobra su comida igual. Solo mientras no esté
-- liquidada: una semana cerrada no se reescribe.
create or replace function public.retain_courier_fee(p_order_id uuid, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_filas integer;
begin
  if char_length(btrim(coalesce(p_motivo, ''))) < 3 then
    raise exception using errcode = '22023', message = 'Escribe el motivo.';
  end if;
  update public.order_ledger
     set retenido = true, retenido_motivo = left(btrim(p_motivo), 300)
   where order_id = p_order_id and kind = 'venta'
     and reparto_para = 'motorizado' and courier_settlement_id is null and not retenido;
  get diagnostics v_filas = row_count;
  return jsonb_build_object('result', case when v_filas > 0 then 'retenida' else 'no_aplica' end);
end;
$$;

revoke all on function public.retain_courier_fee(uuid, text) from public, anon, authenticated;
grant execute on function public.retain_courier_fee(uuid, text) to service_role;


-- ── 12. El cierre semanal de los motorizados ──────────────────────────────
--
-- El mismo mecanismo que el de los locales: derecho (sus carreras, sin las
-- retenidas) − en mano (el efectivo que cobró) + lo que debía. Por
-- conjuntos, idempotente y con candado.
create or replace function public.close_weekly_courier_settlements(p_week_start date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_fin    date;
  v_hoy    date := (now() at time zone 'America/Guayaquil')::date;
  v_hasta  timestamptz;
  v_creadas integer;
begin
  if p_week_start is null or extract(isodow from p_week_start) <> 1 then
    raise exception using errcode = '22023', message = 'La semana empieza en lunes.';
  end if;
  v_fin := p_week_start + 7;
  if v_fin > v_hoy then
    raise exception using errcode = '22023', message = 'Esa semana todavía no terminó.';
  end if;
  if p_week_start < public.liquidacion_semanal_desde() then
    return jsonb_build_object('semana', p_week_start, 'creadas', 0, 'motivo', 'antes_del_corte');
  end if;

  perform pg_advisory_xact_lock(hashtext('close_weekly_courier_settlements'));
  v_hasta := v_fin::timestamp at time zone 'America/Guayaquil';

  with libro as (
    select l.courier_id,
           count(*) filter (where l.kind = 'venta')::integer as pedidos,
           coalesce(sum(case when l.reparto_para = 'motorizado' and not l.retenido then l.reparto_cents else 0 end), 0)::integer as derecho,
           coalesce(sum(case when l.en_mano = 'motorizado' then l.total_cents else 0 end), 0)::integer as en_mano
    from public.order_ledger l
    where l.courier_id is not null and l.courier_settlement_id is null and l.sold_at < v_hasta
    group by l.courier_id
  ),
  deuda as (
    select courier_id, sum(neto_cents)::integer as arrastre
    from public.courier_settlements
    where status = 'por_cobrar' and period_start < p_week_start
    group by courier_id
  ),
  base as (
    select coalesce(l.courier_id, d.courier_id) as courier_id,
           coalesce(l.pedidos, 0) as pedidos, coalesce(l.derecho, 0) as derecho,
           coalesce(l.en_mano, 0) as en_mano, coalesce(d.arrastre, 0) as arrastre
    from libro l full join deuda d on d.courier_id = l.courier_id
  )
  insert into public.courier_settlements (
    courier_id, period_start, period_end, orders_count,
    derecho_cents, en_mano_cents, arrastre_cents, neto_cents, status
  )
  select b.courier_id, p_week_start, p_week_start + 6, b.pedidos,
         b.derecho, b.en_mano, b.arrastre, b.derecho - b.en_mano + b.arrastre,
         case when b.derecho - b.en_mano + b.arrastre > 0 then 'por_pagar'
              when b.derecho - b.en_mano + b.arrastre < 0 then 'por_cobrar'
              else 'en_cero' end
  from base b
  on conflict (courier_id, period_start) do nothing;
  get diagnostics v_creadas = row_count;

  update public.order_ledger l
     set courier_settlement_id = s.id
    from public.courier_settlements s
   where s.courier_id = l.courier_id and s.period_start = p_week_start
     and l.courier_settlement_id is null and l.sold_at < v_hasta;

  update public.courier_settlements s
     set status = 'compensada', updated_at = now()
   where s.status = 'por_cobrar' and s.period_start < p_week_start
     and exists (select 1 from public.courier_settlements n
                 where n.courier_id = s.courier_id and n.period_start = p_week_start);

  return jsonb_build_object('semana', p_week_start, 'creadas', v_creadas);
end;
$$;

revoke all on function public.close_weekly_courier_settlements(date) from public, anon, authenticated;
grant execute on function public.close_weekly_courier_settlements(date) to service_role;


-- ── 13. Marcar pagada o cobrada la liquidación de un motorizado ────────────
create or replace function public.mark_courier_settlement_paid(p_settlement_id uuid, p_reference text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_ref text := nullif(btrim(coalesce(p_reference, '')), '');
  v_status text;
begin
  if v_ref is null or char_length(v_ref) < 3 then
    raise exception using errcode = '22023', message = 'Escribe la referencia de la transferencia.';
  end if;
  update public.courier_settlements
     set status = case status when 'por_pagar' then 'pagada' else 'cobrada' end,
         paid_at = now(), reference = left(v_ref, 120), updated_at = now()
   where id = p_settlement_id and status in ('por_pagar', 'por_cobrar')
  returning status into v_status;
  if v_status is null then return jsonb_build_object('result', 'not_pending'); end if;
  return jsonb_build_object('result', 'updated', 'status', v_status);
end;
$$;

revoke all on function public.mark_courier_settlement_paid(uuid, text) from public, anon, authenticated;
grant execute on function public.mark_courier_settlement_paid(uuid, text) to service_role;


-- ── 14. Lo que la app del motorizado necesita ver ─────────────────────────
--
-- Los pedidos que puede tomar (aceptados por el local, a domicilio, sin
-- repartidor, de un local que le toca) y los suyos en curso. Con dónde
-- recoger y dónde entregar; nunca el teléfono del local.
-- ⚠️ Lo suyo en curso lo sigue viendo aunque su local apague la flota a mitad
-- de camino: apagar no puede dejar una comida sin nadie que la entregue.
create or replace function public.courier_orders(p_courier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with yo as (select * from public.couriers where id = p_courier_id and active),
  pedidos as (
    select o.*, b.name as local_nombre, b.address as local_direccion,
           b.latitude as local_lat, b.longitude as local_lng
    from public.orders o
    join public.businesses b on b.id = o.business_id
    join yo on true
    where coalesce(o.fulfillment, 'delivery') = 'delivery'
      and (
        (o.courier_id is null and o.status in ('confirmado', 'aceptado', 'preparacion')
          and public.repartidor_puede_llevar(yo.id, o.business_id)
          and not (o.payment_method = 'tarjeta' and o.payment_confirmed_at is null))
        or (o.courier_id = yo.id and o.status not in ('completado', 'cancelado', 'rechazado', 'expirado'))
      )
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id,
    'numero', p.order_number,
    'estado', p.status,
    'mio', p.courier_id is not null,
    'totalCents', round(p.total * 100)::integer,
    'carreraCents', round(coalesce(p.shipping, 0) * 100)::integer,
    -- Efectivo = lo cobra él en la puerta; el resto ya está pagado.
    'cobrarEnEfectivo', coalesce(p.payment_method, 'efectivo') in ('efectivo', 'pago_al_retirar'),
    'recoger', jsonb_build_object('local', p.local_nombre, 'direccion', p.local_direccion,
                                  'lat', p.local_lat, 'lng', p.local_lng),
    'entregar', jsonb_build_object('cliente', p.contact_name, 'direccion', p.delivery_address,
                                   'referencia', p.delivery_reference, 'notas', p.delivery_courier_notes,
                                   'lat', p.delivery_latitude, 'lng', p.delivery_longitude)
  ) order by p.courier_id is null, p.created_at), '[]'::jsonb)
  from pedidos p
$$;

revoke all on function public.courier_orders(uuid) from public, anon, authenticated;
grant execute on function public.courier_orders(uuid) to service_role;

-- Su semana EN CURSO (lo aún sin liquidar) y el efectivo que lleva.
create or replace function public.courier_balance(p_courier_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'pedidos', count(*) filter (where l.kind = 'venta'),
    'carrerasCents', coalesce(sum(case when l.reparto_para = 'motorizado' and not l.retenido then l.reparto_cents else 0 end), 0),
    'retenidasCents', coalesce(sum(case when l.retenido then l.reparto_cents else 0 end), 0),
    'efectivoCobradoCents', coalesce(sum(case when l.en_mano = 'motorizado' then l.total_cents else 0 end), 0),
    'deAntesCents', coalesce((select sum(neto_cents) from public.courier_settlements
                              where courier_id = p_courier_id and status = 'por_cobrar'), 0),
    'efectivoEncimaCents', public.courier_cash_in_hand(p_courier_id)
  )
  from public.order_ledger l
  where l.courier_id = p_courier_id and l.courier_settlement_id is null
$$;

revoke all on function public.courier_balance(uuid) from public, anon, authenticated;
grant execute on function public.courier_balance(uuid) to service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- EL REGISTRO DE QUIÉN MUEVE DINERO (2026-09-29).
-- Ver `migration-2026-09-29-registro-de-dinero.sql`: el porqué está allí.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.money_audit_log (
  id            bigint generated always as identity primary key,
  created_at    timestamptz not null default now(),
  actor         text not null,
  -- ⚠️ Sin foránea: el rastro sobrevive al local. Ver la cabecera.
  business_id   uuid,
  business_name text,
  action        text not null,
  target_table  text not null,
  target_id     text,
  detail        jsonb not null default '{}'::jsonb,
  constraint money_audit_log_actor_check check (length(actor) between 1 and 200),
  constraint money_audit_log_action_check check (action ~ '^[a-z_]{3,60}$')
);

create index if not exists idx_money_audit_log_fecha
  on public.money_audit_log (created_at desc);
create index if not exists idx_money_audit_log_negocio
  on public.money_audit_log (business_id, created_at desc);

alter table public.money_audit_log enable row level security;

-- El patrón más estricto del proyecto: se retira el acceso a TODOS —incluido
-- `service_role`, que salta la RLS— y se devuelve solo leer y añadir.
revoke all on table public.money_audit_log
  from public, anon, authenticated, service_role;
grant select, insert on table public.money_audit_log to service_role;

comment on table public.money_audit_log is
  'Quién movió dinero, cuándo y qué cambió. Lo escribe la base con disparadores; no se edita ni se borra.';

-- ── No se edita ni se borra, ni con permiso ────────────────────────────────

create or replace function public.money_audit_log_inmutable()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'El registro de dinero no se edita ni se borra';
end;
$$;

revoke all on function public.money_audit_log_inmutable() from public, anon, authenticated;

drop trigger if exists money_audit_log_inmutable on public.money_audit_log;
create trigger money_audit_log_inmutable
  before update or delete on public.money_audit_log
  for each row execute function public.money_audit_log_inmutable();

drop trigger if exists money_audit_log_sin_vaciar on public.money_audit_log;
create trigger money_audit_log_sin_vaciar
  before truncate on public.money_audit_log
  for each statement execute function public.money_audit_log_inmutable();

-- ── Quién pidió el cambio ──────────────────────────────────────────────────

create or replace function public.actor_de_la_peticion()
returns text
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_cabeceras text := nullif(current_setting('request.headers', true), '');
  v_actor text;
begin
  -- Sin cabeceras de PostgREST, el cambio no pasó por el servidor.
  if v_cabeceras is null then
    return 'base';
  end if;
  begin
    v_actor := left(btrim(v_cabeceras::json ->> 'x-umbani-actor'), 200);
  exception when others then
    v_actor := null;
  end;
  return coalesce(nullif(v_actor, ''), 'sistema');
end;
$$;

revoke all on function public.actor_de_la_peticion() from public, anon, authenticated;
grant execute on function public.actor_de_la_peticion() to service_role;

-- ── La única puerta de escritura ───────────────────────────────────────────
--
-- `security definer`: escribe aunque el cambio lo haga un rol sin permiso de
-- INSERT sobre el registro. Lo llaman los disparadores de abajo, y nadie más.

create or replace function public.anotar_movimiento_de_dinero(
  p_business_id uuid,
  p_action text,
  p_target_table text,
  p_target_id text,
  p_detail jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.money_audit_log
    (actor, business_id, business_name, action, target_table, target_id, detail)
  values (
    public.actor_de_la_peticion(),
    p_business_id,
    (select b.name from public.businesses b where b.id = p_business_id),
    p_action,
    p_target_table,
    p_target_id,
    coalesce(p_detail, '{}'::jsonb)
  );
end;
$$;

-- ⚠️ `service_role` SÍ la ejecuta: los disparadores corren con el rol de quien
-- hace el cambio, y el servidor entra como `service_role`. Sin este permiso,
-- encender la tarjeta de un local desde el panel fallaría ENTERO por no poder
-- dejar su rastro.
revoke all on function public.anotar_movimiento_de_dinero(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.anotar_movimiento_de_dinero(uuid, text, text, text, jsonb)
  to service_role;

-- ── Los disparadores, tabla por tabla ──────────────────────────────────────

-- Las liquidaciones del local: la de los lunes las CREA; el superadmin las
-- marca PAGADAS con su referencia.
create or replace function public.settlements_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'liquidacion_cerrada', 'settlements',
      new.id::text, jsonb_build_object('party', new.party, 'desde', new.period_start,
        'hasta', new.period_end, 'neto_cents', new.neto_cents, 'estado', new.status));
  elsif old.status is distinct from new.status
     or old.reference is distinct from new.reference
     or old.neto_cents is distinct from new.neto_cents then
    perform public.anotar_movimiento_de_dinero(new.business_id,
      'liquidacion_' || coalesce(new.status, 'cambiada'), 'settlements', new.id::text,
      jsonb_build_object('desde', new.period_start, 'hasta', new.period_end,
        'antes', jsonb_build_object('estado', old.status, 'referencia', old.reference, 'neto_cents', old.neto_cents),
        'despues', jsonb_build_object('estado', new.status, 'referencia', new.reference, 'neto_cents', new.neto_cents)));
  end if;
  return null;
end;
$$;

revoke all on function public.settlements_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists settlements_registro_de_dinero on public.settlements;
create trigger settlements_registro_de_dinero
  after insert or update on public.settlements
  for each row execute function public.settlements_registro_de_dinero();

-- Las liquidaciones de los motorizados: igual, sin local.
create or replace function public.courier_settlements_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.anotar_movimiento_de_dinero(null, 'liquidacion_motorizado_cerrada', 'courier_settlements',
      new.id::text, jsonb_build_object('motorizado', new.courier_id, 'desde', new.period_start,
        'hasta', new.period_end, 'neto_cents', new.neto_cents, 'estado', new.status));
  elsif old.status is distinct from new.status
     or old.reference is distinct from new.reference
     or old.neto_cents is distinct from new.neto_cents then
    perform public.anotar_movimiento_de_dinero(null,
      'liquidacion_motorizado_' || coalesce(new.status, 'cambiada'), 'courier_settlements', new.id::text,
      jsonb_build_object('motorizado', new.courier_id, 'desde', new.period_start, 'hasta', new.period_end,
        'antes', jsonb_build_object('estado', old.status, 'referencia', old.reference, 'neto_cents', old.neto_cents),
        'despues', jsonb_build_object('estado', new.status, 'referencia', new.reference, 'neto_cents', new.neto_cents)));
  end if;
  return null;
end;
$$;

revoke all on function public.courier_settlements_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists courier_settlements_registro_de_dinero on public.courier_settlements;
create trigger courier_settlements_registro_de_dinero
  after insert or update on public.courier_settlements
  for each row execute function public.courier_settlements_registro_de_dinero();

-- La carrera RETENIDA a un motorizado (se le cayó la comida).
create or replace function public.order_ledger_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.business_id,
    case when new.retenido then 'carrera_retenida' else 'carrera_liberada' end,
    'order_ledger', new.id::text,
    jsonb_build_object('pedido', new.order_id, 'motorizado', new.courier_id,
      'reparto_cents', new.reparto_cents, 'motivo', new.retenido_motivo));
  return null;
end;
$$;

revoke all on function public.order_ledger_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists order_ledger_registro_de_dinero on public.order_ledger;
create trigger order_ledger_registro_de_dinero
  after update of retenido on public.order_ledger
  for each row when (old.retenido is distinct from new.retenido)
  execute function public.order_ledger_registro_de_dinero();

-- Los cobros con tarjeta: solo los estados en que el dinero SE MUEVE. Los
-- intentos que nadie pagó (`caducado`) no son dinero, y serían ruido.
create or replace function public.payments_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.business_id, 'tarjeta_' || new.status,
    'payments', new.id::text,
    jsonb_build_object('pedido', new.order_id, 'modo', new.environment,
      'monto_cents', new.amount_cents, 'cobrado_cents', new.captured_cents,
      'antes', old.status, 'payphone', new.provider_transaction_id,
      'detalle', left(coalesce(new.status_detail, ''), 200)));
  return null;
end;
$$;

revoke all on function public.payments_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists payments_registro_de_dinero on public.payments;
create trigger payments_registro_de_dinero
  after update of status on public.payments
  for each row when (
    old.status is distinct from new.status
    and new.status in ('aprobado', 'no_confirmado', 'por_devolver', 'devuelto', 'devolucion_manual')
  )
  execute function public.payments_registro_de_dinero();

-- El pedido: un PAGO CONFIRMADO (la transferencia que aprueba el local, o la
-- tarjeta), y un pedido YA PAGADO que se cancela —que es lo que dispara la
-- devolución—.
create or replace function public.orders_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_base jsonb := jsonb_build_object('numero', new.order_number,
    'metodo', new.payment_method, 'total', new.total);
begin
  if old.payment_confirmed_at is null and new.payment_confirmed_at is not null then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'pago_confirmado', 'orders',
      new.id::text, v_base);
  end if;
  if new.status = 'cancelado' and old.status is distinct from 'cancelado'
     and old.payment_confirmed_at is not null then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'pedido_pagado_cancelado', 'orders',
      new.id::text, v_base || jsonb_build_object('estaba', old.status));
  end if;
  return null;
end;
$$;

revoke all on function public.orders_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists orders_registro_de_dinero on public.orders;
create trigger orders_registro_de_dinero
  after update of payment_confirmed_at, status on public.orders
  for each row when (
    (old.payment_confirmed_at is null and new.payment_confirmed_at is not null)
    or (new.status = 'cancelado' and old.status is distinct from 'cancelado'
        and old.payment_confirmed_at is not null)
  )
  execute function public.orders_registro_de_dinero();

-- La facturación mensual del local (la cuota): se crea, se cobra, se ajusta.
create or replace function public.billing_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'factura_creada', 'billing',
      new.id::text, jsonb_build_object('monto', new.amount, 'desde', new.period_start,
        'hasta', new.period_end, 'estado', new.status));
  elsif old.status is distinct from new.status or old.amount is distinct from new.amount then
    perform public.anotar_movimiento_de_dinero(new.business_id, 'factura_' || coalesce(new.status, 'cambiada'),
      'billing', new.id::text, jsonb_build_object('desde', new.period_start, 'hasta', new.period_end,
        'antes', jsonb_build_object('estado', old.status, 'monto', old.amount),
        'despues', jsonb_build_object('estado', new.status, 'monto', new.amount)));
  end if;
  return null;
end;
$$;

revoke all on function public.billing_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists billing_registro_de_dinero on public.billing;
create trigger billing_registro_de_dinero
  after insert or update on public.billing
  for each row execute function public.billing_registro_de_dinero();

-- La tarjeta de un local, encendida (en pruebas o de verdad) o apagada.
create or replace function public.businesses_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.id, 'tarjeta_del_local', 'businesses',
    new.id::text, jsonb_build_object('antes', old.card_mode, 'despues', new.card_mode));
  return null;
end;
$$;

revoke all on function public.businesses_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists businesses_registro_de_dinero on public.businesses;
create trigger businesses_registro_de_dinero
  after update of card_mode on public.businesses
  for each row when (old.card_mode is distinct from new.card_mode)
  execute function public.businesses_registro_de_dinero();

-- Las reglas del margen: lo que gana Umbani por pedido.
create or replace function public.pricing_rules_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_fila public.pricing_rules := coalesce(new, old);
  v_regla jsonb := jsonb_build_object('alcance', v_fila.scope, 'destino', v_fila.target_name,
    'estrategia', v_fila.strategy, 'porcentaje', v_fila.percentage, 'fijo', v_fila.fixed_amount,
    'minimo', v_fila.min_amount, 'maximo', v_fila.max_amount, 'estado', v_fila.status,
    'version', v_fila.version);
begin
  perform public.anotar_movimiento_de_dinero(v_fila.business_id,
    case tg_op when 'INSERT' then 'margen_creado' when 'DELETE' then 'margen_borrado' else 'margen_cambiado' end,
    'pricing_rules', v_fila.id::text,
    case when tg_op = 'UPDATE'
      then jsonb_build_object('antes', jsonb_build_object('porcentaje', old.percentage, 'fijo', old.fixed_amount,
             'minimo', old.min_amount, 'maximo', old.max_amount, 'estado', old.status), 'despues', v_regla)
      else v_regla end);
  return null;
end;
$$;

revoke all on function public.pricing_rules_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists pricing_rules_registro_de_dinero on public.pricing_rules;
create trigger pricing_rules_registro_de_dinero
  after insert or update or delete on public.pricing_rules
  for each row execute function public.pricing_rules_registro_de_dinero();

-- Los ajustes que deciden dinero —la tarifa de servicio y lo que cobra
-- PayPhone—, y el SEGUNDO PASO del superadmin: configurarlo o reiniciarlo es
-- justo lo que alguien que quisiera entrar sin permiso haría primero. De la
-- clave no se guarda nada, solo que cambió.
create or replace function public.server_settings_registro_de_dinero()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_clave text := coalesce(new.key, old.key);
begin
  if v_clave in ('service_fee', 'payphone_fee_bps') then
    if tg_op = 'UPDATE' and old.value is not distinct from new.value then
      return null;
    end if;
    perform public.anotar_movimiento_de_dinero(null, 'ajuste_' || v_clave, 'server_settings', v_clave,
      jsonb_build_object('antes', case when tg_op = 'INSERT' then null else old.value end,
        'despues', case when tg_op = 'DELETE' then null else new.value end));
  elsif v_clave = 'admin_totp_secret' then
    if tg_op = 'UPDATE' and old.value is not distinct from new.value then
      return null;
    end if;
    perform public.anotar_movimiento_de_dinero(null,
      case when tg_op = 'DELETE' then 'segundo_paso_reiniciado' else 'segundo_paso_configurado' end,
      'server_settings', v_clave, '{}'::jsonb);
  end if;
  return null;
end;
$$;

revoke all on function public.server_settings_registro_de_dinero() from public, anon, authenticated;

drop trigger if exists server_settings_registro_de_dinero on public.server_settings;
create trigger server_settings_registro_de_dinero
  after insert or update or delete on public.server_settings
  for each row execute function public.server_settings_registro_de_dinero();

-- ── La lectura del superadmin ──────────────────────────────────────────────

create or replace function public.money_audit_log_recent(
  p_limite integer default 200,
  p_business_id uuid default null,
  p_antes_de bigint default null
)
returns setof public.money_audit_log
language sql
stable
set search_path = public, pg_temp
as $$
  select *
    from public.money_audit_log
   where (p_business_id is null or business_id = p_business_id)
     and (p_antes_de is null or id < p_antes_de)
   order by id desc
   limit least(greatest(coalesce(p_limite, 200), 1), 500);
$$;

revoke all on function public.money_audit_log_recent(integer, uuid, bigint) from public, anon, authenticated;
grant execute on function public.money_audit_log_recent(integer, uuid, bigint) to service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- EL CUADRE DIARIO CONTRA PAYPHONE (2026-09-29).
-- Ver `migration-2026-09-29-cuadre-con-payphone.sql`: el porqué está allí.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.payments
  add column if not exists reconciled_at timestamptz,
  add column if not exists reconciliation text,
  add column if not exists reconciliation_detail text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payments_reconciliation_check') then
    alter table public.payments
      add constraint payments_reconciliation_check
      check (reconciliation is null or reconciliation in ('cuadra', 'descuadre'));
  end if;
end $$;

comment on column public.payments.reconciliation is
  'El último cuadre contra PayPhone: cuadra o descuadre. Lo escribe la tarea diaria; nunca cambia el estado del cobro.';

-- Los cobros que tocan cuadrar: los de los últimos 3 días que no se cuadraron
-- en las últimas 20 h. Los que siguen vivos (`iniciado`, `confirmando`) son
-- trabajo de la tarea de cobros; solo se miran si llevan más de 30 minutos.
create or replace function public.payments_to_reconcile(p_environment text, p_limite integer default 120)
returns table (
  id uuid,
  business_id uuid,
  business_name text,
  order_id uuid,
  order_number integer,
  client_transaction_id text,
  provider_transaction_id text,
  status text,
  amount_cents integer,
  captured_cents integer,
  created_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select p.id, p.business_id, b.name, p.order_id, o.order_number, p.client_transaction_id,
         p.provider_transaction_id, p.status, p.amount_cents, p.captured_cents, p.created_at
    from public.payments p
    join public.businesses b on b.id = p.business_id
    left join public.orders o on o.id = p.order_id and o.business_id = p.business_id
   where p.environment = p_environment
     and p.created_at > now() - interval '3 days'
     and (p.reconciled_at is null or p.reconciled_at < now() - interval '20 hours')
     and (p.status not in ('iniciado', 'confirmando') or p.created_at < now() - interval '30 minutes')
   order by p.created_at
   limit least(greatest(coalesce(p_limite, 120), 1), 300);
$$;

revoke all on function public.payments_to_reconcile(text, integer) from public, anon, authenticated;
grant execute on function public.payments_to_reconcile(text, integer) to service_role;

create or replace function public.mark_payment_reconciled(p_id uuid, p_resultado text, p_detalle text)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if p_resultado not in ('cuadra', 'descuadre') then
    raise exception using errcode = '22023', message = 'Resultado de cuadre inválido';
  end if;
  -- ⚠️ Sin `updated_at`: ver la cabecera.
  update public.payments
     set reconciled_at = now(),
         reconciliation = p_resultado,
         reconciliation_detail = left(nullif(btrim(coalesce(p_detalle, '')), ''), 300)
   where id = p_id;
  return found;
end;
$$;

revoke all on function public.mark_payment_reconciled(uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_payment_reconciled(uuid, text, text) to service_role;


-- ════════════════════════════════════════════════════════════════════════════
-- LOS LOCALES DE DEMOSTRACIÓN (2026-09-30).
-- Ver `migration-2026-09-30-locales-de-demostracion.sql`: el porqué está allí.
-- ════════════════════════════════════════════════════════════════════════════

update public.businesses
   set is_demo = true
 where notes like 'LOCAL DE MUESTRA%'
   and not is_demo;

-- Cambiar la marca queda en el registro de dinero. Se crea DESPUÉS de marcar
-- los 15 de muestra: esa decisión está escrita aquí, no hace falta repetirla.
create or replace function public.businesses_registro_demo()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  perform public.anotar_movimiento_de_dinero(new.id, 'local_demo', 'businesses',
    new.id::text, jsonb_build_object('antes', old.is_demo, 'despues', new.is_demo));
  return null;
end;
$$;

revoke all on function public.businesses_registro_demo() from public, anon, authenticated;

drop trigger if exists businesses_registro_demo on public.businesses;
create trigger businesses_registro_demo
  after update of is_demo on public.businesses
  for each row when (old.is_demo is distinct from new.is_demo)
  execute function public.businesses_registro_demo();

-- ════════════════════════════════════════════════════════════════════════════
-- LAS INCIDENCIAS Y EL «¿LLEGÓ TODO BIEN?» DEL CLIENTE (2026-10-06, fase 1)
-- Ver `migration-2026-10-06-incidencias.sql`: el porqué está allí. Esta fase
-- no mueve dinero: la compensación queda decidida y anotada.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1. «Todo bien» ─────────────────────────────────────────────────────────
alter table public.orders
  add column if not exists received_ok_at timestamptz;
comment on column public.orders.received_ok_at is
  'Cuándo el cliente dijo «Todo bien» con su pedido entregado.';


-- ── 2. Las incidencias de un pedido ────────────────────────────────────────
create table if not exists public.order_incidents (
  id                 uuid primary key default gen_random_uuid(),
  business_id        uuid not null references public.businesses(id) on delete cascade,
  order_id           uuid not null,
  -- Quién lo llevaba cuando pasó (si lo llevó alguien de una flota).
  courier_id         uuid references public.couriers(id) on delete set null,
  kind               text not null,
  -- Quién la abrió: el cliente desde la app, o el superadmin.
  origin             text not null,
  status             text not null default 'abierta',
  -- Se decide al resolver.
  responsible        text,
  -- Las unidades reportadas: [{ item, nombre, cantidad, centavos }].
  lines              jsonb not null default '[]'::jsonb,
  note               text,
  -- Lo que calculó la base al abrirla (lo que pagó el cliente por eso).
  suggested_cents    integer not null default 0,
  -- Lo que se decidió compensar al resolver.
  compensation_cents integer,
  resolution_note    text,
  resolved_by        text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz,

  constraint order_incidents_order_fk foreign key (order_id, business_id)
    references public.orders (id, business_id) on delete cascade,
  constraint order_incidents_kind_check check (kind in (
    'falta_producto', 'vino_mal', 'no_llego',
    'comida_caida', 'cliente_ausente', 'accidente', 'no_aparecio', 'otro'
  )),
  constraint order_incidents_origin_check check (origin in ('cliente', 'superadmin')),
  constraint order_incidents_status_check check (status in ('abierta', 'resuelta', 'descartada')),
  constraint order_incidents_responsible_check check (
    responsible is null or responsible in ('local', 'repartidor', 'cliente', 'umbani')
  ),
  constraint order_incidents_texto_check check (
    (note is null or char_length(note) <= 500)
    and (resolution_note is null or char_length(resolution_note) <= 500)
  ),
  constraint order_incidents_centavos_check check (
    suggested_cents >= 0 and (compensation_cents is null or compensation_cents >= 0)
  ),
  -- Resuelta = se sabe quién responde, cuánto se compensa y cuándo.
  constraint order_incidents_resuelta_check check (
    status = 'abierta'
    or (status = 'descartada' and resolved_at is not null)
    or (status = 'resuelta' and resolved_at is not null and responsible is not null and compensation_cents is not null)
  ),
  constraint order_incidents_lines_check check (jsonb_typeof(lines) = 'array')
);

-- El cliente reclama UNA vez por pedido.
create unique index if not exists order_incidents_un_reclamo_por_pedido
  on public.order_incidents (order_id) where origin = 'cliente';
create index if not exists idx_order_incidents_estado on public.order_incidents (status, created_at desc);
create index if not exists idx_order_incidents_negocio on public.order_incidents (business_id, created_at desc);
create index if not exists idx_order_incidents_repartidor on public.order_incidents (courier_id) where courier_id is not null;

alter table public.order_incidents enable row level security;
revoke all on table public.order_incidents from anon, authenticated;
comment on table public.order_incidents is
  'Incidencias de un pedido: las reporta el cliente (falta, vino mal, no llegó) o las registra el superadmin. Fase 1: no mueven dinero.';


-- ── 3. El pedido de ESTE teléfono, entregado ───────────────────────────────
-- La pregunta común a «Todo bien» y al reclamo. El teléfono, con y sin «+»
-- (YCloud lo manda con él; los pedidos se guardan sin él).
create or replace function public.pedido_entregado_de(p_order_id uuid, p_phone text)
returns table (order_id uuid, business_id uuid, status text, entregado_en timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select o.id, o.business_id, o.status,
         coalesce(
           (select max(s.sold_at) from public.sales s where s.order_id = o.id),
           (select max(e.created_at) from public.order_events e where e.order_id = o.id and e.to_status = 'completado'),
           o.updated_at)
  from public.orders o
  where o.id = p_order_id
    and regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
    and o.contact_phone in (regexp_replace(p_phone, '\D', '', 'g'), '+' || regexp_replace(p_phone, '\D', '', 'g'))
$$;

revoke all on function public.pedido_entregado_de(uuid, text) from public, anon, authenticated;


-- ── 4. «Todo bien» ─────────────────────────────────────────────────────────
create or replace function public.customer_confirm_order(p_order_id uuid, p_phone text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
begin
  select * into v from public.pedido_entregado_de(p_order_id, p_phone);
  if v.order_id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v.status <> 'completado' then return jsonb_build_object('result', 'no_entregado'); end if;
  if exists (select 1 from public.order_incidents i where i.order_id = v.order_id and i.origin = 'cliente') then
    return jsonb_build_object('result', 'ya_reclamado');
  end if;
  update public.orders set received_ok_at = coalesce(received_ok_at, now()) where id = v.order_id;
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function public.customer_confirm_order(uuid, text) from public, anon, authenticated;
grant execute on function public.customer_confirm_order(uuid, text) to service_role;


-- ── 5. El reclamo del cliente ──────────────────────────────────────────────
-- ⚠️ Lo que le corresponde lo calcula AQUÍ la base, nunca el teléfono: el
-- precio de cada unidad que pagó —el del local más su parte del margen de
-- Umbani—, en centavos. El porcentaje del margen no se guarda en el pedido
-- (sí su total), así que se reparte en PROPORCIÓN al precio de cada línea; la
-- tarifa de servicio no es de ningún producto y no entra. Nunca más que el
-- total del pedido.
create or replace function public.customer_report_order(
  p_order_id uuid, p_phone text, p_kind text, p_lines jsonb, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v record;
  v_o public.orders%rowtype;
  v_base numeric;
  v_factor numeric;
  v_fila record;
  v_lineas jsonb := '[]'::jsonb;
  v_sugerido bigint := 0;
  v_unidad integer;
  v_total integer;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('falta_producto', 'vino_mal', 'no_llego') then
    return jsonb_build_object('result', 'tipo_invalido');
  end if;
  if p_note is not null and char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_larga');
  end if;

  select * into v from public.pedido_entregado_de(p_order_id, p_phone);
  if v.order_id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v.status <> 'completado' then return jsonb_build_object('result', 'no_entregado'); end if;
  if exists (select 1 from public.order_incidents i where i.order_id = v.order_id and i.origin = 'cliente') then
    return jsonb_build_object('result', 'ya_reclamado');
  end if;
  if v.entregado_en < now() - interval '48 hours' then
    return jsonb_build_object('result', 'fuera_de_plazo');
  end if;

  select * into v_o from public.orders where id = v.order_id;
  v_total := round(coalesce(v_o.total, 0) * 100)::integer;

  if p_kind = 'no_llego' then
    -- No llegó nada: el pedido entero.
    v_sugerido := v_total;
  else
    if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
      return jsonb_build_object('result', 'sin_lineas');
    end if;
    if exists (
      select 1 from jsonb_array_elements(p_lines) x
       where jsonb_typeof(x) <> 'object'
          or coalesce(x ->> 'item', '') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
          or coalesce(x ->> 'cantidad', '') !~ '^[0-9]{1,3}$'
    ) then
      return jsonb_build_object('result', 'linea_invalida');
    end if;

    select coalesce(sum(oi.line_total), 0) into v_base from public.order_items oi where oi.order_id = v_o.id;
    v_factor := case when v_base > 0
      then 1 + greatest(coalesce(v_o.platform_markup, 0) - coalesce(v_o.service_fee, 0), 0) / v_base
      else 1 end;

    -- La misma línea dos veces cuenta como una, sumando la cantidad.
    for v_fila in
      select (x ->> 'item')::uuid as item, sum((x ->> 'cantidad')::integer) as cantidad
        from jsonb_array_elements(p_lines) x
       group by 1
    loop
      declare
        v_item public.order_items%rowtype;
      begin
        select * into v_item from public.order_items oi where oi.id = v_fila.item and oi.order_id = v_o.id;
        if v_item.id is null or v_fila.cantidad < 1 or v_fila.cantidad > v_item.quantity then
          return jsonb_build_object('result', 'linea_invalida');
        end if;
        v_unidad := round(round(v_item.line_total / v_item.quantity, 2) * v_factor * 100)::integer;
        v_sugerido := v_sugerido + v_unidad::bigint * v_fila.cantidad;
        v_lineas := v_lineas || jsonb_build_object(
          'item', v_item.id, 'nombre', v_item.product_name, 'cantidad', v_fila.cantidad,
          'centavos', v_unidad * v_fila.cantidad);
      end;
    end loop;
    v_sugerido := least(v_sugerido, v_total);
  end if;

  insert into public.order_incidents (business_id, order_id, courier_id, kind, origin, lines, note, suggested_cents)
  values (v_o.business_id, v_o.id, v_o.courier_id, p_kind, 'cliente', v_lineas,
          nullif(btrim(coalesce(p_note, '')), ''), v_sugerido::integer)
  returning id into v_id;

  return jsonb_build_object('result', 'ok', 'id', v_id, 'sugeridoCents', v_sugerido::integer);
exception
  -- Dos toques a la vez: el índice único deja entrar uno solo.
  when unique_violation then
    return jsonb_build_object('result', 'ya_reclamado');
end;
$$;

revoke all on function public.customer_report_order(uuid, text, text, jsonb, text) from public, anon, authenticated;
grant execute on function public.customer_report_order(uuid, text, text, jsonb, text) to service_role;


-- ── 6. Las que registra el superadmin ──────────────────────────────────────
-- Las que el cliente no ve: comida caída, cliente ausente, accidente, el
-- repartidor que no apareció. El pedido se nombra por su local y su número.
create or replace function public.register_incident(
  p_business_id uuid, p_order_number integer, p_kind text, p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_o public.orders%rowtype;
  v_id uuid;
begin
  if p_kind is null or p_kind not in ('falta_producto', 'vino_mal', 'no_llego', 'comida_caida',
                                      'cliente_ausente', 'accidente', 'no_aparecio', 'otro') then
    return jsonb_build_object('result', 'tipo_invalido');
  end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 or char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_invalida');
  end if;
  select * into v_o from public.orders where business_id = p_business_id and order_number = p_order_number;
  if v_o.id is null then return jsonb_build_object('result', 'not_found'); end if;

  insert into public.order_incidents (business_id, order_id, courier_id, kind, origin, note)
  values (v_o.business_id, v_o.id, v_o.courier_id, p_kind, 'superadmin', btrim(p_note))
  returning id into v_id;
  return jsonb_build_object('result', 'ok', 'id', v_id);
end;
$$;

revoke all on function public.register_incident(uuid, integer, text, text) from public, anon, authenticated;
grant execute on function public.register_incident(uuid, integer, text, text) to service_role;


-- ── 7. Resolverla ──────────────────────────────────────────────────────────
-- Quién responde y cuánto se compensa al cliente; o descartarla (con motivo).
-- ⚠️ Una resuelta no se reescribe: en la fase 2 de ella colgará dinero.
-- La compensación nunca pasa del total del pedido.
create or replace function public.resolve_incident(
  p_id uuid, p_status text, p_responsible text, p_compensation_cents integer, p_note text, p_actor text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_i public.order_incidents%rowtype;
  v_total integer;
begin
  select * into v_i from public.order_incidents where id = p_id for update;
  if v_i.id is null then return jsonb_build_object('result', 'not_found'); end if;
  if v_i.status <> 'abierta' then return jsonb_build_object('result', 'ya_resuelta'); end if;
  if char_length(btrim(coalesce(p_note, ''))) < 3 or char_length(btrim(p_note)) > 500 then
    return jsonb_build_object('result', 'nota_invalida');
  end if;

  if p_status = 'descartada' then
    update public.order_incidents
       set status = 'descartada', resolution_note = btrim(p_note), resolved_by = left(coalesce(p_actor, 'superadmin'), 120), resolved_at = now()
     where id = p_id;
    return jsonb_build_object('result', 'ok');
  end if;
  if p_status is distinct from 'resuelta'
     or p_responsible is null or p_responsible not in ('local', 'repartidor', 'cliente', 'umbani') then
    return jsonb_build_object('result', 'datos_invalidos');
  end if;
  select round(coalesce(o.total, 0) * 100)::integer into v_total from public.orders o where o.id = v_i.order_id;
  if p_compensation_cents is null or p_compensation_cents < 0 or p_compensation_cents > v_total then
    return jsonb_build_object('result', 'compensacion_invalida', 'maximoCents', v_total);
  end if;

  update public.order_incidents
     set status = 'resuelta', responsible = p_responsible, compensation_cents = p_compensation_cents,
         resolution_note = btrim(p_note), resolved_by = left(coalesce(p_actor, 'superadmin'), 120), resolved_at = now()
   where id = p_id;
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function public.resolve_incident(uuid, text, text, integer, text, text) from public, anon, authenticated;
grant execute on function public.resolve_incident(uuid, text, text, integer, text, text) to service_role;

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
